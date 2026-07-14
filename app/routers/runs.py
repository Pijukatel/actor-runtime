"""Run lifecycle endpoints plus build/run lookup and logs."""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse

from ..auth import resolve_user
from ..responses import data, get_service, not_found, read_body
from ..serializers import build_dict, run_dict


def _bounded_int(params, key: str, default: int, minimum: int, message: str) -> int:
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
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"Query parameter '{key}' must be an integer.")
    if value < minimum:
        raise HTTPException(status_code=400, detail=message)
    return value

# Start-run lives under the actor prefixes (/v2/acts + /v2/actors).
actor_runs_router = APIRouter()

# Flat resources.
flat_router = APIRouter()


@actor_runs_router.post("/{actor_id}/runs")
async def start_run(actor_id: str, request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    actor = await svc.get_actor(actor_id, username=user)
    if actor is None:
        return not_found(f"Actor '{actor_id}' was not found.")
    raw = await read_body(request)
    try:
        run_input = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        run_input = {}
    params = request.query_params
    # Validate every query param BEFORE starting the run so a bad value returns a
    # 400 without spawning a run. memory/timeout must be positive integers (a
    # zero/negative memory would otherwise silently disable the container memory
    # cap); waitForFinish may be 0.
    options = {
        "build": params.get("build", "latest"),
        "memoryMbytes": _bounded_int(
            params, "memory", 1024, minimum=1, message="Query parameter 'memory' must be positive."
        ),
        "timeoutSecs": _bounded_int(
            params, "timeout", 300, minimum=1, message="Query parameter 'timeout' must be positive."
        ),
    }
    wait_secs = min(
        _bounded_int(
            params, "waitForFinish", 0, minimum=0, message="Query parameter 'waitForFinish' must not be negative."
        ),
        60,
    )

    run = await svc.start_run(actor_id, run_input, options)

    deadline = wait_secs
    while deadline > 0:
        current = await svc.get_run(run.id)
        if current.status in {"SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"}:
            run = current
            break
        await asyncio.sleep(0.5)
        deadline -= 0.5
    else:
        run = await svc.get_run(run.id)
    return data(run_dict(run), status_code=201)


@actor_runs_router.get("/{actor_id}/runs")
async def list_runs(actor_id: str, request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    runs = await svc.list_runs(actor_id, username=user)
    items = [run_dict(r) for r in runs]
    return data({"total": len(items), "count": len(items), "items": items})


@flat_router.get("/v2/actor-runs/{run_id}")
async def get_run(run_id: str, request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    run = await svc.get_run(run_id, username=user)
    if run is None:
        return not_found(f"Run '{run_id}' was not found.")
    return data(run_dict(run))


@flat_router.post("/v2/actor-runs/{run_id}/abort")
async def abort_run(run_id: str, request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    run = await svc.abort_run(run_id, username=user)
    if run is None:
        return not_found(f"Run '{run_id}' was not found.")
    return data(run_dict(run))


@flat_router.get("/v2/actor-builds/{build_id}")
async def get_build(build_id: str, request: Request) -> object:
    svc = get_service(request)
    user = await resolve_user(request)
    build = await svc.get_build(build_id, username=user)
    if build is None:
        return not_found(f"Build '{build_id}' was not found.")
    return data(build_dict(build))


@flat_router.get("/v2/logs/{job_id}")
async def get_log(job_id: str, request: Request) -> PlainTextResponse:
    svc = get_service(request)
    user = await resolve_user(request)
    build = await svc.get_build(job_id, username=user)
    if build is not None:
        return PlainTextResponse(build.log or "")
    run = await svc.get_run(job_id, username=user)
    if run is not None:
        return PlainTextResponse(run.log or "")
    return PlainTextResponse("", status_code=404)
