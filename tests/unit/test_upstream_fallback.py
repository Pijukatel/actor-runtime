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

import httpx
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


@pytest_asyncio.fixture
async def wired_upstream_trailing_slash_base_url(tmp_path, fake_upstream):
    """Like `wired_upstream`, but `apify_upstream_base_url` is configured WITH
    a trailing slash (e.g. as an operator might set `APIFY_UPSTREAM_BASE_URL`)
    -- `Settings.__post_init__` (app/config.py) normalizes it away, so the
    outgoing request path built by `fetch_upstream_fallback` never gets a
    double slash."""
    settings = dataclasses.replace(make_settings(tmp_path), apify_upstream_base_url=f"{fake_upstream.base_url}/")
    async for pair in _wire(tmp_path, StubDriver(), settings=settings):
        yield pair


@pytest_asyncio.fixture
async def wired_malformed_upstream(tmp_path):
    """Like `wired`, but `apify_upstream_base_url` is malformed in a way `httpx`
    rejects while BUILDING the request (`httpx.InvalidURL`, raised before any
    connection is attempted) -- simulating a misconfigured
    `APIFY_UPSTREAM_BASE_URL` (e.g. missing scheme, unparsable host). No fake
    server needed: the failure happens before any network I/O."""
    settings = dataclasses.replace(make_settings(tmp_path), apify_upstream_base_url="http://[::1")
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
    just the two members (`content-encoding`/`content-length`) this proxy
    added beyond that plain set to handle its own decoded-body/recomputed-
    framing needs -- none of these ever belongs on a relayed response.
    `content-encoding`/`content-length` are exercised separately, over an
    actually-compressed response, in
    `test_fallback_relay_strips_content_encoding_and_recomputes_content_length_for_compressed_response`
    below -- a mismatched-but-unused value here wouldn't prove anything about
    stripping vs. blind forwarding the way a real compressed body does."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    fake_upstream.set_response(
        200,
        b"{}",
        [
            ("content-type", "application/json"),
            # A real `Content-Length` is required alongside `Connection:
            # keep-alive` here -- httpx treats that combination as "more may
            # follow on this connection" and blocks waiting for it absent a
            # length to bound the body by, timing out rather than exercising
            # the header-stripping this test is actually about.
            ("content-length", "2"),
            ("connection", "keep-alive"),
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
    for header in (
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "trailers",
        "upgrade",
    ):
        assert header not in resp.headers


async def test_fallback_relay_strips_content_encoding_and_recomputes_content_length_for_compressed_response(
    wired_upstream, fake_upstream
):
    """`content-encoding`/`content-length` are the two members
    `_HOP_BY_HOP_RESPONSE_HEADERS` adds beyond the plain RFC 7230 set, and --
    unlike the rest of that set -- neither has a test that actually exercises
    a real compressed upstream reply. httpx transparently decodes a response
    whose `Content-Encoding` it recognizes, so `upstream.content` (what this
    module relays) is already the DEcompressed bytes while `upstream.headers`
    still carries the ORIGINAL `content-encoding`/`content-length` describing
    the compressed wire bytes -- forwarding either verbatim would hand the
    caller a body/header pair that doesn't match (a `content-length` shorter
    than the actual decompressed body, and a `content-encoding: gzip` label on
    bytes that are no longer gzipped). Exercising this over a real gzip body
    is the only way to prove the two headers are actually stripped-and-
    recomputed rather than coincidentally correct."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    plaintext = json.dumps({"data": {"items": [{"key": "OUTPUT"}], "count": 1, "limit": 1, "isTruncated": False}})
    compressed = gzip.compress(plaintext.encode())
    assert len(compressed) != len(plaintext.encode())  # the case this test exists to catch
    fake_upstream.set_response(
        200,
        compressed,
        [
            ("content-type", "application/json"),
            ("content-encoding", "gzip"),
            ("content-length", str(len(compressed))),
        ],
    )

    resp = await client.get("/v2/key-value-stores/nobody~nothing/keys")
    assert resp.status_code == 200
    assert resp.json()["data"]["items"] == [{"key": "OUTPUT"}]  # httpx already decoded it
    assert "content-encoding" not in resp.headers
    # Recomputed by Starlette from the actual (decompressed) relayed body --
    # not the original (compressed, shorter) upstream value -- so the caller
    # never receives a `content-length` inconsistent with the bytes on the wire.
    assert resp.headers["content-length"] == str(len(plaintext.encode()))


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


async def test_fallback_malformed_upstream_base_url_collapses_to_local_404(wired_malformed_upstream):
    """`httpx.InvalidURL` is raised while httpx builds the outgoing request --
    not a subclass of `httpx.HTTPError` -- so a misconfigured
    `APIFY_UPSTREAM_BASE_URL` must still collapse to the original local 404
    like every other fallback failure, not crash the request."""
    client, service = wired_malformed_upstream
    local_only = await client.get("/v2/key-value-stores/nobody~nothing/keys")
    assert local_only.status_code == 404
    local_body = local_only.json()

    service.upstream_fallback_enabled = True
    resp = await client.get("/v2/key-value-stores/nobody~nothing/keys")
    assert resp.status_code == 404
    assert resp.json() == local_body


# ---------------------------------------------- fallback: identity resolution failures


async def test_fallback_unresolvable_token_on_spa_catchall_404_collapses_to_local_404(wired_upstream, fake_upstream):
    """The SPA catch-all (app/routers/console.py's `spa_catch_all`) 404s an
    allowlisted-prefix path that matches no registered route WITHOUT ever
    calling `resolve_user` itself -- unlike every registered handler on these
    prefixes, which authenticates before it can 404. So
    `fetch_upstream_fallback`'s own `resolve_user` call is the FIRST
    resolution attempt for a request like this one, and an unresolvable token
    there must collapse to the original local 404 like any other fallback
    failure -- never an uncaught `InvalidTokenError` (a bare 500)."""
    client, service = wired_upstream
    # Ground truth: the plain local 404, captured with no token involved at all.
    local_only = await client.get("/v2/actors/someuser~someactor/no-such-nested-path")
    assert local_only.status_code == 404
    local_body = local_only.json()

    service.upstream_fallback_enabled = True
    # Bootstrap the default user's credential with a first token.
    bootstrap = await client.get("/v2/users/me", headers=auth("FIRST-TOKEN"))
    assert bootstrap.status_code == 200

    # A second, unknown token can no longer bootstrap the now-claimed default
    # user -- ordinarily a clean 401 from the FIRST `resolve_user` call a
    # registered handler makes, but this path never reaches one.
    resp = await client.get(
        "/v2/actors/someuser~someactor/no-such-nested-path", headers=auth("SECOND-UNKNOWN-TOKEN")
    )
    assert resp.status_code == 404
    assert resp.json() == local_body
    assert fake_upstream.requests == []  # never got far enough to attempt the upstream call


async def test_fallback_disabled_unresolvable_token_on_spa_catchall_is_plain_local_404(wired_upstream, fake_upstream):
    """Companion to the test above with the toggle OFF: the same request must
    still be the plain local 404 either way -- with fallback disabled the
    middleware short-circuits before ever calling `resolve_user`, so an
    unresolvable token is irrelevant."""
    client, service = wired_upstream
    assert service.upstream_fallback_enabled is False
    bootstrap = await client.get("/v2/users/me", headers=auth("FIRST-TOKEN"))
    assert bootstrap.status_code == 200

    resp = await client.get(
        "/v2/actors/someuser~someactor/no-such-nested-path", headers=auth("SECOND-UNKNOWN-TOKEN")
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["type"] == "record-not-found"
    assert fake_upstream.requests == []


async def test_fallback_non_invalid_token_fault_during_identity_resolution_collapses_to_local_404(
    wired_upstream, fake_upstream, monkeypatch
):
    """RED->GREEN for the finding that `fetch_upstream_fallback`'s failure
    boundary only caught `InvalidTokenError` (plus the upstream-call
    exceptions) -- any OTHER fault raised while resolving the caller's
    identity, e.g. a transient DB error from `Service.get_user`, used to
    escape uncaught as a raw 500 (`ServerErrorMiddleware`'s generic "Internal
    Server Error"), never the original local 404 the module's own contract
    promises for "any failure" on this path. `svc.get_user` raising a plain
    `RuntimeError` stands in for that DB fault. With the fix (one broad
    `except Exception` covering the whole fallback attempt), this must
    collapse to the exact same local 404 as if fallback were off."""
    client, service = wired_upstream
    await _create_user(client, "alice")

    # Ground truth: the plain local 404, captured before any fault is injected.
    local_only = await client.get("/v2/key-value-stores/alice~nonexistent/keys", headers=auth("alice"))
    assert local_only.status_code == 404
    local_body = local_only.json()

    service.upstream_fallback_enabled = True

    async def _boom(_username):
        raise RuntimeError("simulated transient DB fault")

    monkeypatch.setattr(service, "get_user", _boom)

    resp = await client.get("/v2/key-value-stores/alice~nonexistent/keys", headers=auth("alice"))
    assert resp.status_code == 404
    assert resp.json() == local_body
    assert fake_upstream.requests == []  # never got far enough to attempt the upstream call


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


# ------------------------------------------------------- base URL normalization


async def test_fallback_trailing_slash_base_url_builds_url_without_double_slash(
    wired_upstream_trailing_slash_base_url, monkeypatch
):
    """RED->GREEN for the finding that a trailing slash on
    `APIFY_UPSTREAM_BASE_URL` (e.g. `https://api.apify.com/`) made
    `fetch_upstream_fallback` build a double slash (`.../..//v2/...`) when it
    concatenated `settings.apify_upstream_base_url` with `request.url.path`
    (which always starts with its own `/`). Asserts directly on the URL
    STRING `fetch_upstream_fallback` hands to `httpx.AsyncClient.request` --
    monkeypatched here to capture it and return a canned response instead of
    making a real call -- which is where the double slash is actually built
    (or not). This is the genuine RED->GREEN check for `Settings.__post_init__`
    (app/config.py): a same-request test built on a real socket/HTTP-server
    double (see the companion end-to-end test below) CANNOT discriminate
    this specific bug, because Python's own
    `http.server.BaseHTTPRequestHandler.parse_request()` collapses any
    request path starting with `//` down to a single `/` before a test's
    handler ever sees it (a CVE mitigation, gh-87389) -- so it would report
    the same "correct" single-slash path whether or not this fix is present."""
    client, service = wired_upstream_trailing_slash_base_url
    service.upstream_fallback_enabled = True

    # The outer `client` fixture is ITSELF an `httpx.AsyncClient` (wired to the
    # app via `httpx.ASGITransport`, `base_url="http://test"` -- see
    # conftest.py's `_wire`), so patching the class method also intercepts its
    # calls, not just the one made by `fetch_upstream_fallback`'s own fresh
    # `httpx.AsyncClient(...)`. Distinguish by `base_url`: only the latter has
    # none set, so only ITS call is captured here; the outer client's own call
    # is passed through to the real implementation so the app/middleware
    # actually runs and produces the local 404 that triggers the fallback.
    seen_urls = []
    original_request = httpx.AsyncClient.request

    async def _capturing_request(self, method, url, **kwargs):
        if self.base_url == httpx.URL("http://test"):
            return await original_request(self, method, url, **kwargs)
        seen_urls.append(str(url))
        return httpx.Response(200, content=b"[]", headers={"content-type": "application/json"})

    monkeypatch.setattr(httpx.AsyncClient, "request", _capturing_request)

    resp = await client.get("/v2/datasets/nobody~nothing/items")
    assert resp.status_code == 200
    assert len(seen_urls) == 1
    assert seen_urls[0].endswith("/v2/datasets/nobody~nothing/items")
    assert "//v2" not in seen_urls[0]


async def test_fallback_trailing_slash_base_url_does_not_double_slash_the_path(
    wired_upstream_trailing_slash_base_url, fake_upstream
):
    """Companion end-to-end smoke test for the same fix, against the real fake
    upstream stub used by every other test in this file: with the fix in
    place, a request the caller made to an allowlisted path that 404s
    locally is still correctly relayed upstream (i.e. nothing about the
    normalization silently breaks the happy path). NOTE: unlike the test
    above, this one is NOT a red/green discriminator for the trailing-slash
    fix specifically -- see that test's docstring for why a real
    `http.server`-based stub can't distinguish a single vs. a leading double
    slash here."""
    client, service = wired_upstream_trailing_slash_base_url
    service.upstream_fallback_enabled = True
    fake_upstream.set_response(200, b"[]", {"content-type": "application/json"})

    resp = await client.get("/v2/datasets/nobody~nothing/items")
    assert resp.status_code == 200
    assert len(fake_upstream.requests) == 1
    assert fake_upstream.requests[0]["path"] == "/v2/datasets/nobody~nothing/items"


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


# -------------------------------------------------------- caller-resolution dedup


async def test_fallback_resolves_caller_only_once_per_request(wired_upstream, fake_upstream, monkeypatch):
    """RED->GREEN for the finding that `fetch_upstream_fallback` re-resolved
    the caller from scratch even though the route handler's own `_guard`
    (app/routers/storages.py) already called `resolve_user` once to produce
    the local 404 -- a redundant `Service.user_for_token` DB round-trip on
    every fallback-triggering request. `resolve_user` (app/auth.py) now
    memoizes its result on `request.state`, so the SAME request's second
    `resolve_user` call (made here, to build the outgoing `Authorization`
    header) is a cache hit. Counting calls to the underlying
    `Service.user_for_token` -- the method both the handler's and the
    fallback's `resolve_user` call would otherwise invoke independently --
    pins that it now runs exactly once rather than twice."""
    client, service = wired_upstream
    await _create_user(client, "alice")  # alice.token == "alice"
    fake_upstream.set_response(200, b"[]", {"content-type": "application/json"})
    service.upstream_fallback_enabled = True

    calls = 0
    original = service.user_for_token

    async def _counting(token):
        nonlocal calls
        calls += 1
        return await original(token)

    monkeypatch.setattr(service, "user_for_token", _counting)

    resp = await client.get("/v2/datasets/alice~nonexistent/items", headers=auth("alice"))
    assert resp.status_code == 200
    assert fake_upstream.requests[0]["headers"].get("authorization") == "Bearer alice"
    assert calls == 1


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
