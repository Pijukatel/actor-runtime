"""Dependency-free standby fixture Actor for the on-demand-calls-standby e2e test.

When started in standby mode (APIFY_META_ORIGIN == "STANDBY"), listens on
ACTOR_STANDBY_PORT, answers the readiness probe, and otherwise echoes the
request it received (method, path+query, body) plus a per-process request
counter -- mirroring apify-core's own standby fixture actors
(``shared_actors.js``) -- so the caller can prove both exact forwarding and
warm-container reuse across requests. When started in standard mode it exits
successfully with a note, as the platform docs recommend for standby-capable
Actors. Deliberately stdlib-only (no apify SDK) so the image builds offline
and behaviour is fully deterministic, like ``sample_actor``.
"""
import http.server
import json
import os
import urllib.request

request_count = 0


def _save_served_call(record: dict) -> None:
    """Best-effort: push one dataset item per served call through the runtime API.

    Uses the same env the platform gives every container (API base URL, token,
    default dataset id); a failure is logged, never fatal -- serving requests
    must not depend on the bookkeeping write.
    """
    base_url = os.environ.get("APIFY_API_BASE_URL")
    token = os.environ.get("APIFY_TOKEN")
    dataset_id = os.environ.get("APIFY_DEFAULT_DATASET_ID")
    if not (base_url and token and dataset_id):
        return
    req = urllib.request.Request(
        f"{base_url}/v2/datasets/{dataset_id}/items",
        data=json.dumps([record]).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=10).close()
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


def main() -> None:
    # Standby-capable Actors can still be started in standard mode (a plain
    # `apify call` / POST .../runs). Per the platform docs, the two modes are
    # distinguished by APIFY_META_ORIGIN == "STANDBY"; a standard start has
    # nothing to serve, so exit successfully instead of crashing on the
    # standby-only ACTOR_STANDBY_PORT variable.
    if os.environ.get("APIFY_META_ORIGIN") != "STANDBY":
        print("Started in standard (non-standby) mode; nothing to serve, exiting.", flush=True)
        return
    port = int(os.environ["ACTOR_STANDBY_PORT"])
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Standby fixture Actor listening on port {port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
