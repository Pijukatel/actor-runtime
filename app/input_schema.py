"""Actor input-schema resolution: read a pushed version's
``.actor/input_schema.json`` (or an ``.actor/actor.json`` ``input`` field
pointing at / inlining one), mirroring ``app/standby.py``'s
``_extract_uses_standby_mode`` fail-soft parsing pattern exactly -- the same
first-match-wins by-name scan over inline ``source_files`` (a later entry
sharing an earlier one's name never overwrites it, in either module), the
same TEXT/BASE64 branch, the same "can't read it -> None" contract (never
raise, never crash a console page or an API caller).

Used by ``GET /{actor_id}/input-schema`` (``app/routers/actors.py``) via
``Service.get_input_schema``, which additionally resolves WHICH version to
read this from (the version behind the actor's most recent successful build,
falling back to its latest-tagged version only when no build exists yet --
see that method's own docstring) and skips TARBALL versions entirely, since
their pushed archive isn't inspectable until a build unpacks it (see
``Service._upsert_version_in_session``'s docstring).
"""
from __future__ import annotations

import base64
import json
from typing import Any


def _read_json_source_file(files_by_name: dict[str, dict], name: str) -> Any | None:
    """Return ``name``'s parsed JSON content from a ``source_files``-by-name
    map, or ``None`` if the file is absent/unreadable/malformed -- never
    raises, same fail-soft contract as ``_extract_uses_standby_mode``.
    """
    entry = files_by_name.get(name)
    if entry is None:
        return None
    content = entry.get("content", "")
    if entry.get("format") == "BASE64":
        try:
            content = base64.b64decode(content).decode("utf-8")
        except Exception:  # noqa: BLE001 - unreadable file -> no signal
            return None
    try:
        return json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return None


def _resolve_relative_input_path(files_by_name: dict[str, dict], path: str) -> dict | None:
    """Resolve ``.actor/actor.json``'s string ``input`` field against pushed
    source-file names.

    Real ``.actor/actor.json`` files reference the schema both ways in the
    wild: relative to the project root (e.g. ``"input_schema.json"``,
    landing next to ``main.py``) and relative to ``.actor/``'s own directory
    (e.g. ``"./input_schema.json"`` sitting beside ``actor.json`` itself) --
    so this tries the given path both as given and re-rooted under
    ``.actor/`` (in whichever direction is missing), returning the first
    that resolves to a JSON object.
    """
    normalized = (path or "").strip()
    while normalized.startswith("./"):
        normalized = normalized[2:]
    normalized = normalized.lstrip("/")
    if not normalized:
        return None
    candidates = [normalized]
    if normalized.startswith(".actor/"):
        candidates.append(normalized[len(".actor/") :])
    else:
        candidates.append(f".actor/{normalized}")
    for name in candidates:
        schema = _read_json_source_file(files_by_name, name)
        if isinstance(schema, dict):
            return schema
    return None


def resolve_input_schema(source_files: list[dict]) -> dict | None:
    """Return a version's input schema from its pushed inline ``source_files``,
    or ``None`` if there is no signal (no manifest/schema file present, it
    fails to parse, or it isn't a JSON object) -- fail soft, exactly like
    ``_extract_uses_standby_mode``, never raise.

    Resolution order:
      1. ``.actor/actor.json``'s ``input`` field -- an inline object is used
         directly; a string is resolved as a relative path against the
         pushed source-file names (see ``_resolve_relative_input_path``).
      2. ``.actor/input_schema.json``, the Apify-conventional default path,
         when step 1 found no ``input`` field or it didn't resolve to a
         schema.

    The schema is returned exactly as pushed (whatever key order and
    ``sectionCaption``/etc. fields it has) -- this module does no
    transformation, only lookup/decode/parse.
    """
    # First-match-wins by name (NOT a dict comprehension, which would let a
    # later duplicate-named entry silently overwrite an earlier one) -- this
    # mirrors `_extract_uses_standby_mode`'s own linear scan-and-return-on-
    # first-match exactly, so two source_files entries that happen to share a
    # name resolve identically in both places.
    files_by_name: dict[str, dict] = {}
    for entry in source_files or []:
        name = entry.get("name")
        if name not in files_by_name:
            files_by_name[name] = entry

    manifest = _read_json_source_file(files_by_name, ".actor/actor.json")
    if isinstance(manifest, dict):
        input_field = manifest.get("input")
        if isinstance(input_field, dict):
            return input_field
        if isinstance(input_field, str) and input_field.strip():
            schema = _resolve_relative_input_path(files_by_name, input_field)
            if schema is not None:
                return schema

    schema = _read_json_source_file(files_by_name, ".actor/input_schema.json")
    return schema if isinstance(schema, dict) else None
