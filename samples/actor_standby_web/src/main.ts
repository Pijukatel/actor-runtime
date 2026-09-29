/**
 * Standby web sample for actor-runtime. One Actor, two roles:
 *
 * - A standby run serves a web page whose script calls this server with a root-relative URL, as most web
 *   UIs do; that only works where the Actor owns `/` of its standby URL, as on `*.apify.actor`.
 *
 *     GET /                  the page
 *     GET /api/greeting?name=Ada   JSON: a greeting, the answering run, and the Host the request came to
 *
 * - An ordinary run (`apify call`) is a client of a standby Actor, this one unless `standbyActor` names
 *   another: it reads that Actor's `standbyUrl` through the API, calls `/api/greeting`, and pushes the
 *   answer to its default dataset.
 */
import { createServer, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { Actor, log } from 'apify';

/** Sent by the platform (and the runtime) until the server answers; any response means "ready". */
const READINESS_PROBE_HEADER = 'x-apify-container-server-readiness-probe';

interface Input {
	standbyActor?: string;
	name?: string;
}

const PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Standby web sample</title></head>
<body>
<h1>Standby web sample</h1>
<p id="greeting">Loading...</p>
<script>
	// Root-relative on purpose; the token the page was opened with is passed on.
	const token = new URLSearchParams(location.search).get('token');
	fetch('/api/greeting?name=browser', { headers: token ? { authorization: 'Bearer ' + token } : {} })
		.then((res) => res.json())
		.then((body) => (document.getElementById('greeting').textContent = body.greeting + ' (run ' + body.runId + ')'))
		.catch((error) => (document.getElementById('greeting').textContent = 'Failed: ' + error));
</script>
</body>
</html>
`;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(`${JSON.stringify(body, null, 2)}\n`);
}

async function serve(): Promise<void> {
	const runId = Actor.config.get('actorRunId');
	const port = Actor.config.get('standbyPort');

	const server = createServer((req, res) => {
		if (req.headers[READINESS_PROBE_HEADER]) {
			res.end('ok\n');
			return;
		}
		const url = new URL(req.url ?? '/', 'http://localhost');
		const route = `${req.method} ${url.pathname}`;
		log.info(`${route} (Host: ${req.headers.host})`);
		if (route === 'GET /') {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			res.end(PAGE);
		} else if (route === 'GET /api/greeting') {
			const name = url.searchParams.get('name') ?? 'world';
			sendJson(res, 200, { greeting: `Hello, ${name}!`, runId, host: req.headers.host });
		} else {
			sendJson(res, 404, { error: `No endpoint ${route}.` });
		}
	});

	// An idle standby run is wound down with an `aborting` event; the SDK exits right after its listeners.
	Actor.on('aborting', () => {
		server.close();
	});
	server.listen(port, () => log.info(`Standby server listening on port ${port}`));
}

async function callStandbyActor(): Promise<void> {
	const input = (await Actor.getInput<Input>()) ?? {};
	const target = input.standbyActor || Actor.config.get('actorId')!;
	// Read from inside a container, the Actor object carries a standbyUrl this container can reach.
	const actor = (await Actor.newClient().actor(target).get()) as { standbyUrl?: string | null } | undefined;
	if (!actor?.standbyUrl) throw new Error(`Actor ${target} does not exist or has Standby off.`);

	const url = `${actor.standbyUrl}/api/greeting?name=${encodeURIComponent(input.name ?? 'Actor')}`;
	log.info(`Calling ${url}`);
	const res = await fetch(url, { headers: { authorization: `Bearer ${Actor.config.get('token')}` } });
	const body = (await res.json()) as Record<string, unknown>;
	log.info(`${res.status}: ${JSON.stringify(body)}`);
	if (!res.ok) throw new Error(`The standby Actor answered ${res.status}.`);
	await Actor.pushData({ standbyUrl: actor.standbyUrl, status: res.status, ...body });
}

await Actor.init();

if (Actor.config.get('metaOrigin') === 'STANDBY') {
	await serve();
} else {
	await callStandbyActor();
	await Actor.exit();
}
