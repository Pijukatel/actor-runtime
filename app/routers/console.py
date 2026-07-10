"""Serves the static console single-page app."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

router = APIRouter()
_CONSOLE_DIR = Path(__file__).resolve().parent.parent / "console"


@router.get("/")
@router.get("/console")
async def index() -> FileResponse:
    return FileResponse(_CONSOLE_DIR / "index.html")


@router.get("/console/app.js")
async def app_js() -> FileResponse:
    return FileResponse(_CONSOLE_DIR / "app.js", media_type="application/javascript")
