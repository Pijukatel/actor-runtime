"""Helpers for the public-Apify-style response envelope and error shapes."""
from __future__ import annotations

import gzip
import json
from typing import Any

import brotli
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .service import Service


def get_service(request: Request) -> Service:
    return request.app.state.service


async def read_body(request: Request) -> bytes:
    """Read the raw request body, transparently decompressing it if needed.

    apify-client sends some payloads (e.g. the Actor version source files)
    with ``Content-Encoding: gzip``, and -- since apify-client 3.x -- every
    storage write the SDK's own internal API client makes (``set_value``/
    ``push_data``/``add_request``/... via ``Actor.new_client()`` too) with
    ``Content-Encoding: br`` (Brotli), its own default compression for that
    client. Starlette does not decompress either automatically; a body that
    claims one of these encodings but is malformed yields a 400, not a bare
    500.
    """
    body = await request.body()
    if not body:
        return body
    encoding = request.headers.get("content-encoding", "").lower()
    if "br" in encoding:
        try:
            body = brotli.decompress(body)
        except brotli.error as exc:
            raise HTTPException(status_code=400, detail=f"Malformed brotli request body: {exc}")
    elif "gzip" in encoding:
        try:
            body = gzip.decompress(body)
        except (OSError, EOFError) as exc:
            raise HTTPException(status_code=400, detail=f"Malformed gzip request body: {exc}")
    return body


async def read_json(request: Request) -> Any:
    body = await read_body(request)
    if not body:
        return {}
    try:
        return json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail=f"Malformed JSON request body: {exc}")


def _parse_int(raw: str, key: str, minimum: int, message: str) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"Query parameter '{key}' must be an integer.")
    if value < minimum:
        raise HTTPException(status_code=400, detail=message)
    return value


def bounded_int(params, key: str, default: int, minimum: int, message: str) -> int:
    """Parse an integer query param with a lower bound, or raise a 400 (never a bare 500).

    Mirrors the malformed-body handling: a non-integer or out-of-range value is
    caller error, so it maps to HTTP 400 in the Apify error shape rather than an
    uncaught ``ValueError`` that FastAPI would surface as a 500. ``minimum=1``
    yields "must be positive" semantics; ``minimum=0`` yields "must not be
    negative" semantics.
    """
    raw = params.get(key)
    if raw is None or raw == "":
        return default
    return _parse_int(raw, key, minimum, message)


def optional_bounded_int(params, key: str, minimum: int, message: str) -> int | None:
    """Like ``bounded_int``, but returns ``None`` (not a default value) when the
    param is absent -- for optional pagination params where "absent" must stay
    distinguishable from any concrete integer, including ``0``. Callers use
    ``None`` to mean "keep today's unpaginated behaviour".
    """
    raw = params.get(key)
    if raw is None or raw == "":
        return None
    return _parse_int(raw, key, minimum, message)


def data(payload: Any, status_code: int = 200) -> JSONResponse:
    return JSONResponse({"data": payload}, status_code=status_code)


def bad_request(message: str = "The request is not valid.") -> JSONResponse:
    return JSONResponse(
        {"error": {"type": "invalid-request", "message": message}}, status_code=400
    )


def not_found(message: str = "We did not find the resource you were looking for.") -> JSONResponse:
    return JSONResponse(
        {"error": {"type": "record-not-found", "message": message}}, status_code=404
    )


def forbidden(message: str = "You do not have permission to perform this action.") -> JSONResponse:
    return JSONResponse(
        {"error": {"type": "insufficient-permissions", "message": message}}, status_code=403
    )


def conflict(message: str = "A resource with this id already exists.") -> JSONResponse:
    return JSONResponse(
        {"error": {"type": "resource-conflict", "message": message}}, status_code=409
    )


def unauthorized(message: str = "The provided API token is not valid.") -> JSONResponse:
    return JSONResponse(
        {"error": {"type": "invalid-token", "message": message}}, status_code=401
    )


def standby_unavailable(
    message: str = "The standby Actor did not become ready in time.",
) -> JSONResponse:
    return JSONResponse(
        {"error": {"type": "actor-standby-unavailable", "message": message}}, status_code=503
    )


def standby_start_failed(
    message: str = "The standby Actor failed to start.",
) -> JSONResponse:
    """An infrastructure/driver failure while launching a standby container --

    distinct from ``not_found`` ("no successful build") and from
    ``standby_unavailable`` ("started but never became ready"): here the
    container never even started, for a reason that has nothing to do with
    whether the Actor id or its build exist. 500-family, not 404, so a
    developer isn't misled into thinking they need to push a new build.
    """
    return JSONResponse(
        {"error": {"type": "actor-standby-start-failed", "message": message}}, status_code=500
    )
