"""Crash reports in, and the operator's views of crashes and abuse."""

from datetime import timedelta
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.account.models import SecurityEvent
from app.admin.router import require_admin
from app.auth.models import User
from app.common.time import utcnow
from app.database import get_db
from app.ops.models import AuthFailure, ClientError
from app.ops.service import fingerprint
from app.ratelimit import limiter

router = APIRouter(tags=["ops"])

# Distinct crash groups kept at once (resolved ones free their slot).
MAX_GROUPS = 1000


class ClientErrorIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    stack: str | None = Field(default=None, max_length=20_000)
    url: str | None = Field(default=None, max_length=2000)
    release: str | None = Field(default=None, max_length=40)


@router.post("/client-errors", status_code=202)
@limiter.limit("30/minute")
async def report_client_error(
    request: Request, body: ClientErrorIn, db: AsyncSession = Depends(get_db)
):
    """No authentication and no user id: a crash on the sign-in screen must
    be reportable, and a crash report is not a reason to know who someone is.
    The URL is cut to its path, because query strings carry reset tokens."""
    now = utcnow()
    path = urlsplit(body.url).path[:300] if body.url else None
    message = body.message[:500]
    stack = body.stack[:4000] if body.stack else None
    agent = (request.headers.get("user-agent") or "")[:400] or None
    fp = fingerprint(message, stack)
    # Unauthenticated, so bounded: past MAX_GROUPS distinct crashes, only
    # ones already known are counted. Real crashes repeat; floods rotate.
    known = (
        await db.execute(select(ClientError.id).where(ClientError.fingerprint == fp))
    ).scalar_one_or_none()
    if known is None:
        groups = (await db.execute(select(func.count()).select_from(ClientError))).scalar_one()
        if groups >= MAX_GROUPS:
            return {"received": False}
    stmt = insert(ClientError).values(
        fingerprint=fp,
        message=message,
        stack=stack,
        path=path,
        release=body.release,
        user_agent=agent,
        count=1,
        first_seen=now,
        last_seen=now,
    )
    await db.execute(
        stmt.on_conflict_do_update(
            index_elements=[ClientError.fingerprint],
            set_={
                "count": ClientError.count + 1,
                "last_seen": now,
                "path": stmt.excluded.path,
                "user_agent": stmt.excluded.user_agent,
                "release": stmt.excluded.release,
            },
        )
    )
    await db.commit()
    return {"received": True}


@router.get("/admin/client-errors")
async def list_client_errors(_: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    rows = (
        (await db.execute(select(ClientError).order_by(ClientError.last_seen.desc()).limit(100)))
        .scalars()
        .all()
    )
    return [
        {
            "id": str(e.id),
            "message": e.message,
            "stack": e.stack,
            "path": e.path,
            "release": e.release,
            "user_agent": e.user_agent,
            "count": e.count,
            "first_seen": e.first_seen.isoformat(),
            "last_seen": e.last_seen.isoformat(),
        }
        for e in rows
    ]


@router.delete("/admin/client-errors/{error_id}", status_code=204)
async def resolve_client_error(
    error_id: str, _: User = Depends(require_admin), db: AsyncSession = Depends(get_db)
):
    """Mark fixed by deleting. If it happens again it comes back, counting
    from one - which is what "did the fix work?" needs."""
    result = await db.execute(delete(ClientError).where(ClientError.id == error_id))
    if not result.rowcount:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await db.commit()


@router.get("/admin/abuse")
async def abuse(_: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """The last 24 hours: who is failing to sign in, which accounts are being
    tried, and which addresses are creating accounts. Admin only."""
    since = utcnow() - timedelta(hours=24)
    by_ip = (
        await db.execute(
            select(
                AuthFailure.ip_address,
                func.count(),
                func.count(func.distinct(AuthFailure.email_hash)),
            )
            .where(AuthFailure.created_at >= since)
            .group_by(AuthFailure.ip_address)
            .order_by(func.count().desc())
            .limit(20)
        )
    ).all()
    # Only real accounts: the admin needs to know whose account is under
    # attack. Attempts on addresses with no account stay anonymous hashes.
    by_account = (
        await db.execute(
            select(User.email, func.count(), func.count(func.distinct(AuthFailure.ip_address)))
            .join(User, User.id == AuthFailure.user_id)
            .where(AuthFailure.created_at >= since)
            .group_by(User.email)
            .order_by(func.count().desc())
            .limit(20)
        )
    ).all()
    signups = (
        await db.execute(
            select(SecurityEvent.ip_address, func.count())
            .where(SecurityEvent.kind == "signup", SecurityEvent.created_at >= since)
            .group_by(SecurityEvent.ip_address)
            .order_by(func.count().desc())
            .limit(20)
        )
    ).all()
    totals = dict(
        (
            await db.execute(
                select(AuthFailure.kind, func.count())
                .where(AuthFailure.created_at >= since)
                .group_by(AuthFailure.kind)
            )
        ).all()
    )
    return {
        "since": since.isoformat(),
        "failures": totals,
        "by_ip": [{"ip": ip, "failures": n, "accounts": a} for ip, n, a in by_ip],
        "by_account": [
            {"account": email, "failures": n, "ips": ips} for email, n, ips in by_account
        ],
        "signups_by_ip": [{"ip": ip, "signups": n} for ip, n in signups],
    }
