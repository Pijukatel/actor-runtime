"""Tiny sample Actor for the e2e test.

Reads its INPUT from the default key-value store and writes to all three default
storages (key-value store, dataset, request queue) using the Apify/crawlee local
storage layout, so the runtime can import the results after the run finishes.

Deliberately dependency-free (no apify SDK) so the image builds offline and the
behaviour is fully deterministic.
"""
import json
import os
from pathlib import Path

STORAGE = Path(os.environ.get("ACTOR_STORAGE_DIR") or os.environ.get("CRAWLEE_STORAGE_DIR") or "/apify_storage")


def default_dir(kind: str) -> Path:
    path = STORAGE / kind / "default"
    path.mkdir(parents=True, exist_ok=True)
    return path


def main() -> None:
    kv = default_dir("key_value_stores")
    input_path = kv / "INPUT.json"
    actor_input = json.loads(input_path.read_text()) if input_path.exists() else {}
    greeting = actor_input.get("greeting", "hello")
    print(f"Sample Actor started. Input greeting = {greeting!r}", flush=True)

    # 1) Key-value store: write an OUTPUT record that echoes the input.
    (kv / "OUTPUT.json").write_text(
        json.dumps({"greeting": greeting, "receivedInput": actor_input, "status": "ok"})
    )

    # 2) Dataset: push one item derived from the input.
    ds = default_dir("datasets")
    (ds / "000000001.json").write_text(
        json.dumps({"message": f"{greeting} world", "index": 1})
    )

    # 3) Request queue: enqueue one request.
    rq = default_dir("request_queues")
    (rq / "request-1.json").write_text(
        json.dumps(
            {
                "url": "https://example.com/from-actor",
                "uniqueKey": "https://example.com/from-actor",
                "method": "GET",
            }
        )
    )

    print("Sample Actor finished: wrote OUTPUT, 1 dataset item, 1 queued request.", flush=True)


if __name__ == "__main__":
    main()
