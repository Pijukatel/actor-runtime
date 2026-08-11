"""Resolve the acting user from the request's ``Authorization: Bearer`` token.

There is no real authentication. Identity (a username) and credential (a token)
are decoupled: the token is only ever used to look up which stored user is acting
and is never turned into a username. An absent token resolves to the default local
user; the first token ever presented binds ("bootstraps") the default user's
credential; a later token that matches no stored user is rejected.

Three variants of that resolution live here side by side, deliberately
co-located so they can be diffed by eye, in definition order:

- ``resolve_user`` — the default described above: bootstrap-or-reject. Used
  by every registered handler that needs identity. Takes a keyword-only
  ``bootstrap`` (default ``True``); ``app/routers/runtime_config.py``'s
  ``PUT`` handler is the one caller that passes ``bootstrap=False``, turning
  an unresolvable token into a plain rejection with NO state mutation instead
  of binding it to the default user. See its own docstring for why that one
  endpoint must never bootstrap.
- ``resolve_standby_caller`` — differs from ``resolve_user`` in exactly one
  respect: an absent credential is rejected (401) rather than falling back to
  the default user, since forwarding into (and possibly starting) an Actor
  container must never happen anonymously. Also accepts a ``?token=`` query
  credential ``resolve_user`` does not.
- ``resolve_forwardable_token`` — a PURE lookup for ``app/upstream.py``'s
  fallback proxy: never binds or bootstraps, so a token matching no existing
  user simply has nothing to forward (``None``) rather than claiming the
  default user's credential as a side effect. See its own docstring.
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


async def resolve_user(request: Request, *, bootstrap: bool = True) -> str:
    """Return the acting username for the request's credential.

    No token -> the default user. A token matching a stored user -> that
    user. A token matching no user, with ``bootstrap`` True (the default,
    used by every registered handler that needs identity) -> bootstrap the
    (still unclaimed) default user with it, else reject.

    ``bootstrap=False`` is used only by ``app/routers/runtime_config.py``'s
    ``PUT`` handler: a token matching no user is rejected outright, with NO
    state mutation -- ``bind_default_token`` is never called. That distinction
    matters specifically there because that switch, once on, causes the
    runtime to forward the caller's own real Apify credential to the public
    internet on a local 404: binding an unrecognized token to the default
    user's credential on that one endpoint would both hand whoever presented
    it control over every future anonymous fallback attempt AND permanently
    lock out the operator's own later, real login (a bound default user can
    never again satisfy this function's own ``token IS NULL`` bootstrap
    condition below).
    """
    token = token_from_request(request)
    service = request.app.state.service
    if not token:
        await service.ensure_default_user()
        return DEFAULT_USERNAME
    username = await service.user_for_token(token)
    if username is not None:
        return username
    if bootstrap and await service.bind_default_token(token):
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


async def resolve_forwardable_token(request: Request) -> str | None:
    """Return the caller's own bound token to forward upstream, or ``None``.

    Used only by ``app/upstream.py``'s fallback proxy. Differs from
    ``resolve_user`` in that it is a PURE lookup: it never binds or
    bootstraps, so a token matching no existing user simply has nothing to
    forward (returns ``None``, meaning "abandon the whole fallback attempt")
    rather than claiming the (possibly still-unclaimed) default user's
    credential as a side effect. This matters because one path -- the SPA
    catch-all -- can reach this lookup before any handler's own
    ``resolve_user`` call does (it 404s an unmatched allowlisted path without
    authenticating first), so a read-through fallback attempt must never
    silently bootstrap local identity state.

    Two outcomes are NOT the same and callers must not conflate them:
    - ``None`` — a PRESENT token matched no existing user. There is truly
      nothing to forward; the caller must abandon the attempt entirely.
    - ``""`` (empty string) — the caller resolved to a known user (or, with
      no token at all, the default user) who simply has no bound `token` yet
      (e.g. the still-unclaimed default user). The attempt must proceed,
      forwarding no ``Authorization`` header, rather than abort.

    A present token resolves through ``Service.get_user``, NOT the presented
    token directly: ``user_for_token`` matches either a user's bound
    ``token`` OR their ``container_token`` (so an Actor container's own
    injected ``APIFY_TOKEN`` also resolves here), and the row's own ``token``
    -- the user's real bound credential -- is what must be forwarded, never
    the container token that happened to resolve it.
    """
    token = token_from_request(request)
    service = request.app.state.service
    if token:
        username = await service.user_for_token(token)
        if username is None:
            return None
    else:
        username = DEFAULT_USERNAME
    row = await service.get_user(username)
    return row.token if row is not None and row.token else ""
