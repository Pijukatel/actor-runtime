"""On-demand fixture Actor for the on-demand-calls-standby e2e test.

Input is the standby Actor's NAME only (``standbyActorName``), never a
username-qualified id -- an id like ``josef.prochazka~standby-actor`` is only
ever meaningful on whatever single environment minted it, so this Actor
resolves its own owning user's id live and builds ``{username}~{name}``
itself, the same on the real platform and locally.
"""
import asyncio
import json

import httpx
from apify import Actor


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        standby_actor_name = actor_input.get("standbyActorName")
        if not standby_actor_name:
            raise ValueError(
                'Missing required input field "standbyActorName" (the name of the standby '
                'Actor to call, e.g. {"standbyActorName": "standby-actor"}).'
            )
        greeting = actor_input.get("greeting", "hi")

        client = Actor.new_client()

        # Username resolved live, never hardcoded or taken as input (see module docstring).
        print("Resolving the acting user via the configured client (client.user(user_id).get())", flush=True)
        me = await client.user(Actor.configuration.user_id).get()
        username = getattr(me, "username", None)
        if not username:
            raise ValueError("Could not resolve the acting user's username from client.user(user_id).get().")
        # {username}~{name} is the platform's own Actor-id convention.
        standby_actor_id = f"{username}~{standby_actor_name}"

        print(f"Discovering standby Actor {standby_actor_id!r} via the configured client", flush=True)
        actor = await client.actor(standby_actor_id).get()
        standby_url = actor.standby_url
        print(f"Calling standby Actor at {standby_url}", flush=True)

        # No SDK method calls another Actor's HTTP endpoint, so httpx handles
        # this one call directly (still authenticated, via this run's own token).
        call_url = f"{standby_url}/echo?greeting={greeting}"
        headers = {"Authorization": f"Bearer {Actor.configuration.token}"}
        async with httpx.AsyncClient(timeout=30) as http_client:
            response = await http_client.get(call_url, headers=headers)
            # A non-2xx reply must fail this run, not be persisted as the standby's answer.
            response.raise_for_status()
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
