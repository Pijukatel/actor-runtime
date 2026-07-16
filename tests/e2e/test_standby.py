"""Standby-actor end-to-end test: an on-demand Actor discovers and calls a
standby Actor's ``standbyUrl`` container-to-container, through a real running
runtime.

Requires Docker and apify-cli, exactly like ``tests/e2e/test_e2e.py`` (see
that file's docstring for the shared skip/harness pattern this mirrors). Uses
its OWN runtime instance rather than importing that file's fixture, so the two
e2e files stay fully independent and ``test_e2e.py`` itself needs no changes.
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
    os.chmod(data_dir, 0o777)
    api_port = _free_port()
    console_port = _free_port()
    name = f"actor-runtime-standby-e2e-{uuid.uuid4().hex[:8]}"

    subprocess.run(
        [
            "docker", "run", "-d", "--name", name,
            "-v", "/var/run/docker.sock:/var/run/docker.sock",
            "-v", f"{data_dir}:{data_dir}",
            "-e", f"DATA_DIR={data_dir}",
            "-e", f"HOST_DATA_DIR={data_dir}",
            # Near-instant idle reap so this test doesn't have to wait out the
            # 300s/5s-minimum production default to observe teardown.
            "-e", "STANDBY_IDLE_OVERRIDE_SECS=8",
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


def _push(project: Path, env: dict) -> None:
    result = subprocess.run(
        ["apify", "push", "--force"], cwd=project, env=env,
        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, f"apify push failed:\n{result.stdout}\n{result.stderr}"


def _wait_run_terminal(api: str, run_id: str, timeout: int = 120) -> dict:
    deadline = time.time() + timeout
    run: dict = {}
    while time.time() < deadline:
        run = httpx.get(f"{api}/v2/actor-runs/{run_id}", timeout=10).json()["data"]
        if run["status"] in {"SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"}:
            return run
        time.sleep(2)
    return run


def test_on_demand_actor_discovers_and_calls_standby_actor(runtime, tmp_path):
    api = runtime["api"]
    env = _apify_env(api)

    standby_project = tmp_path / "standby-actor"
    shutil.copytree(REPO / "sample_actor_standby", standby_project)
    _push(standby_project, env)

    caller_project = tmp_path / "caller-actor"
    shutil.copytree(REPO / "sample_actor_caller", caller_project)
    _push(caller_project, env)

    standby_actor_id = "local-user~standby-actor"
    caller_actor_id = "local-user~caller-actor"

    # Before any request: no run yet for the standby actor (criterion 4).
    runs_before = httpx.get(f"{api}/v2/acts/{standby_actor_id}/runs", timeout=10).json()["data"]["items"]
    assert runs_before == []

    actor = httpx.get(f"{api}/v2/actors/{standby_actor_id}", timeout=10).json()["data"]
    assert actor.get("standbyUrl"), "standby-enabled actor must expose standbyUrl"

    # The on-demand Actor discovers standbyUrl itself (criterion 22) and calls
    # it container-to-container (criterion 23) -- see sample_actor_caller/main.py.
    # Input goes through --input-file, not `-i`: apify-cli treats any inline
    # `--input` value containing "~" (every `username~name` actor id) as a file
    # path and rejects it (apify/apify-cli#1281).
    input_file = tmp_path / "caller-input.json"
    input_file.write_text(json.dumps({"standbyActorId": standby_actor_id, "greeting": "howdy"}))
    call = subprocess.run(
        ["apify", "call", f"--input-file={input_file}"],
        cwd=caller_project, env=env, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=300,
    )
    assert call.returncode == 0, f"apify call failed:\n{call.stdout}\n{call.stderr}"

    caller_runs = httpx.get(f"{api}/v2/acts/{caller_actor_id}/runs", timeout=10).json()["data"]["items"]
    assert caller_runs, "no caller runs recorded"
    caller_run = _wait_run_terminal(api, caller_runs[0]["id"])
    assert caller_run["status"] == "SUCCEEDED", f"caller run: {caller_run}"  # criterion 24

    output = httpx.get(
        f"{api}/v2/key-value-stores/{caller_run['defaultKeyValueStoreId']}/records/OUTPUT", timeout=10
    ).json()
    received = output["receivedFromStandby"]
    assert received["method"] == "GET"
    assert received["path"] == "/echo?greeting=howdy"

    # The standby actor's own run is now warm and inspectable (criterion 24).
    standby_runs = httpx.get(f"{api}/v2/acts/{standby_actor_id}/runs", timeout=10).json()["data"]["items"]
    assert standby_runs, "standby actor should have started a warm run"
    assert standby_runs[0]["status"] == "RUNNING"

    # It tears itself down after the (overridden, short) idle timeout, with no
    # further request needed to trigger it (criterion 12).
    standby_run = _wait_run_terminal(api, standby_runs[0]["id"], timeout=60)
    assert standby_run["status"] == "ABORTED", f"standby run: {standby_run}"
