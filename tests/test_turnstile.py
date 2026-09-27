"""app/turnstile.py, and its wiring into the endpoints it guards.

Cloudflare's siteverify endpoint is mocked here rather than called for real -
these are unit tests of our side of the contract (missing token, rejected
token, Cloudflare unreachable, and the exemption for an authenticated caller
asking for their own account), not of Cloudflare's service.
"""

import httpx
import pytest

import app.turnstile as turnstile_module
from tests.conftest import PASSWORD, bearer, login, register


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _FakeClient:
    """Stands in for httpx.AsyncClient(...) used as `async with ... as client`."""

    def __init__(self, result):
        self._result = result

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, *args, **kwargs):
        if isinstance(self._result, Exception):
            raise self._result
        return _FakeResponse(self._result)


@pytest.fixture
def turnstile_on(monkeypatch):
    """Returns a function that turns verification on, from the point it is
    called (not from fixture setup - tests need room to register/log in a
    user first, while it is still off), stubbing Cloudflare's response with
    the given payload (or an exception, for a network failure)."""

    def set_result(result):
        monkeypatch.setattr(turnstile_module.settings, "turnstile_secret_key", "test-secret")
        monkeypatch.setattr(
            turnstile_module.httpx, "AsyncClient", lambda **kw: _FakeClient(result)
        )

    return set_result


def test_off_by_default(client, monkeypatch):
    """With no secret key configured (the default), no token is required -
    signup works exactly as every other test in this suite expects."""
    monkeypatch.setattr(turnstile_module.settings, "turnstile_secret_key", None)
    response = client.post(
        "/v1/auth/signup", json={"email": "no-turnstile@example.com", "password": PASSWORD}
    )
    assert response.status_code == 201


def test_signup_requires_a_token_once_enabled(client, turnstile_on):
    turnstile_on({"success": True})
    response = client.post(
        "/v1/auth/signup", json={"email": "needs-token@example.com", "password": PASSWORD}
    )
    assert response.status_code == 400
    assert "Complete the verification challenge" in response.json()["detail"]


def test_signup_accepts_a_token_cloudflare_approves(client, turnstile_on):
    turnstile_on({"success": True})
    response = client.post(
        "/v1/auth/signup",
        json={"email": "approved@example.com", "password": PASSWORD, "turnstile_token": "tok"},
    )
    assert response.status_code == 201


def test_signup_rejects_a_token_cloudflare_declines(client, turnstile_on):
    turnstile_on({"success": False, "error-codes": ["invalid-input-response"]})
    response = client.post(
        "/v1/auth/signup",
        json={"email": "declined@example.com", "password": PASSWORD, "turnstile_token": "bad"},
    )
    assert response.status_code == 400
    assert "Verification failed" in response.json()["detail"]


def test_login_needs_a_token_too(client, turnstile_on):
    turnstile_on({"success": True})
    response = client.post(
        "/v1/auth/login", json={"email": "someone@example.com", "password": PASSWORD}
    )
    assert response.status_code == 400


def test_cloudflare_unreachable_fails_closed(client, turnstile_on):
    turnstile_on(httpx.ConnectError("boom"))
    response = client.post(
        "/v1/auth/signup",
        json={"email": "unreachable@example.com", "password": PASSWORD, "turnstile_token": "tok"},
    )
    assert response.status_code == 503


def test_resend_verification_needs_a_token_when_anonymous(client, turnstile_on):
    turnstile_on({"success": True})
    response = client.post(
        "/v1/auth/resend-verification", json={"email": "someone@example.com"}
    )
    assert response.status_code == 400


def test_resend_verification_skips_the_token_for_the_signed_in_owner(client, turnstile_on):
    """A live session already proves who the caller is - no widget is
    rendered for the resend button in Settings or the coach card, so the
    endpoint must not demand a token there."""
    email = "resend-owner@example.com"
    register(client, email)
    token = login(client, email)  # both need to run before turnstile turns on
    turnstile_on({"success": True})
    response = client.post(
        "/v1/auth/resend-verification",
        json={"email": email},
        headers=bearer(token),
    )
    assert response.status_code == 200


def test_resend_verification_cannot_be_used_to_spam_someone_elses_address(client, turnstile_on):
    """A logged-in caller's exemption only covers their own address - asking
    for anyone else's still needs a token, or a session becomes a free way
    around the whole point of this."""
    owner_email = "resend-owner-2@example.com"
    register(client, owner_email)
    token = login(client, owner_email)
    turnstile_on({"success": True})
    response = client.post(
        "/v1/auth/resend-verification",
        json={"email": "victim@example.com"},
        headers=bearer(token),
    )
    assert response.status_code == 400
