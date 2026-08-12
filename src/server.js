/**
 * Entrypoint: serve the same app on two ports (API + console) and print URLs.
 *
 * The app's boot sequence (DB + storage + driver setup) runs exactly once;
 * both HTTP servers then serve the already-initialised request handler.
 */
import http from 'node:http';

import { createApp } from './app.js';
import { loadSettings } from './config.js';

async function serve() {
    const settings = loadSettings();
    const app = await createApp({ settings });

    console.log('='.repeat(60));
    console.log('  actor-runtime is starting');
    console.log(`  API URL:     http://localhost:${settings.portApi}`);
    console.log(`  Console URL: http://localhost:${settings.portConsole}`);
    console.log('='.repeat(60));

    const apiServer = http.createServer(app.handler);
    const consoleServer = http.createServer(app.handler);
    apiServer.listen(settings.portApi, '0.0.0.0');
    consoleServer.listen(settings.portConsole, '0.0.0.0');

    const shutdown = async () => {
        apiServer.close();
        consoleServer.close();
        await app.close();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

serve().catch((err) => {
    console.error('actor-runtime failed to start:', err);
    process.exit(1);
});
