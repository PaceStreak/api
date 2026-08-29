"""The health endpoint is what the uptime monitor watches."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import __version__


def test_health_returns_ok(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": __version__}


def test_health_is_not_versioned(client: TestClient) -> None:
    """Health is an operational endpoint, not part of the client contract.

    If this starts failing because health moved under /v1, the uptime monitor
    in PaceStreak/status has to move with it.
    """
    assert client.get("/v1/health").status_code == 404
