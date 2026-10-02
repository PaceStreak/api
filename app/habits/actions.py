"""Signed links behind a reminder's "Done" and "Snooze" buttons.

A push notification is handled by the service worker, which has no access
token (those live in the app's memory, by design). Like the one-click email
unsubscribe, the action URL carries an HMAC instead: scoped to one user, one
habit, one action and one day, and expiring, so a leaked link can at most
tick or snooze that one habit until it expires.
"""

import hashlib
import hmac
import time
from uuid import UUID

from app.config import get_settings

settings = get_settings()

ACTIONS = ("done", "snooze")
LIFETIME_SECONDS = 18 * 3600


def _secret() -> bytes:
    # Derived from the JWT key, like unsubscribe links: rotating it rotates these.
    return hashlib.sha256(b"habit-action:" + settings.jwt_private_key.encode()).digest()


def sign(user_id: UUID, habit_id: UUID, action: str, day: str, expires: int) -> str:
    message = f"{user_id}:{habit_id}:{action}:{day}:{expires}".encode()
    return hmac.new(_secret(), message, hashlib.sha256).hexdigest()[:40]


def verify(user_id: UUID, habit_id: UUID, action: str, day: str, expires: int, sig: str) -> bool:
    if action not in ACTIONS or expires < time.time():
        return False
    return hmac.compare_digest(sign(user_id, habit_id, action, day, expires), sig)


def action_url(user_id: UUID, habit_id: UUID, action: str, day: str) -> str:
    expires = int(time.time()) + LIFETIME_SECONDS
    sig = sign(user_id, habit_id, action, day, expires)
    return (
        f"{settings.public_api_url.rstrip('/')}/v1/habits/{habit_id}/action"
        f"?a={action}&u={user_id}&d={day}&e={expires}&s={sig}"
    )
