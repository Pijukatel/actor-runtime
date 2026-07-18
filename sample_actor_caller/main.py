"""On-demand fixture Actor for the on-demand-calls-standby e2e test, driven by
the full Apify SDK lifecycle.

Reads its own input via ``Actor.get_input()``, discovers the standby Actor's
``standbyUrl`` through the SDK-configured client (``Actor.new_client()`` ->
``actor(standby_actor_id).get()``), calls it once container-to-container, and
persists the response both into its own default dataset (via
``Actor.push_data()``) and as the key-value store ``OUTPUT`` record (via
``Actor.set_value()``), so the test can read the round trip back over the API
either way.

The actual call to the standby Actor's HTTP server is NOT a storage
operation -- there is no SDK method for "call another Actor's endpoint", so
that one call uses ``httpx`` directly (a plain async HTTP client, not this
runtime's own storage API and not a hand-rolled low-level socket call).
Every storage interaction (input, dataset push, OUTPUT) goes through
``apify.Actor``.
"""
import asyncio
import json

import httpx
from apify import Actor


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        standby_actor_id = actor_input.get("standbyActorId")
        if not standby_actor_id:
            raise ValueError(
                'Missing required input field "standbyActorId" (the id of the standby '
                'Actor to call, e.g. {"standbyActorId": "local-user~standby-actor"}).'
            )
        greeting = actor_input.get("greeting", "hi")

        print(f"Discovering standby Actor {standby_actor_id!r} via the configured client", flush=True)
        client = Actor.new_client()
        actor = await client.actor(standby_actor_id).get()
        standby_url = actor["standbyUrl"]
        print(f"Calling standby Actor at {standby_url}", flush=True)

        call_url = f"{standby_url}/echo?greeting={greeting}"
        async with httpx.AsyncClient(timeout=30) as http_client:
            response = await http_client.get(call_url)
            received = response.json()
        print(f"Received from standby Actor: {json.dumps(received)}", flush=True)

        # Persist the standby Actor's response twice: into this run's own
        # dataset (through the SDK, like an SDK Actor at home would) and as
        # the OUTPUT key-value record.
        await Actor.push_data([received])
        await Actor.set_value("OUTPUT", {"receivedFromStandby": received})
        print("On-demand Actor finished calling the standby Actor.", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
