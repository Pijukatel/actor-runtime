"""Dependency-free leaf constants and helpers shared across the service layer.

Kept in their own module (no imports from `.service`, `.standby`, or
`.storage_access`) specifically so `app/standby.py` and `app/storage_access.py`
can import them at plain module top level -- importing these five names from
`app.service` directly would recreate the circular imports those modules'
`TYPE_CHECKING`-only `Service` import exists to avoid. `app/service.py`
re-exports all five so existing `from .service import STORAGE_KV` etc. call
sites (routers, tests) keep working unchanged.
"""
from __future__ import annotations

import uuid

TERMINAL_OK = "SUCCEEDED"
TERMINAL_FAIL = "FAILED"
TERMINAL_ABORTED = "ABORTED"
TERMINAL_TIMED_OUT = "TIMED-OUT"

STORAGE_KV = "key-value-store"
STORAGE_DS = "dataset"
STORAGE_RQ = "request-queue"


def short_id() -> str:
    return uuid.uuid4().hex[:17]
