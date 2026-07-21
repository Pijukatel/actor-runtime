"""Direct-import coverage for ``sample_actor/main.py``'s ``repeatCount``/
``shout``/``tone``/``recipients`` handling.

``sample_actor/.actor/input_schema.json`` describes ``repeatCount`` ("How
many times to repeat the greeting"), ``shout`` ("Uppercase the greeting
before writing it out"), ``tone`` ("Style of the greeting message" -- the
schema's enum/select showcase) and ``recipients`` ("Names to greet
individually" -- the schema's stringList showcase). This file proves all
four actually affect the Actor's OUTPUT/dataset, by loading and running the
real, unmodified script directly (it's dependency-free stdlib-only code, so
no Docker/apify-cli is needed to exercise it -- unlike the full
``tests/e2e/test_e2e.py`` dev-loop test).

Also locks in the no-op-defaults contract that keeps the existing
Docker-dependent e2e assertions valid unmodified: with no ``repeatCount``/
``shout``/``tone``/``recipients`` given, ``processedGreeting`` must equal the
plain ``greeting`` and the dataset must hold exactly its original one item
(so ``tests/e2e/test_e2e.py``'s ``output["greeting"] == "howdy"`` and dataset
``[{"message": "howdy world", "index": 1}]`` assertions, which read the
*raw* ``greeting`` key/variable and the dataset's first item only, keep
meaning what they've always meant).
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
MAIN_PY = REPO / "sample_actor" / "main.py"


def _load_main_module():
    """Fresh module object per call (isolated ``STORAGE`` global) -- avoids
    any cross-test state leaking through Python's module cache."""
    spec = importlib.util.spec_from_file_location("sample_actor_main_under_test", MAIN_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(tmp_path: Path, actor_input: dict) -> dict:
    module = _load_main_module()
    module.STORAGE = tmp_path  # redirect default_dir()'s base dir, no env vars needed
    kv = tmp_path / "key_value_stores" / "default"
    kv.mkdir(parents=True)
    (kv / "INPUT.json").write_text(json.dumps(actor_input))
    module.main()
    return json.loads((kv / "OUTPUT.json").read_text())


def _dataset_items(tmp_path: Path) -> list:
    """Read back every dataset item `main.py` wrote, in the same sorted
    filename order the real runtime's `Storage._import_dataset_dir`
    (`app/storage.py`) uses to import them -- lets a test assert on the
    dataset's full shape, not just OUTPUT.json."""
    ds_dir = tmp_path / "datasets" / "default"
    return [json.loads(p.read_text()) for p in sorted(ds_dir.iterdir())]


def test_default_repeat_count_and_shout_leave_processed_greeting_unchanged(tmp_path):
    """No repeatCount/shout/tone/recipients in the input at all (schema
    defaults/no-ops: repeatCount 1, shout false, tone "friendly", recipients
    absent) -- processedGreeting must equal the raw greeting and the dataset
    must hold exactly its original one item, matching the sample's existing
    default/prefill behavior and keeping the Docker-dependent
    e2e test's `output["greeting"] == "howdy"` and
    `items == [{"message": "howdy world", "index": 1}]` assertions meaningful
    without needing to touch that file."""
    output = _run(tmp_path, {"greeting": "howdy"})
    assert output["greeting"] == "howdy"
    assert output["processedGreeting"] == "howdy"
    assert output["receivedInput"] == {"greeting": "howdy"}
    assert output["recipientGreetings"] == []
    assert _dataset_items(tmp_path) == [{"message": "howdy world", "index": 1}]


def test_shout_uppercases_the_processed_greeting(tmp_path):
    output = _run(tmp_path, {"greeting": "hi", "shout": True})
    assert output["processedGreeting"] == "HI"
    assert output["greeting"] == "hi"  # the raw key is untouched by shout


def test_repeat_count_repeats_the_processed_greeting(tmp_path):
    output = _run(tmp_path, {"greeting": "hi", "repeatCount": 3})
    assert output["processedGreeting"] == "hi hi hi"


def test_repeat_count_and_shout_combine(tmp_path):
    output = _run(tmp_path, {"greeting": "hi", "repeatCount": 2, "shout": True})
    assert output["processedGreeting"] == "HI HI"


def test_repeat_count_zero_yields_empty_processed_greeting(tmp_path):
    output = _run(tmp_path, {"greeting": "hi", "repeatCount": 0})
    assert output["processedGreeting"] == ""


@pytest.mark.parametrize("bad_repeat_count", ["not-a-number", None, [1, 2]])
def test_non_numeric_repeat_count_fails_soft_to_the_default(tmp_path, bad_repeat_count):
    """Input is never validated against the schema -- a malformed
    repeatCount must not crash the Actor; it falls back to the schema's
    default of 1."""
    output = _run(tmp_path, {"greeting": "hi", "repeatCount": bad_repeat_count})
    assert output["processedGreeting"] == "hi"


def test_non_string_greeting_does_not_crash_shout_processing(tmp_path):
    """`greeting` is read from permissive, unvalidated JSON input -- a
    schema declaring `greeting` as a string doesn't stop a client from
    sending a number/object/etc. `shout`'s `.upper()` must not crash on a
    non-string greeting; the raw `greeting` key/receivedInput stay exactly
    as received either way."""
    output = _run(tmp_path, {"greeting": 42, "shout": True, "repeatCount": 2})
    assert output["greeting"] == 42
    assert output["processedGreeting"] == "42 42"
    assert output["receivedInput"] == {"greeting": 42, "shout": True, "repeatCount": 2}


# -- tone --------------------------------------------------------------------


def test_tone_explicit_friendly_is_still_a_no_op(tmp_path):
    """`tone: "friendly"` given explicitly (not just omitted) must behave
    identically to leaving it out -- "friendly" is the schema's own default
    and TONE_TEMPLATES' no-op entry."""
    output = _run(tmp_path, {"greeting": "hi", "tone": "friendly"})
    assert output["processedGreeting"] == "hi"


def test_tone_formal_wraps_the_greeting_in_the_formal_template(tmp_path):
    output = _run(tmp_path, {"greeting": "hi", "tone": "formal"})
    assert output["processedGreeting"] == "Dear recipient, hi. Regards."
    assert output["greeting"] == "hi"  # raw key untouched, as with shout


def test_tone_playful_wraps_the_greeting_in_the_playful_template(tmp_path):
    output = _run(tmp_path, {"greeting": "hi", "tone": "playful"})
    assert output["processedGreeting"] == "hi!! :)"


def test_tone_applies_before_repeat_count_join(tmp_path):
    """Each repeated copy is individually styled (the tone template wraps
    the whole repeated unit), not applied once to the final joined string."""
    output = _run(tmp_path, {"greeting": "hi", "tone": "playful", "repeatCount": 2})
    assert output["processedGreeting"] == "hi!! :) hi!! :)"


def test_tone_and_shout_combine(tmp_path):
    output = _run(tmp_path, {"greeting": "hi", "tone": "formal", "shout": True})
    assert output["processedGreeting"] == "Dear recipient, HI. Regards."


@pytest.mark.parametrize("bad_tone", ["sarcastic", 42, None, ["formal"]])
def test_unrecognized_or_non_string_tone_fails_soft_to_friendly(tmp_path, bad_tone):
    """Input is never validated against the schema -- a `tone` value outside
    the schema's declared enum, or not even a string, must not crash the
    Actor; it falls back to the same no-op "friendly" template the schema's
    own default uses."""
    output = _run(tmp_path, {"greeting": "hi", "tone": bad_tone})
    assert output["processedGreeting"] == "hi"


# -- recipients ---------------------------------------------------------------


def test_recipients_produce_a_styled_greeting_per_recipient_in_output(tmp_path):
    output = _run(tmp_path, {"greeting": "hi", "recipients": ["Ada", "Grace"]})
    assert output["recipientGreetings"] == ["hi, Ada!", "hi, Grace!"]
    # The plain processedGreeting/greeting keys are unaffected by recipients.
    assert output["processedGreeting"] == "hi"
    assert output["greeting"] == "hi"


def test_recipients_use_the_same_styled_greeting_as_tone_and_shout(tmp_path):
    """Recipient greetings are built from the same tone/shout-styled text as
    `processedGreeting`, not from the raw `greeting` -- the two showcase
    properties compose rather than acting in isolation."""
    output = _run(
        tmp_path,
        {"greeting": "hi", "tone": "playful", "shout": True, "recipients": ["Bob"]},
    )
    assert output["processedGreeting"] == "HI!! :)"
    assert output["recipientGreetings"] == ["HI!! :), Bob!"]


def test_recipients_produce_additional_dataset_items_after_item_one(tmp_path):
    output = _run(tmp_path, {"greeting": "hi", "recipients": ["Ada", "Grace"]})
    items = _dataset_items(tmp_path)
    assert items == [
        {"message": "hi world", "index": 1},
        {"message": "hi, Ada!", "recipient": "Ada", "index": 2},
        {"message": "hi, Grace!", "recipient": "Grace", "index": 3},
    ]
    assert output["recipientGreetings"] == ["hi, Ada!", "hi, Grace!"]


def test_empty_recipients_list_yields_no_extra_dataset_items(tmp_path):
    """An explicit empty list must behave the same as omitting the key
    entirely -- both are "no recipients", not an error."""
    output = _run(tmp_path, {"greeting": "hi", "recipients": []})
    assert output["recipientGreetings"] == []
    assert _dataset_items(tmp_path) == [{"message": "hi world", "index": 1}]


@pytest.mark.parametrize("bad_recipients", ["Ada", 42, {"name": "Ada"}, None])
def test_non_list_recipients_fails_soft_to_no_recipients(tmp_path, bad_recipients):
    """Input is never validated against the schema -- a `recipients` value
    that isn't a JSON array (a bare string, a number, an object, null) must
    not crash the Actor; it falls back to treating it as no recipients at
    all rather than e.g. iterating over a string's characters."""
    output = _run(tmp_path, {"greeting": "hi", "recipients": bad_recipients})
    assert output["recipientGreetings"] == []
    assert _dataset_items(tmp_path) == [{"message": "hi world", "index": 1}]


def test_non_string_recipient_entries_are_coerced_not_crashed(tmp_path):
    """A recipients array containing a non-string entry (permissive,
    unvalidated input) must not crash `main.py`'s per-recipient formatting;
    the entry is coerced to text exactly like a non-string `greeting` is."""
    output = _run(tmp_path, {"greeting": "hi", "recipients": [42, None]})
    assert output["recipientGreetings"] == ["hi, 42!", "hi, None!"]
