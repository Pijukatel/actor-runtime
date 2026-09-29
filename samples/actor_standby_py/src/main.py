"""Python Actor Standby sample for actor-runtime.

An HTTP server that the platform (or the runtime) starts on demand and sends requests to. Mirrors
`samples/actor_standby_ts` endpoint for endpoint:

    GET  /                 what this server offers, and which run is answering
    GET  /hello?name=Ada   a greeting; pushes one item to the run's default dataset
    POST /echo             the request's JSON (or text) body, echoed back
    GET  /stats            requests served by this run, and by every run so far (a named key-value store)
    GET  /stream?count=5   a Server-Sent Events stream, one event every half second
    WS   /ws               a websocket that echoes every message
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any

from aiohttp import WSMsgType, web
from apify import Actor, Event

# Sent by the platform (and the runtime) until the server answers; any response means "ready".
READINESS_PROBE_HEADER = 'x-apify-container-server-readiness-probe'
STATS_STORE = 'standby-sample-py-stats'
STATS_KEY = 'STATS'


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class StandbyServer:
    def __init__(self, run_id: str | None, standby_url: str, before: dict[str, int]) -> None:
        self.run_id = run_id
        self.standby_url = standby_url
        # The totals of every earlier run; this run's own count is added on top whenever they are saved.
        self.before = before
        self.served = 0

    def all_runs(self) -> dict[str, int]:
        return {'served': self.before['served'] + self.served, 'runs': self.before['runs'] + 1}

    @web.middleware
    async def count_requests(self, request: web.Request, handler: Any) -> web.StreamResponse:
        if request.headers.get(READINESS_PROBE_HEADER):
            return web.Response(text='ok\n')
        if request.path != '/':
            self.served += 1
            Actor.log.info(f'{request.method} {request.path} (request #{self.served} of this run)')
        return await handler(request)

    async def index(self, _request: web.Request) -> web.Response:
        return web.json_response(
            {
                'actor': 'Python Standby sample',
                'runId': self.run_id,
                'standbyUrl': self.standby_url,
                'endpoints': ['GET /hello?name=', 'POST /echo', 'GET /stats', 'GET /stream?count=', 'WS /ws'],
            }
        )

    async def hello(self, request: web.Request) -> web.Response:
        name = request.query.get('name', 'world')
        await Actor.push_data({'name': name, 'servedAt': now()})
        return web.json_response({'greeting': f'Hello, {name}!', 'runId': self.run_id, 'served': self.served})

    async def echo(self, request: web.Request) -> web.Response:
        body: Any = await request.text()
        if request.content_type == 'application/json':
            try:
                body = json.loads(body)
            except json.JSONDecodeError:
                return web.json_response({'error': 'The body is not valid JSON.'}, status=400)
        return web.json_response({'runId': self.run_id, 'query': dict(request.query), 'body': body})

    async def stats(self, _request: web.Request) -> web.Response:
        return web.json_response(
            {'runId': self.run_id, 'thisRun': {'served': self.served}, 'allRuns': self.all_runs()}
        )

    async def stream(self, request: web.Request) -> web.StreamResponse:
        try:
            count = min(int(request.query.get('count', '5')), 50)
        except ValueError:
            count = 5
        response = web.StreamResponse(headers={'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
        await response.prepare(request)
        for n in range(1, count + 1):
            data = json.dumps({'n': n, 'of': count, 'at': now()})
            await response.write(f'event: tick\ndata: {data}\n\n'.encode())
            await asyncio.sleep(0.5)
        await response.write(b'event: done\ndata: {}\n\n')
        await response.write_eof()
        return response

    async def websocket(self, request: web.Request) -> web.WebSocketResponse:
        socket = web.WebSocketResponse()
        await socket.prepare(request)
        await socket.send_json({'hello': 'Send me anything and I will echo it.', 'runId': self.run_id})
        async for message in socket:
            if message.type == WSMsgType.TEXT:
                await socket.send_json({'echo': message.data})
        return socket

    def app(self) -> web.Application:
        app = web.Application(middlewares=[self.count_requests])
        app.router.add_get('/', self.index)
        app.router.add_get('/hello', self.hello)
        app.router.add_post('/echo', self.echo)
        app.router.add_get('/stats', self.stats)
        app.router.add_get('/stream', self.stream)
        app.router.add_get('/ws', self.websocket)
        return app


async def main() -> None:
    async with Actor:
        config = Actor.configuration
        if config.meta_origin != 'STANDBY':
            # `apify call` lands here: an Actor server has nothing to do without requests.
            Actor.log.info(f'This Actor is an HTTP server. Send requests to {config.standby_url}/ instead.')
            return

        stats_store = await Actor.open_key_value_store(name=STATS_STORE)
        before = await stats_store.get_value(STATS_KEY) or {'served': 0, 'runs': 0}
        server = StandbyServer(config.actor_run_id, config.standby_url, before)

        async def save_stats(*_args: Any) -> None:
            await stats_store.set_value(STATS_KEY, server.all_runs())

        # An idle standby run is wound down with an `aborting` event: stop serving, save, and exit.
        stopping = asyncio.Event()

        async def on_aborting(*_args: Any) -> None:
            Actor.log.info(f'Shutting down after serving {server.served} requests.')
            stopping.set()

        # Saved whenever the platform asks (periodically, and before a migration), so no count is lost.
        Actor.on(Event.PERSIST_STATE, save_stats)
        Actor.on(Event.ABORTING, on_aborting)

        # The Python SDK reads the server port from ACTOR_WEB_SERVER_PORT (4321 unless set otherwise).
        port = config.web_server_port
        runner = web.AppRunner(server.app())
        await runner.setup()
        await web.TCPSite(runner, '0.0.0.0', port).start()
        Actor.log.info(f'Standby server listening on port {port}')

        await stopping.wait()
        await runner.cleanup()
        await save_stats()
