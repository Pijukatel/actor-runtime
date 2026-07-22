"""Fixture Actor exercising the full apify SDK path: ``async with Actor``,
``Actor.is_at_home()``, a real API round trip via
``Actor.new_client().user("me").get()`` (the ``"me"`` alias round trip), and
``Actor.push_data()`` for the storage write.
"""
import asyncio

from apify import Actor


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
        # v4 returns a response model (UserPublicInfo/UserPrivateInfo), never a dict.
        username = getattr(me, "username", None)

        result = {"is_at_home": bool(is_at_home), "user": username, "dataset_id": dataset_id}
        print(f"isathome Actor resolved: {result}", flush=True)

        # (c) write the result into the run's real default dataset through
        # the SDK -- an API-based storage write, not a local-disk write.
        await Actor.push_data(result)

        print("isathome Actor finished: pushed result via Actor.push_data().", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
