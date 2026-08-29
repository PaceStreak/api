"""CORS is load-bearing: the frontend cannot reach this API without it."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from tests.conftest import FRONTEND_ORIGIN


def test_allowed_origin_gets_credentialed_cors_headers(client: TestClient) -> None:
    response = client.get("/health", headers={"Origin": FRONTEND_ORIGIN})

    assert response.headers["access-control-allow-origin"] == FRONTEND_ORIGIN
    assert response.headers["access-control-allow-credentials"] == "true"


def test_allowed_origin_is_echoed_not_wildcarded(client: TestClient) -> None:
    """A wildcard would be rejected by the browser on a credentialed response.

    The failure mode is a blocked request, not a permissive one, so this is a
    correctness assertion rather than a hardening one.
    """
    response = client.get("/health", headers={"Origin": FRONTEND_ORIGIN})

    assert response.headers["access-control-allow-origin"] != "*"


def test_unknown_origin_gets_no_cors_headers(client: TestClient) -> None:
    response = client.get("/health", headers={"Origin": "https://evil.example"})

    assert "access-control-allow-origin" not in response.headers


def test_preflight_is_answered(client: TestClient) -> None:
    response = client.options(
        "/health",
        headers={
            "Origin": FRONTEND_ORIGIN,
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == FRONTEND_ORIGIN


def test_settings_reject_wildcard_origin() -> None:
    """Guard the mistake at construction time rather than at request time."""
    with pytest.raises(ValueError, match="may not contain"):
        Settings(cors_allow_origins=("*",))
