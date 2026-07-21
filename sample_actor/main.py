"""Sample Actor for the e2e dev-loop test, driven by the full Apify SDK lifecycle.

Reads its INPUT through ``Actor.get_input()``, writes an ``OUTPUT`` record via
``Actor.set_value()``, pushes dataset items via ``Actor.push_data()``, and
enqueues one request via ``Actor.open_request_queue()`` -- the full storage
surface a real Apify Actor uses, all through the SDK's own API-backed storage
client. No direct disk access, no hand-rolled HTTP: every storage interaction
goes through ``apify.Actor``.

``tone``/``repeatCount``/``shout``/``recipients`` (see
``.actor/input_schema.json``) are the Input tab's widget showcase -- each has
a real, observable effect on ``processedGreeting``/``recipientGreetings``
below. Every one of them defaults/no-ops so that a run which omits them
(e.g. the Docker-dependent ``tests/e2e/test_e2e.py`` call, which only ever
sends ``{"greeting": "howdy"}``) reproduces the previous (pre-input-schema)
version's output values byte-for-byte, so the existing e2e assertions keep
passing unchanged.
"""
import asyncio

from apify import Actor

# `tone` (.actor/input_schema.json's enum/select showcase: friendly/formal/
# playful, default "friendly") selects the template that wraps the styled
# greeting before repeatCount/join. "friendly" is a pure no-op template
# (`"{greeting}"`), so any run that never sets `tone` at all -- e.g. the
# Docker-dependent `tests/e2e/test_e2e.py` call, which never sends the key --
# keeps producing byte-identical `processedGreeting` output to before this
# template existed.
TONE_TEMPLATES = {
    "friendly": "{greeting}",
    "formal": "Dear recipient, {greeting}. Regards.",
    "playful": "{greeting}!! :)",
}


def _styled_greeting(text: str, tone: object) -> str:
    """Apply `tone`'s template to `text`. Anything that isn't one of the
    schema's three declared enum values -- an unrecognized string, a
    non-string (input is never validated against the schema, so a client
    can send anything), or an absent key -- fails soft to the same
    "friendly" no-op template `tone`'s own schema default already uses,
    rather than raising or silently producing `None`."""
    template = TONE_TEMPLATES.get(tone) if isinstance(tone, str) else None
    return (template or TONE_TEMPLATES["friendly"]).format(greeting=text)


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        greeting = actor_input.get("greeting", "hello")

        # `repeatCount`/`shout` (see .actor/input_schema.json) both default to
        # the schema's own no-op values (1 repeat, no shouting), so an
        # unedited/default run's processedGreeting always equals the plain
        # greeting -- the "greeting" key below and the dataset item's wording
        # stay exactly as before for the same input.
        repeat_count = actor_input.get("repeatCount", 1)
        try:
            repeat_count = max(int(repeat_count), 0)
        except (TypeError, ValueError):
            repeat_count = 1
        shout = bool(actor_input.get("shout", False))
        # `greeting` itself is left exactly as read (any JSON type, permissive
        # input) -- only the derived text below is coerced to a string, so a
        # non-string greeting can never crash the Actor on `.upper()`/`.join()`.
        greeting_text = greeting if isinstance(greeting, str) else str(greeting)
        base = greeting_text.upper() if shout else greeting_text

        # `tone` (the schema's enum/select showcase) and `recipients` (its
        # stringList showcase) are both read and actually applied below, so
        # every non-trivial widget kind the schema demonstrates has a real,
        # observable effect on the Actor's output. `tone` defaults to
        # "friendly" (a no-op template, see `TONE_TEMPLATES`), so
        # `processed_greeting` for any input that omits `tone` matches the
        # same no-op-defaults contract `repeatCount`/`shout` already keep
        # above.
        tone = actor_input.get("tone", "friendly")
        styled_greeting = _styled_greeting(base, tone)
        processed_greeting = " ".join([styled_greeting] * repeat_count)

        # `recipients` (a list of names, stringList editor, no schema
        # `default` -- only a console-only `prefill`): produces one styled
        # greeting per recipient, surfaced in OUTPUT's `recipientGreetings`
        # and pushed as extra dataset items after item 1. A missing/non-list
        # value fails soft to an empty list -- no recipients, no extra
        # output/dataset items -- so every existing e2e/unit-test input
        # (which omits the key entirely) keeps producing the same dataset
        # shape, and the same OUTPUT shape except for the always-present
        # (empty-list, when there are no recipients) `recipientGreetings` key.
        raw_recipients = actor_input.get("recipients", [])
        recipients = (
            [name if isinstance(name, str) else str(name) for name in raw_recipients]
            if isinstance(raw_recipients, list)
            else []
        )
        recipient_greetings = [f"{styled_greeting}, {name}!" for name in recipients]

        print(f"Sample Actor started. Input greeting = {greeting!r}", flush=True)

        # 1) Key-value store: write an OUTPUT record that echoes the input and
        #    shows repeatCount/shout/tone/recipients actually affecting the
        #    greeting.
        await Actor.set_value(
            "OUTPUT",
            {
                "greeting": greeting,
                "processedGreeting": processed_greeting,
                "recipientGreetings": recipient_greetings,
                "receivedInput": actor_input,
                "status": "ok",
            },
        )

        # 2) Dataset: push one item derived from the input, plus one more per
        #    recipient (empty `recipients` -> no extra items, so the
        #    dataset's shape for every existing test/e2e input -- all of
        #    which omit `recipients` -- is unchanged: still exactly the one
        #    item below).
        await Actor.push_data({"message": f"{greeting} world", "index": 1})
        for i, (name, message) in enumerate(zip(recipients, recipient_greetings), start=2):
            await Actor.push_data({"message": message, "recipient": name, "index": i})

        # 3) Request queue: enqueue one request.
        request_queue = await Actor.open_request_queue()
        await request_queue.add_request("https://example.com/from-actor")

        print(
            f"Sample Actor finished: wrote OUTPUT, {1 + len(recipients)} dataset item(s), 1 queued request.",
            flush=True,
        )


if __name__ == "__main__":
    asyncio.run(main())
