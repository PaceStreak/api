"""Operational signals: failed sign-ins and client crash reports.

Both are for the operator, never for other users, and both are kept for 30
days and then swept by the worker.
"""

import hashlib
import hmac
from datetime import timedelta
from uuid import UUID

from fastapi import Request
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.time import utcnow
from app.config import get_settings
from app.ops.models import AuthFailure, ClientError

settings = get_settings()

RETENTION = timedelta(days=30)


def _key() -> bytes:
    # Derived from the JWT key, like the unsubscribe signatures: nothing new
    # to manage, and rotating the key rotates this.
    return hashlib.sha256(b"auth-failure:" + settings.jwt_private_key.encode()).digest()


def email_hash(email: str) -> str:
    """Keyed, so the table can't be reversed with a list of addresses."""
    return hmac.new(_key(), email.strip().lower().encode(), hashlib.sha256).hexdigest()


def client_ip(request: Request | None) -> str | None:
    if request is None:
        return None
    forwarded = request.headers.get("x-forwarded-for")
    ip = (
        forwarded.split(",")[0].strip()
        if forwarded
        else (request.client.host if request.client else None)
    )
    return ip[:45] if ip else None


async def record_failure(
    db: AsyncSession,
    kind: str,
    request: Request | None,
    email: str | None = None,
    user_id: UUID | None = None,
) -> None:
    """Record and commit in the caller's session. Never raises: an audit
    write must not turn a 401 into a 500."""
    try:
        if user_id is None and email:
            from app.auth.models import User

            user_id = (
                await db.execute(select(User.id).where(User.email == email.strip().lower()))
            ).scalar_one_or_none()
        db.add(
            AuthFailure(
                kind=kind,
                ip_address=client_ip(request),
                email_hash=email_hash(email) if email else None,
                user_id=user_id,
            )
        )
        await db.commit()
    except Exception:
        await db.rollback()


def fingerprint(message: str, stack: str | None) -> str:
    """Same bug, same row: the message plus the first stack frame, with
    line/column numbers kept (they identify the site) but query strings and
    content hashes of bundles left in, so a new release groups separately."""
    first = (stack or "").strip().splitlines()[1:2]
    return hashlib.sha256((message + "|" + "".join(first)).encode()).hexdigest()


async def sweep(db: AsyncSession) -> None:
    cutoff = utcnow() - RETENTION
    await db.execute(delete(AuthFailure).where(AuthFailure.created_at < cutoff))
    await db.execute(delete(ClientError).where(ClientError.last_seen < cutoff))


__all__ = ["ClientError", "email_hash", "fingerprint", "record_failure", "sweep"]
