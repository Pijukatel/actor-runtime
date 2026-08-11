"""Upstream-API fallback middleware (app/upstream.py) + the runtime-config
toggle it reads. All Docker-free: `wired_upstream` (tests/conftest.py) points
`Settings.apify_upstream_base_url` at a `FakeUpstreamServer` -- an in-process
HTTP stub standing in for api.apify.com -- instead of the real platform. See
requirements/api.md's "Upstream fallback" section.
"""
from __future__ import annotations

import gzip
import json


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _create_user(client, name):
    await client.post("/v2/users", json={"name": name})


# ------------------------------------------------------------------- toggle


async def test_runtime_config_get_is_token_free_and_defaults_off(wired):
    client, _service = wired
    resp = await client.get("/v2/runtime-config")
    assert resp.status_code == 200
    assert resp.json()["data"] == {"upstreamFallbackEnabled": False}


async def test_runtime_config_get_ignores_presented_token(wired):
    """Token-free means GET never validates a presented credential either --
    a bearer matching no user must not be rejected here (mirrors GET
    /v2/users' own token-free contract), unlike PUT below."""
    client, _service = wired
    resp = await client.get("/v2/runtime-config", headers=auth("stale-unknown-token"))
    assert resp.status_code == 200


async def test_runtime_config_put_with_no_token_works(wired):
    """No credential at all is never rejected -- the same "absent token ->
    default user" rule every other endpoint follows, not GET's token-free
    carve-out -- so a bare PUT with no Authorization header still succeeds."""
    client, service = wired
    resp = await client.put("/v2/runtime-config", json={"upstreamFallbackEnabled": True})
    assert resp.status_code == 200
    assert service.upstream_fallback_enabled is True


async def test_runtime_config_put_rejects_unresolvable_token(wired):
    """PUT is NOT token-free: a present token matching no existing user is
    401, the same `resolve_user` check `POST /v2/users` already makes.
    Bootstrap the default user's credential with a first token via ordinary
    authenticated work, then present a SECOND, different (now genuinely
    unresolvable) token to the PUT itself."""
    client, service = wired
    await client.get("/v2/users/me", headers=auth("first-token"))  # bootstraps the default user

    resp = await client.put(
        "/v2/runtime-config", json={"upstreamFallbackEnabled": True}, headers=auth("second-token")
    )
    assert resp.status_code == 401
    assert service.upstream_fallback_enabled is False  # never touched


async def test_runtime_config_put_with_valid_token_works(wired):
    client, service = wired
    await _create_user(client, "alice")  # alice.token == "alice"
    resp = await client.put(
        "/v2/runtime-config", json={"upstreamFallbackEnabled": True}, headers=auth("alice")
    )
    assert resp.status_code == 200
    assert resp.json()["data"] == {"upstreamFallbackEnabled": True}
    assert service.upstream_fallback_enabled is True


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


async def test_fallback_toggle_off_never_attempts_upstream(wired_upstream, fake_upstream):
    """Covers both "off by default" (a fresh `Service`'s `upstream_fallback_
    enabled` is a plain in-memory attribute with no persistence path, so it
    starts `False`) and "off means off" (the same explicit assignment): a
    request for a resource missing locally returns the exact same local `404`
    as before this change, and the upstream stub receives zero requests."""
    client, service = wired_upstream
    assert service.upstream_fallback_enabled is False
    service.upstream_fallback_enabled = False
    resp = await client.get("/v2/key-value-stores/nobody~nothing/keys")
    assert resp.status_code == 404
    assert resp.json()["error"]["type"] == "record-not-found"
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
    """`app/http_relay.py`'s shared `HOP_BY_HOP` is the full RFC 7230
    hop-by-hop set, not just the two extra members
    (`content-encoding`/`content-length`, unioned into
    `_EXCLUDED_RESPONSE_HEADERS` in app/upstream.py) this proxy adds on top to
    handle its own decoded-body/recomputed-framing needs -- none of these
    ever belongs on a relayed response.
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
    app/upstream.py's `_EXCLUDED_RESPONSE_HEADERS` adds beyond the
    shared `app/http_relay.py` RFC 7230 set: httpx already decodes a
    response whose `Content-Encoding` it recognizes, so
    `upstream.content` is the DEcompressed bytes while `upstream.headers`
    still describes the compressed wire -- forwarding either verbatim would
    hand the caller a mismatched body/header pair. A real gzip body is the
    only way to prove they're actually stripped-and-recomputed, not just
    coincidentally correct."""
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
    resolving identity itself -- unlike every registered handler on these
    prefixes, which authenticates before it can 404. So
    `fetch_upstream_fallback`'s own lookup is the FIRST identity resolution
    for a request like this one, and a token matching no existing user there
    must collapse to the original local 404 like any other fallback failure."""
    client, service = wired_upstream
    # Ground truth: the plain local 404, captured with no token involved at all.
    local_only = await client.get("/v2/actors/someuser~someactor/no-such-nested-path")
    assert local_only.status_code == 404
    local_body = local_only.json()

    service.upstream_fallback_enabled = True
    # Bind the default user's credential to a first token.
    bootstrap = await client.get("/v2/users/me", headers=auth("FIRST-TOKEN"))
    assert bootstrap.status_code == 200

    # A second, unknown token matches no existing user -- there is nothing to
    # forward, so this must collapse to the local 404 rather than reach the
    # upstream call at all.
    resp = await client.get(
        "/v2/actors/someuser~someactor/no-such-nested-path", headers=auth("SECOND-UNKNOWN-TOKEN")
    )
    assert resp.status_code == 404
    assert resp.json() == local_body
    assert fake_upstream.requests == []  # never got far enough to attempt the upstream call


async def test_fallback_disabled_unresolvable_token_on_spa_catchall_is_plain_local_404(wired_upstream, fake_upstream):
    """Companion to the test above with the toggle OFF: the same request must
    still be the plain local 404 either way -- with fallback disabled the
    middleware short-circuits before ever attempting an identity lookup, so
    an unresolvable token is irrelevant."""
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


async def test_fallback_unmatched_path_unknown_token_never_binds_or_creates_a_user(wired_upstream, fake_upstream):
    """Regression: enabling the toggle used to let an UNMATCHED allowlisted
    path's fallback attempt bootstrap/bind the default user's credential to
    whatever token was presented, since `fetch_upstream_fallback` re-called
    `app/auth.py`'s `resolve_user` -- which is not a pure lookup. On a
    completely fresh instance (no user ever created), a GET carrying an
    unknown ("not a real Apify credential") bearer token to an unmatched
    allowlisted path must 404 exactly as before AND leave the user table
    untouched: a token matching no existing user has nothing to forward, so
    the whole attempt must collapse to the local 404 with zero state
    mutation, never a bind. Upstream is stubbed to fail (401) -- as a
    placeholder token genuinely would against the real platform -- so the
    OLD, buggy code's own bind-then-forward-then-fail sequence still ends in
    a 404, making the DB-state assertion below the only thing that tells the
    two behaviours apart."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    fake_upstream.set_response(401, b'{"error":{"message":"bad token"}}')

    before = (await client.get("/v2/users")).json()["data"]["items"]
    assert before == []

    resp = await client.get(
        "/v2/actors/someuser~someactor/no-such-nested-path", headers=auth("GARBAGE-TOKEN")
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["type"] == "record-not-found"
    assert fake_upstream.requests == []  # nothing to forward -- never even attempted

    after = (await client.get("/v2/users")).json()["data"]["items"]
    assert after == []  # no user created or bound as a side effect


async def test_fallback_unmatched_path_known_token_still_forwards_it(wired_upstream, fake_upstream):
    """Companion to the test above: on the same unmatched-allowlisted-path
    branch, a token that DOES match an existing user's bound credential must
    still be forwarded exactly as before -- the pure-lookup fix only changes
    the unmatched-token case, never this one."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    await _create_user(client, "alice")  # alice.token == "alice"
    fake_upstream.set_response(200, b"[]", {"content-type": "application/json"})

    resp = await client.get("/v2/actors/someuser~someactor/no-such-nested-path", headers=auth("alice"))
    assert resp.status_code == 200
    assert len(fake_upstream.requests) == 1
    assert fake_upstream.requests[0]["headers"].get("authorization") == "Bearer alice"


async def test_fallback_non_invalid_token_fault_during_identity_resolution_collapses_to_local_404(
    wired_upstream, fake_upstream, monkeypatch
):
    """Regression: `fetch_upstream_fallback`'s failure boundary used to only
    catch `InvalidTokenError` (plus the upstream-call exceptions) -- any OTHER
    fault raised while resolving the caller's identity, e.g. a transient DB
    error from `Service.get_user`, escaped uncaught as a raw 500
    (`ServerErrorMiddleware`'s generic "Internal Server Error"), never the
    original local 404 the module's own contract promises for "any failure"
    on this path. `svc.get_user` raising a plain `RuntimeError` stands in for
    that DB fault; with one broad `except Exception` covering the whole
    fallback attempt, this must collapse to the exact same local 404 as if
    fallback were off."""
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


async def test_fallback_enabled_local_write_success_is_unaffected_and_not_proxied(wired_upstream, fake_upstream):
    """The middleware's body-buffering branch (`body = await request.body()`
    before `call_next`) runs for every allowlisted write while the toggle is
    on -- including the common case where the write actually SUCCEEDS locally
    (e.g. writing to a storage the caller already owns), the arm every real
    Actor write takes. That case must never reach `fetch_upstream_fallback`
    at all (only a local 404 does), and pre-reading the body for a possible
    replay must not corrupt what the handler itself receives: read the write
    back and confirm it round-tripped intact."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    await _create_user(client, "gwen")
    await client.post("/v2/key-value-stores", json={"name": "mine"}, headers=auth("gwen"))

    resp = await client.put(
        "/v2/key-value-stores/gwen~mine/records/K",
        content=json.dumps({"hello": "world"}),
        headers={**auth("gwen"), "content-type": "application/json"},
    )
    assert resp.status_code == 200
    assert fake_upstream.requests == []

    readback = await client.get("/v2/key-value-stores/gwen~mine/records/K", headers=auth("gwen"))
    assert readback.status_code == 200
    assert readback.json() == {"hello": "world"}


# Base URL normalization (a trailing slash on `APIFY_UPSTREAM_BASE_URL`
# producing a double slash in the outgoing path) is pinned at the one
# boundary every construction path goes through --
# `test_config.py::test_load_settings_strips_trailing_slash_from_upstream_base_url`
# -- rather than here: `http.server`'s own request parser collapses a
# doubled `//` before a stub handler ever sees it (a CVE mitigation,
# gh-87389), so a same-request test built on one cannot discriminate this
# fix from its absence, only a real HTTP capture (out of scope for this
# Docker-free suite) or a `Settings`-construction-boundary pin can.


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


async def test_fallback_forwards_real_token_not_container_token(wired_upstream, fake_upstream):
    """`resolve_forwardable_token`'s own documented contract (see its
    docstring in app/auth.py): `user_for_token` matches either a user's bound
    `token` OR their `container_token` -- so an Actor container's own
    injected `APIFY_TOKEN` also resolves a caller here -- but the row's own
    real `token` is what must be forwarded upstream, never the container
    token that happened to resolve it. Authenticate this fallback-triggering
    request via alice's `container_token` (exactly as an apify-sdk call made
    from inside her Actor's own container would present it) and confirm the
    upstream call carries alice's real bound `token`, never the
    container_token used to authenticate."""
    client, service = wired_upstream
    service.upstream_fallback_enabled = True
    await _create_user(client, "alice")  # alice.token == "alice"
    container_token = await service.container_token_for("alice")
    assert container_token != "alice"
    fake_upstream.set_response(200, b"[]", {"content-type": "application/json"})

    resp = await client.get("/v2/datasets/alice~nonexistent/items", headers=auth(container_token))
    assert resp.status_code == 200
    assert len(fake_upstream.requests) == 1
    assert fake_upstream.requests[0]["headers"].get("authorization") == "Bearer alice"


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
    client, _service = wired_upstream
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
