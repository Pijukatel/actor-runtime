/**
 * Direct coverage for `sample_actor/main.js`'s `repeatCount`/`shout`/
 * `tone`/`recipients` handling.
 *
 * `sample_actor/.actor/input_schema.json` describes `repeatCount` ("How
 * many times to repeat the greeting"), `shout` ("Uppercase the greeting
 * before writing it out"), `tone` ("Style of the greeting message" -- the
 * schema's enum/select showcase) and `recipients` ("Names to greet
 * individually" -- the schema's stringList showcase). This file proves all
 * four actually affect the Actor's OUTPUT/dataset.
 *
 * `main.js` is a full `apify` SDK Actor (`Actor.main(...)`), not a
 * dependency-free script. Two consequences drive how these tests drive it:
 *
 * - `Actor.exit()` calls `process.exit()` on the way out (matching a real
 *   deployed Actor's own container process), so importing `main.js`
 *   in-process would kill the whole test run. Every test below runs the
 *   real, unmodified `sample_actor/main.js` as a **subprocess** instead --
 *   still no Docker/apify-cli needed (unlike the full e2e dev-loop test),
 *   just a plain `node sample_actor/main.js` pointed at a scratch local
 *   storage directory via `CRAWLEE_STORAGE_DIR`, exactly how a developer
 *   runs an Actor locally with the `apify` CLI. Seeding
 *   `key_value_stores/default/INPUT.json` by hand before the run is the
 *   same convention local Actor development already uses; the SDK's local
 *   storage client auto-detects the bare file.
 * - Reading `OUTPUT`/the dataset back after the subprocess exits is done by
 *   parsing the SDK's on-disk storage files directly
 *   (`key_value_stores/default/OUTPUT.json`,
 *   `datasets/default/<NNNNNNNNN>.json`). The Python original read them
 *   back through the Python SDK's `KeyValueStore`/`Dataset` API instead
 *   (with an explicit non-purging `Configuration`); doing the same with the
 *   JS SDK in-process would drag its global configuration/storage
 *   singletons into the test process, so direct file reads are the
 *   deliberate, simpler adaptation here -- the layout (`OUTPUT.json`, one
 *   zero-padded JSON file per dataset item) is the JS SDK's stable local
 *   format, the same one the runtime's own storage code serves.
 *
 * Also locks in the no-op-defaults contract that keeps the existing
 * Docker-dependent e2e assertions valid unmodified: with no `repeatCount`/
 * `shout`/`tone`/`recipients` given, `processedGreeting` must equal the
 * plain `greeting` and the dataset must hold exactly its original one item
 * (so the e2e suite's `output["greeting"] == "howdy"` and dataset
 * `[{"message": "howdy world", "index": 1}]` assertions, which read the
 * *raw* `greeting` key/variable and the dataset's first item only, keep
 * meaning what they've always meant).
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN_JS = path.join(REPO, 'sample_actor', 'main.js');

// SDK startup takes a few seconds per subprocess run; be generous.
const TEST_TIMEOUT = 60_000;

const tmpPaths = [];

afterEach(async () => {
    await Promise.all(tmpPaths.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Per-test scratch storage directory (the pytest `tmp_path` equivalent). */
async function makeTmpPath() {
    const dir = await mkdtemp(path.join(tmpdir(), 'sample-actor-test-'));
    tmpPaths.push(dir);
    return dir;
}

/**
 * Seed `tmpPath` as a scratch local Apify SDK storage directory, run the
 * real, unmodified `sample_actor/main.js` against it as a subprocess (see
 * module docstring for why not in-process), then read `OUTPUT` back from
 * the storage directory. Call `datasetItems` separately afterward to read
 * the dataset the same run wrote.
 */
async function run(tmpPath, actorInput) {
    const kv = path.join(tmpPath, 'key_value_stores', 'default');
    await mkdir(kv, { recursive: true });
    await writeFile(path.join(kv, 'INPUT.json'), JSON.stringify(actorInput));

    // Strip any ambient Apify/Crawlee env vars (e.g. a stray APIFY_TOKEN)
    // before pointing CRAWLEE_STORAGE_DIR at the scratch directory, so the
    // subprocess's `Actor.isAtHome()` is guaranteed false (local file-system
    // storage, no network) regardless of the environment this test itself
    // runs in.
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith('APIFY_') && !k.startsWith('CRAWLEE_')),
    );
    env.CRAWLEE_STORAGE_DIR = tmpPath;

    try {
        await execFileAsync(process.execPath, [MAIN_JS], { cwd: REPO, env, timeout: 55_000 });
    } catch (err) {
        expect.fail(
            `sample_actor/main.js exited ${err.code}\nstdout:\n${err.stdout}\nstderr:\n${err.stderr}`,
        );
    }

    return JSON.parse(await readFile(path.join(kv, 'OUTPUT.json'), 'utf8'));
}

/**
 * Read back every dataset item the run started by `run` wrote, in write
 * order (index 1, 2, 3, ...) -- lets a test assert on the dataset's full
 * shape, not just OUTPUT. The SDK's local dataset stores one zero-padded
 * `<NNNNNNNNN>.json` file per item, so lexicographic filename order is
 * write order.
 */
async function datasetItems(tmpPath) {
    const dir = path.join(tmpPath, 'datasets', 'default');
    let names;
    try {
        names = await readdir(dir);
    } catch {
        return []; // no dataset directory -> no items written
    }
    names = names.filter((name) => name.endsWith('.json') && !name.includes('__metadata__')).sort();
    return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(dir, name), 'utf8'))));
}

it(
    'default repeatCount and shout leave processedGreeting unchanged',
    async () => {
        // No repeatCount/shout/tone/recipients in the input at all (schema
        // defaults/no-ops: repeatCount 1, shout false, tone "friendly",
        // recipients absent) -- processedGreeting must equal the raw greeting
        // and the dataset must hold exactly its original one item, matching
        // the sample's existing default/prefill behavior and keeping the
        // Docker-dependent e2e test's `output["greeting"] == "howdy"` and
        // `items == [{"message": "howdy world", "index": 1}]` assertions
        // meaningful without needing to touch that file.
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'howdy' });
        expect(output.greeting).toBe('howdy');
        expect(output.processedGreeting).toBe('howdy');
        expect(output.receivedInput).toEqual({ greeting: 'howdy' });
        expect(output.recipientGreetings).toEqual([]);
        expect(await datasetItems(tmpPath)).toEqual([{ message: 'howdy world', index: 1 }]);
    },
    TEST_TIMEOUT,
);

it(
    'shout uppercases the processed greeting',
    async () => {
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', shout: true });
        expect(output.processedGreeting).toBe('HI');
        expect(output.greeting).toBe('hi'); // the raw key is untouched by shout
    },
    TEST_TIMEOUT,
);

it(
    'repeatCount repeats the processed greeting',
    async () => {
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', repeatCount: 3 });
        expect(output.processedGreeting).toBe('hi hi hi');
    },
    TEST_TIMEOUT,
);

it(
    'repeatCount and shout combine',
    async () => {
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', repeatCount: 2, shout: true });
        expect(output.processedGreeting).toBe('HI HI');
    },
    TEST_TIMEOUT,
);

it(
    'repeatCount zero yields empty processed greeting',
    async () => {
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', repeatCount: 0 });
        expect(output.processedGreeting).toBe('');
    },
    TEST_TIMEOUT,
);

// Input is never validated against the schema -- a malformed repeatCount
// must not crash the Actor; it falls back to the schema's default of 1.
it.each([['not-a-number'], [null], [[1, 2]]])(
    'non-numeric repeatCount %j fails soft to the default',
    async (badRepeatCount) => {
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', repeatCount: badRepeatCount });
        expect(output.processedGreeting).toBe('hi');
    },
    TEST_TIMEOUT,
);

it(
    'non-string greeting does not crash shout processing',
    async () => {
        // `greeting` is read from permissive, unvalidated JSON input -- a
        // schema declaring `greeting` as a string doesn't stop a client from
        // sending a number/object/etc. `shout`'s `.toUpperCase()` must not
        // crash on a non-string greeting; the raw `greeting`
        // key/receivedInput stay exactly as received either way.
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 42, shout: true, repeatCount: 2 });
        expect(output.greeting).toBe(42);
        expect(output.processedGreeting).toBe('42 42');
        expect(output.receivedInput).toEqual({ greeting: 42, shout: true, repeatCount: 2 });
    },
    TEST_TIMEOUT,
);

// -- tone --------------------------------------------------------------------

it(
    'tone explicit friendly is still a no-op',
    async () => {
        // `tone: "friendly"` given explicitly (not just omitted) must behave
        // identically to leaving it out -- "friendly" is the schema's own
        // default and TONE_TEMPLATES' no-op entry.
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', tone: 'friendly' });
        expect(output.processedGreeting).toBe('hi');
    },
    TEST_TIMEOUT,
);

it(
    'tone formal wraps the greeting in the formal template',
    async () => {
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', tone: 'formal' });
        expect(output.processedGreeting).toBe('Dear recipient, hi. Regards.');
        expect(output.greeting).toBe('hi'); // raw key untouched, as with shout
    },
    TEST_TIMEOUT,
);

it(
    'tone playful wraps the greeting in the playful template',
    async () => {
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', tone: 'playful' });
        expect(output.processedGreeting).toBe('hi!! :)');
    },
    TEST_TIMEOUT,
);

it(
    'tone applies before repeatCount join',
    async () => {
        // Each repeated copy is individually styled (the tone template wraps
        // the whole repeated unit), not applied once to the final joined
        // string.
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', tone: 'playful', repeatCount: 2 });
        expect(output.processedGreeting).toBe('hi!! :) hi!! :)');
    },
    TEST_TIMEOUT,
);

it(
    'tone and shout combine',
    async () => {
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', tone: 'formal', shout: true });
        expect(output.processedGreeting).toBe('Dear recipient, HI. Regards.');
    },
    TEST_TIMEOUT,
);

// Input is never validated against the schema -- a `tone` value outside the
// schema's declared enum, or not even a string, must not crash the Actor;
// it falls back to the same no-op "friendly" template the schema's own
// default uses.
it.each([['sarcastic'], [42], [null], [['formal']]])(
    'unrecognized or non-string tone %j fails soft to friendly',
    async (badTone) => {
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', tone: badTone });
        expect(output.processedGreeting).toBe('hi');
    },
    TEST_TIMEOUT,
);

// -- recipients ---------------------------------------------------------------

it(
    'recipients produce a styled greeting per recipient in output',
    async () => {
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', recipients: ['Ada', 'Grace'] });
        expect(output.recipientGreetings).toEqual(['hi, Ada!', 'hi, Grace!']);
        // The plain processedGreeting/greeting keys are unaffected by
        // recipients.
        expect(output.processedGreeting).toBe('hi');
        expect(output.greeting).toBe('hi');
    },
    TEST_TIMEOUT,
);

it(
    'recipients use the same styled greeting as tone and shout',
    async () => {
        // Recipient greetings are built from the same tone/shout-styled text
        // as `processedGreeting`, not from the raw `greeting` -- the two
        // showcase properties compose rather than acting in isolation.
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, {
            greeting: 'hi',
            tone: 'playful',
            shout: true,
            recipients: ['Bob'],
        });
        expect(output.processedGreeting).toBe('HI!! :)');
        expect(output.recipientGreetings).toEqual(['HI!! :), Bob!']);
    },
    TEST_TIMEOUT,
);

it(
    'recipients produce additional dataset items after item one',
    async () => {
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', recipients: ['Ada', 'Grace'] });
        const items = await datasetItems(tmpPath);
        expect(items).toEqual([
            { message: 'hi world', index: 1 },
            { message: 'hi, Ada!', recipient: 'Ada', index: 2 },
            { message: 'hi, Grace!', recipient: 'Grace', index: 3 },
        ]);
        expect(output.recipientGreetings).toEqual(['hi, Ada!', 'hi, Grace!']);
    },
    TEST_TIMEOUT,
);

it(
    'empty recipients list yields no extra dataset items',
    async () => {
        // An explicit empty list must behave the same as omitting the key
        // entirely -- both are "no recipients", not an error.
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', recipients: [] });
        expect(output.recipientGreetings).toEqual([]);
        expect(await datasetItems(tmpPath)).toEqual([{ message: 'hi world', index: 1 }]);
    },
    TEST_TIMEOUT,
);

// Input is never validated against the schema -- a `recipients` value that
// isn't a JSON array (a bare string, a number, an object, null) must not
// crash the Actor; it falls back to treating it as no recipients at all
// rather than e.g. iterating over a string's characters.
it.each([['Ada'], [42], [{ name: 'Ada' }], [null]])(
    'non-list recipients %j fails soft to no recipients',
    async (badRecipients) => {
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', recipients: badRecipients });
        expect(output.recipientGreetings).toEqual([]);
        expect(await datasetItems(tmpPath)).toEqual([{ message: 'hi world', index: 1 }]);
    },
    TEST_TIMEOUT,
);

it(
    'non-string recipient entries are coerced not crashed',
    async () => {
        // A recipients array containing a non-string entry (permissive,
        // unvalidated input) must not crash `main.js`'s per-recipient
        // formatting; the entry is coerced to text exactly like a non-string
        // `greeting` is. (The Python original expected "hi, None!" for a
        // null entry -- Python's `str(None)`; the JS port's language-native
        // coercion `String(null)` yields "null" instead, so the expected
        // text is adapted accordingly. The intent -- coerce, don't crash --
        // is unchanged.)
        const tmpPath = await makeTmpPath();
        const output = await run(tmpPath, { greeting: 'hi', recipients: [42, null] });
        expect(output.recipientGreetings).toEqual(['hi, 42!', 'hi, null!']);
    },
    TEST_TIMEOUT,
);
