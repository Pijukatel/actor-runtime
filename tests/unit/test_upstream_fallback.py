"""Upstream-API fallback middleware (app/upstream.py) + the runtime-config
toggle it reads. All Docker-free: a tiny in-process HTTP server (mirroring
conftest.py's own FakeStandbyServer pattern) stands in for api.apify.com, with
`Settings.apify_upstream_base_url` pointed at it. See .shepherd/2-design.md.
"""
from __future__ import annotations

import dataclasses
import http.server
import json
import threading

import pytest_asyncio
from conftest import StubDriver, _wire, make_settings


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _create_user(client, name):
    await client.post("/v2/users", json={"name": name})


class _FakeUpstreamHandler(http.server.BaseHTTPRequestHandler):
    def _handle(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        self.server.requests.append(
            {
                "method": self.command,
                "path": self.path,
                "headers": dict(self.headers.items()),
                "body": body,
            }
        )
        status, payload, headers = self.server.next_response
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def do_GET(self) -> None:
        self._handle()

    def do_POST(self) -> None:
        self._handle()

    def do_PUT(self) -> None:
        self._handle()

    def do_DELETE(self) -> None:
        self._handle()

    def log_message(self, format, *args) -> None:  # silence default stderr logging
        pass


class FakeUpstreamServer:
    """Stand-in for api.apify.com: records every request it receives and
    replies with whatever `set_response` was last configured with (default
    200/empty)."""

    def __init__(self) -> None:
        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FakeUpstreamHandler)
        self._httpd.requests = []
        self._httpd.next_response = (200, b"", {})
        self.port = self._httpd.server_address[1]
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()
        self._stopped = False

    @property
    def requests(self) -> list:
        return self._httpd.requests

    def set_response(self, status: int, body: bytes = b"", headers: dict | None = None) -> None:
        self._httpd.next_response = (status, body, headers or {})

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def stop(self) -> None:
        """Idempotent: also used mid-test to simulate a connect error (nothing
        listens at the port any more), so the fixture's own teardown must not
        double-close an already-stopped server."""
        if self._stopped:
            return
        self._stopped = True
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)


@pytest_asyncio.fixture
async def fake_upstream():
    server = FakeUpstreamServer()
    yield server
    server.stop()


@pytest_asyncio.fixture
async def wired_upstream(tmp_path, fake_upstream):
    """Like the shared `wired` fixture, but `apify_upstream_base_url` points at
    `fake_upstream` instead of the real platform."""
    settings = dataclasses.replace(make_settings(tmp_path), apify_upstream_base_url=fake_upstream.base_url)
    async for pair in _wire(tmp_path, StubDriver(), settings=settings):
        yield pair


# ------------------------------------------------------------------- toggle


async def test_runtime_config_get_is_token_free_and_defaults_off(wired):
    client, _service = wired
    resp = await client.get("/v2/runtime-config")
    assert resp.status_code == 200
    assert resp.json()["data"] == {"upstreamFallbackEnabled": False}


async def test_fresh_wiring_starts_with_toggle_off(wired):
    """A brand-new `Service` (~ a fresh process after a restart) always starts
    with the toggle off -- it is a plain in-memory attribute with no
    persistence path (no DB table/column) that could carry a prior value
    across a restart."""
    _client, service = wired
    assert service.upstream_fallback_enabled is False


async def test_runtime_config_put_takes_effect_immediately(wired):
    client, service = wired
    resp = await client.put("/v2/runtime-config", json={"upstreamFallbackEnabled": True})
    assert resp.status_code == 200
    assert resp.json()["data"] == {"upstreamFallbackEnabled": True}
    assert service.upstream_fallback_enabled is True

    again = await client.get("/v2/runtime-config")
    assert again.json()["data"] == {"upstreamFallbackEnabled": True}

    off = await client.put("/v2/runtime-config", json={"upstreamFallbackEnabled": False})
    assert off.json()["data"] == {"upstreamFallbackEnabled": False}
    assert service.upstream_fallback_enabled is False


async def test_runtime_config_put_rejects_non_boolean(wired):
    client, service = wired
    resp = await client.put("/v2/runtime-config", json={"upstreamFallbackEnabled": "yes"})
    assert resp.status_code == 400
    assert service.upstream_fallback_enabled is False


# ------------------------------------------------------ fallback: read (GET)


async def test_fallback_disabled_by_default_local_404_unchanged(wired_upstream):
    client, service = wired_upstream
    assert service.upstream_fallback_enabled is False
    resp = await client.get("/v2/key-value-stores/nobody~nothing/keys")
    assert resp.status_code == 404
    assert resp.json()["error"]["type"] == "record-not-found"


async def test_fallback_toggle_off_never_attempts_upstream(wired_upstream, fake_upstream):
    client, service = wired_upstream
    service.upstream_fallback_enabled = False
    resp = await client.get("/v2/key-value-stores/nobody~nothing/keys")
    assert resp.status_code == 404
    assert fake_upstream.requests == []


async def test_fallback_get_relays_upstream_2xx_verbatim(wired_upstream, fake_upstream):
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    fake_upstream.set_response(
        200,
        json.dumps({"data": {"items": [{"key": "OUTPUT"}], "count": 1, "limit": 1, "isTruncated": False}}).encode(),
        {"content-type": "application/json", "x-test-marker": "hello"},
    )

    resp = await client.get("/v2/key-value-stores/nobody~nothing/keys")
    assert resp.status_code == 200
    assert resp.json()["data"]["items"] == [{"key": "OUTPUT"}]
    assert resp.headers.get("x-test-marker") == "hello"
    assert len(fake_upstream.requests) == 1
    seen = fake_upstream.requests[0]
    assert seen["method"] == "GET"
    assert seen["path"] == "/v2/key-value-stores/nobody~nothing/keys"


async def test_fallback_upstream_non_2xx_collapses_to_local_404(wired_upstream, fake_upstream):
    client, service = wired_upstream
    # Capture the plain local 404 with fallback OFF, before any upstream
    # attempt could shape it.
    local_only = await client.get("/v2/key-value-stores/nobody~nothing/keys")
    assert local_only.status_code == 404
    local_body = local_only.json()

    service.upstream_fallback_enabled = True
    fake_upstream.set_response(500, b"boom")
    resp = await client.get("/v2/key-value-stores/nobody~nothing/keys")
    assert resp.status_code == 404
    assert resp.json() == local_body
    assert len(fake_upstream.requests) == 1  # the attempt was made, and failed


async def test_fallback_upstream_connect_error_collapses_to_local_404(wired_upstream, fake_upstream):
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    fake_upstream.stop()  # nothing listens at this port any more

    resp = await client.get("/v2/key-value-stores/nobody~nothing/keys")
    assert resp.status_code == 404
    assert resp.json()["error"]["type"] == "record-not-found"


# --------------------------------------------------- fallback: writes (POST/PUT/DELETE)


async def test_fallback_delete_relays_upstream_2xx_verbatim(wired_upstream, fake_upstream):
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    fake_upstream.set_response(
        200, json.dumps({"data": {"id": "nobody~nothing"}}).encode(), {"content-type": "application/json"}
    )

    resp = await client.delete("/v2/key-value-stores/nobody~nothing")
    assert resp.status_code == 200
    assert resp.json()["data"] == {"id": "nobody~nothing"}
    assert len(fake_upstream.requests) == 1
    assert fake_upstream.requests[0]["method"] == "DELETE"


async def test_fallback_delete_upstream_failure_collapses_to_local_404(wired_upstream, fake_upstream):
    client, service = wired_upstream
    local_only = await client.delete("/v2/key-value-stores/nobody~nothing")
    assert local_only.status_code == 404
    local_body = local_only.json()

    service.upstream_fallback_enabled = True
    fake_upstream.set_response(401, b'{"error":{"message":"bad token"}}')
    resp = await client.delete("/v2/key-value-stores/nobody~nothing")
    assert resp.status_code == 404
    assert resp.json() == local_body


async def test_fallback_write_body_and_query_replayed_verbatim(wired_upstream, fake_upstream):
    """A PUT that 404s locally replays the SAME method, query string AND body,
    not just the path."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    fake_upstream.set_response(201, b'{"data":{"key":"K"}}', {"content-type": "application/json"})

    resp = await client.put(
        "/v2/key-value-stores/otheruser~theirs/records/K?foo=bar",
        content=json.dumps({"hello": "world"}),
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 201
    assert len(fake_upstream.requests) == 1
    seen = fake_upstream.requests[0]
    assert seen["method"] == "PUT"
    assert seen["path"] == "/v2/key-value-stores/otheruser~theirs/records/K?foo=bar"
    assert json.loads(seen["body"]) == {"hello": "world"}
    assert seen["headers"].get("content-type") == "application/json"


# ------------------------------------------------------------- guardrails


async def test_fallback_never_proxied_when_resource_exists_locally(wired_upstream, fake_upstream):
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    await _create_user(client, "eve")
    await client.post("/v2/key-value-stores", json={"name": "mine"}, headers=auth("eve"))

    resp = await client.get("/v2/key-value-stores/eve~mine/keys", headers=auth("eve"))
    assert resp.status_code == 200
    assert fake_upstream.requests == []


async def test_fallback_never_proxied_for_non_404_local_status(wired_upstream, fake_upstream):
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    await _create_user(client, "owner")
    await _create_user(client, "reader")
    created = await client.post("/v2/key-value-stores", json={"name": "shared"}, headers=auth("owner"))
    store_id = created.json()["data"]["id"]
    await client.post(
        f"/v2/key-value-stores/{store_id}/access-rights",
        json={"grantee": "reader", "level": "READ"},
        headers=auth("owner"),
    )

    # A READ grantee's write is a local 403 -- never proxied, even with
    # fallback on.
    resp = await client.put(
        f"/v2/key-value-stores/{store_id}/records/K",
        content=json.dumps({"v": 1}),
        headers={**auth("reader"), "content-type": "application/json"},
    )
    assert resp.status_code == 403
    assert fake_upstream.requests == []


# -------------------------------------------------------------- token identity


async def test_fallback_forwards_the_callers_own_bound_token(wired_upstream, fake_upstream):
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    await _create_user(client, "alice")  # alice.token == "alice"
    fake_upstream.set_response(200, b"[]", {"content-type": "application/json"})

    resp = await client.get("/v2/datasets/alice~nonexistent/items", headers=auth("alice"))
    assert resp.status_code == 200
    assert len(fake_upstream.requests) == 1
    assert fake_upstream.requests[0]["headers"].get("authorization") == "Bearer alice"


async def test_fallback_forwards_different_callers_different_tokens(wired_upstream, fake_upstream):
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    await _create_user(client, "alice")
    await _create_user(client, "bob")
    fake_upstream.set_response(200, b"[]", {"content-type": "application/json"})

    await client.get("/v2/datasets/alice~nonexistent/items", headers=auth("alice"))
    await client.get("/v2/datasets/bob~nonexistent/items", headers=auth("bob"))
    assert len(fake_upstream.requests) == 2
    assert fake_upstream.requests[0]["headers"].get("authorization") == "Bearer alice"
    assert fake_upstream.requests[1]["headers"].get("authorization") == "Bearer bob"


async def test_fallback_anonymous_caller_forwards_no_token_when_unclaimed(wired_upstream, fake_upstream):
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    fake_upstream.set_response(200, b"[]", {"content-type": "application/json"})

    resp = await client.get("/v2/datasets/local-user~nonexistent/items")  # no Authorization header
    assert resp.status_code == 200
    assert len(fake_upstream.requests) == 1
    assert "authorization" not in fake_upstream.requests[0]["headers"]


# -------------------------------------------------------- toggle + middleware wired together


async def test_toggle_via_runtime_config_endpoint_enables_fallback_immediately(wired_upstream, fake_upstream):
    client, service = wired_upstream
    fake_upstream.set_response(200, b"[]", {"content-type": "application/json"})

    before = await client.get("/v2/datasets/nobody~nothing/items")
    assert before.status_code == 404
    assert fake_upstream.requests == []

    put = await client.put("/v2/runtime-config", json={"upstreamFallbackEnabled": True})
    assert put.status_code == 200

    after = await client.get("/v2/datasets/nobody~nothing/items")
    assert after.status_code == 200
    assert len(fake_upstream.requests) == 1


async def test_toggle_off_stops_further_fallback_attempts_mid_session(wired_upstream, fake_upstream):
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    fake_upstream.set_response(200, b"[]", {"content-type": "application/json"})

    first = await client.get("/v2/datasets/nobody~nothing/items")
    assert first.status_code == 200
    assert len(fake_upstream.requests) == 1

    off = await client.put("/v2/runtime-config", json={"upstreamFallbackEnabled": False})
    assert off.status_code == 200

    second = await client.get("/v2/datasets/nobody~nothing/items")
    assert second.status_code == 404
    assert len(fake_upstream.requests) == 1  # no new attempt
