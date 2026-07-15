"""FastAPI application factory."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .auth import InvalidTokenError
from .config import Settings, load_settings
from .db import Database
from .driver import Driver
from .responses import unauthorized
from .routers import actors, console, runs, storages, users
from .service import Service
from .storage import Storage


def create_app(settings: Settings | None = None, driver: Driver | None = None) -> FastAPI:
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        settings.runs_dir.mkdir(parents=True, exist_ok=True)
        settings.builds_dir.mkdir(parents=True, exist_ok=True)
        db = Database(settings.meta_db_url)
        await db.create_all()
        storage = Storage(settings.storage_db_url)
        await storage.start()

        drv = driver
        if drv is None:
            from .driver import DockerDriver

            drv = DockerDriver()

        service = Service(settings, db, storage, drv)
        # Sweep any Build/Run rows left RUNNING by a previous unclean shutdown.
        await service.reconcile_stale_jobs()
        app.state.service = service
        try:
            yield
        finally:
            await storage.stop()
            await db.dispose()

    app = FastAPI(title="actor-runtime", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(InvalidTokenError)
    async def _invalid_token_handler(request, exc):
        return unauthorized()

    # /v2/users/me
    app.include_router(actors.user_router)
    # User management (list / create).
    app.include_router(users.router)
    # Actor + version + build-trigger endpoints, under both spellings.
    for prefix in ("/v2/acts", "/v2/actors"):
        app.include_router(actors.router, prefix=prefix)
        app.include_router(runs.actor_runs_router, prefix=prefix)
    # Flat resources and storages.
    app.include_router(runs.flat_router)
    app.include_router(storages.router)
    # Console SPA.
    app.include_router(console.router)
    return app
