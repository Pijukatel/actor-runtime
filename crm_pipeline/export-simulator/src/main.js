/**
 * export-simulator - produces the eight nightly regional CRM exports, plus the ground truth
 * a correct pipeline has to reproduce.
 *
 * Writes to the named key-value store "crm-exports":
 *   region-<n>.csv       the raw export, defects and all
 *   expected-report.json { totalRows, imported, quarantinedByReason, duplicatesMerged, uniqueContacts }
 */

import { Actor, log } from 'apify';

import { dedupeContacts, normalizeRow, parseCsvText, tallyReasons } from './crm.js';
import { generateExports, ROWS_PER_REGION } from './generate.js';

const EXPORT_STORE = 'crm-exports';
const DEFAULT_SEED = 20240301;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const seed = Number.isFinite(input.seed) ? Math.trunc(input.seed) : DEFAULT_SEED;

log.info(`Generating regional CRM exports from seed ${seed}.`);
const { files, stats } = generateExports(seed);

const store = await Actor.openKeyValueStore(EXPORT_STORE);

for (const stat of stats) {
	const csv = files.get(stat.region);
	await store.setValue(`region-${stat.region}.csv`, csv, { contentType: 'text/csv; charset=utf-8' });
	const injected = stat.injected;
	log.info(
		`region-${stat.region}.csv: ${stat.rows} rows, ${(csv.length / 1024).toFixed(0)} KiB, ` +
			`malformed target ${(stat.malformedRate * 100).toFixed(1)}% -> injected ${injected.malformed} ` +
			`(${((injected.malformed / stat.rows) * 100).toFixed(2)}%), ${injected.duplicates} cross-region duplicates, ` +
			`bad values: ${injected.missing_id} id / ${injected.invalid_email} email / ` +
			`${injected.invalid_phone} phone / ${injected.invalid_date} date`,
	);
}

// Ground truth: one single-process reference pass over exactly the bytes just published, using the
// same normalization rules (crm.js) the importers and the reporter run. Anything the distributed
// pipeline gets wrong - a lost region, a double import, a botched dedup - shows up as a diff.
const contacts = [];
const reasons = [];
let totalRows = 0;

for (const [, csv] of files) {
	const { rows } = parseCsvText(csv);
	totalRows += rows.length;
	for (const row of rows) {
		const result = normalizeRow(row.fields);
		if (result.ok) contacts.push(result.contact);
		else reasons.push(result.reason);
	}
}

const { unique, duplicatesMerged } = dedupeContacts(contacts);
const expected = {
	totalRows,
	imported: contacts.length,
	quarantinedByReason: tallyReasons(reasons),
	duplicatesMerged,
	uniqueContacts: unique.length,
};

await store.setValue('expected-report.json', expected);
log.info(`Ground truth saved to ${EXPORT_STORE}/expected-report.json: ${JSON.stringify(expected)}`);

await Actor.setValue('OUTPUT', { seed, regions: stats.length, rowsPerRegion: ROWS_PER_REGION, expected });
await Actor.exit(`Published ${stats.length} regional exports (${totalRows} rows) and the expected report.`);
