/**
 * Actor input-schema resolution: read a pushed version's
 * `.actor/input_schema.json` (or an `.actor/actor.json` `input` field
 * pointing at / inlining one), mirroring `src/standby.js`'s
 * `extractUsesStandbyMode` fail-soft parsing pattern exactly -- the same
 * first-match-wins by-name scan over inline `sourceFiles` (a later entry
 * sharing an earlier one's name never overwrites it, in either module), the
 * same TEXT/BASE64 branch, the same "can't read it -> null" contract (never
 * throw, never crash a console page or an API caller).
 */

function readJsonSourceFile(filesByName, name) {
    const entry = filesByName.get(name);
    if (!entry) return null;
    let content = entry.content ?? '';
    if (entry.format === 'BASE64') {
        try {
            content = Buffer.from(content, 'base64').toString('utf8');
        } catch {
            return null;
        }
    }
    try {
        return JSON.parse(content);
    } catch {
        return null;
    }
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve `.actor/actor.json`'s string `input` field against pushed
 * source-file names.
 *
 * Real `.actor/actor.json` files reference the schema both ways in the wild:
 * relative to the project root (e.g. `"input_schema.json"`, landing next to
 * `main.js`) and relative to `.actor/`'s own directory (e.g.
 * `"./input_schema.json"` sitting beside `actor.json` itself) -- so this
 * tries the given path both as given and re-rooted under `.actor/` (in
 * whichever direction is missing), returning the first that resolves to a
 * JSON object.
 */
function resolveRelativeInputPath(filesByName, inputPath) {
    let normalized = (inputPath ?? '').trim();
    while (normalized.startsWith('./')) normalized = normalized.slice(2);
    normalized = normalized.replace(/^\/+/, '');
    if (!normalized) return null;
    const candidates = [normalized];
    if (normalized.startsWith('.actor/')) {
        candidates.push(normalized.slice('.actor/'.length));
    } else {
        candidates.push(`.actor/${normalized}`);
    }
    for (const name of candidates) {
        const schema = readJsonSourceFile(filesByName, name);
        if (isPlainObject(schema)) return schema;
    }
    return null;
}

/**
 * Return a version's input schema from its pushed inline `sourceFiles`, or
 * `null` if there is no signal (no manifest/schema file present, it fails to
 * parse, or it isn't a JSON object) -- fail soft, never throw.
 *
 * Resolution order:
 *   1. `.actor/actor.json`'s `input` field -- an inline object is used
 *      directly; a string is resolved as a relative path against the pushed
 *      source-file names (see `resolveRelativeInputPath`).
 *   2. `.actor/input_schema.json`, the Apify-conventional default path, when
 *      step 1 found no `input` field or it didn't resolve to a schema.
 *
 * The schema is returned exactly as pushed (whatever key order and
 * `sectionCaption`/etc. fields it has) -- this module does no transformation,
 * only lookup/decode/parse.
 */
export function resolveInputSchema(sourceFiles) {
    // First-match-wins by name (a later duplicate-named entry never silently
    // overwrites an earlier one) -- mirrors `extractUsesStandbyMode`'s own
    // linear scan exactly, so two source-file entries that happen to share a
    // name resolve identically in both places.
    const filesByName = new Map();
    for (const entry of sourceFiles ?? []) {
        if (entry?.name && !filesByName.has(entry.name)) {
            filesByName.set(entry.name, entry);
        }
    }

    const manifest = readJsonSourceFile(filesByName, '.actor/actor.json');
    if (isPlainObject(manifest)) {
        const inputField = manifest.input;
        if (isPlainObject(inputField)) return inputField;
        if (typeof inputField === 'string' && inputField.trim()) {
            const schema = resolveRelativeInputPath(filesByName, inputField);
            if (schema !== null) return schema;
        }
    }

    const schema = readJsonSourceFile(filesByName, '.actor/input_schema.json');
    return isPlainObject(schema) ? schema : null;
}
