/**
 * Standby fixture Actor for the on-demand-calls-standby e2e test.
 *
 * In standby mode, listens on `ACTOR_STANDBY_PORT`, answers the readiness
 * probe, and echoes each request (method, path+query, body) plus a
 * per-process counter, so a caller can prove both exact forwarding and
 * warm-container reuse. In standard mode it exits immediately. Uses
 * `node:http` because this fixture IS the server under test, not an HTTP
 * client.
 */
import http from 'node:http';

import { Actor } from 'apify';

let requestCount = 0;

/**
 * Best-effort: push one dataset item per served call via the SDK. A failure
 * (timeout, storage error) is logged, never fatal -- serving requests must
 * not depend on this write.
 */
async function saveServedCall(record) {
    try {
        await Actor.pushData(record);
    } catch (err) {
        console.log(`Failed to save served call to dataset: ${err?.message ?? err}`);
    }
}

await Actor.main(async () => {
    // Standby-capable Actors can still be started in standard mode (a plain
    // `apify call` / POST .../runs). Per the platform docs, the two modes
    // are distinguished by APIFY_META_ORIGIN == "STANDBY"; a standard start
    // has nothing to serve, so exit successfully instead of crashing on the
    // standby-only ACTOR_STANDBY_PORT variable.
    if (process.env.APIFY_META_ORIGIN !== 'STANDBY') {
        console.log('Started in standard (non-standby) mode; nothing to serve, exiting.');
        return;
    }

    const port = Number(process.env.ACTOR_STANDBY_PORT);
    const server = http.createServer(async (req, res) => {
        // One log line per handled request (probes included), so the run's
        // captured log shows the standby traffic.
        console.log(`Handling request: ${req.method} ${req.url}`);
        if (req.headers['x-apify-container-server-readiness-probe']) {
            res.statusCode = 200;
            res.end('ready');
            return;
        }
        requestCount += 1;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        await saveServedCall({ method: req.method, path: req.url, requestCount });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
            JSON.stringify({
                method: req.method,
                path: req.url,
                body,
                requestCount,
                reply: `Standby Actor served request #${requestCount}`,
            }),
        );
    });

    await new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, '0.0.0.0', () => {
            console.log(`Standby fixture Actor listening on port ${port}`);
        });
        // Never resolves in normal operation -- the standby container is
        // stopped by the runtime's idle-timeout/abort teardown.
    });
});
