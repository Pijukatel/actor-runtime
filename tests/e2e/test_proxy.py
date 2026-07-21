"""End-to-end test for platform-style proxy behavior: a runtime started with
a user-populated ``APIFY_PROXY_PASSWORD`` injects the platform's
``APIFY_PROXY_*`` variables into a real Actor container, and the
``sample_actor_proxy`` fixture resolves its platform-shaped
``proxyConfiguration`` input (the object the platform's ``"editor": "proxy"``
widget produces) exactly like ``Actor.create_proxy_configuration`` -- here
exercising the generic-proxy branch (``proxyUrls``), which needs no network
egress and no real Apify Proxy account, so the test stays deterministic. The
Apify Proxy branch's URL building, password requirement and access check are
covered by unit tests (``tests/unit/test_sample_actor_proxy.py``); its env
plumbing (password/hostname/port reaching the container) is asserted HERE,
through the fixture Actor's own ``apifyProxyEnv`` OUTPUT echo.

Requires Docker and apify-cli, exactly like ``tests/e2e/test_e2e.py`` (see
that file's docstring for the shared skip/harness pattern this mirrors). Uses
its OWN runtime instance -- started with the proxy env vars under test --
rather than importing another file's fixture, so the e2e files stay fully
independent (mirroring ``test_standby.py``/``test_isathome.py``).
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
import uuid
from pathlib import Path

import httpx
import pytest

REPO = Path(__file__).resolve().parents[2]
RUNTIME_IMAGE = os.environ.get("RUNTIME_IMAGE", "actor-runtime:test")

# The password the "user" populated on the runtime container; must reach the
# Actor container as APIFY_PROXY_PASSWORD -- and must never surface in the
# run's stored OUTPUT or log.
PROXY_PASSWORD = "e2e-proxy-password"
# Userinfo credential inside a custom proxy URL; same never-surfaces rule.
CUSTOM_PROXY_SECRET = "custom-proxy-secret"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _have(cmd: list[str]) -> bool:
    try:
        subprocess.run(cmd, capture_output=True, check=True)
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _have(["docker", "version"]) or shutil.which("apify") is None,
    reason="requires Docker daemon and apify-cli on PATH",
)


@pytest.fixture(scope="module")
def runtime(tmp_path_factory):
    data_dir = tmp_path_factory.mktemp("runtime-data")
    # World-writable so the sibling Actor container can write its storage.
    os.chmod(data_dir, 0o777)
    api_port = _free_port()
    console_port = _free_port()
    name = f"actor-runtime-proxy-e2e-{uuid.uuid4().hex[:8]}"

    subprocess.run(
        [
            "docker", "run", "-d", "--name", name,
            "-v", "/var/run/docker.sock:/var/run/docker.sock",
            "-v", f"{data_dir}:{data_dir}",
            "-e", f"DATA_DIR={data_dir}",
            "-e", f"HOST_DATA_DIR={data_dir}",
            # The proxy wiring under test: the user populates this variable
            # with their own Apify Proxy password (README's proxy section).
            "-e", f"APIFY_PROXY_PASSWORD={PROXY_PASSWORD}",
            "-p", f"{api_port}:3333",
            "-p", f"{console_port}:3000",
            RUNTIME_IMAGE,
        ],
        check=True,
        capture_output=True,
    )
    api_url = f"http://localhost:{api_port}"
    try:
        _wait_ready(api_url)
        yield {"api": api_url, "name": name, "data_dir": data_dir}
    finally:
        subprocess.run(["docker", "logs", name], capture_output=False)
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def _wait_ready(api_url: str, timeout: int = 60) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if httpx.get(f"{api_url}/v2/users/me", timeout=2).status_code == 200:
                return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError("runtime did not become ready in time")


def _apify_env(api_url: str) -> dict:
    env = dict(os.environ)
    env.update(
        {
            "APIFY_CLIENT_BASE_URL": api_url,
            "APIFY_TOKEN": "local-user",
            "APIFY_CLI_DISABLE_TELEMETRY": "1",
            "APIFY_CLI_SKIP_UPDATE_CHECK": "1",
        }
    )
    return env


def _wait_run_terminal(api: str, run_id: str, timeout: int = 120) -> dict:
    deadline = time.time() + timeout
    run: dict = {}
    while time.time() < deadline:
        run = httpx.get(f"{api}/v2/actor-runs/{run_id}", timeout=10).json()["data"]
        if run["status"] in {"SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"}:
            return run
        time.sleep(2)
    return run


def test_proxy_sample_actor_resolves_custom_proxies_and_gets_apify_proxy_env(runtime, tmp_path):
    api = runtime["api"]
    env = _apify_env(api)

    project = tmp_path / "proxy-actor"
    shutil.copytree(REPO / "sample_actor_proxy", project)

    # 1) push -> creates Actor + version and builds it.
    push = subprocess.run(
        ["apify", "push", "--force"],
        cwd=project, env=env, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=300,
    )
    assert push.returncode == 0, f"apify push failed:\n{push.stdout}\n{push.stderr}"

    # 2) run it with a generic-proxy configuration -- the same object the
    # platform's proxy editor produces with "Custom proxies" selected. No
    # targetUrl, so the Actor only resolves and reports (no network egress).
    run_input = {
        "proxyConfiguration": {
            "useApifyProxy": False,
            "proxyUrls": [
                f"http://alice:{CUSTOM_PROXY_SECRET}@proxy-one.invalid:8000",
                "http://proxy-two.invalid:8000",
            ],
        }
    }
    call = subprocess.run(
        ["apify", "call", "-i", json.dumps(run_input)],
        cwd=project, env=env, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=300,
    )
    assert call.returncode == 0, f"apify call failed:\n{call.stdout}\n{call.stderr}"

    # 3) find the finished run.
    runs = httpx.get(f"{api}/v2/acts/local-user~sample-actor-proxy/runs", timeout=10).json()["data"]["items"]
    assert runs, "no runs recorded"
    run = _wait_run_terminal(api, runs[0]["id"])
    assert run["status"] == "SUCCEEDED", f"run: {run}"

    # 4) OUTPUT: the custom proxies resolved, credential-masked, and the
    # platform's APIFY_PROXY_* env (password included) reached the container.
    kv_id = run["defaultKeyValueStoreId"]
    output = httpx.get(f"{api}/v2/key-value-stores/{kv_id}/records/OUTPUT", timeout=10).json()
    assert output["proxy"]["used"] == "custom"
    assert output["proxy"]["proxyUrls"] == [
        "http://alice:***@proxy-one.invalid:8000",
        "http://proxy-two.invalid:8000",
    ]
    assert output["apifyProxyEnv"] == {
        "hostname": "proxy.apify.com",
        "port": "8000",
        "statusUrl": "http://proxy.apify.com",
        "passwordSet": True,
    }

    # 5) dataset: one masked item per proxy URL, in rotation order.
    ds_id = run["defaultDatasetId"]
    items = httpx.get(f"{api}/v2/datasets/{ds_id}/items", timeout=10).json()
    assert items == [
        {"proxyUrl": "http://alice:***@proxy-one.invalid:8000", "kind": "custom", "index": 1},
        {"proxyUrl": "http://proxy-two.invalid:8000", "kind": "custom", "index": 2},
    ]

    # 6) no credential ever surfaces: neither the user's Apify Proxy password
    # nor the custom proxy URL's userinfo appears in the stored OUTPUT,
    # dataset, or the run's log.
    log = httpx.get(f"{api}/v2/logs/{run['id']}", timeout=10).text
    for haystack in (json.dumps(output), json.dumps(items), log):
        assert PROXY_PASSWORD not in haystack
        assert CUSTOM_PROXY_SECRET not in haystack


def test_proxy_sample_actor_without_proxy_input_resolves_to_none(runtime, tmp_path):
    """The proxy editor's "no proxy" object resolves to no proxy at all --
    and the run still SUCCEEDs (an Actor without proxy input must keep
    working on a proxy-configured runtime)."""
    api = runtime["api"]
    env = _apify_env(api)

    project = tmp_path / "proxy-actor-none"
    shutil.copytree(REPO / "sample_actor_proxy", project)
    push = subprocess.run(
        ["apify", "push", "--force"],
        cwd=project, env=env, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=300,
    )
    assert push.returncode == 0, f"apify push failed:\n{push.stdout}\n{push.stderr}"

    call = subprocess.run(
        ["apify", "call", "-i", json.dumps({"proxyConfiguration": {"useApifyProxy": False}})],
        cwd=project, env=env, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=300,
    )
    assert call.returncode == 0, f"apify call failed:\n{call.stdout}\n{call.stderr}"

    runs = httpx.get(f"{api}/v2/acts/local-user~sample-actor-proxy/runs", timeout=10).json()["data"]["items"]
    run = _wait_run_terminal(api, runs[0]["id"])
    assert run["status"] == "SUCCEEDED", f"run: {run}"
    kv_id = run["defaultKeyValueStoreId"]
    output = httpx.get(f"{api}/v2/key-value-stores/{kv_id}/records/OUTPUT", timeout=10).json()
    assert output["proxy"]["used"] == "none"
    assert output["proxy"]["proxyUrls"] == []