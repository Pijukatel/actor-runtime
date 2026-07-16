"""Dependency-free standby fixture Actor for the on-demand-calls-standby e2e test.

Listens on ACTOR_STANDBY_PORT, answers the readiness probe, and otherwise
echoes the request it received (method, path+query, body) plus a per-process
request counter -- mirroring apify-core's own standby fixture actors
(``shared_actors.js``) -- so the caller can prove both exact forwarding and
warm-container reuse across requests. Deliberately stdlib-only (no apify SDK)
so the image builds offline and behaviour is fully deterministic, like
``sample_actor``.
"""
import http.server
import json
import os

PORT = int(os.environ["ACTOR_STANDBY_PORT"])
request_count = 0


class Handler(http.server.BaseHTTPRequestHandler):
    def _handle(self) -> None:
        global request_count
        if self.headers.get("x-apify-container-server-readiness-probe"):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ready")
            return
        request_count += 1
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        payload = json.dumps(
            {
                "method": self.command,
                "path": self.path,
                "body": body.decode("utf-8", errors="replace"),
                "requestCount": request_count,
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
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Standby fixture Actor listening on port {PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
