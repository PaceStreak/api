import logging
import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.auth.router import CSRF_HEADER
from app.cache import close_cache, init_cache
from app.config import get_settings
from app.database import Base, engine
from app.ops.health import router as health_router
from app.ratelimit import limiter
from app.v1.router import router as v1_router
from app.versioning import API_V1_PREFIX, API_VERSION

settings = get_settings()

# The app's own loggers (app.email, app.worker, ...) have no handler unless
# something configures one, and uvicorn only configures its own. Without
# this, EMAIL_BACKEND=console "sends" verification links into the void and
# local sign-up cannot be completed.
_app_logger = logging.getLogger("app")
if not _app_logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s %(message)s"))
    _app_logger.addHandler(_handler)
    _app_logger.setLevel(logging.INFO)


def _check_production_config() -> None:
    """Fail loudly at startup rather than silently in production.

    Every one of these is a setting that works fine in development and is a
    real vulnerability left on by default in production - the kind of thing
    that otherwise only surfaces during an incident.
    """
    if settings.environment != "production":
        return

    problems = []
    if not settings.cookie_secure:
        problems.append("COOKIE_SECURE must be True in production")
    if settings.debug:
        problems.append("DEBUG must be False in production")
    if not settings.totp_encryption_key:
        problems.append(
            "TOTP_ENCRYPTION_KEY must be set in production, or a database dump "
            "is a permanent 2FA bypass for every enrolled user"
        )
    if settings.reset_db_on_startup:
        problems.append("RESET_DB_ON_STARTUP must be False in production")
    if not settings.turnstile_secret_key:
        problems.append(
            "TURNSTILE_SECRET_KEY must be set in production, or signup, login, "
            "forgot-password, resend-verification and recover have no protection "
            "against a script emptying the daily email quota or grinding through guesses"
        )

    if settings.email_backend != "smtp":
        problems.append(
            "EMAIL_BACKEND must be 'smtp' in production - on 'console', verification "
            "and password-reset links are only ever written to the log"
        )
    elif not (settings.smtp_ssl or settings.smtp_starttls):
        problems.append("SMTP_SSL or SMTP_STARTTLS must be on in production")
    if settings.jwt_private_key_pem is None and not os.path.isfile(settings.jwt_private_key_path):
        problems.append("No JWT private key: set JWT_PRIVATE_KEY_PEM or JWT_PRIVATE_KEY_PATH")
    if not settings.public_api_url.startswith("https://"):
        problems.append("PUBLIC_API_URL must be an https:// URL in production")
    if problems:
        for problem in problems:
            print(f"refusing to start: {problem}", file=sys.stderr)
        raise SystemExit(1)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _check_production_config()

    # Schema is owned by Alembic (`docker compose run --rm api alembic upgrade
    # head`, or RUN_MIGRATIONS=1 - see docker/entrypoint.sh). This is a
    # development-only escape hatch: it bypasses Alembic entirely, so the
    # database ends up ahead of alembic_version and migrations then fail until
    # `alembic stamp head` fixes the bookkeeping by hand.
    if settings.environment == "development" and settings.reset_db_on_startup:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

    init_cache()

    yield

    await close_cache()
    await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        debug=settings.debug,
        lifespan=lifespan,
    )

    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.add_middleware(SlowAPIMiddleware)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*", CSRF_HEADER],
    )

    app.include_router(v1_router, prefix=API_V1_PREFIX)

    # Reports which URL version served the request, the way Stripe's
    # `Stripe-Version` response header or GitHub's versioned media types do -
    # cheap for a client to log, and it turns "which version am I actually
    # hitting" from a support question into a header they already have.
    # Skipped on /health: that route is intentionally unversioned so a
    # monitor's URL never has to change across a version bump.
    @app.middleware("http")
    async def add_api_version_header(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith(API_V1_PREFIX):
            response.headers["PaceStreak-Version"] = API_VERSION
        return response

    app.include_router(health_router)

    return app


app = create_app()
