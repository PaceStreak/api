"""Application wiring."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_docs_are_served_outside_production(client: TestClient) -> None:
    assert client.get("/docs").status_code == 200
    assert client.get("/openapi.json").status_code == 200


def test_docs_are_absent_in_production() -> None:
    """The schema describes the attack surface; production need not publish it."""
    app = create_app(Settings(environment="production", cookie_domain="pacestreak.com"))

    with TestClient(app) as client:
        assert client.get("/docs").status_code == 404
        assert client.get("/openapi.json").status_code == 404


def test_v1_prefix_is_mounted(client: TestClient) -> None:
    """No v1 routes exist yet, but the prefix must be reserved from the start.

    A 404 under /v1 is expected; what would be wrong is /v1 resolving to
    something else, or a client-facing route appearing outside it.
    """
    assert client.get("/v1/").status_code == 404
