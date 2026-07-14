"""Resolve the acting user from the request's ``Authorization: Bearer`` token.

There is no real authentication. The token string is sanitized into a username
and auto-provisioned into the ``users`` table the first time it is seen. An
absent or empty token resolves to the default local user, so every code path
that predates auth (and the unit suite's token-less requests) keeps working.
"""
from __future__ import annotations

import re

from fastapi import Request

from .config import DEFAULT_USERNAME


def _sanitize_username(token: str) -> str:
    return re.sub(r"[^a-z0-9_.-]+", "-", token.lower()).strip("-") or DEFAULT_USERNAME


def token_from_request(request: Request) -> str:
    header = request.headers.get("authorization", "")
    if not header:
        return ""
    parts = header.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return header.strip()


async def resolve_user(request: Request) -> str:
    """Return the acting username, provisioning it on first sight."""
    token = token_from_request(request)
    username = _sanitize_username(token) if token else DEFAULT_USERNAME
    await request.app.state.service.ensure_user(username)
    return username
