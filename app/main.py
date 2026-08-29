"""Application factory."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__, health, v1
from app.config import Settings, get_settings


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the ASGI application.

    A factory rather than a module-level singleton so tests can construct an
    application with different settings without reaching into global state.

    The local is named `application`, not `app`: this package is itself called
    `app`, and shadowing it inside the function would break any later
    `from app import ...` added here, in a way that reads as correct.
    """
    settings = settings or get_settings()

    application = FastAPI(
        title="PaceStreak API",
        version=__version__,
        summary="Backend for app.pacestreak.com.",
        # The interactive docs are useful in development and are an unnecessary
        # description of the attack surface in production.
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/openapi.json",
    )

    # `allow_credentials=True` with an explicit origin list is the only
    # combination that works here: the session cookie is sent on every
    # authenticated call, and browsers reject a wildcard origin on a
    # credentialed response. `Settings` refuses to hold "*" for this reason.
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_allow_origins),
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )

    application.include_router(health.router)
    application.include_router(v1.router)

    return application


app = create_app()
