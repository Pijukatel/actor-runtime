"""Offline coverage for ``sample_actor_crawler/main.py``'s proxy-configuration
branching. These tests pin the SDK's actual omitted-``proxyConfiguration``
semantics -- omitted is equivalent to an explicit ``useApifyProxy: true``, and
never falls back to a direct (proxy-less) crawl -- so the sample's docs and
code cannot silently drift from real ``apify`` SDK behaviour.

``sample_actor_crawler/main.py`` imports ``crawlee.crawlers.ParselCrawler``,
which needs the optional ``parsel`` package (pulled in via
``crawlee[parsel]`` in the Actor's own ``.actor/Dockerfile``, not in this
repo's ``requirements-dev.txt``). ``parsel`` is not installed in this venv,
so importing ``main.py`` directly, or running it as a subprocess the way
``tests/unit/test_sample_actor.py`` runs ``sample_actor/main.py``, is not
possible here without adding a new dependency purely to satisfy one branch
-- so these tests call the real ``apify`` SDK's
``Actor.create_proxy_configuration`` directly instead, avoiding both the
subprocess and the ``parsel`` dev dependency entirely.

``main.py``'s proxy handling is a single, uncustomized passthrough (see
``test_main_py_still_passes_proxy_configuration_straight_through`` below,
which pins this claim against the file's actual source):

    proxy_configuration = await Actor.create_proxy_configuration(
        actor_proxy_input=actor_input.get("proxyConfiguration")
    )

-- no fallback, no try/except (a deliberate design decision, not an
oversight). So calling the real ``apify`` SDK's
``Actor.create_proxy_configuration`` with exactly the values
``actor_input.get("proxyConfiguration")`` would produce for each input shape
tests the sample's real, documented behaviour fully offline, without needing
``parsel`` or a real crawl:

- an explicit ``{"useApifyProxy": false}`` (no ``proxyUrls``) returns
  ``None`` immediately -- no ``ProxyConfiguration`` is even constructed, so
  this is trivially offline.
- ``actor_proxy_input=None`` (an *omitted* ``proxyConfiguration``) falls
  through to the SDK's own default ``ProxyConfiguration``, whose
  ``initialize()`` raises ``ValueError`` when no password is available.
  This is also fully offline: ``ProxyConfiguration._maybe_fetch_password()``
  only calls the Apify API when an ``APIFY_TOKEN`` is present (verified by
  reading ``apify/_proxy_configuration.py`` directly), and these tests strip
  every ambient ``APIFY_``/``CRAWLEE_`` env var first, exactly like
  ``test_sample_actor.py``'s ``_run`` helper does for the same reason.
"""
from __future__ import annotations

import ast
import json
import os
from pathlib import Path

import pytest
from apify import Actor, Configuration
from crawlee._service_locator import service_locator

REPO = Path(__file__).resolve().parents[2]
CRAWLER_DIR = REPO / "sample_actor_crawler"
MAIN_PY = CRAWLER_DIR / "main.py"
INPUT_SCHEMA = json.loads((CRAWLER_DIR / ".actor" / "input_schema.json").read_text())
SCHEMA_DEFAULT_PROXY_CONFIGURATION = INPUT_SCHEMA["properties"]["proxyConfiguration"]["default"]

NO_PASSWORD_ERROR = "Apify Proxy password must be provided"


@pytest.fixture(autouse=True)
def _isolated_service_locator():
    """crawlee's global ``service_locator`` singleton refuses to accept a
    second, different ``Configuration`` once one has already been set
    (raises ``ServiceConflictError``) -- exactly what happens across this
    module's several ``async with Actor(configuration=...):`` blocks below,
    each pointed at its own scratch ``tmp_path``. ``Actor.__aenter__`` is the
    only thing in this repo's test suite that calls
    ``service_locator.set_configuration`` (``KeyValueStore.open``/
    ``Dataset.open`` in ``test_sample_actor.py`` use their explicitly-passed
    ``configuration``/``storage_client`` directly, never touching the
    singleton), so resetting it here cannot affect any other test file.
    Mirrors the isolation the apify SDK's own test suite applies via its
    ``_isolate_test_environment`` fixture (this repo has no such fixture of
    its own to reuse)."""
    original = (service_locator._configuration, service_locator._event_manager, service_locator._storage_client)
    service_locator._configuration = None
    service_locator._event_manager = None
    service_locator._storage_client = None
    yield
    service_locator._configuration, service_locator._event_manager, service_locator._storage_client = original


async def _create_proxy_configuration(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, actor_proxy_input):
    """Call the real ``apify`` SDK's ``Actor.create_proxy_configuration`` the
    exact way ``sample_actor_crawler/main.py`` does, against a throwaway
    ``Actor`` instance (``exit_process=False`` so it never calls
    ``sys.exit()`` on the way out -- see ``_ActorType.__aexit__`` --, unlike
    the module-level ``Actor`` singleton a real run uses) pointed at a
    scratch storage directory.

    Strips every ambient ``APIFY_``/``CRAWLEE_`` env var first (mirroring
    ``test_sample_actor.py``'s ``_run`` helper) so ``Actor.is_at_home()`` is
    guaranteed False and no stray ``APIFY_TOKEN``/``APIFY_PROXY_PASSWORD``
    from the environment this test itself runs in leaks into the call.
    """
    for key in list(os.environ):
        if key.startswith(("APIFY_", "CRAWLEE_")):
            monkeypatch.delenv(key, raising=False)

    configuration = Configuration(storage_dir=str(tmp_path))
    local_actor = Actor(configuration=configuration, exit_process=False)
    async with local_actor:
        return await local_actor.create_proxy_configuration(actor_proxy_input=actor_proxy_input)


async def test_explicit_use_apify_proxy_false_returns_none_and_crawls_direct(tmp_path, monkeypatch):
    """The sole documented way to run without credentials (see README.md's
    "Apify Proxy" section and ``input_schema.json``'s ``proxyConfiguration``
    description): an explicit ``{"useApifyProxy": false}`` (with no
    ``proxyUrls``) makes the SDK return ``None``, so ``ParselCrawler`` gets
    no proxy and crawls direct."""
    result = await _create_proxy_configuration(tmp_path, monkeypatch, {"useApifyProxy": False})
    assert result is None


async def test_omitted_proxy_configuration_is_not_a_direct_crawl(tmp_path, monkeypatch):
    """Regression guard against the false belief that an omitted
    ``proxyConfiguration`` crawls direct: omitting it entirely
    (``actor_input.get("proxyConfiguration")`` evaluates to ``None``) does
    NOT behave like ``useApifyProxy: false`` -- it falls through to the
    SDK's own default ``ProxyConfiguration``, which assumes Apify Proxy,
    exactly like an explicit ``useApifyProxy: true``. With no
    ``APIFY_PROXY_PASSWORD`` and no ``APIFY_TOKEN`` (so the SDK cannot fetch
    one either), that default configuration's ``initialize()`` raises
    ``ValueError`` -- fully offline; no network call is attempted."""
    with pytest.raises(ValueError, match=NO_PASSWORD_ERROR):
        await _create_proxy_configuration(tmp_path, monkeypatch, None)


async def test_schema_default_proxy_configuration_behaves_like_omitted(tmp_path, monkeypatch):
    """The schema's own default (read from the real, on-disk
    ``input_schema.json``: ``useApifyProxy: true``,
    ``apifyProxyGroups: ["RESIDENTIAL"]``) is an *explicit*
    ``useApifyProxy: true``, not an omission -- it must fail the exact same
    way as the omitted case above when no password is available, directly
    proving the documented "omitted behaves like an explicit
    useApifyProxy: true" claim rather than merely asserting it in prose."""
    assert SCHEMA_DEFAULT_PROXY_CONFIGURATION == {
        "useApifyProxy": True,
        "apifyProxyGroups": ["RESIDENTIAL"],
    }
    with pytest.raises(ValueError, match=NO_PASSWORD_ERROR):
        await _create_proxy_configuration(tmp_path, monkeypatch, SCHEMA_DEFAULT_PROXY_CONFIGURATION)


def test_main_py_still_passes_proxy_configuration_straight_through():
    """Pins the three tests above to ``main.py``'s actual source via its AST
    (immune to reformatting -- unlike a source-text regex, this survives an
    ``oxfmt``/``ruff format`` reflow of the call). If this call site ever
    grows a fallback -- e.g.
    ``actor_input.get("proxyConfiguration") or {"useApifyProxy": False}`` --
    or gets wrapped in a ``try``/``except``, this test fails, flagging that
    the offline tests above no longer represent ``main.py``'s real, no-
    fallback behaviour."""
    tree = ast.parse(MAIN_PY.read_text(), filename=str(MAIN_PY))

    try_line_ranges = [(node.lineno, node.end_lineno) for node in ast.walk(tree) if isinstance(node, ast.Try)]
    call_node = next(
        (
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "create_proxy_configuration"
        ),
        None,
    )
    assert call_node is not None, "expected a call to Actor.create_proxy_configuration in main.py"
    assert not any(start <= call_node.lineno <= end for start, end in try_line_ranges), (
        "Actor.create_proxy_configuration must not be wrapped in a try/except (no-fallback design decision)"
    )

    keywords = {kw.arg: kw.value for kw in call_node.keywords}
    assert set(keywords) == {"actor_proxy_input"}, f"unexpected call signature: {ast.dump(call_node)}"

    passthrough = keywords["actor_proxy_input"]
    is_plain_get = (
        isinstance(passthrough, ast.Call)
        and isinstance(passthrough.func, ast.Attribute)
        and passthrough.func.attr == "get"
        and isinstance(passthrough.func.value, ast.Name)
        and passthrough.func.value.id == "actor_input"
        and len(passthrough.args) == 1
        and isinstance(passthrough.args[0], ast.Constant)
        and passthrough.args[0].value == "proxyConfiguration"
    )
    assert is_plain_get, (
        'expected a straight actor_input.get("proxyConfiguration") passthrough with no fallback default, '
        f"got: {ast.dump(passthrough)}"
    )
