"""Multi-actor sample actor for actor-runtime.

A deliberately trivial demonstration of cross-Actor calls. It calls two Actors in turn:

1. `localActorId` - an Actor already pushed to this runtime, so the call is served locally.
2. `remoteActorId` - an Actor that exists only on the real Apify platform. With the runtime's
   upstream API fallback off (the default), the runtime has no such Actor, the call fails, and this
   Actor logs it and carries on. With `fallbackNotFoundEnabled` switched on, the very same call is
   relayed to the platform and really runs there.

Each call records one dataset item either way, so `apify datasets info <id>` and the console show
the difference between the two fallback states side by side.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from apify import Actor

# How long to wait for a callee. One still running when this elapses is reported with whatever
# status it has at that point - it is not aborted.
CALL_TIMEOUT = timedelta(minutes=2)


async def call_actor(actor_id: str, run_input: Any = None) -> None:
    """Call one Actor and record the outcome, treating "not available" as an expected result."""
    Actor.log.info(f'Calling Actor {actor_id!r}...')

    try:
        run = await Actor.call(actor_id, run_input, wait=CALL_TIMEOUT, logger=None)
    except Exception as exc:
        # Never crash on a callee this runtime cannot resolve - that is the whole point of the
        # second call below, which is expected to land here until the fallback is switched on.
        Actor.log.warning(f'Actor {actor_id!r} could not be run: {exc}')
        await Actor.push_data({'actorId': actor_id, 'called': False, 'error': str(exc)})
        return

    Actor.log.info(
        f'Actor {actor_id!r} run {run.id} finished as {run.status.value} (dataset {run.default_dataset_id}).'
    )
    await Actor.push_data(
        {
            'actorId': actor_id,
            'called': True,
            'runId': run.id,
            'status': run.status.value,
            'defaultDatasetId': run.default_dataset_id,
        }
    )


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        local_actor_id = actor_input.get('localActorId', 'my-actor')
        remote_actor_id = actor_input.get('remoteActorId', 'apify/hello-world')

        # Served by this runtime. `maxPages` keeps the default callee (sample_actor_ts) short; any
        # other callee simply ignores the field.
        await call_actor(local_actor_id, {'maxPages': 1})

        # Not in this runtime. Reachable only once the upstream API fallback is switched on.
        await call_actor(remote_actor_id)

        Actor.log.info("Both calls done - see this run's default dataset for the two outcomes.")
