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
import os
import re

# Before anything imports the app: ignore the developer's .env (see
# app/config.py), and default to email that is printed, never sent.
os.environ["PACESTREAK_ENV_FILE"] = ""
os.environ.setdefault("EMAIL_BACKEND", "console")
os.environ.setdefault("TURNSTILE_SECRET_KEY", "")

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
                    "recovery_codes, webauthn_challenges, worker_heartbeats, "
                    "client_errors, auth_failures "
                    "RESTART IDENTITY CASCADE"
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


@pytest.fixture(autouse=True)
def fake_storage(monkeypatch):
    """Body photos live in R2 in production; tests fake it with a dict so the
    suite needs no real bucket or credentials. See app/storage.py.

    A real presigned PUT happens entirely in the client's browser - this
    process never sees it - so a test stands in for "the browser's PUT
    succeeded" by writing into `objects` directly, under the same key
    `app.training.photos._object_key` would use, before calling the
    `/upload/complete` route. `verify_upload` below then runs the same
    size/magic-byte checks the real R2-backed version does, against that
    dict instead of a real bucket."""
    from app import storage

    objects: dict[str, tuple[bytes, str]] = {}

    async def put_object(key, data, content_type):
        objects[key] = (data, content_type)

    async def presigned_put_url(key, content_type, expires_in=300):
        return f"https://fake-r2.test/{key}"

    async def presigned_get_url(key, content_type, expires_in=60):
        return f"https://fake-r2.test/{key}"

    async def verify_upload(key, magic, max_bytes):
        if key not in objects:
            raise FileNotFoundError(key)
        data, _content_type = objects[key]
        if len(data) > max_bytes:
            del objects[key]
            raise ValueError("too large")
        if not data.startswith(magic):
            del objects[key]
            raise ValueError("wrong type")
        return len(data)

    async def get_object(key):
        try:
            return objects[key][0]
        except KeyError:
            raise FileNotFoundError(key) from None

    async def delete_object(key):
        objects.pop(key, None)

    async def delete_objects(keys):
        for key in keys:
            objects.pop(key, None)

    monkeypatch.setattr(storage, "put_object", put_object)
    monkeypatch.setattr(storage, "presigned_put_url", presigned_put_url)
    monkeypatch.setattr(storage, "presigned_get_url", presigned_get_url)
    monkeypatch.setattr(storage, "verify_upload", verify_upload)
    monkeypatch.setattr(storage, "get_object", get_object)
    monkeypatch.setattr(storage, "delete_object", delete_object)
    monkeypatch.setattr(storage, "delete_objects", delete_objects)
    return objects


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


# Distinguishes which of the three OTP emails a captured message is, by a
# substring unique to its subject line (email.py's send_*_email functions).
_OTP_SUBJECTS = {
    "verify-email": "subject=Confirm your",
    "reset-password": "subject=Reset your",
    "confirm-email": "subject=Confirm your new",
}


def otp_code(kind: str) -> str | None:
    """Pull the 6-digit code out of the most recent matching email."""
    marker = _OTP_SUBJECTS[kind]
    for message in reversed(_SENT):
        if marker not in message:
            continue
        # "verify-email"'s marker is a prefix of "confirm-email"'s subject, so
        # skip a message that actually matched the more specific one.
        if kind == "verify-email" and _OTP_SUBJECTS["confirm-email"] in message:
            continue
        match = re.search(r"code is: (\d{6})", message)
        if match:
            return match.group(1)
    return None


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def register(client, email: str = "user@example.com", password: str = PASSWORD):
    """Sign up and confirm the address. Returns (email, password) for reuse."""
    response = client.post("/v1/auth/signup", json={"email": email, "password": password})
    assert response.status_code == 201, response.text
    client.post("/v1/auth/verify-email", json={"email": email, "code": otp_code("verify-email")})
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
