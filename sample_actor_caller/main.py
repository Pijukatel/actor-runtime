"""On-demand fixture Actor for the on-demand-calls-standby e2e test, driven by
the full Apify SDK lifecycle.

Reads its own input via ``Actor.get_input()``: the standby Actor's NAME only
(``standbyActorName``), never a username-qualified id -- an id like
``josef.prochazka~standby-actor`` is only ever meaningful on whatever single
environment minted it (a real platform username there, ``local-user`` here),
so hardcoding or accepting one as input would make this Actor's code differ
between environments. Instead, the acting user's username is resolved at
run time through the SDK-configured client (``Actor.new_client()`` ->
``client.user("me").get()``, reading the returned user model's ``.username``
attribute -- the same real-network-round-trip pattern
``sample_actor_isathome/main.py`` uses) and combined with the given name
using the platform's own ``username~name`` Actor-id convention (the same
convention the runtime itself uses to mint Actor ids -- see
``app/service.py``'s ``create_actor``) into ``f"{username}~{name}"``. That id
is then used to discover the standby Actor's standby URL through the same
client (``client.actor(standby_actor_id).get()``), reading it off the
fetched Actor object's ``.standby_url`` attribute (apify-client's own
``Actor`` response model, never a raw dict) -- the same read works for any
standby-enabled Actor id, since the runtime always parameterizes the URL by
the requested Actor's own id, not a hardcoded one. Calls the discovered URL
once container-to-container, and persists the response both into its own
default dataset (via ``Actor.push_data()``) and as the key-value store
``OUTPUT`` record (via ``Actor.set_value()``), so the test can read the
round trip back over the API either way.

The actual call to the standby Actor's HTTP server is NOT a storage
operation -- there is no SDK method for "call another Actor's endpoint", so
that one call uses ``httpx`` directly (a plain async HTTP client, not this
runtime's own storage API and not a hand-rolled low-level socket call). It is
still an authenticated call, exactly like a real platform-to-platform
container call would be: it carries this run's own ``APIFY_TOKEN``
(``Actor.configuration.token``) as an ``Authorization: Bearer`` header, and a
non-2xx reply raises instead of being treated as the standby Actor's answer --
an error envelope must never be mistaken for -- or silently persisted as --
a successful round trip.
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
        standby_actor_name = actor_input.get("standbyActorName")
        if not standby_actor_name:
            raise ValueError(
                'Missing required input field "standbyActorName" (the name of the standby '
                'Actor to call, e.g. {"standbyActorName": "standby-actor"}).'
            )
        greeting = actor_input.get("greeting", "hi")

        client = Actor.new_client()

        # Username resolved live, never hardcoded or taken as input (see module docstring).
        print("Resolving the acting user via the configured client (client.user('me').get())", flush=True)
        me = await client.user("me").get()
        username = getattr(me, "username", None)
        if not username:
            raise ValueError("Could not resolve the acting user's username from client.user('me').get().")
        standby_actor_id = f"{username}~{standby_actor_name}"

        print(f"Discovering standby Actor {standby_actor_id!r} via the configured client", flush=True)
        actor = await client.actor(standby_actor_id).get()
        standby_url = actor.standby_url
        print(f"Calling standby Actor at {standby_url}", flush=True)

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
