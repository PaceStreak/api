"""Shared fixtures.

Settings are built explicitly per test rather than read from the environment,
so a developer's `.env` cannot change what the suite asserts.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

FRONTEND_ORIGIN = "https://app.pacestreak.com"


@pytest.fixture
def settings() -> Settings:
    return Settings(
        environment="local",
        cors_allow_origins=(FRONTEND_ORIGIN,),
        cookie_domain="pacestreak.com",
    )


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client
