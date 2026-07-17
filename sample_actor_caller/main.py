"""Dependency-free on-demand fixture Actor for the on-demand-calls-standby e2e test.

Reads the standby Actor's id from its own INPUT, discovers that Actor's
``standbyUrl`` through ``APIFY_API_BASE_URL`` + its own ``APIFY_TOKEN`` (no
hardcoded runtime URL/port anywhere in this file), calls it once
container-to-container, prints the response, and persists it both into its
own default dataset (via the runtime API) and as its key-value store OUTPUT
record, so the test can read the round trip back over the API either way.
Deliberately stdlib-only (no apify SDK), like ``sample_actor``.
"""
import json
import os
import urllib.request
from pathlib import Path

STORAGE = Path(os.environ.get("ACTOR_STORAGE_DIR") or os.environ.get("CRAWLEE_STORAGE_DIR") or "/apify_storage")


def default_dir(kind: str) -> Path:
    path = STORAGE / kind / "default"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _get_json(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _post_json(url: str, token: str, payload) -> None:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=30).close()


def main() -> None:
    kv = default_dir("key_value_stores")
    input_path = kv / "INPUT.json"
    actor_input = json.loads(input_path.read_text()) if input_path.exists() else {}
    standby_actor_id = actor_input.get("standbyActorId")
    if not standby_actor_id:
        raise SystemExit(
            'Missing required input field "standbyActorId" (the id of the standby '
            'Actor to call, e.g. {"standbyActorId": "local-user~standby-actor"}).'
        )
    greeting = actor_input.get("greeting", "hi")

    base_url = os.environ["APIFY_API_BASE_URL"]
    token = os.environ["APIFY_TOKEN"]
    print(f"Discovering standby Actor {standby_actor_id!r} via {base_url}", flush=True)

    actor = _get_json(f"{base_url}/v2/actors/{standby_actor_id}", token)["data"]
    standby_url = actor["standbyUrl"]
    print(f"Calling standby Actor at {standby_url}", flush=True)

    call_url = f"{standby_url}/echo?greeting={greeting}"
    received = _get_json(call_url, token)
    print(f"Received from standby Actor: {json.dumps(received)}", flush=True)

    # Persist the standby Actor's response twice: into this run's own dataset
    # (through the runtime API, like an SDK at home would) and as the OUTPUT
    # key-value record (imported from disk when the run finishes).
    dataset_id = os.environ["APIFY_DEFAULT_DATASET_ID"]
    _post_json(f"{base_url}/v2/datasets/{dataset_id}/items", token, [received])
    (kv / "OUTPUT.json").write_text(json.dumps({"receivedFromStandby": received}))
    print("On-demand Actor finished calling the standby Actor.", flush=True)


if __name__ == "__main__":
    main()
