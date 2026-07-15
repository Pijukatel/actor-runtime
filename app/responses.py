"""Helpers for the public-Apify-style response envelope and error shapes."""
from __future__ import annotations

import gzip
import json
from typing import Any

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .service import Service


def get_service(request: Request) -> Service:
    return request.app.state.service


async def read_body(request: Request) -> bytes:
    """Read the raw request body, transparently gunzipping it if needed.

    apify-client sends some payloads (e.g. the Actor version source files) with
    ``Content-Encoding: gzip``; Starlette does not decompress automatically. A
    body that claims to be gzip but is malformed yields a 400, not a bare 500.
    """
    body = await request.body()
    if body and "gzip" in request.headers.get("content-encoding", "").lower():
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
