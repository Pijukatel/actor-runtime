import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { closeServer } from '../../src/shutdown.js';

/**
 * Regression coverage for the graceful-shutdown deadlock: `server.close()` alone never resolves while
 * any response (like a `?stream=true` log) is still held open. `closeServer` must resolve promptly
 * regardless.
 */
describe('closeServer', () => {
	it('resolves even while a response is held open (never end()-ed)', async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(200);
			res.write('chunk'); // deliberately never res.end() - mirrors a live `?stream=true` log response
		});
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const { port } = server.address() as AddressInfo;

		const clientReq = http.get(`http://127.0.0.1:${port}`);
		await new Promise<void>((resolve) => clientReq.on('response', () => resolve()));

		// Regression: a bare `new Promise((resolve) => server.close(() => resolve()))` would hang here
		// forever, since the held-open response keeps the underlying socket alive.
		const closed = closeServer(server);
		const timedOut = Symbol('timeout');
		const result = await Promise.race([
			closed.then(() => 'closed' as const),
			new Promise((resolve) => setTimeout(() => resolve(timedOut), 2000)),
		]);

		expect(result).toBe('closed');
		clientReq.destroy();
	});

	it('resolves immediately for a server with no open connections at all', async () => {
		const server = http.createServer((_req, res) => res.end('ok'));
		await new Promise<void>((resolve) => server.listen(0, resolve));

		await expect(closeServer(server)).resolves.toBeUndefined();
	});
});
