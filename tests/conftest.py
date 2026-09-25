"""Shared fixtures.

Tests run against a real Postgres and Redis - the same ones `docker compose up`
starts. Nothing here mocks the database: the behaviour under test is largely
*about* transactions, revocation and uniqueness, which a mock would not
exercise. Every test gets an empty database, which is cheap here and keeps
tests order-independent.

Run with: `docker compose exec api pytest` (see Makefile's `make test`), or
against a local Postgres/Redis with `uv run pytest`.
"""

import asyncio
import logging
import re

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.database import engine
from app.main import app

# The link tokens only ever exist in the outgoing message, so tests read them
# back out of the log the same way a person would read their inbox.
_SENT: list[str] = []


class _Capture(logging.Handler):
    def emit(self, record):
        _SENT.append(record.getMessage())


logging.getLogger("app.email").addHandler(_Capture())
logging.getLogger("app.email").setLevel(logging.INFO)
logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)


@pytest.fixture(autouse=True)
def clean_database():
    async def truncate():
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "TRUNCATE users, refresh_tokens, one_time_tokens, "
                    "recovery_codes, webauthn_challenges RESTART IDENTITY CASCADE"
                )
            )
        # These connections belong to the loop asyncio.run() just created;
        # leaving them pooled would let the app's own loop pick one up and
        # fail with "attached to a different loop".
        await engine.dispose()

        # Every test hits the rate-limited endpoints from the same client IP
        # (127.0.0.1), so limits accumulated by an earlier test would 429 a
        # later, unrelated one. Flushed here rather than raised in
        # app/config.py, so the limits under test are the real production
        # values.
        from app.cache import close_cache, get_client

        await get_client().flushdb()
        await close_cache()

    asyncio.run(truncate())
    _SENT.clear()
    yield


@pytest.fixture
def client(clean_database):
    """Depends on clean_database so the truncate always happens first."""
    with TestClient(app) as c:
        yield c


@pytest.fixture
def sent():
    """The captured outbound messages, newest last."""
    return _SENT


PASSWORD = "correct-horse-battery-staple"


def link_token(kind: str) -> str | None:
    """Pull the token out of the most recent matching email."""
    for message in reversed(_SENT):
        match = re.search(rf"{kind}\?token=([\w\-]+)", message)
        if match:
            return match.group(1)
    return None


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def register(client, email: str = "user@example.com", password: str = PASSWORD):
    """Sign up and confirm the address. Returns (email, password) for reuse."""
    response = client.post("/v1/auth/signup", json={"email": email, "password": password})
    assert response.status_code == 201, response.text
    client.post("/v1/auth/verify-email", json={"token": link_token("verify-email")})
    return email, password


def login(client, email: str = "user@example.com", password: str = PASSWORD):
    """Log in and return the access token. Cookies land on the client."""
    response = client.post("/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


def csrf_headers(client) -> dict[str, str]:
    token = client.cookies.get("csrf_token")
    assert token, "no csrf_token cookie on the client - log in first"
    return {"X-CSRF-Token": token}


def onboard(client, token: str, handle: str = "runner", **extra) -> dict:
    """Finish onboarding. Defaults to an adult with a public profile."""
    body = {
        "handle": handle,
        "display_name": handle.title(),
        "birth_year": 1990,
        "accept_terms": True,
        "timezone": "UTC",
        "weekly_target": 3,
        "visibility": "public",
    } | extra
    response = client.post("/v1/me/onboarding", json=body, headers=bearer(token))
    assert response.status_code == 200, response.text
    return response.json()


def person(client, email: str, handle: str, **extra) -> str:
    """Register, verify, log in and onboard. Returns an access token."""
    register(client, email)
    token = login(client, email)
    onboard(client, token, handle, **extra)
    return token
