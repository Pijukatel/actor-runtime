"""Mandatory end-to-end test: real apify-cli against a real running runtime.

Flow: scaffold sample Actor -> ``apify push`` (creates Actor + version and builds
it) -> ``apify call`` (runs it) -> fetch the run's key-value store, dataset and
request queue over the API and assert the Actor's written data is present.

Requires Docker and apify-cli; skips cleanly if either is unavailable so the
unit suite can still run in constrained environments. ``scripts/run-tests.sh``
provides both.
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
    # World-writable so the sibling Actor containers can write their storage.
    os.chmod(data_dir, 0o777)
    api_port = _free_port()
    console_port = _free_port()
    name = f"actor-runtime-e2e-{uuid.uuid4().hex[:8]}"

    subprocess.run(
        [
            "docker", "run", "-d", "--name", name,
            "-v", "/var/run/docker.sock:/var/run/docker.sock",
            "-v", f"{data_dir}:{data_dir}",
            "-e", f"DATA_DIR={data_dir}",
            "-e", f"HOST_DATA_DIR={data_dir}",
            "-p", f"{api_port}:3333",
            "-p", f"{console_port}:3000",
            RUNTIME_IMAGE,
        ],
        check=True,
        capture_output=True,
    )
    api_url = f"http://localhost:{api_port}"
    console_url = f"http://localhost:{console_port}"
    try:
        _wait_ready(api_url)
        yield {"api": api_url, "console": console_url, "name": name, "data_dir": data_dir}
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


def test_startup_prints_two_labelled_urls(runtime):
    logs = subprocess.run(
        ["docker", "logs", runtime["name"]], capture_output=True, text=True
    ).stdout + subprocess.run(
        ["docker", "logs", runtime["name"]], capture_output=True, text=True
    ).stderr
    assert "API URL:" in logs
    assert "Console URL:" in logs
    assert logs.count("http://localhost:") >= 2


def test_console_and_api_reachable_without_auth(runtime):
    console = httpx.get(runtime["console"] + "/", timeout=5)
    assert console.status_code == 200 and "Actor Runtime Console" in console.text
    api = httpx.get(runtime["api"] + "/v2/acts", timeout=5)
    assert api.status_code == 200


def test_full_dev_loop(runtime, tmp_path):
    api = runtime["api"]
    env = _apify_env(api)

    project = tmp_path / "sample-actor"
    shutil.copytree(REPO / "sample_actor", project)

    # 1) push -> creates Actor + version and builds it (apify push triggers a build).
    push = subprocess.run(
        ["apify", "push", "--force"],
        cwd=project, env=env, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=300,
    )
    assert push.returncode == 0, f"apify push failed:\n{push.stdout}\n{push.stderr}"

    # 2) Actor and its source are present in the runtime.
    actor = httpx.get(f"{api}/v2/actors/local-user~sample-actor", timeout=10).json()["data"]
    assert actor["name"] == "sample-actor"
    version = httpx.get(f"{api}/v2/actors/local-user~sample-actor/versions/0.0", timeout=10).json()["data"]
    assert any(f["name"] == "main.py" for f in version["sourceFiles"])

    # 3) build reached SUCCEEDED and produced an image.
    builds = httpx.get(f"{api}/v2/acts/local-user~sample-actor/builds", timeout=10).json()["data"]["items"]
    assert builds and builds[0]["status"] == "SUCCEEDED", f"builds: {builds}"

    # 4) run via the CLI.
    call = subprocess.run(
        ["apify", "call", "-i", json.dumps({"greeting": "howdy"})],
        cwd=project, env=env, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=300,
    )
    assert call.returncode == 0, f"apify call failed:\n{call.stdout}\n{call.stderr}"

    # 5) find the finished run.
    runs = httpx.get(f"{api}/v2/acts/local-user~sample-actor/runs", timeout=10).json()["data"]["items"]
    assert runs, "no runs recorded"
    run = _wait_run_terminal(api, runs[0]["id"])
    assert run["status"] == "SUCCEEDED", f"run: {run}"

    kv_id = run["defaultKeyValueStoreId"]
    ds_id = run["defaultDatasetId"]
    rq_id = run["defaultRequestQueueId"]

    # 6) fetch all three default storages and assert the Actor's data landed.
    output = httpx.get(f"{api}/v2/key-value-stores/{kv_id}/records/OUTPUT", timeout=10).json()
    assert output["greeting"] == "howdy"
    assert output["receivedInput"] == {"greeting": "howdy"}

    items = httpx.get(f"{api}/v2/datasets/{ds_id}/items", timeout=10).json()
    assert items == [{"message": "howdy world", "index": 1}]

    meta = httpx.get(f"{api}/v2/request-queues/{rq_id}", timeout=10).json()["data"]
    assert meta["totalRequestCount"] == 1
    reqs = httpx.get(f"{api}/v2/request-queues/{rq_id}/requests", timeout=10).json()["data"]["items"]
    assert reqs[0]["url"] == "https://example.com/from-actor"


def _wait_run_terminal(api: str, run_id: str, timeout: int = 120) -> dict:
    deadline = time.time() + timeout
    run = {}
    while time.time() < deadline:
        run = httpx.get(f"{api}/v2/actor-runs/{run_id}", timeout=10).json()["data"]
        if run["status"] in {"SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"}:
            return run
        time.sleep(2)
    return run
