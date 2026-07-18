"""Sample Actor for the e2e dev-loop test, driven by the full Apify SDK lifecycle.

Reads its INPUT through ``Actor.get_input()``, writes an ``OUTPUT`` record via
``Actor.set_value()``, pushes one dataset item via ``Actor.push_data()``, and
enqueues one request via ``Actor.open_request_queue()`` -- the full storage
surface a real Apify Actor uses, all through the SDK's own API-backed storage
client. No direct disk access, no hand-rolled HTTP: every storage interaction
goes through ``apify.Actor``. Reproduces the previous (dependency-free)
version's output values byte-for-byte, so the existing e2e assertions keep
passing unchanged.
"""
import asyncio

from apify import Actor


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        greeting = actor_input.get("greeting", "hello")
        print(f"Sample Actor started. Input greeting = {greeting!r}", flush=True)

        # 1) Key-value store: write an OUTPUT record that echoes the input.
        await Actor.set_value("OUTPUT", {"greeting": greeting, "receivedInput": actor_input, "status": "ok"})

        # 2) Dataset: push one item derived from the input.
        await Actor.push_data({"message": f"{greeting} world", "index": 1})

        # 3) Request queue: enqueue one request.
        request_queue = await Actor.open_request_queue()
        await request_queue.add_request("https://example.com/from-actor")

        print("Sample Actor finished: wrote OUTPUT, 1 dataset item, 1 queued request.", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
