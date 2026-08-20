import { bootstrapStorage } from './storage/bootstrap.js';
import { openRegistries } from './storage/registries.js';
import { reconcileOrphanedJobs } from './services/runs.js';
import { createDriver } from './driver/index.js';
import { createApiServer } from './api/server.js';
import { createConsoleServer } from './console/server.js';
import { startLogFlusher } from './services/logs.js';
import { gracefulShutdown } from './shutdown.js';
import { API_PORT, CONSOLE_PORT, DEFAULT_DATA_DIR } from './config.js';

async function main(): Promise<void> {
	bootstrapStorage(DEFAULT_DATA_DIR);
	await openRegistries();
	// No default user is created here any more - users are created ad-hoc, per previously-unseen token,
	// at the first API request that carries it (`services/users.ts: getOrCreateUserForToken()`,
	// `cli.md`'s User bootstrap).
	startLogFlusher();

	const driver = await createDriver();
	await reconcileOrphanedJobs(driver);

	const apiApp = createApiServer({ driver });
	const consoleApp = createConsoleServer({ driver });

	const apiServer = apiApp.listen(API_PORT);
	const consoleServer = consoleApp.listen(CONSOLE_PORT);

	console.log(`actor-runtime API listening on port ${API_PORT}`);

	console.log(`actor-runtime console listening on port ${CONSOLE_PORT}`);
	if (!driver.available) {
		console.warn(`Docker is not available: ${driver.unavailableReason}. Builds and runs will fail fast.`);
	}

	const shutdown = async () => {
		await gracefulShutdown({ apiServer, consoleServer });
		process.exit(0);
	};

	process.on('SIGTERM', () => void shutdown());
	process.on('SIGINT', () => void shutdown());
}

main().catch((error) => {
	console.error('Fatal error during startup:', error);
	process.exit(1);
});
