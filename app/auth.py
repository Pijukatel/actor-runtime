"""Resolve the acting user from the request's ``Authorization: Bearer`` token.

There is no real authentication. Identity (a username) and credential (a token)
are decoupled: the token is only ever used to look up which stored user is acting
and is never turned into a username. An absent token resolves to the default local
user; the first token ever presented binds ("bootstraps") the default user's
credential; a later token that matches no stored user is rejected.
"""
from __future__ import annotations

from fastapi import Request

from .config import DEFAULT_USERNAME


class InvalidTokenError(Exception):
    """Raised when a present bearer token matches no user after bootstrap."""


def token_from_request(request: Request) -> str:
    header = request.headers.get("authorization", "")
    if not header:
        return ""
    parts = header.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return header.strip()


async def resolve_user(request: Request) -> str:
    """Return the acting username for the request's credential.

    No token -> the default user. A token matching a stored user -> that user. A
    token matching no user -> bootstrap the (still unclaimed) default user with
    it, else reject.

    Memoizes its result on ``request.state`` so a second call for the SAME
    request is a cache hit rather than a second identical DB round-trip.
    ``request.state`` lives on the shared ASGI ``scope`` dict, so this is
    visible across every ``Request`` object built from that scope -- in
    particular, between a route handler's own call (most handlers resolve the
    caller before they can produce a 404) and app/upstream.py's
    ``fetch_upstream_fallback``, which re-resolves the same caller to build
    the upstream request's ``Authorization`` header when that local 404
    triggers a fallback attempt.
    """
    cached = getattr(request.state, "resolved_username", None)
    if cached is not None:
        return cached
    token = token_from_request(request)
    service = request.app.state.service
    if not token:
        await service.ensure_default_user()
        request.state.resolved_username = DEFAULT_USERNAME
        return DEFAULT_USERNAME
    username = await service.user_for_token(token)
    if username is not None:
        request.state.resolved_username = username
        return username
    if await service.bind_default_token(token):
        request.state.resolved_username = DEFAULT_USERNAME
        return DEFAULT_USERNAME
    raise InvalidTokenError()


async def resolve_standby_caller(request: Request) -> str:
    """Resolve the standby-forwarding caller's username from ``?token=`` or bearer.

    Differs from ``resolve_user`` in exactly one respect: a request presenting
    no credential at all is rejected (401) rather than falling back to the
    default user, since forwarding into (and possibly starting) an Actor
    container must never happen anonymously. A token that IS present goes
    through the exact same bootstrap-or-reject resolution as everywhere else.
    """
    token = request.query_params.get("token") or token_from_request(request)
    if not token:
        raise InvalidTokenError()
    service = request.app.state.service
    username = await service.user_for_token(token)
    if username is not None:
        return username
    if await service.bind_default_token(token):
        return DEFAULT_USERNAME
    raise InvalidTokenError()
