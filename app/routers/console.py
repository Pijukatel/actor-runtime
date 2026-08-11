"""Serves the static console single-page app."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, Response

from ..responses import not_found

router = APIRouter()
_CONSOLE_DIR = Path(__file__).resolve().parent.parent / "console"

# Without an explicit Cache-Control, browsers apply HEURISTIC caching to these
# static files and can keep serving a stale app.js for hours after the runtime
# image was rebuilt with new console code. `no-cache` means "revalidate before
# every use": FileResponse's ETag/Last-Modified turn that into cheap 304s, so
# the console always picks up a rebuilt image without hard refreshes.
_NO_CACHE = {"Cache-Control": "no-cache"}

# First path segment of every client route the SPA owns. A deep link or refresh
# to any of these must render the app shell (index.html), so the browser can run
# the client router. Anything else is not a console route.
_SPA_PREFIXES = ("actors", "storage", "users")


@router.get("/")
@router.get("/console")
async def index() -> FileResponse:
    return FileResponse(_CONSOLE_DIR / "index.html", headers=_NO_CACHE)


@router.get("/console/app.js")
async def app_js() -> FileResponse:
    return FileResponse(_CONSOLE_DIR / "app.js", media_type="application/javascript", headers=_NO_CACHE)


@router.get("/console/input_tab.js")
async def input_tab_js() -> FileResponse:
    return FileResponse(_CONSOLE_DIR / "input_tab.js", media_type="application/javascript", headers=_NO_CACHE)


@router.get("/console/storage_tab.js")
async def storage_tab_js() -> FileResponse:
    return FileResponse(_CONSOLE_DIR / "storage_tab.js", media_type="application/javascript", headers=_NO_CACHE)


@router.api_route(
    "/{full_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    response_model=None,
)
async def spa_catch_all(request: Request, full_path: str) -> Response:
    """Serve the SPA shell for client-side routes so deep links / refreshes work.

    This is registered LAST (both within this router and in main.py, where
    ``console.router`` is included last), so it only sees paths no earlier route
    — every ``/v2/*`` API route, ``/``, ``/console``, ``/console/app.js``,
    ``/console/input_tab.js`` and ``/console/storage_tab.js`` — matched. It
    serves ``index.html`` ONLY for a GET
    to the SPA's own top-level prefixes (an allowlist on the first path
    segment); every other unmatched path is a normal API 404 in the Apify
    envelope, so the catch-all never shadows the API surface.

    It matches all common methods (not just GET) so an unknown path answers a
    uniform 404 regardless of verb: a GET-only catch-all would leave a non-GET
    request to an unknown path a *partial* route match, which Starlette reports
    as ``405 Method Not Allowed`` — misleading for a path that does not exist.
    """
    first = full_path.split("/", 1)[0]
    if request.method == "GET" and first in _SPA_PREFIXES:
        return FileResponse(_CONSOLE_DIR / "index.html", headers=_NO_CACHE)
    return not_found()
