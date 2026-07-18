"""End-to-end test verifying that the real ``apify`` SDK, driving the full
``Actor`` lifecycle (``async with Actor``) *inside* a real actor container,
reports ``is_at_home = true`` the way ``Actor.is_at_home()`` itself computes
it, calls back into the runtime's own API through ``Actor.new_client()``
using its injected ``APIFY_TOKEN``, and writes its result into its own
default dataset via ``Actor.push_data()`` -- proving an API-based storage
write against the run's real dataset id, not a local-disk write.

Requires Docker and apify-cli, exactly like ``tests/e2e/test_e2e.py`` (see
that file's docstring for the shared skip/harness pattern this mirrors). Uses
its OWN runtime instance rather than importing that file's fixture, so the
e2e files stay fully independent and neither ``test_e2e.py`` nor
``test_standby.py`` needs any change -- mirroring how ``test_standby.py``
already does this relative to ``test_e2e.py`` (see that file's docstring).

The fixture Actor (``sample_actor_isathome/``) pip-installs the real,
published ``apify``/``apify-client`` packages at image BUILD time, like every
other ``sample_actor*`` fixture now (see ``sample_actor_isathome/main.py``
for exactly which SDK surface is used and why).
"""
from __future__ import annotations

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
    # World-writable so the sibling Actor container can write its storage.
    os.chmod(data_dir, 0o777)
    api_port = _free_port()
    console_port = _free_port()
    name = f"actor-runtime-isathome-e2e-{uuid.uuid4().hex[:8]}"

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


def test_real_apify_client_reports_is_at_home_and_writes_via_api(runtime, tmp_path):
    """Push/build/run ``sample_actor_isathome``, then verify over the API that
    its dataset item -- written THROUGH the real apify-client, not local disk
    -- shows ``is_at_home is True``, a ``user`` matching the run's real
    owner, and a ``dataset_id`` matching the run's real ``defaultDatasetId``.
    """
    api = runtime["api"]
    env = _apify_env(api)

    project = tmp_path / "isathome-actor"
    shutil.copytree(REPO / "sample_actor_isathome", project)

    # 1) push -> creates Actor + version and builds it (installs apify-client
    # + apify at image build time, like every sample_actor* fixture now, so
    # allow extra headroom over a from-cache build).
    push = subprocess.run(
        ["apify", "push", "--force"],
        cwd=project, env=env, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=600,
    )
    assert push.returncode == 0, f"apify push failed:\n{push.stdout}\n{push.stderr}"

    # 2) run it via the CLI (no input needed).
    call = subprocess.run(
        ["apify", "call"],
        cwd=project, env=env, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=300,
    )
    assert call.returncode == 0, f"apify call failed:\n{call.stdout}\n{call.stderr}"

    # 3) find the finished run.
    runs = httpx.get(f"{api}/v2/acts/local-user~isathome-actor/runs", timeout=10).json()["data"]["items"]
    assert runs, "no runs recorded"
    run = _wait_run_terminal(api, runs[0]["id"])
    assert run["status"] == "SUCCEEDED", f"run: {run}"

    ds_id = run["defaultDatasetId"]

    # 4) read the run's default dataset back over the API -- proving the
    # Actor's write landed via the client's real API call, not local disk.
    items = httpx.get(f"{api}/v2/datasets/{ds_id}/items", timeout=10).json()
    assert len(items) == 1, f"expected exactly one dataset item, got: {items}"
    item = items[0]

    # (a) the real apify-client/SDK, running inside the container, reports
    # is_at_home the way it computes it (Configuration.is_at_home, sourced
    # from APIFY_IS_AT_HOME) -- true for every actor-runtime run.
    assert item["is_at_home"] is True

    # (b) it called back into the runtime's own API using its injected
    # APIFY_TOKEN and resolved to the run's real owner.
    assert item["user"] == run["username"] == "local-user"

    # (c) it saw its real storage id -- this GET already proves the write
    # landed in the run's actual dataset, not a hardcoded/local one.
    assert item["dataset_id"] == ds_id
