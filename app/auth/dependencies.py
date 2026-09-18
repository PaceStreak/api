from dataclasses import dataclass
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt.exceptions import InvalidTokenError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.cache import cache_user, get_cached_user, is_session_revoked
from app.auth.models import RefreshToken, User
from app.auth.security import decode_access_token
from app.database import get_db

bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class CurrentAuth:
    """The authenticated user plus the session the request arrived on.

    Endpoints that only need identity depend on get_current_user; those that
    must distinguish *this* session from the user's others - /v1/auth/sessions
    - depend on get_current_auth for the session id.
    """

    user: User
    session_id: UUID


async def get_current_auth(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> CurrentAuth:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
        )

    try:
        payload = decode_access_token(credentials.credentials)
        user_id: UUID = payload.get("sub")
        # Parsed here, inside the guard: a malformed sid must be a 401, not a
        # 500 from UUID() further down.
        session_id: UUID = UUID(payload["sid"])
    except (InvalidTokenError, ValueError, KeyError) as err:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
        ) from err

    # Single-session logout. Unlike the user cache this cannot fail open, so a
    # Redis outage falls through to the database rather than skipping the check.
    revoked = await is_session_revoked(session_id)
    if revoked is None:
        revoked = not await _session_is_live(db, session_id)
    if revoked:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Session has been logged out"
        )

    user = await get_cached_user(user_id)
    if user is None:
        user = await db.get(User, user_id)
        if user is not None:
            await cache_user(user)

    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User is inactive or missing"
        )

    # Revoked by /v1/auth/logout-all, which bumps the user's token_version.
    if payload.get("ver") != user.token_version:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Token has been revoked"
        )

    return CurrentAuth(user=user, session_id=session_id)


async def get_current_user(auth: CurrentAuth = Depends(get_current_auth)) -> User:
    """The common case: identity only."""
    return auth.user


async def get_current_db_user(
    auth: CurrentAuth = Depends(get_current_auth),
    db: AsyncSession = Depends(get_db),
) -> User:
    """A session-attached User, re-read from Postgres.

    get_current_user may hand back a cached instance: it carries only the
    columns the cache stores, and it is transient, not attached to a session.
    That is fine for identity, but wrong in two ways for anything else -
    secret columns like hashed_password and totp_secret are deliberately not
    cached, and assignments to a transient instance are never persisted by
    commit().

    So every endpoint that reads a secret column or writes to the user depends
    on this instead.
    """
    user = await db.get(User, auth.user.id)
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User is inactive or missing"
        )
    return user


async def get_verified_user(user: User = Depends(get_current_user)) -> User:
    """For endpoints that must not be reachable before the address is
    confirmed. Unused by default, since REQUIRE_VERIFIED_EMAIL gates at login,
    but this is the hook for per-endpoint enforcement."""
    if not user.is_verified:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Email address not verified"
        )
    return user


async def _session_is_live(db: AsyncSession, session_id: UUID) -> bool:
    """Database fallback for the session denylist.

    A session is live while at least one refresh token in its family is
    unrevoked; logout revokes the whole family, leaving none.
    """
    result = await db.execute(
        select(RefreshToken.id)
        .where(RefreshToken.family_id == session_id)
        .where(RefreshToken.revoked_at.is_(None))
        .limit(1)
    )
    return result.scalar_one_or_none() is not None
