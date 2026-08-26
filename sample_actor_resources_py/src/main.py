"""Python sample Actor that reports the resources it was granted and the usage the runtime measures.

Two different SDK surfaces are involved, and the split between them is the point of this sample:

- *Granted* resources come from the SDK's configuration, which reads the environment variables the
  runtime sets on every Actor container: `ACTOR_MEMORY_MBYTES`/`APIFY_MEMORY_MBYTES` for the memory
  grant, `APIFY_DEDICATED_CPUS` for the CPU share.
- *Used* resources arrive through the SDK's event manager, which connects to the events websocket
  named by `ACTOR_EVENTS_WEBSOCKET_URL` and re-emits every `systemInfo` frame the runtime samples
  from the container.

The Actor prints one line per frame and then exits, so a plain `apify call` shows the whole picture.
"""

from __future__ import annotations

import asyncio

from apify import Actor, Event, EventSystemInfoData

# The runtime publishes one systemInfo frame per second. The extra seconds cover the container's
# own startup before the first frame lands, so a healthy run never trips the timeout.
GRACE_SECS = 10


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        wanted = int(actor_input.get('samples', 5))

        config = Actor.configuration
        Actor.log.info('Granted to this run (SDK configuration):')
        Actor.log.info(f'  memory: {config.memory_mbytes} MB')
        Actor.log.info(f'  CPU:    {config.dedicated_cpus} core(s)')

        collected: list[EventSystemInfoData] = []
        enough = asyncio.Event()

        # Declared async so the event manager awaits it inline rather than scheduling it on its own
        # thread, which keeps `collected` free of cross-thread races.
        async def report_usage(event_data: EventSystemInfoData) -> None:
            collected.append(event_data)
            # `used_ratio` is already relative to this run's own CPU grant: the SDK divides the
            # frame's percent-of-one-core by `dedicated_cpus` before handing it over.
            used_cpu = event_data.cpu_info.used_ratio
            used_memory_mb = event_data.memory_info.current_size.to_mb()
            Actor.log.info(
                f'sample {len(collected)}/{wanted}: '
                f'CPU {used_cpu:.1%} of the grant, memory {used_memory_mb:.1f} MB'
            )
            if len(collected) >= wanted:
                enough.set()

        Actor.on(Event.SYSTEM_INFO, report_usage)
        try:
            await asyncio.wait_for(enough.wait(), timeout=wanted + GRACE_SECS)
        except TimeoutError:
            Actor.log.warning(
                f'Only {len(collected)} of {wanted} systemInfo event(s) arrived. Without '
                'ACTOR_EVENTS_WEBSOCKET_URL the SDK has no platform events to subscribe to, so usage '
                'stays unreported and Crawlee autoscaling would have no resource signal either.'
            )
        finally:
            Actor.off(Event.SYSTEM_INFO, report_usage)

        last = collected[-1] if collected else None
        await Actor.push_data(
            {
                'grantedMemoryMbytes': config.memory_mbytes,
                'grantedCpus': config.dedicated_cpus,
                'samplesObserved': len(collected),
                'lastUsedCpuRatioOfGrant': last.cpu_info.used_ratio if last else None,
                'lastUsedMemoryMbytes': last.memory_info.current_size.to_mb() if last else None,
            }
        )
