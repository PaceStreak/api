"""Cloudflare Turnstile: a challenge solved once per form submission, checked
here against Cloudflare's siteverify endpoint before an endpoint that sends
email or checks a password/recovery code runs.

This exists because the per-IP rate limits in app/ratelimit.py cap a single
address, not a script willing to use many. Unmetered, a bot hitting
/auth/signup or /auth/resend-verification can create accounts and trigger
verification email after verification email - on a free SMTP tier (Brevo,
300/day) that alone empties the day's quota for real users. Turnstile makes
that expensive to automate without adding a login of our own to a page that
should stay anonymous.

Unset TURNSTILE_SECRET_KEY (the default) turns this off entirely, so a fresh
checkout and the test suite need no Cloudflare account - the same pattern
EMAIL_BACKEND=console uses for mail.
"""

import logging

import httpx
from fastapi import HTTPException, Request, status

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


async def verify_turnstile(request: Request, token: str | None) -> None:
    """Raises 400 if the token is missing or Cloudflare rejects it, 503 if
    Cloudflare itself could not be reached. No-ops when no secret is set."""
    if not settings.turnstile_secret_key:
        return
    if not token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Complete the verification challenge")

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                _VERIFY_URL,
                data={
                    "secret": settings.turnstile_secret_key,
                    "response": token,
                    "remoteip": request.client.host if request.client else "",
                },
            )
        result = response.json()
    except httpx.HTTPError, ValueError:
        # Cloudflare being unreachable shouldn't silently wave every request
        # through - fail closed, and let the client just try again.
        logger.exception("turnstile siteverify request failed")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Verification is temporarily unavailable"
        ) from None

    if not result.get("success"):
        logger.info("turnstile rejected a token: %s", result.get("error-codes"))
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Verification failed, please try again")
