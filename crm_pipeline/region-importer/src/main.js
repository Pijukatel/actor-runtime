/**
 * region-importer - imports one regional CRM export.
 *
 * Input:  { region: 1..8, force?: boolean }
 * Reads:  crm-exports/region-<region>.csv          (named key-value store)
 * Writes: crm-normalized  - normalized valid contacts        (named dataset)
 *         crm-quarantine  - { region, rowNumber, reason, raw } (named dataset)
 *
 * Circuit breaker: the whole file is parsed before anything is written. If more than 5% of the
 * rows are malformed (wrong column count) and `force` is not true, the run logs the rate and
 * exits non-zero having written nothing at all.
 */

import { Actor, log } from 'apify';

import { normalizeRow, parseCsvText } from './crm.js';

const EXPORT_STORE = 'crm-exports';
const NORMALIZED_DATASET = 'crm-normalized';
const QUARANTINE_DATASET = 'crm-quarantine';
const MALFORMED_THRESHOLD = 0.05;
const PUSH_BATCH = 1000;

async function pushInBatches(dataset, items, label) {
	for (let offset = 0; offset < items.length; offset += PUSH_BATCH) {
		const batch = items.slice(offset, offset + PUSH_BATCH);
		await dataset.pushData(batch);
		log.info(`${label}: pushed ${Math.min(offset + batch.length, items.length)}/${items.length} rows.`);
	}
}

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const region = Number.parseInt(input.region, 10);
const force = input.force === true;

if (!Number.isInteger(region)) {
	await Actor.fail(`Invalid input: "region" must be an integer, got ${JSON.stringify(input.region)}.`);
}

const key = `region-${region}.csv`;
log.info(`Importing ${EXPORT_STORE}/${key}${force ? ' (force=true - circuit breaker disarmed)' : ''}.`);

const store = await Actor.openKeyValueStore(EXPORT_STORE);
const csv = await store.getValue(key);
if (csv === null || csv === undefined) {
	await Actor.fail(`Export ${EXPORT_STORE}/${key} not found - has export-simulator run?`);
}

const { rows } = parseCsvText(typeof csv === 'string' ? csv : csv.toString('utf8'));

// Parse and classify everything up front: the breaker must be able to reject the whole file
// before a single row has been written anywhere.
const valid = [];
const quarantined = [];
let malformed = 0;

for (const row of rows) {
	const result = normalizeRow(row.fields);
	if (result.ok) {
		valid.push({ ...result.contact, sourceRegion: region, sourceRow: row.rowNumber });
		continue;
	}
	if (result.reason === 'malformed_row') malformed += 1;
	quarantined.push({ region, rowNumber: row.rowNumber, reason: result.reason, raw: row.raw });
}

const malformedRate = rows.length === 0 ? 0 : malformed / rows.length;
log.info(
	`Parsed ${rows.length} rows: ${valid.length} valid, ${quarantined.length} quarantined ` +
		`(${malformed} malformed = ${(malformedRate * 100).toFixed(2)}%).`,
);

if (malformedRate > MALFORMED_THRESHOLD && !force) {
	log.error(
		`CIRCUIT BREAKER: region ${region} has a malformed row rate of ${(malformedRate * 100).toFixed(2)}%, ` +
			`above the ${(MALFORMED_THRESHOLD * 100).toFixed(2)}% threshold. ` +
			`Nothing was written; re-run with force=true to import anyway.`,
	);
	await Actor.fail(
		`Circuit breaker tripped for region ${region}: malformed rate ${(malformedRate * 100).toFixed(2)}%.`,
	);
	// Belt and braces: Actor.fail() ends the process, but nothing below this line may ever run
	// for a tripped breaker - the guarantee is that a rejected region writes no rows at all.
	process.exit(1);
}

const normalizedDataset = await Actor.openDataset(NORMALIZED_DATASET);
const quarantineDataset = await Actor.openDataset(QUARANTINE_DATASET);

await pushInBatches(normalizedDataset, valid, `${NORMALIZED_DATASET} (region ${region})`);
await pushInBatches(quarantineDataset, quarantined, `${QUARANTINE_DATASET} (region ${region})`);

const summary = {
	region,
	force,
	totalRows: rows.length,
	imported: valid.length,
	quarantined: quarantined.length,
	malformed,
	malformedRate: Number(malformedRate.toFixed(6)),
};
await Actor.setValue('OUTPUT', summary);

await Actor.exit(
	`Region ${region}: imported ${valid.length} rows, quarantined ${quarantined.length} ` +
		`(malformed ${(malformedRate * 100).toFixed(2)}%).`,
);
