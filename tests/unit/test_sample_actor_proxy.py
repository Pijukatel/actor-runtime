"""Direct-import coverage for ``sample_actor_proxy/main.py``: the sample
Actor whose ``proxyConfiguration`` input is resolved the same way
``Actor.create_proxy_configuration`` resolves the platform proxy editor's
object (Apify Proxy via ``useApifyProxy``/``apifyProxyGroups``/
``apifyProxyCountry`` built from the ``APIFY_PROXY_*`` env vars, generic
proxies via ``proxyUrls`` with round-robin rotation, no proxy otherwise).

Loads and runs the real, unmodified script directly (stdlib-only code, like
``sample_actor``), monkeypatching its single ``http_get`` seam so no test
ever touches the network. Also locks in the no-credential-leak guarantee:
neither the Apify Proxy password nor userinfo from custom ``proxyUrls`` may
appear anywhere in the Actor's OUTPUT, dataset items, or printed log.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
MAIN_PY = REPO / "sample_actor_proxy" / "main.py"

PASSWORD = "secret-proxy-password"


def _load_main_module():
    """Fresh module object per call (isolated ``STORAGE`` global) -- avoids
    any cross-test state leaking through Python's module cache."""
    spec = importlib.util.spec_from_file_location("sample_actor_proxy_main_under_test", MAIN_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _prepare(tmp_path: Path, actor_input: dict):
    module = _load_main_module()
    module.STORAGE = tmp_path
    kv = tmp_path / "key_value_stores" / "default"
    kv.mkdir(parents=True)
    (kv / "INPUT.json").write_text(json.dumps(actor_input))
    return module, kv


def _run(tmp_path: Path, actor_input: dict) -> dict:
    module, kv = _prepare(tmp_path, actor_input)
    module.main()
    return json.loads((kv / "OUTPUT.json").read_text())


def _dataset_items(tmp_path: Path) -> list:
    ds_dir = tmp_path / "datasets" / "default"
    return [json.loads(p.read_text()) for p in sorted(ds_dir.iterdir())]


@pytest.fixture(autouse=True)
def _clean_proxy_env(monkeypatch):
    """Isolate every test from the host's own proxy-related environment."""
    for var in (
        "APIFY_PROXY_PASSWORD",
        "APIFY_PROXY_HOSTNAME",
        "APIFY_PROXY_PORT",
        "APIFY_PROXY_STATUS_URL",
    ):
        monkeypatch.delenv(var, raising=False)


def _connected_http_get(calls: list):
    """A fake ``http_get`` that records calls and answers the Apify Proxy
    status check with ``connected: true``."""

    def fake(url, proxy_url, timeout):
        calls.append({"url": url, "proxy_url": proxy_url, "timeout": timeout})
        return 200, json.dumps({"connected": True, "clientIp": "203.0.113.7"}).encode()

    return fake


# -- no proxy ---------------------------------------------------------------

def test_no_proxy_configuration_resolves_to_none(tmp_path):
    output = _run(tmp_path, {})
    assert output["status"] == "ok"
    assert output["proxy"] == {"used": "none", "proxyUrls": [], "username": None, "accessCheck": None}
    assert output["fetch"] is None
    assert _dataset_items(tmp_path) == [{"proxyUrl": None, "kind": "none", "index": 1}]


def test_use_apify_proxy_false_without_urls_resolves_to_none(tmp_path):
    """The SDK contract: ``useApifyProxy: false`` with no ``proxyUrls`` means
    "no proxy", not an error (this is what the platform's proxy editor sends
    when the user unchecks everything)."""
    output = _run(tmp_path, {"proxyConfiguration": {"useApifyProxy": False}})
    assert output["proxy"]["used"] == "none"


# -- Apify Proxy ------------------------------------------------------------

def test_apify_proxy_builds_platform_url_and_masks_password(tmp_path, monkeypatch):
    monkeypatch.setenv("APIFY_PROXY_PASSWORD", PASSWORD)
    module, kv = _prepare(
        tmp_path,
        {
            "proxyConfiguration": {
                "useApifyProxy": True,
                "apifyProxyGroups": ["RESIDENTIAL", "SHADER"],
                "apifyProxyCountry": "US",
            }
        },
    )
    calls: list = []
    monkeypatch.setattr(module, "http_get", _connected_http_get(calls))
    module.main()
    output = json.loads((kv / "OUTPUT.json").read_text())

    # The SDK's username scheme and URL shape, with defaults for host/port.
    assert output["proxy"]["used"] == "apify"
    assert output["proxy"]["username"] == "groups-RESIDENTIAL+SHADER,country-US"
    assert output["proxy"]["proxyUrls"] == [
        "http://groups-RESIDENTIAL+SHADER,country-US:***@proxy.apify.com:8000"
    ]
    assert output["proxy"]["accessCheck"] == {"performed": True, "connected": True, "note": "ok"}
    assert output["apifyProxyEnv"]["passwordSet"] is True

    # The access check went to the status page THROUGH the real (unmasked) URL.
    assert calls[0]["url"] == "http://proxy.apify.com/?format=json"
    assert calls[0]["proxy_url"] == f"http://groups-RESIDENTIAL+SHADER,country-US:{PASSWORD}@proxy.apify.com:8000"

    # The password appears nowhere in anything the Actor persisted.
    persisted = (kv / "OUTPUT.json").read_text() + json.dumps(_dataset_items(tmp_path))
    assert PASSWORD not in persisted


def test_apify_proxy_without_options_uses_auto_username(tmp_path, monkeypatch):
    monkeypatch.setenv("APIFY_PROXY_PASSWORD", PASSWORD)
    module, kv = _prepare(tmp_path, {"proxyConfiguration": {"useApifyProxy": True}})
    monkeypatch.setattr(module, "http_get", _connected_http_get([]))
    module.main()
    output = json.loads((kv / "OUTPUT.json").read_text())
    assert output["proxy"]["username"] == "auto"
    assert output["proxy"]["proxyUrls"] == ["http://auto:***@proxy.apify.com:8000"]


def test_apify_proxy_honours_runtime_env_overrides(tmp_path, monkeypatch):
    """Hostname/port/status URL come from the env the runtime injected, so a
    non-default proxy deployment is honoured exactly like the SDK would."""
    monkeypatch.setenv("APIFY_PROXY_PASSWORD", PASSWORD)
    monkeypatch.setenv("APIFY_PROXY_HOSTNAME", "proxy.example.com")
    monkeypatch.setenv("APIFY_PROXY_PORT", "9000")
    monkeypatch.setenv("APIFY_PROXY_STATUS_URL", "http://status.example.com")
    module, kv = _prepare(tmp_path, {"proxyConfiguration": {"useApifyProxy": True}})
    calls: list = []
    monkeypatch.setattr(module, "http_get", _connected_http_get(calls))
    module.main()
    output = json.loads((kv / "OUTPUT.json").read_text())
    assert output["proxy"]["proxyUrls"] == ["http://auto:***@proxy.example.com:9000"]
    assert calls[0]["url"] == "http://status.example.com/?format=json"


def test_apify_proxy_missing_password_fails_with_clear_message(tmp_path, capsys):
    """No APIFY_PROXY_PASSWORD (the runtime got none from the user): the run
    fails with the SDK's own missing-password message -- the same outcome a
    platform run with a broken password credential gets -- and no OUTPUT is
    written."""
    module, kv = _prepare(tmp_path, {"proxyConfiguration": {"useApifyProxy": True}})
    with pytest.raises(SystemExit) as exc_info:
        module.main()
    assert exc_info.value.code == 1
    out = capsys.readouterr().out
    assert "APIFY_PROXY_PASSWORD" in out
    assert not (kv / "OUTPUT.json").exists()


def test_apify_proxy_access_check_connected_false_fails_run(tmp_path, monkeypatch, capsys):
    """A reachable status page answering ``connected: false`` (e.g. a wrong
    password) fails the run with the page's own connectionError -- mirroring
    the SDK's hard ConnectionError, unlike the unreachable case below."""
    monkeypatch.setenv("APIFY_PROXY_PASSWORD", PASSWORD)
    module, kv = _prepare(tmp_path, {"proxyConfiguration": {"useApifyProxy": True}})

    def refused(url, proxy_url, timeout):
        return 200, json.dumps({"connected": False, "connectionError": "Invalid password"}).encode()

    monkeypatch.setattr(module, "http_get", refused)
    with pytest.raises(SystemExit):
        module.main()
    assert "Invalid password" in capsys.readouterr().out
    assert not (kv / "OUTPUT.json").exists()


def test_apify_proxy_access_check_unreachable_is_warning_only(tmp_path, monkeypatch, capsys):
    """An unreachable status page (offline/firewalled host) must NOT fail the
    run -- the SDK only warns. It retries exactly the SDK's two attempts."""
    monkeypatch.setenv("APIFY_PROXY_PASSWORD", PASSWORD)
    module, kv = _prepare(tmp_path, {"proxyConfiguration": {"useApifyProxy": True}})
    attempts: list = []

    def unreachable(url, proxy_url, timeout):
        attempts.append(url)
        raise OSError("connection refused")

    monkeypatch.setattr(module, "http_get", unreachable)
    module.main()
    output = json.loads((kv / "OUTPUT.json").read_text())
    assert output["status"] == "ok"
    assert output["proxy"]["accessCheck"]["connected"] is None
    assert len(attempts) == 2
    assert "WARNING" in capsys.readouterr().out


# -- generic (custom) proxies ------------------------------------------------

def test_custom_proxy_urls_rotate_round_robin_and_mask_credentials(tmp_path):
    urls = [
        "http://alice:hunter2@proxy-one.example.com:8000",
        "http://proxy-two.example.com:8000",
        "https://bob:hunter3@proxy-three.example.com:9000",
    ]
    output = _run(
        tmp_path, {"proxyConfiguration": {"useApifyProxy": False, "proxyUrls": urls}}
    )
    assert output["proxy"]["used"] == "custom"
    assert output["proxy"]["username"] is None
    assert output["proxy"]["accessCheck"] is None  # SDK: no access check for custom proxies
    masked = [
        "http://alice:***@proxy-one.example.com:8000",
        "http://proxy-two.example.com:8000",
        "https://bob:***@proxy-three.example.com:9000",
    ]
    assert output["proxy"]["proxyUrls"] == masked
    # Dataset shows one item per URL in the SDK's round-robin rotation order.
    assert _dataset_items(tmp_path) == [
        {"proxyUrl": masked[i], "kind": "custom", "index": i + 1} for i in range(3)
    ]
    persisted = json.dumps(output) + json.dumps(_dataset_items(tmp_path))
    assert "hunter2" not in persisted and "hunter3" not in persisted
    # The echoed input masks credentials too.
    assert output["receivedInput"]["proxyConfiguration"]["proxyUrls"] == masked


def test_custom_proxy_new_url_rotation_wraps_around(tmp_path):
    """``new_url``'s round-robin must wrap: after the last URL it hands out
    the first again, exactly like the SDK's rotation."""
    module = _load_main_module()
    config = {"kind": "custom", "urls": ["http://a:1", "http://b:2"], "username": None}
    state: dict = {}
    picked = [module.new_url(config, state) for _ in range(4)]
    assert picked == ["http://a:1", "http://b:2", "http://a:1", "http://b:2"]


def test_invalid_proxy_url_fails_run_without_leaking_credentials(tmp_path, capsys):
    output_input = {"proxyConfiguration": {"useApifyProxy": False, "proxyUrls": ["ftp://user:pw@x:1"]}}
    module, kv = _prepare(tmp_path, output_input)
    with pytest.raises(SystemExit):
        module.main()
    out = capsys.readouterr().out
    assert "Invalid proxy URL" in out
    assert "pw@" not in out  # the credential from the rejected URL never prints
    assert ":***@" in out


def test_invalid_group_and_country_fail_run(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("APIFY_PROXY_PASSWORD", PASSWORD)
    module, _ = _prepare(
        tmp_path,
        {"proxyConfiguration": {"useApifyProxy": True, "apifyProxyGroups": ["not a group!"]}},
    )
    with pytest.raises(SystemExit):
        module.main()
    assert "apifyProxyGroups" in capsys.readouterr().out

    module, _ = _prepare(
        tmp_path / "country", {"proxyConfiguration": {"useApifyProxy": True, "apifyProxyCountry": "usa"}}
    )
    with pytest.raises(SystemExit):
        module.main()
    assert "apifyProxyCountry" in capsys.readouterr().out


def test_malformed_proxy_configuration_fails_run(tmp_path, capsys):
    module, _ = _prepare(tmp_path, {"proxyConfiguration": "not-an-object"})
    with pytest.raises(SystemExit):
        module.main()
    assert "must be an object" in capsys.readouterr().out


# -- the proxied fetch -------------------------------------------------------

def test_target_url_fetched_through_custom_proxy(tmp_path, monkeypatch):
    module, kv = _prepare(
        tmp_path,
        {
            "proxyConfiguration": {
                "useApifyProxy": False,
                "proxyUrls": ["http://alice:hunter2@proxy-one.example.com:8000"],
            },
            "targetUrl": "https://api.apify.com/v2/browser-info",
        },
    )
    calls: list = []

    def fake(url, proxy_url, timeout):
        calls.append({"url": url, "proxy_url": proxy_url})
        return 200, b'{"clientIp": "203.0.113.7"}'

    monkeypatch.setattr(module, "http_get", fake)
    module.main()
    output = json.loads((kv / "OUTPUT.json").read_text())
    # The real fetch used the real (unmasked) proxy URL; OUTPUT records the
    # masked one plus the response.
    assert calls == [
        {
            "url": "https://api.apify.com/v2/browser-info",
            "proxy_url": "http://alice:hunter2@proxy-one.example.com:8000",
        }
    ]
    assert output["fetch"]["viaProxy"] == "http://alice:***@proxy-one.example.com:8000"
    assert output["fetch"]["status"] == 200
    assert "203.0.113.7" in output["fetch"]["bodyPreview"]
    assert "hunter2" not in (kv / "OUTPUT.json").read_text()


def test_target_url_fetched_directly_without_proxy(tmp_path, monkeypatch):
    module, kv = _prepare(tmp_path, {"targetUrl": "https://example.com/"})
    calls: list = []

    def fake(url, proxy_url, timeout):
        calls.append({"url": url, "proxy_url": proxy_url})
        return 200, b"ok"

    monkeypatch.setattr(module, "http_get", fake)
    module.main()
    output = json.loads((kv / "OUTPUT.json").read_text())
    assert calls[0]["proxy_url"] is None
    assert output["fetch"]["viaProxy"] is None


def test_failed_fetch_fails_run_with_masked_error(tmp_path, monkeypatch, capsys):
    module, kv = _prepare(
        tmp_path,
        {
            "proxyConfiguration": {
                "useApifyProxy": False,
                "proxyUrls": ["http://alice:hunter2@proxy-one.example.com:8000"],
            },
            "targetUrl": "https://example.com/",
        },
    )

    def failing(url, proxy_url, timeout):
        # urllib-style failure that quotes the full proxy URL, credentials
        # included -- exactly what scrub_secrets exists to mask.
        raise OSError(f"cannot connect to {proxy_url}")

    monkeypatch.setattr(module, "http_get", failing)
    with pytest.raises(SystemExit):
        module.main()
    out = capsys.readouterr().out
    assert "hunter2" not in out
    assert "http://alice:***@proxy-one.example.com:8000" in out
    assert not (kv / "OUTPUT.json").exists()
