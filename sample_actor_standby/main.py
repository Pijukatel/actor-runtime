"""Standby fixture Actor for the on-demand-calls-standby e2e test.

In standby mode, listens on ``ACTOR_STANDBY_PORT``, answers the readiness
probe, and echoes each request (method, path+query, body) plus a per-process
counter, so a caller can prove both exact forwarding and warm-container
reuse. In standard mode it exits immediately. Uses stdlib ``http.server``
because this fixture IS the server under test, not an HTTP client.
"""
import asyncio
import http.server
import json
import os

from apify import Actor

request_count = 0

# The event loop running `async with Actor:` (set once, in `main`, before the
# server starts accepting connections). The HTTP handler thread has no event
# loop of its own, so it schedules the actual push onto this one instead.
_actor_loop: asyncio.AbstractEventLoop | None = None


def _save_served_call(record: dict) -> None:
    """Best-effort: push one dataset item per served call via the SDK.

    Runs on the handler's worker thread; marshals the push onto the event
    loop that holds the Actor context. A failure (timeout, storage error) is
    logged, never fatal -- serving requests must not depend on this write.
    """
    if _actor_loop is None:
        return

    async def _push() -> None:
        await Actor.push_data(record)

    try:
        future = asyncio.run_coroutine_threadsafe(_push(), _actor_loop)
        future.result(timeout=10)
    except Exception as exc:  # noqa: BLE001 - bookkeeping only
        print(f"Failed to save served call to dataset: {exc}", flush=True)


class Handler(http.server.BaseHTTPRequestHandler):
    def _handle(self) -> None:
        global request_count
        # One log line per handled request (probes included), so the run's
        # captured log shows the standby traffic.
        print(f"Handling request: {self.command} {self.path}", flush=True)
        if self.headers.get("x-apify-container-server-readiness-probe"):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ready")
            return
        request_count += 1
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        _save_served_call(
            {"method": self.command, "path": self.path, "requestCount": request_count}
        )
        payload = json.dumps(
            {
                "method": self.command,
                "path": self.path,
                "body": body.decode("utf-8", errors="replace"),
                "requestCount": request_count,
                "reply": f"Standby Actor served request #{request_count}",
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        self._handle()

    def do_POST(self) -> None:
        self._handle()

    def log_message(self, format, *args) -> None:  # silence default stderr logging
        pass


async def main() -> None:
    global _actor_loop
    async with Actor:
        # Standby-capable Actors can still be started in standard mode (a
        # plain `apify call` / POST .../runs). Per the platform docs, the two
        # modes are distinguished by APIFY_META_ORIGIN == "STANDBY"; a
        # standard start has nothing to serve, so exit successfully instead
        # of crashing on the standby-only ACTOR_STANDBY_PORT variable.
        if os.environ.get("APIFY_META_ORIGIN") != "STANDBY":
            print("Started in standard (non-standby) mode; nothing to serve, exiting.", flush=True)
            return

        _actor_loop = asyncio.get_running_loop()
        port = int(os.environ["ACTOR_STANDBY_PORT"])
        server = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
        print(f"Standby fixture Actor listening on port {port}", flush=True)
        # Run the blocking server on a worker thread so the event loop (and
        # the Actor context/event manager it holds) stays free to run the
        # coroutines `_save_served_call` schedules onto it from that thread.
        await asyncio.to_thread(server.serve_forever)


if __name__ == "__main__":
    asyncio.run(main())
