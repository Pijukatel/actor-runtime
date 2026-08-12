/**
 * Tests for the TARBALL source-upload build path and no-stale-source guarantee.
 *
 * All run Docker-free through `wire()` (in-process app + StubDriver). The
 * StubDriver captures the materialized build directory before the service
 * rm -rf's it, so tests can assert exactly which source was unzipped/written.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SourceFileNameError, extractZip } from '../../src/driver.js';
import { wire } from '../helpers.js';

function makeZip(files) {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) {
        // adm-zip's addFile normalizes entry names (strips `../`, leading
        // `/`); malicious traversal names are written by mutating the entry
        // after the fact, so the produced archive carries the raw name
        // verbatim -- exactly what a hostile zip would contain.
        const placeholder = `placeholder-${zip.getEntries().length}`;
        zip.addFile(placeholder, Buffer.from(content));
        zip.getEntry(placeholder).entryName = name;
    }
    return zip.toBuffer();
}

/**
 * A zip with one legitimate file plus one entry marked as a symlink via its
 * external attributes (the Unix mode bits `S_IFLNK` packed into the high 16
 * bits, as real zip tools do for symlink entries).
 */
function makeZipWithSymlink(legitName, legitContent, linkName, linkTarget) {
    const zip = new AdmZip();
    zip.addFile(legitName, Buffer.from(legitContent));
    zip.addFile(linkName, Buffer.from(linkTarget));
    zip.getEntry(linkName).attr = ((0o120000 | 0o777) << 16) >>> 0; // S_IFLNK | 0777
    return zip.toBuffer();
}

function tarballUrl(storeId, key) {
    return `http://test/key-value-stores/${storeId}/records/${key}?disableRedirect=true`;
}

/** Create the KV store the way a real push does, then PUT bytes; return its id. */
async function putRecord(client, storeName, key, body) {
    const created = await client.post('/v2/key-value-stores', { json: { name: storeName } });
    const storeId = created.json().data.id;
    const put = await client.put(`/v2/key-value-stores/${storeId}/records/${key}`, {
        body,
        headers: { 'content-type': 'application/zip' },
    });
    expect(put.status).toBe(200);
    return storeId;
}

async function createActor(client, name) {
    await client.post('/v2/acts', { json: { name, versions: [{ versionNumber: '0.0' }] } });
    return `local-user~${name}`;
}

async function build(client, service, actorId) {
    const started = (await client.post(`/v2/acts/${actorId}/builds?version=0.0`)).json().data;
    await service.waitIdle();
    return (await client.get(`/v2/actor-builds/${started.id}`)).json().data;
}

/** Every file path (recursive) under `dir` whose basename equals `name`. */
function findFilesNamed(dir, name) {
    const found = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return found;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...findFilesNamed(full, name));
        else if (entry.name === name) found.push(full);
    }
    return found;
}

let ctx;
let tmpDirs;

beforeEach(async () => {
    ctx = await wire();
    tmpDirs = [];
});

afterEach(async () => {
    await ctx.close();
    for (const dir of tmpDirs) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
});

async function makeTmpDir() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tarball-build-test-'));
    tmpDirs.push(dir);
    return dir;
}

describe('tarball builds', () => {
    // -- Inline push still builds the pushed files (TEXT + BASE64) --------------
    it('inline build materializes the pushed files', async () => {
        const { client, service } = ctx;
        const actorId = await createActor(client, 'inline');
        const blob = Buffer.from([0x62, 0x69, 0x6e, 0x61, 0x72, 0x79, 0x00, 0xff, 0x20, 0x64, 0x61, 0x74, 0x61]); // binary\x00\xff data
        await client.put(`/v2/actors/${actorId}/versions/0.0`, {
            json: {
                sourceType: 'SOURCE_FILES',
                sourceFiles: [
                    { name: 'main.py', format: 'TEXT', content: "print('hi')\n" },
                    { name: '.actor/Dockerfile', format: 'TEXT', content: 'FROM scratch\n' },
                    { name: 'blob.bin', format: 'BASE64', content: blob.toString('base64') },
                ],
            },
        });
        const final = await build(client, service, actorId);
        expect(final.status).toBe('SUCCEEDED');
        const captured = service.driver.capturedBuildDirContents;
        expect(captured['main.py']).toEqual(Buffer.from("print('hi')\n"));
        expect(captured['.actor/Dockerfile']).toEqual(Buffer.from('FROM scratch\n'));
        expect(captured['blob.bin']).toEqual(blob);
    });

    // -- A TARBALL build unzips the pushed zip's real contents -------------------
    it("a tarball build materializes the unzipped source", async () => {
        const { client, service } = ctx;
        const actorId = await createActor(client, 'tb');
        const zipBytes = makeZip({
            'main.py': "print('from tarball')\n",
            'src/util.py': 'VALUE = 42\n',
            '.actor/Dockerfile': 'FROM scratch\n',
        });
        // Use whatever id the store-creation step returns, verbatim, in the URL.
        const storeId = await putRecord(client, 'tb-source', 'version-0.0.zip', zipBytes);
        await client.put(`/v2/actors/${actorId}/versions/0.0`, {
            json: { sourceType: 'TARBALL', tarballUrl: tarballUrl(storeId, 'version-0.0.zip') },
        });
        const final = await build(client, service, actorId);
        expect(final.status).toBe('SUCCEEDED');
        const captured = service.driver.capturedBuildDirContents;
        expect(captured['main.py']).toEqual(Buffer.from("print('from tarball')\n"));
        expect(captured['src/util.py']).toEqual(Buffer.from('VALUE = 42\n'));
        expect(captured['.actor/Dockerfile']).toEqual(Buffer.from('FROM scratch\n'));
    });

    // -- Tarball push after inline push builds only the tarball ------------------
    it('no stale source: tarball after inline', async () => {
        const { client, service } = ctx;
        const actorId = await createActor(client, 'sw1');
        await client.put(`/v2/actors/${actorId}/versions/0.0`, {
            json: {
                sourceType: 'SOURCE_FILES',
                sourceFiles: [
                    { name: 'inline_marker.txt', format: 'TEXT', content: 'inline\n' },
                    { name: '.actor/Dockerfile', format: 'TEXT', content: 'FROM scratch\n' },
                ],
            },
        });
        const first = await build(client, service, actorId);
        expect(first.status).toBe('SUCCEEDED');
        expect(service.driver.capturedBuildFiles).toContain('inline_marker.txt');

        const zipBytes = makeZip({ 'tarball_marker.txt': 'tarball\n', '.actor/Dockerfile': 'FROM scratch\n' });
        const storeId = await putRecord(client, 'sw1-source', 'version-0.0.zip', zipBytes);
        await client.put(`/v2/actors/${actorId}/versions/0.0`, {
            json: { sourceType: 'TARBALL', tarballUrl: tarballUrl(storeId, 'version-0.0.zip') },
        });
        const second = await build(client, service, actorId);
        expect(second.status).toBe('SUCCEEDED');
        const files = service.driver.capturedBuildFiles;
        expect(files).toContain('tarball_marker.txt');
        expect(files).not.toContain('inline_marker.txt');
    });

    // -- Inline push after tarball push builds only the inline files -------------
    it('no stale source: inline after tarball', async () => {
        const { client, service } = ctx;
        const actorId = await createActor(client, 'sw2');
        const zipBytes = makeZip({ 'tarball_marker.txt': 'tarball\n', '.actor/Dockerfile': 'FROM scratch\n' });
        const storeId = await putRecord(client, 'sw2-source', 'version-0.0.zip', zipBytes);
        await client.put(`/v2/actors/${actorId}/versions/0.0`, {
            json: { sourceType: 'TARBALL', tarballUrl: tarballUrl(storeId, 'version-0.0.zip') },
        });
        const first = await build(client, service, actorId);
        expect(first.status).toBe('SUCCEEDED');
        expect(service.driver.capturedBuildFiles).toContain('tarball_marker.txt');

        // Delete the tarball record: a stale/superseded record must not resurrect it.
        await client.delete(`/v2/key-value-stores/${storeId}`);
        await client.put(`/v2/actors/${actorId}/versions/0.0`, {
            json: {
                sourceType: 'SOURCE_FILES',
                sourceFiles: [
                    { name: 'inline_marker.txt', format: 'TEXT', content: 'inline\n' },
                    { name: '.actor/Dockerfile', format: 'TEXT', content: 'FROM scratch\n' },
                ],
            },
        });
        const second = await build(client, service, actorId);
        expect(second.status).toBe('SUCCEEDED');
        const files = service.driver.capturedBuildFiles;
        expect(files).toContain('inline_marker.txt');
        expect(files).not.toContain('tarball_marker.txt');
    });

    // -- Serialized version reflects the pushed shape, clears the other ----------
    it('the version dict reflects the pushed shape', async () => {
        const { client } = ctx;
        const actorId = await createActor(client, 'vd');

        await client.put(`/v2/actors/${actorId}/versions/0.0`, {
            json: {
                sourceType: 'SOURCE_FILES',
                sourceFiles: [{ name: 'a.py', format: 'TEXT', content: 'x\n' }],
            },
        });
        let v = (await client.get(`/v2/actors/${actorId}/versions/0.0`)).json().data;
        expect(v.sourceType).toBe('SOURCE_FILES');
        expect(v.sourceFiles).toEqual([{ name: 'a.py', format: 'TEXT', content: 'x\n' }]);
        expect(v).not.toHaveProperty('tarballUrl');

        const url = tarballUrl('local-user~vd-source', 'version-0.0.zip');
        await client.put(`/v2/actors/${actorId}/versions/0.0`, {
            json: { sourceType: 'TARBALL', tarballUrl: url },
        });
        v = (await client.get(`/v2/actors/${actorId}/versions/0.0`)).json().data;
        expect(v.sourceType).toBe('TARBALL');
        expect(v.tarballUrl).toBe(url);
        expect(v.sourceFiles).toEqual([]);

        await client.put(`/v2/actors/${actorId}/versions/0.0`, {
            json: {
                sourceType: 'SOURCE_FILES',
                sourceFiles: [{ name: 'b.py', format: 'TEXT', content: 'y\n' }],
            },
        });
        v = (await client.get(`/v2/actors/${actorId}/versions/0.0`)).json().data;
        expect(v.sourceType).toBe('SOURCE_FILES');
        expect(v).not.toHaveProperty('tarballUrl');
        expect(v.sourceFiles).toEqual([{ name: 'b.py', format: 'TEXT', content: 'y\n' }]);
    });

    // -- Zip traversal safety (escaping entries fail the build) ------------------
    it('tarball traversal entries fail the build', async () => {
        // Wire a dedicated app whose whole data dir lives under a tmp dir
        // this test controls, so "nothing escaped anywhere in the
        // surrounding tmp tree" checks the tree the build dir actually
        // lives in.
        const tmpDir = await makeTmpDir();
        const local = await wire({ tmpDir });
        try {
            const { client, service } = local;
            const actorId = await createActor(client, 'tv');
            const zipBytes = makeZip({
                '.actor/Dockerfile': 'FROM scratch\n',
                '../../evil.txt': 'pwned\n',
                '/etc/evil.txt': 'pwned\n',
            });
            const storeId = await putRecord(client, 'tv-source', 'version-0.0.zip', zipBytes);
            await client.put(`/v2/actors/${actorId}/versions/0.0`, {
                json: { sourceType: 'TARBALL', tarballUrl: tarballUrl(storeId, 'version-0.0.zip') },
            });
            const final = await build(client, service, actorId);
            expect(final.status).toBe('FAILED');
            expect(final.finishedAt).not.toBeNull();
            // Nothing escaped: no evil.txt landed anywhere in the surrounding
            // tmp tree. (The absolute-path entry's own coverage lives in
            // 'extractZip rejects an absolute entry name' below, which
            // controls `dest` directly instead of relying on a filesystem
            // check that can never observe where an unguarded absolute write
            // would actually land.)
            expect(findFilesNamed(tmpDir, 'evil.txt')).toEqual([]);
        } finally {
            await local.close();
        }
    });

    // -- extractZip unit coverage: absolute entry names are rejected, nothing written
    it('extractZip rejects an absolute entry name and writes nothing', async () => {
        const tmpDir = await makeTmpDir();
        const dest = path.join(tmpDir, 'build');
        const outsideTarget = path.join(tmpDir, 'evil.txt');
        const zipBytes = makeZip({ [outsideTarget]: 'pwned\n' });
        await expect(extractZip(zipBytes, dest)).rejects.toBeInstanceOf(SourceFileNameError);
        expect(fs.existsSync(outsideTarget)).toBe(false);
        // Nothing written into dest either.
        expect(fs.existsSync(dest) ? fs.readdirSync(dest) : []).toEqual([]);
    });

    // -- Regression: symlink zip entries are never materialized as links ---------
    it('extractZip skips symlink entries', async () => {
        const tmpDir = await makeTmpDir();
        const dest = path.join(tmpDir, 'build');
        const zipBytes = makeZipWithSymlink('main.py', "print('ok')\n", 'evil_link', '../../etc/passwd');
        await extractZip(zipBytes, dest);
        // The legitimate file alongside the symlink entry still gets extracted.
        expect(fs.readFileSync(path.join(dest, 'main.py'), 'utf8')).toBe("print('ok')\n");
        // The symlink entry is never materialized as a file or a link, in dest...
        expect(fs.existsSync(path.join(dest, 'evil_link'))).toBe(false);
        expect(fs.lstatSync(path.join(dest, 'evil_link'), { throwIfNoEntry: false })).toBeUndefined();
        // ...nor anywhere else in the surrounding tmp tree.
        expect(findFilesNamed(tmpDir, 'evil_link')).toEqual([]);
    });

    // -- Missing tarball record fails cleanly (not empty/SUCCEEDED) --------------
    it('a missing tarball record fails cleanly', async () => {
        const { client, service } = ctx;
        const actorId = await createActor(client, 'mr');
        const url = tarballUrl('local-user~mr-source', 'version-0.0.zip'); // never PUT
        await client.put(`/v2/actors/${actorId}/versions/0.0`, {
            json: { sourceType: 'TARBALL', tarballUrl: url },
        });
        const final = await build(client, service, actorId);
        expect(final.status).toBe('FAILED');
        expect(final.finishedAt).not.toBeNull();
        const log = service.getBuild(final.id).log.toLowerCase();
        expect(log.includes('not found') || log.includes('record')).toBe(true);
    });

    // -- Corrupt (non-zip) bytes fail cleanly -------------------------------------
    it('corrupt (non-zip) tarball bytes fail cleanly', async () => {
        const { client, service } = ctx;
        const actorId = await createActor(client, 'cb');
        const storeId = await putRecord(client, 'cb-source', 'version-0.0.zip', Buffer.from('this is not a zip file'));
        await client.put(`/v2/actors/${actorId}/versions/0.0`, {
            json: { sourceType: 'TARBALL', tarballUrl: tarballUrl(storeId, 'version-0.0.zip') },
        });
        const final = await build(client, service, actorId);
        expect(final.status).toBe('FAILED');
        expect(final.finishedAt).not.toBeNull();
        const log = service.getBuild(final.id).log.toLowerCase();
        expect(log.includes('zip') || log.includes('archive')).toBe(true);
    });

    // -- Negative: lookup keys off the URL's store id, not a guess ---------------
    it('the tarball read keys off the store id in the URL, not a reconstructed one', async () => {
        const { client, service } = ctx;
        const actorId = await createActor(client, 'prov');
        const zipBytes = makeZip({ '.actor/Dockerfile': 'FROM scratch\n', 'main.py': 'x\n' });
        // Store the zip under one id, but point the URL at a DIFFERENT id.
        await putRecord(client, 'prov-real-source', 'version-0.0.zip', zipBytes);
        const wrongUrl = tarballUrl('local-user~prov-wrong-source', 'version-0.0.zip');
        await client.put(`/v2/actors/${actorId}/versions/0.0`, {
            json: { sourceType: 'TARBALL', tarballUrl: wrongUrl },
        });
        const final = await build(client, service, actorId);
        // A reconstructed/guessed id would have found the zip; keying off the
        // URL's (wrong) id must miss the record and fail, same as a missing
        // tarball record.
        expect(final.status).toBe('FAILED');
        expect(final.finishedAt).not.toBeNull();
    });
});
