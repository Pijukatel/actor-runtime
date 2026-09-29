/**
 * TypeScript Actor Standby sample for actor-runtime: an HTTP server that the platform (or the runtime)
 * starts on demand and sends requests to. Mirrored endpoint for endpoint by `samples/actor_standby_py`.
 *
 *   GET  /                 what this server offers, and which run is answering
 *   GET  /hello?name=Ada   a greeting; pushes one item to the run's default dataset
 *   POST /echo             the request's JSON (or text) body, echoed back
 *   GET  /stats            requests served by this run, and by every run so far (a named key-value store)
 *   GET  /stream?count=5   a Server-Sent Events stream, one event every half second
 *   WS   /ws               a websocket that echoes every message
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { Actor, log } from 'apify';
import { WebSocketServer } from 'ws';

/** Sent by the platform (and the runtime) until the server answers; any response means "ready". */
const READINESS_PROBE_HEADER = 'x-apify-container-server-readiness-probe';
const STATS_STORE = 'standby-sample-ts-stats';
const STATS_KEY = 'STATS';

interface Stats {
	served: number;
	runs: number;
}

await Actor.init();

if (Actor.config.get('metaOrigin') !== 'STANDBY') {
	// `apify call` lands here: an Actor server has nothing to do without requests.
	log.info(`This Actor is an HTTP server. Send requests to ${Actor.config.get('standbyUrl')}/ instead.`);
	await Actor.exit(); // Ends the process.
}

const runId = Actor.config.get('actorRunId');
const port = Actor.config.get('standbyPort');
const statsStore = await Actor.openKeyValueStore(STATS_STORE);
// The totals of every earlier run; this run's own count is added on top whenever they are saved.
const before = (await statsStore.getValue<Stats>(STATS_KEY)) ?? { served: 0, runs: 0 };
let served = 0;

const allRuns = (): Stats => ({ served: before.served + served, runs: before.runs + 1 });
const saveStats = async () => statsStore.setValue(STATS_KEY, allRuns());

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(`${JSON.stringify(body, null, 2)}\n`);
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

async function streamEvents(res: ServerResponse, count: number): Promise<void> {
	res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
	for (let n = 1; n <= count && !res.destroyed; n++) {
		res.write(`event: tick\ndata: ${JSON.stringify({ n, of: count, at: new Date().toISOString() })}\n\n`);
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	res.end('event: done\ndata: {}\n\n');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? '/', 'http://localhost');
	const route = `${req.method} ${url.pathname}`;

	if (route === 'GET /') {
		sendJson(res, 200, {
			actor: 'TypeScript Standby sample',
			runId,
			standbyUrl: Actor.config.get('standbyUrl'),
			endpoints: ['GET /hello?name=', 'POST /echo', 'GET /stats', 'GET /stream?count=', 'WS /ws'],
		});
		return;
	}

	served += 1;
	log.info(`${route} (request #${served} of this run)`);

	if (route === 'GET /hello') {
		const name = url.searchParams.get('name') ?? 'world';
		await Actor.pushData({ name, servedAt: new Date().toISOString() });
		sendJson(res, 200, { greeting: `Hello, ${name}!`, runId, served });
	} else if (route === 'POST /echo') {
		const text = await readBody(req);
		let body: unknown = text;
		if (req.headers['content-type']?.startsWith('application/json')) {
			try {
				body = JSON.parse(text);
			} catch {
				sendJson(res, 400, { error: 'The body is not valid JSON.' });
				return;
			}
		}
		sendJson(res, 200, { runId, query: Object.fromEntries(url.searchParams), body });
	} else if (route === 'GET /stats') {
		sendJson(res, 200, { runId, thisRun: { served }, allRuns: allRuns() });
	} else if (route === 'GET /stream') {
		await streamEvents(res, Math.min(Number(url.searchParams.get('count')) || 5, 50));
	} else {
		sendJson(res, 404, { error: `No endpoint ${route} - see GET / for the list.` });
	}
}

const server = createServer((req, res) => {
	if (req.headers[READINESS_PROBE_HEADER]) {
		res.end('ok\n');
		return;
	}
	handle(req, res).catch((error: Error) => {
		log.exception(error, `${req.method} ${req.url} failed`);
		if (!res.headersSent) sendJson(res, 500, { error: error.message });
		else res.destroy();
	});
});

const sockets = new WebSocketServer({ server, path: '/ws' });
sockets.on('connection', (socket) => {
	served += 1;
	socket.send(JSON.stringify({ hello: 'Send me anything and I will echo it.', runId }));
	socket.on('message', (data) => socket.send(JSON.stringify({ echo: String(data) })));
});

// Saved whenever the platform asks (periodically, and before a migration), so no count is lost.
Actor.on('persistState', saveStats);

// An idle standby run is wound down with an `aborting` event; the SDK exits by itself right after
// its listeners finish, so this only has to stop taking requests and save the totals.
Actor.on('aborting', async () => {
	log.info(`Shutting down after serving ${served} requests.`);
	sockets.close();
	server.close();
	await saveStats();
});

server.listen(port, () => log.info(`Standby server listening on port ${port}`));
