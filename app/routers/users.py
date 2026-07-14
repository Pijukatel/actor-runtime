"""User management endpoints: list all users and create a user by name.

Both are deliberately open (no per-user guard, tokens returned in plaintext) —
consistent with the tool's local, no-auth ethos. Tokens are the mechanism the
console uses to reveal and switch the acting user.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Request

from ..auth import resolve_user
from ..responses import bad_request, conflict, data, get_service, read_json
from ..serializers import user_dict

router = APIRouter()

# A username is the load-bearing owner segment of the ``username~name`` id scheme
# (Actors and storages) and of storage id namespacing, so it must exclude ``~``
# and ``/`` at minimum. Restrict to the safe charset identity was always confined
# to, and require at least one alphanumeric so a "safe" name can't be all-
# punctuation (``.``, ``..``, ``---``); reject anything else rather than mutate
# (the name is also the token, so silent mutation would break login).
_SAFE_NAME = re.compile(r"^(?=.*[A-Za-z0-9])[A-Za-z0-9_.-]+$")


@router.get("/v2/users")
async def list_users(request: Request) -> object:
    svc = get_service(request)
    users = await svc.list_users()
    items = [user_dict(u) for u in users]
    return data({"total": len(items), "count": len(items), "items": items})


@router.post("/v2/users")
async def create_user(request: Request) -> object:
    svc = get_service(request)
    await resolve_user(request)
    body = await read_json(request)
    name = body.get("name") if isinstance(body, dict) else None
    if not isinstance(name, str) or not name or not _SAFE_NAME.match(name):
        return bad_request(
            "User name must be a non-empty string, contain only letters, digits, '_', '.' or '-' "
            "(no '~', '/', spaces or other characters), and include at least one letter or digit."
        )
    user = await svc.create_user(name)
    if user is None:
        # Distinguish a taken username from a name that collides with another
        # user's (unique) token, so the 409 message reflects the actual cause.
        if await svc.get_user(name) is not None:
            return conflict(f"A user named '{name}' already exists.")
        return conflict(f"The name '{name}' is already in use as another user's token.")
    return data(user_dict(user), status_code=201)
