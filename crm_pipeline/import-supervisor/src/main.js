/**
 * import-supervisor - orchestrates the nightly CRM import.
 *
 *   1. runs export-simulator and waits for it,
 *   2. runs region-importer for regions 1-8, at most 4 at a time, polling run statuses,
 *   3. relaunches any FAILED region with force=true (up to 3 attempts per region),
 *   4. once all 8 regions have SUCCEEDED, runs reconciliation-reporter and waits for it,
 *   5. compares its OUTPUT field by field against the simulator's expected-report.json and
 *      ends the log with "RECONCILIATION PASS" or the exact diff.
 *
 * Coordination is only through named storages and the Actor runs API - no request queues.
 */

import { Actor, log } from 'apify';

const SIMULATOR = 'export-simulator';
const IMPORTER = 'region-importer';
const REPORTER = 'reconciliation-reporter';

const EXPORT_STORE = 'crm-exports';
const PIPELINE_DATASETS = ['crm-normalized', 'crm-quarantine', 'crm-master'];

const REGIONS = [1, 2, 3, 4, 5, 6, 7, 8];
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 2000;
const RUN_TIMEOUT_SECS = 1800;

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
const COMPARED_FIELDS = ['totalRows', 'imported', 'quarantinedByReason', 'duplicatesMerged', 'uniqueContacts'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const seed = Number.isFinite(input.seed) ? Math.trunc(input.seed) : 20240301;
const concurrency = Number.isFinite(input.maxConcurrency) ? Math.trunc(input.maxConcurrency) : DEFAULT_CONCURRENCY;
const maxAttempts = Number.isFinite(input.maxAttempts) ? Math.trunc(input.maxAttempts) : DEFAULT_MAX_ATTEMPTS;

const client = Actor.newClient();

/** Starts an Actor run and polls the runs API until it reaches a terminal status. */
async function runAndWait(actorName, runInput, { memory, label }) {
	const started = await client.actor(actorName).start(runInput, { memory, timeout: RUN_TIMEOUT_SECS });
	log.info(`${label}: started run ${started.id} of ${actorName} with input ${JSON.stringify(runInput)}.`);

	let lastStatus = started.status;
	for (;;) {
		const run = await client.run(started.id).get();
		if (run.status !== lastStatus) {
			log.info(`${label}: run ${started.id} is ${run.status}.`);
			lastStatus = run.status;
		}
		if (TERMINAL_STATUSES.has(run.status)) return run;
		await sleep(POLL_INTERVAL_MS);
	}
}

/** Pulls the failed run's own log back so the reason shows up in the supervisor's log too. */
async function circuitBreakerReason(runId) {
	try {
		const text = await client.log(runId).get();
		const line = String(text ?? '')
			.split('\n')
			.reverse()
			.find((entry) => entry.includes('CIRCUIT BREAKER'));
		// eslint-disable-next-line no-control-regex -- the captured log carries the importer's own colour codes
		return line ? line.replace(/\u001b\[[0-9;]*m/g, '').trim() : null;
	} catch (error) {
		log.warning(`Could not read the log of run ${runId}: ${error.message}`);
		return null;
	}
}

// --- step 0: start from a clean slate ---------------------------------------------------------
// The pipeline's datasets are named and therefore long-lived; a nightly run measures itself, so
// yesterday's rows are dropped before today's importers append anything.
for (const name of PIPELINE_DATASETS) {
	const existing = await client.datasets().getOrCreate(name);
	await client.dataset(existing.id).delete();
	log.info(`Reset named dataset "${name}" (dropped ${existing.id}).`);
}

// --- step 1: generate the exports -------------------------------------------------------------
const simulatorRun = await runAndWait(SIMULATOR, { seed }, { memory: 2048, label: 'simulator' });
if (simulatorRun.status !== 'SUCCEEDED') {
	await Actor.fail(`${SIMULATOR} run ${simulatorRun.id} ended ${simulatorRun.status}; aborting the import.`);
}
log.info(`${SIMULATOR} finished: the eight regional exports are in "${EXPORT_STORE}".`);

// --- step 2 + 3: import all regions, at most `concurrency` at a time --------------------------
const queue = [...REGIONS];
const regionsRetried = new Set();
const regionRuns = new Map();

async function importRegion(region) {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const force = attempt > 1;
		const label = `region ${region} attempt ${attempt}/${maxAttempts}`;
		const run = await runAndWait(IMPORTER, { region, force }, { memory: 2048, label });

		if (run.status === 'SUCCEEDED') {
			regionRuns.set(region, { runId: run.id, attempts: attempt, forced: force });
			log.info(`${label}: SUCCEEDED (force=${force}).`);
			return;
		}

		const reason = await circuitBreakerReason(run.id);
		// One stream, one order: the whole failure narrative goes out at warning level, so a
		// reader of this log always sees "failed -> why -> relaunched" in that order.
		log.warning(
			`${label}: run ${run.id} ended ${run.status}.${reason ? ` The importer reported -> ${reason}` : ''}`,
		);

		if (attempt < maxAttempts) {
			regionsRetried.add(region);
			log.warning(`Relaunching region ${region} with force=true (attempt ${attempt + 1} of ${maxAttempts}).`);
			continue;
		}
		throw new Error(
			`Region ${region} did not succeed within ${maxAttempts} attempts (last run ${run.id}: ${run.status}).`,
		);
	}
}

async function worker(slot) {
	for (;;) {
		const region = queue.shift();
		if (region === undefined) return;
		log.info(`Worker ${slot} picked up region ${region} (${queue.length} region(s) still queued).`);
		await importRegion(region);
	}
}

log.info(`Importing regions ${REGIONS.join(', ')} with max ${concurrency} concurrent runs.`);
try {
	await Promise.all(Array.from({ length: concurrency }, (_, slot) => worker(slot + 1)));
} catch (error) {
	await Actor.fail(`Import failed: ${error.message}`);
}

const retried = [...regionsRetried].sort((a, b) => a - b);
log.info(
	`All ${REGIONS.length} regions SUCCEEDED. Regions that needed a forced retry: ${retried.length ? retried.join(', ') : 'none'}.`,
);

// --- step 4: reconcile -------------------------------------------------------------------------
const reporterRun = await runAndWait(REPORTER, { regionsRetried: retried }, { memory: 4096, label: 'reporter' });
if (reporterRun.status !== 'SUCCEEDED') {
	await Actor.fail(`${REPORTER} run ${reporterRun.id} ended ${reporterRun.status}; cannot reconcile.`);
}

const reportRecord = await client.keyValueStore(reporterRun.defaultKeyValueStoreId).getRecord('OUTPUT');
const actual = reportRecord?.value;
if (!actual) {
	await Actor.fail(`${REPORTER} run ${reporterRun.id} produced no OUTPUT record.`);
}

const exportStore = await client.keyValueStores().getOrCreate(EXPORT_STORE);
const expectedRecord = await client.keyValueStore(exportStore.id).getRecord('expected-report.json');
const expected = expectedRecord?.value;
if (!expected) {
	await Actor.fail(`${EXPORT_STORE}/expected-report.json is missing; nothing to reconcile against.`);
}

log.info(`Expected (ground truth): ${JSON.stringify(expected)}`);
log.info(`Actual (reconciliation-reporter OUTPUT): ${JSON.stringify(actual)}`);

// --- step 5: field-by-field comparison ---------------------------------------------------------
const differences = [];
for (const field of COMPARED_FIELDS) {
	const expectedValue = expected[field];
	const actualValue = actual[field];
	if (JSON.stringify(expectedValue) !== JSON.stringify(actualValue)) {
		differences.push(`${field}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`);
	}
}
// Not part of the ground truth (the simulator cannot know it) - checked against what the
// supervisor itself observed while driving the imports.
if (JSON.stringify(actual.regionsRetried ?? []) !== JSON.stringify(retried)) {
	differences.push(
		`regionsRetried: supervisor recorded ${JSON.stringify(retried)}, report says ${JSON.stringify(actual.regionsRetried ?? [])}`,
	);
}

await Actor.setValue('OUTPUT', {
	seed,
	expected,
	actual,
	regionsRetried: retried,
	regionRuns: Object.fromEntries([...regionRuns].map(([region, info]) => [region, info])),
	reconciliation: differences.length === 0 ? 'PASS' : 'FAIL',
	differences,
});

if (differences.length > 0) {
	log.error(`RECONCILIATION FAIL - ${differences.length} field(s) differ:`);
	for (const difference of differences) log.error(`  ${difference}`);
	await Actor.fail({ statusMessage: `Reconciliation failed on ${differences.length} field(s).`, exitCode: 1 });
}

log.info('RECONCILIATION PASS');
await Actor.exit({ statusMessage: 'RECONCILIATION PASS' });
