"""Fixture Actor proving the real apify SDK path end to end: the full
``Actor`` lifecycle (``async with Actor``), ``Actor.is_at_home()``,
``Actor.new_client()`` for a real API round trip (a user-lookup call), and
``Actor.push_data()`` for the storage write -- all through the SDK's
Actor/storage-client abstraction. Unlike this fixture's previous version, no
low-level client is constructed by hand anywhere in this file; the one
client instance in use is obtained exclusively through ``Actor.new_client()``,
the SDK's own sanctioned accessor.

Two packages: ``apify`` (the Actor SDK) for the lifecycle, storage and
``is_at_home``/``new_client`` accessors; ``apify-client`` only implicitly, as
``apify``'s own dependency providing the client `Actor.new_client()` returns.
Both are pip-installed at image BUILD time (see ``.actor/Dockerfile``); at RUN
time the only network use is calling the runtime's own API.
"""
import asyncio

from apify import Actor


def _resolve_username(me: object) -> str | None:
    """Best-effort read of the acting user's identity from whatever shape
    ``UserClientAsync.get()`` returns: a plain dict per apify-client 2.5.1's
    current source (handled first here), with an attribute-based fallback in
    case a different client version ever returns a model instead.
    """
    if isinstance(me, dict):
        return me.get("username") or me.get("id")
    return getattr(me, "username", None) or getattr(me, "id", None)


async def main() -> None:
    async with Actor:
        # (a) is_at_home, through the SDK's own accessor.
        is_at_home = Actor.is_at_home()
        dataset_id = Actor.configuration.default_dataset_id

        # (b) a real network round trip back into the runtime's own API,
        # using the SDK-configured client (token/API URL come from the
        # Actor's Configuration, same as everywhere else in the SDK).
        client = Actor.new_client()
        me = await client.user("me").get()
        username = _resolve_username(me)

        result = {"is_at_home": bool(is_at_home), "user": username, "dataset_id": dataset_id}
        print(f"isathome Actor resolved: {result}", flush=True)

        # (c) write the result into the run's real default dataset through
        # the SDK -- an API-based storage write, not a local-disk write.
        await Actor.push_data(result)

        print("isathome Actor finished: pushed result via Actor.push_data().", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
