/**
 * reconciliation-reporter - collapses the imported rows into the master contact list and
 * reports what the pipeline actually did.
 *
 * Reads:  crm-normalized, crm-quarantine   (named datasets)
 * Writes: crm-master                        (named dataset - one row per unique contact)
 *         OUTPUT in its own default key-value store:
 *         { totalRows, imported, quarantinedByReason, duplicatesMerged, uniqueContacts, regionsRetried }
 */

import { Actor, log } from 'apify';

import { dedupeContacts, tallyReasons } from './crm.js';

const NORMALIZED_DATASET = 'crm-normalized';
const QUARANTINE_DATASET = 'crm-quarantine';
const MASTER_DATASET = 'crm-master';
const PAGE_SIZE = 5000;
const PUSH_BATCH = 1000;

/** Reads a whole dataset page by page - the datasets here hold tens of thousands of rows. */
async function readAll(dataset, label) {
	const items = [];
	for (let offset = 0; ; offset += PAGE_SIZE) {
		const page = await dataset.getData({ offset, limit: PAGE_SIZE });
		items.push(...page.items);
		if (items.length >= page.total || page.items.length === 0) {
			log.info(`${label}: read ${items.length} rows.`);
			return items;
		}
	}
}

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const regionsRetried = Array.isArray(input.regionsRetried) ? [...input.regionsRetried].sort((a, b) => a - b) : [];

const normalizedDataset = await Actor.openDataset(NORMALIZED_DATASET);
const quarantineDataset = await Actor.openDataset(QUARANTINE_DATASET);

const imported = await readAll(normalizedDataset, NORMALIZED_DATASET);
const quarantined = await readAll(quarantineDataset, QUARANTINE_DATASET);

const { unique, duplicatesMerged } = dedupeContacts(imported);
log.info(
	`Deduplicated ${imported.length} imported rows into ${unique.length} unique contacts (${duplicatesMerged} merged).`,
);

const masterDataset = await Actor.openDataset(MASTER_DATASET);
for (let offset = 0; offset < unique.length; offset += PUSH_BATCH) {
	const batch = unique.slice(offset, offset + PUSH_BATCH);
	await masterDataset.pushData(batch);
	log.info(`${MASTER_DATASET}: pushed ${Math.min(offset + batch.length, unique.length)}/${unique.length} contacts.`);
}

const report = {
	totalRows: imported.length + quarantined.length,
	imported: imported.length,
	quarantinedByReason: tallyReasons(quarantined.map((row) => row.reason)),
	duplicatesMerged,
	uniqueContacts: unique.length,
	regionsRetried,
};

await Actor.setValue('OUTPUT', report);
log.info(`Reconciliation report: ${JSON.stringify(report)}`);

await Actor.exit(`Wrote ${unique.length} unique contacts to ${MASTER_DATASET}.`);
