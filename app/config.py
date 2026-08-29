"""Runtime configuration.

Everything here is environment-driven. Nothing in this file may carry a real
secret as a default: a default that works in production is a secret that has
been committed.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["local", "staging", "production"]


class Settings(BaseSettings):
    """Settings, read from the environment and `.env` in that order.

    See `.env.example` for the full list. The defaults here are the *local*
    defaults; production overrides them through real environment variables.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="PACESTREAK_",
        extra="ignore",
        frozen=True,
    )

    environment: Environment = "local"

    # --- HTTP -------------------------------------------------------------
    #
    # Explicit origins only. A wildcard is rejected outright by browsers when
    # credentials are included, and this API always sends credentials, so a
    # wildcard here would not be a lax setting - it would be a broken one.
    cors_allow_origins: tuple[str, ...] = ("http://localhost:4321",)

    # --- Cookies ----------------------------------------------------------
    #
    # The session cookie must reach api.pacestreak.com from app.pacestreak.com,
    # which are different origins on the same site. Domain-scoping it to the
    # registrable domain is the only way to do that, and it is why every
    # subdomain of pacestreak.com sits inside one trust boundary.
    cookie_domain: str | None = None
    cookie_name: str = "__Secure-pacestreak-session"

    @field_validator("cors_allow_origins")
    @classmethod
    def _reject_wildcard_origin(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if "*" in value:
            msg = (
                "cors_allow_origins may not contain '*'. This API sends "
                "credentials, and browsers reject a wildcard origin on a "
                "credentialed response - the result is a CORS failure, not a "
                "permissive one. List the origins explicitly."
            )
            raise ValueError(msg)
        return value

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide settings.

    Cached so the environment is read once. Tests that need different settings
    should call `get_settings.cache_clear()` or override the FastAPI dependency
    rather than mutating the returned object, which is frozen.
    """
    return Settings()
