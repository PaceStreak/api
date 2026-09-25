"""Cache of the per-request auth state read by `get_current_user`.

Only the fields needed to authenticate and to serve /v1/auth/me are stored, so
the payload stays small and nothing sensitive (password hash, TOTP secret,
tokens) is held in Redis. Postgres remains the source of truth; a miss, a
stale entry, or an unreachable Redis all fall back to a database read.

Invalidation is explicit: anything that changes a user's auth state (logout-
all bumping token_version, deactivation, a role change) must call
invalidate_user. The TTL is a backstop for invalidation we forget or that is
lost to a Redis restart, not the primary mechanism.
"""

import json
import logging
from uuid import UUID

from redis.exceptions import RedisError

from app.auth.models import User, UserRole
from app.cache import get_client
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

KEY_PREFIX = "auth:user:"


def _key(user_id: UUID | str) -> str:
    return f"{KEY_PREFIX}{user_id}"


def _serialize(user: User) -> str:
    return json.dumps(
        {
            "id": str(user.id),
            "email": user.email,
            "role": user.role.value if user.role else None,
            "is_active": user.is_active,
            "is_verified": user.is_verified,
            "token_version": user.token_version,
        }
    )


def _deserialize(raw: str) -> User:
    """Rebuild a transient User from the cached fields.

    The result is not attached to a session: it carries exactly the cached
    columns and must not be used to write or to traverse relationships.
    """
    data = json.loads(raw)
    user = User(
        email=data["email"],
        role=UserRole(data["role"]) if data["role"] else None,
        is_active=data["is_active"],
        is_verified=data["is_verified"],
        token_version=data["token_version"],
    )
    user.id = UUID(data["id"])
    return user


async def get_cached_user(user_id: UUID | str) -> User | None:
    try:
        raw = await get_client().get(_key(user_id))
    except RedisError:
        logger.warning("auth cache read failed for %s", user_id, exc_info=True)
        return None

    if raw is None:
        return None

    try:
        return _deserialize(raw)
    except ValueError, KeyError:
        logger.warning("discarding unreadable auth cache entry for %s", user_id)
        await invalidate_user(user_id)
        return None


async def cache_user(user: User) -> None:
    try:
        await get_client().set(_key(user.id), _serialize(user), ex=settings.user_cache_ttl_seconds)
    except RedisError:
        logger.warning("auth cache write failed for %s", user.id, exc_info=True)


async def invalidate_user(user_id: UUID | str) -> None:
    """Drop a user's entry. Must be called whenever their auth state changes."""
    try:
        await get_client().delete(_key(user_id))
    except RedisError:
        # Worst case the stale entry survives until its TTL expires, which is
        # why user_cache_ttl_seconds is kept short.
        logger.warning("auth cache invalidation failed for %s", user_id, exc_info=True)


SESSION_REVOKED_PREFIX = "auth:revoked_sid:"


def _session_key(session_id: UUID | str) -> str:
    return f"{SESSION_REVOKED_PREFIX}{session_id}"


async def revoke_session(session_id: UUID | str) -> bool:
    """Deny every access token issued for this session.

    The entry only has to outlive the access tokens already in circulation, so
    it expires with them and the denylist stays bounded by recent logouts
    rather than growing forever.

    Returns False if Redis could not be reached, in which case callers must
    rely on the database fallback in is_session_revoked.
    """
    try:
        await get_client().set(_session_key(session_id), "1", ex=settings.access_token_minutes * 60)
        return True
    except RedisError:
        logger.warning("session revocation write failed for %s", session_id, exc_info=True)
        return False


async def is_session_revoked(session_id: UUID | str) -> bool | None:
    """True if revoked, False if not, None if Redis could not answer.

    None is not "allow": this check cannot fail open, so the caller must
    settle it against the database instead.
    """
    try:
        return await get_client().exists(_session_key(session_id)) == 1
    except RedisError:
        logger.warning("session revocation read failed for %s", session_id, exc_info=True)
        return None
