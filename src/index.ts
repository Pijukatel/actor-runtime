import { bootstrapStorage } from './storage/bootstrap.js';
import { openRegistries } from './storage/registries.js';
import { reconcileOrphanedJobs } from './services/runs.js';
import { createDriver } from './driver/index.js';
import { createApiServer } from './api/server.js';
import { attachEventsWebSocket } from './api/events-ws.js';
import { closeStandbyUpgrades, handleStandbyUpgrade } from './api/standby-proxy.js';
import { createConsoleServer } from './console/server.js';
import { attachBrowserViewWebSocket } from './console/browser-view-ws.js';
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
	// Upgrades on the same API server/port - no second port (`system.md`); see
	// `api/events-ws.ts`'s own doc comment for why this attaches here rather than inside `createApiServer`
	// (Express never sees an `upgrade` event, so this needs the actual `http.Server` `listen()` returned).
	const eventsWebSocketServer = attachEventsWebSocket(apiServer, (req, socket, head) =>
		handleStandbyUpgrade(driver, req, socket, head),
	);
	const browserViewWebSocketServer = attachBrowserViewWebSocket(consoleServer);

	console.log(`actor-runtime API listening on port ${API_PORT}`);

	console.log(`actor-runtime console listening on port ${CONSOLE_PORT}`);
	// An agent that started this runtime reads this output and has no other reason to go looking.
	console.log(
		`actor-runtime Agent Skill (how to drive this runtime): ` +
			`'apify runtime skill --install', or GET http://localhost:${API_PORT}/actor-runtime/skill`,
	);
	if (!driver.available) {
		console.warn(`Docker is not available: ${driver.unavailableReason}. Builds and runs will fail fast.`);
	}

	const shutdown = async () => {
		closeStandbyUpgrades();
		await gracefulShutdown({ apiServer, consoleServer, eventsWebSocketServer, browserViewWebSocketServer });
		process.exit(0);
	};

	process.on('SIGTERM', () => void shutdown());
	process.on('SIGINT', () => void shutdown());
}

main().catch((error) => {
	console.error('Fatal error during startup:', error);
	process.exit(1);
});
