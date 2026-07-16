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
