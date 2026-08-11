"""Upstream-API fallback middleware (app/upstream.py) + the runtime-config
toggle it reads. All Docker-free: a tiny in-process HTTP server stands in for
api.apify.com, with `Settings.apify_upstream_base_url` pointed at it, built on
conftest.py's own shared `_make_threaded_http_server`/`_start_http_server_thread`/
`_stop_threaded_http_server` helpers and `_QuietHandlerMixin` -- the same
ThreadingHTTPServer/start/stop lifecycle `FakeStandbyServer` there uses, with
only the request handler differing. See requirements/api.md's "Upstream
fallback" section.
"""
from __future__ import annotations

import dataclasses
import gzip
import http.server
import json

import pytest_asyncio
from conftest import (
    StubDriver,
    _make_threaded_http_server,
    _QuietHandlerMixin,
    _start_http_server_thread,
    _stop_threaded_http_server,
    _wire,
    make_settings,
)


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _create_user(client, name):
    await client.post("/v2/users", json={"name": name})


class _FakeUpstreamHandler(_QuietHandlerMixin, http.server.BaseHTTPRequestHandler):
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
        # `headers` is a list of (name, value) pairs, not a dict, so a test can
        # configure more than one header with the same name (e.g. two
        # Set-Cookie headers) -- see test_fallback_relay_preserves_duplicate_
        # response_headers below.
        for k, v in headers:
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


class FakeUpstreamServer:
    """Stand-in for api.apify.com: records every request it receives and
    replies with whatever `set_response` was last configured with (default
    200/empty)."""

    def __init__(self) -> None:
        self._httpd = _make_threaded_http_server(_FakeUpstreamHandler)
        self._httpd.requests = []
        self._httpd.next_response = (200, b"", [])
        self.port = self._httpd.server_address[1]
        self._thread = _start_http_server_thread(self._httpd)
        self._stopped = False

    @property
    def requests(self) -> list:
        return self._httpd.requests

    def set_response(
        self, status: int, body: bytes = b"", headers: dict | list[tuple[str, str]] | None = None
    ) -> None:
        """`headers` may be a plain dict (the common case) or a list of
        `(name, value)` pairs when a test needs more than one header with the
        same name -- a dict could never represent that."""
        if headers is None:
            pairs: list[tuple[str, str]] = []
        elif isinstance(headers, dict):
            pairs = list(headers.items())
        else:
            pairs = list(headers)
        self._httpd.next_response = (status, body, pairs)

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
        _stop_threaded_http_server(self._httpd, self._thread)


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


async def test_fallback_relayed_response_still_carries_cors_headers(wired_upstream, fake_upstream):
    """The middleware discards `call_next()`'s response and builds a brand-new
    one from the upstream reply on a relay -- that new response must still
    pass back through CORSMiddleware (registered outer to the fallback
    middleware in app/main.py), exactly like every other response."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    fake_upstream.set_response(
        200,
        json.dumps({"data": {"items": [], "count": 0, "limit": 0, "isTruncated": False}}).encode(),
        {"content-type": "application/json"},
    )

    resp = await client.get(
        "/v2/key-value-stores/nobody~nothing/keys", headers={"Origin": "https://example.com"}
    )
    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-origin") == "*"


async def test_fallback_relay_preserves_duplicate_response_headers(wired_upstream, fake_upstream):
    """A dict comprehension over `upstream.headers.items()` would silently keep
    only the last value for a header name the upstream repeats -- e.g. two
    Set-Cookie headers -- contradicting `fetch_upstream_fallback`'s own
    "relayed back verbatim" contract. Mirrors the same regression check
    app/routers/standby.py's own upstream proxy already has for its
    duplicate-header-preserving `MutableHeaders.append()` usage."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    fake_upstream.set_response(
        200,
        b"{}",
        [
            ("content-type", "application/json"),
            ("set-cookie", "a=1"),
            ("set-cookie", "b=2"),
        ],
    )

    resp = await client.get("/v2/key-value-stores/nobody~nothing/keys")
    assert resp.status_code == 200
    assert resp.headers.get_list("set-cookie") == ["a=1", "b=2"]


async def test_fallback_relay_strips_full_hop_by_hop_response_header_set(wired_upstream, fake_upstream):
    """`_HOP_BY_HOP_RESPONSE_HEADERS` is the full RFC 7230 hop-by-hop set, not
    just the two members (`content-encoding`/`content-length`/`transfer-
    encoding`/`connection`) this proxy happened to need before -- none of
    these ever belongs on a relayed response."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    fake_upstream.set_response(
        200,
        b"{}",
        [
            ("content-type", "application/json"),
            ("keep-alive", "timeout=5"),
            ("proxy-authenticate", "Basic"),
            ("proxy-authorization", "Basic abc"),
            ("te", "trailers"),
            ("trailer", "X-Something"),
            ("trailers", "X-Something"),
            ("upgrade", "h2c"),
        ],
    )

    resp = await client.get("/v2/key-value-stores/nobody~nothing/keys")
    assert resp.status_code == 200
    for header in ("keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "trailers", "upgrade"):
        assert header not in resp.headers


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


async def test_fallback_write_forwards_content_encoding_for_compressed_body(wired_upstream, fake_upstream):
    """A write with a compressed body (apify-client 3.x sends every storage
    write with `Content-Encoding: br` by default; gzip is used here since it's
    stdlib) must replay `Content-Encoding` upstream, not just the compressed
    bytes -- otherwise the real API tries to parse still-compressed bytes as
    plain JSON, the upstream call fails, and the fallback's own
    upstream-failure-collapses-to-404 rule silently swallows what should have
    been a successful write."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    fake_upstream.set_response(201, b'{"data":{"key":"K"}}', {"content-type": "application/json"})

    compressed = gzip.compress(json.dumps({"hello": "world"}).encode())
    resp = await client.put(
        "/v2/key-value-stores/otheruser~theirs/records/K",
        content=compressed,
        headers={"content-type": "application/json", "content-encoding": "gzip"},
    )
    assert resp.status_code == 201
    assert len(fake_upstream.requests) == 1
    seen = fake_upstream.requests[0]
    assert seen["headers"].get("content-encoding") == "gzip"
    assert seen["body"] == compressed  # replayed byte-for-byte, still compressed


# ------------------------------------------------------------- guardrails


async def test_fallback_excludes_logs_path_even_on_local_404(wired_upstream, fake_upstream):
    """`/v2/logs/...` has no real-platform analogue reachable the same way --
    excluded from the allowlist regardless of toggle state."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    resp = await client.get("/v2/logs/no-such-job")
    assert resp.status_code == 404
    assert fake_upstream.requests == []


async def test_fallback_excludes_bare_actor_collection_route(wired_upstream, fake_upstream):
    """`POST /v2/acts` (no id yet) is a bare collection route, not a by-id
    resource -- it is excluded from the allowlist (and never 404s locally
    anyway, since it always creates), so it must never reach upstream."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    await _create_user(client, "creator")
    resp = await client.post("/v2/acts", json={"name": "x"}, headers=auth("creator"))
    assert resp.status_code == 201
    assert fake_upstream.requests == []


async def test_fallback_excludes_actor_standby_forwarding_path(wired_upstream, fake_upstream):
    """`/v2/actor-standby/...` is a local-only route (container forwarding),
    with no equivalent reachable the same way upstream."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    await _create_user(client, "prober")
    resp = await client.get("/v2/actor-standby/no-such-actor/ping", headers=auth("prober"))
    assert resp.status_code == 404
    assert fake_upstream.requests == []


async def test_fallback_excludes_unmatched_runtime_config_subpath(wired_upstream, fake_upstream):
    """An unmatched path under `/v2/runtime-config/...` 404s via the console's
    catch-all -- it must stay excluded (the toggle endpoint itself is local-only,
    and this sub-path matches no registered route at all)."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    resp = await client.get("/v2/runtime-config/nope")
    assert resp.status_code == 404
    assert fake_upstream.requests == []


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
