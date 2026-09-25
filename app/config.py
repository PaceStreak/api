from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", case_sensitive=False, extra="ignore"
    )

    app_name: str = Field(default="PaceStreak API")
    app_version: str = Field(default="0.1.0")
    environment: str = Field(default="development")
    debug: bool = Field(default=True)
    # Schema is owned by Alembic. This bypasses it and only exists for local
    # throwaway databases - see app/main.py.
    reset_db_on_startup: bool = Field(default=False)

    database_url: str = Field(
        default="postgresql+asyncpg://pacestreak:pacestreak@localhost:5432/pacestreak",
    )

    jwt_issuer: str = Field(default="api.pacestreak.com")
    jwt_audience: str = Field(default="pacestreak")
    access_token_minutes: int = Field(default=15)
    refresh_token_days: int = Field(default=7)

    jwt_private_key_path: str = Field(default="./keys/private.pem")
    jwt_public_key_path: str = Field(default="./keys/public.pem")
    # PEM contents, for platforms that inject secrets as environment variables
    # rather than files. When set they win over the *_PATH settings, and no
    # key file needs to exist - so no key file needs its permissions widened
    # to be readable by the container user.
    jwt_private_key_pem: str | None = Field(default=None, repr=False)
    jwt_public_key_pem: str | None = Field(default=None, repr=False)

    # --- cookies ------------------------------------------------------------
    # Domain=pacestreak.com is load-bearing: it is what lets app.pacestreak.com
    # send the cookie to api.pacestreak.com. That also means it can never carry
    # the __Host- prefix (which forbids Domain) - __Secure- is used instead.
    # Left unset for local development, where there is no shared registrable
    # domain between localhost:xxxx ports.
    cookie_domain: str | None = Field(default=None)
    cookie_secure: bool = Field(default=False)
    # SameSite=Lax is sufficient: api.pacestreak.com and app.pacestreak.com are
    # cross-origin but same-site. "none" would widen exposure for nothing and
    # also requires cookie_secure=True.
    cookie_samesite: str = Field(default="lax")

    redis_url: str = Field(default="redis://localhost:6379/0")
    redis_max_connections: int = Field(default=20)
    user_cache_ttl_seconds: int = Field(default=60)

    # --- email verification & password reset --------------------------------
    # Public URL of app.pacestreak.com, which handles the links emailed out.
    frontend_url: str = Field(default="http://localhost:5173")
    # Public URL of this API. Only used to build links that leave the app and
    # are fetched by something else - today, the private calendar feed URL
    # that a calendar app polls.
    public_api_url: str = Field(default="http://localhost:8000")
    require_verified_email: bool = Field(default=False)
    email_verify_token_hours: int = Field(default=24)
    password_reset_token_minutes: int = Field(default=30)

    # "console" logs the message instead of sending it - the default so a fresh
    # checkout works with no mail provider configured. No third-party email API
    # is wired in here; wiring one is a deliberate, separate decision.
    email_backend: str = Field(default="console")
    email_from: str = Field(default="no-reply@pacestreak.com")
    smtp_host: str = Field(default="localhost")
    smtp_port: int = Field(default=587)
    smtp_user: str | None = Field(default=None)
    smtp_password: str | None = Field(default=None)
    smtp_starttls: bool = Field(default=True)
    # Implicit TLS (port 465). Mutually exclusive with STARTTLS; one of the two
    # must be on in production, or credentials cross the network in clear.
    smtp_ssl: bool = Field(default=False)
    smtp_timeout_seconds: float = Field(default=10.0)
    smtp_attempts: int = Field(default=3)
    # Display name on outgoing mail: "PaceStreak <no-reply@pacestreak.com>".
    email_from_name: str = Field(default="PaceStreak")
    email_reply_to: str | None = Field(default="hello@pacestreak.com")

    # --- two-factor authentication -------------------------------------------
    mfa_challenge_minutes: int = Field(default=5)
    totp_valid_window: int = Field(default=1)
    recovery_code_count: int = Field(default=10)
    # Fernet key (44-char urlsafe-base64) encrypting totp_secret at rest, so a
    # database dump alone is not a permanent 2FA bypass. Generate with
    # `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
    # Left unset in development; app/main.py refuses to start with it unset
    # outside development.
    totp_encryption_key: str | None = Field(default=None)

    # --- web push -------------------------------------------------------------
    # VAPID identifies this server to the browsers' push services. `make vapid`
    # writes the key; with no key, push is simply off and the client never
    # offers it. The subject must be a mailto: or https: URL the push services
    # can contact about abuse.
    vapid_private_key_path: str = Field(default="./keys/vapid_private.pem")
    vapid_private_key_pem: str | None = Field(default=None, repr=False)
    vapid_subject: str = Field(default="mailto:hello@pacestreak.com")

    # --- worker ---------------------------------------------------------------
    # Seconds between scheduler ticks in app/worker.py. Reminders are aimed at
    # a local hour, so anything under a few minutes is precision nobody needs.
    worker_interval_seconds: int = Field(default=120)
    # Grace period between "delete my account" and the purge.
    deletion_grace_days: int = Field(default=30)

    # --- rate limiting --------------------------------------------------------
    # Backed by Redis (see app/ratelimit.py) so limits hold across replicas.
    rate_limit_login: str = Field(default="10/minute")
    rate_limit_mfa_verify: str = Field(default="10/minute")
    rate_limit_signup: str = Field(default="5/minute")
    rate_limit_password_email: str = Field(default="3/minute")

    # CORS_ORIGINS has no wildcard default on purpose - see the validator
    # below. Production must be the exact scheme+host of app.pacestreak.com.
    cors_origins: str = Field(default="http://localhost:5173")

    @model_validator(mode="after")
    def _reject_wildcard_cors_with_credentials(self) -> Settings:
        # Cookies mean every request carries credentials, so a wildcard origin
        # is not "insecure" here, it is a bug: Starlette's CORS middleware
        # echoes the caller's Origin back verbatim once allow_credentials=True
        # and "*" is configured, which lets any site ride the session cookie.
        # Refusing to boot is louder than a comment nobody re-reads.
        if "*" in self.cors_origin_list:
            raise ValueError(
                "CORS_ORIGINS must not contain '*' - this API sends credentialed "
                "cookies, so a wildcard origin authorises every site on the "
                "internet to use them. Name explicit origins instead."
            )
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def jwt_private_key(self) -> str:
        return _read_key(self.jwt_private_key_pem, self.jwt_private_key_path)

    @property
    def jwt_public_key(self) -> str:
        return _read_key(self.jwt_public_key_pem, self.jwt_public_key_path)

    @property
    def totp_issuer(self) -> str:
        return self.app_name


@lru_cache(maxsize=8)
def _read_key(pem: str | None, path: str) -> str:
    """Key material, read once per process rather than on every token signed.
    Literal "\\n" sequences are unescaped, because many secret stores flatten
    a multi-line PEM into one line."""
    if pem:
        return pem.replace("\\n", "\n").strip() + "\n"
    with open(path) as f:
        return f.read()


@lru_cache
def get_settings() -> Settings:
    return Settings()
