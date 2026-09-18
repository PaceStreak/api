"""Redis-backed rate limiting for the endpoints an attacker would automate.

Login, the MFA challenge, signup, and the two mailer endpoints are the ones
that matter: unlimited guesses at a 6-digit TOTP code defeats the second
factor outright, and an unmetered mailer endpoint sends email to any address
as fast as it is called. Keyed by client IP - this API has no session yet at
the point most of these run, so there is nothing else to key on.

Backed by Redis (already required for the session denylist) rather than
in-memory, so the limit holds if this ever runs as more than one replica.
"""

from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import get_settings

settings = get_settings()

limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=settings.redis_url,
    # Not True: injecting X-RateLimit-* headers requires every limited
    # endpoint to return (or declare) a starlette Response, which most of
    # these don't - they return a Pydantic model and let FastAPI serialise
    # it. Not worth reshaping every handler for informational headers.
    headers_enabled=False,
)
