"""Entrypoint: serve the same app on two ports (API + console) and print URLs.

The app's lifespan (DB + storage + driver setup) runs exactly once; both uvicorn
servers then serve the already-initialised app with their own lifespan disabled.
"""
from __future__ import annotations

import asyncio

import uvicorn

from .config import load_settings
from .main import create_app


async def _serve() -> None:
    settings = load_settings()
    app = create_app(settings)

    print("=" * 60, flush=True)
    print("  actor-runtime is starting", flush=True)
    print(f"  API URL:     http://localhost:{settings.port_api}", flush=True)
    print(f"  Console URL: http://localhost:{settings.port_console}", flush=True)
    print("=" * 60, flush=True)

    api_server = uvicorn.Server(
        uvicorn.Config(app, host="0.0.0.0", port=settings.port_api, log_level="info", lifespan="off")
    )
    console_server = uvicorn.Server(
        uvicorn.Config(app, host="0.0.0.0", port=settings.port_console, log_level="warning", lifespan="off")
    )

    # Run the app lifespan once, then serve both ports against the ready app.
    async with app.router.lifespan_context(app):
        await asyncio.gather(api_server.serve(), console_server.serve())


def main() -> None:
    asyncio.run(_serve())


if __name__ == "__main__":
    main()
