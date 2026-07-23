"""Dependency-free leaf constants and helpers shared across the service layer.

Kept in their own module (no imports from `.service`, `.standby`, or
`.storage_access`) specifically so `app/standby.py` and `app/storage_access.py`
can import them at plain module top level -- importing these names from
`app.service` directly would recreate the circular imports those modules'
`TYPE_CHECKING`-only `Service` import exists to avoid. `app/service.py`
re-exports them so existing `from .service import STORAGE_KV` etc. call
sites (routers, tests) keep working unchanged.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

TERMINAL_OK = "SUCCEEDED"
TERMINAL_FAIL = "FAILED"
TERMINAL_ABORTED = "ABORTED"
TERMINAL_TIMED_OUT = "TIMED-OUT"

STORAGE_KV = "key-value-store"
STORAGE_DS = "dataset"
STORAGE_RQ = "request-queue"


def storage_name_from_id(storage_id: str, storage_type: str) -> str:
    """Derive a storage's public ``name`` field from its id and type.

    Three id shapes exist (see ``requirements/api.md`` "Top-level storages"):
    a run-derived id (``kv_/ds_/rq_<runId>``, never contains ``~``) has no
    meaningful name and serializes as ``""``; a standalone id is either the
    unqualified ``owner~name`` (the first storage type to claim that owner+
    name), or -- once a *different* type collides on the same owner+name --
    the type-qualified ``owner~{storage_type}~name`` minted by
    ``_create_storage``. Splitting on the first ``~`` alone is wrong for the
    type-qualified shape: it yields ``"{storage_type}~name"`` instead of
    ``"name"``, a string crawlee's own ``validate_storage_name`` rejects
    (contains ``~``), which would crash any real SDK Actor that opens two
    storages of different types under the same name. This is the single
    place every serializer path (``app/serializers.py::storage_dict``,
    ``app/routers/storages.py::_storage_meta``) must derive ``name`` from,
    so the two never drift apart again.
    """
    if "~" not in storage_id:
        return ""
    rest = storage_id.split("~", 1)[1]
    prefix = f"{storage_type}~"
    return rest[len(prefix):] if rest.startswith(prefix) else rest


def short_id() -> str:
    return uuid.uuid4().hex[:17]


def log_stamp() -> str:
    """UTC timestamp prefix for runtime-written log lines.

    Container output gets per-line RFC3339Nano timestamps from Docker itself
    (``timestamps=True``); this millisecond-precision variant of the same
    shape is for the lines the runtime writes into a log on its own (RUN
    ERROR, standby teardown notes, ...), so every ``Run.log`` line starts
    with a timestamp regardless of who wrote it.
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
