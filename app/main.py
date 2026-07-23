"""FastAPI application factory."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .auth import InvalidTokenError
from .config import Settings, load_settings
from .db import Database
from .driver import Driver
from .responses import unauthorized
from .routers import actors, console, runs, runtime_config, standby, storages, users
from .service import Service
from .storage import Storage
from .upstream import UpstreamFallbackMiddleware


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

            drv = DockerDriver(network_name=settings.network_name)
        # Create (if absent) the shared network and self-attach under the
        # container-facing alias; guarded no-op when not running as a
        # container (see DockerDriver.ensure_network). Blocking Docker-SDK
        # I/O, so run it off the event loop like every other driver call.
        await asyncio.to_thread(drv.ensure_network)

        service = Service(settings, db, storage, drv)
        # Sweep any Build/Run rows left RUNNING by a previous unclean shutdown.
        await service.reconcile_stale_jobs()
        # Background idle-reap loop for warm standby runs.
        service.start_standby_watchdog()
        app.state.service = service
        try:
            yield
        finally:
            await service.stop_standby_watchdog()
            await storage.stop()
            await db.dispose()

    app = FastAPI(title="actor-runtime", lifespan=lifespan)
    # Opt-in, off by default (Service.upstream_fallback_enabled) -- see
    # app/upstream.py's module docstring for the full contract. Registered
    # BEFORE CORSMiddleware: Starlette's add_middleware prepends, so the LAST
    # middleware added ends up OUTERMOST. CORS must be outermost so it still
    # wraps the brand-new Response the fallback middleware builds from a
    # relayed upstream reply (that response never passes back through
    # anything registered *before* it) -- reversing this order would make
    # every relayed fallback response silently miss its CORS headers.
    app.add_middleware(UpstreamFallbackMiddleware)
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
    app.include_router(standby.router)
    app.include_router(storages.router)
    # Global fallback toggle.
    app.include_router(runtime_config.router)
    # Console SPA.
    app.include_router(console.router)
    return app
