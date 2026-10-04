from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.limits import enforce
from app.common.net import is_safe_public_url
from app.common.time import utcnow
from app.database import get_db
from app.notifications import unsubscribe
from app.notifications.models import Notification, NotificationPreference, PushSubscription
from app.notifications.service import CATEGORIES, channels_for, deliver, notify, vapid_public_key
from app.profile.models import Profile

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("")
async def inbox(
    before: datetime | None = None,
    limit: int = Query(default=30, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(Notification, Profile)
        .outerjoin(Profile, Profile.user_id == Notification.actor_id)
        .where(Notification.user_id == user.id)
    )
    if before:
        stmt = stmt.where(Notification.created_at < before)
    rows = (await db.execute(stmt.order_by(Notification.created_at.desc()).limit(limit + 1))).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [
            {
                "id": str(n.id),
                "kind": n.kind,
                "category": n.category,
                "title": n.title,
                "body": n.body,
                "url": n.url,
                "read": n.read_at is not None,
                "created_at": n.created_at.isoformat(),
                "actor": {
                    "handle": p.handle,
                    "display_name": p.display_name,
                    "avatar_hue": p.avatar_hue,
                }
                if p
                else None,
            }
            for n, p in rows
        ],
        "next": rows[-1][0].created_at.isoformat() if more else None,
    }


@router.get("/unread-count")
async def unread_count(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    n = (
        await db.execute(
            select(func.count()).where(
                Notification.user_id == user.id, Notification.read_at.is_(None)
            )
        )
    ).scalar_one()
    return {"unread": n}


class ReadIn(BaseModel):
    ids: list[UUID] | None = Field(default=None, max_length=200)


@router.post("/read")
async def mark_read(
    body: ReadIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    stmt = update(Notification).where(
        Notification.user_id == user.id, Notification.read_at.is_(None)
    )
    if body.ids:
        stmt = stmt.where(Notification.id.in_(body.ids))
    await db.execute(stmt.values(read_at=utcnow()))
    await db.commit()
    return {"ok": True}


@router.get("/preferences")
async def get_preferences(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    row = (
        await db.execute(
            select(NotificationPreference).where(NotificationPreference.user_id == user.id)
        )
    ).scalar_one_or_none()
    prefs = row.channels if row else None
    return {
        "habit_summary_hour": row.habit_summary_hour if row else None,
        "backup_attachment": bool(row and row.backup_attachment),
        "backup_frequency": row.backup_frequency if row else "monthly",
        "categories": [
            {
                "id": key,
                "label": meta["label"],
                "locked": bool(meta.get("locked")),
                **channels_for(prefs, key),
            }
            for key, meta in CATEGORIES.items()
        ],
        "push_available": vapid_public_key() is not None,
    }


class PreferencesIn(BaseModel):
    """Either half may be sent alone; what's left out is kept."""

    channels: dict[str, dict[str, bool]] | None = None
    # One evening summary of open habits at this hour, instead of a reminder
    # per habit. Null turns it off.
    habit_summary_hour: int | None = Field(default=None, ge=0, le=23)
    # Attach the export to the monthly backup email. The app shows what that
    # puts in an inbox and asks for confirmation before sending True.
    backup_attachment: bool | None = None
    backup_frequency: Literal["monthly", "weekly"] | None = None


@router.put("/preferences")
async def put_preferences(
    body: PreferencesIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    updates: dict = {}
    if body.channels is not None:
        # Merged into what's stored, per category and channel, so a client
        # changing one switch can never reset the others to their defaults.
        current = (
            await db.execute(
                select(NotificationPreference.channels).where(
                    NotificationPreference.user_id == user.id
                )
            )
        ).scalar_one_or_none() or {}
        merged = {cat: dict(chans) for cat, chans in current.items()}
        for cat, chans in body.channels.items():
            if cat not in CATEGORIES or CATEGORIES[cat].get("locked"):
                continue
            merged.setdefault(cat, {}).update(
                {k: bool(v) for k, v in chans.items() if k in ("push", "email")}
            )
        updates["channels"] = merged
    if "habit_summary_hour" in body.model_fields_set:
        updates["habit_summary_hour"] = body.habit_summary_hour
    if body.backup_attachment is not None:
        updates["backup_attachment"] = body.backup_attachment
    if body.backup_frequency is not None:
        updates["backup_frequency"] = body.backup_frequency
    if updates:
        await db.execute(
            insert(NotificationPreference)
            .values(user_id=user.id, **({"channels": {}} | updates))
            .on_conflict_do_update(index_elements=[NotificationPreference.user_id], set_=updates)
        )
    await db.commit()
    return await get_preferences(user, db)


@router.get("/push/public-key")
async def push_key():
    key = vapid_public_key()
    if key is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Push is not configured on this server")
    return {"public_key": key}


class SubscriptionIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=2000, pattern="^https://")
    keys: dict[str, str]


@router.post("/push/subscribe", status_code=201)
async def subscribe(
    body: SubscriptionIn,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if vapid_public_key() is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Push is not configured on this server")
    p256dh, auth = body.keys.get("p256dh"), body.keys.get("auth")
    if not p256dh or not auth or len(p256dh) > 200 or len(auth) > 100:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Malformed subscription")
    # The worker POSTs to this endpoint later; keep it off our own network.
    if not is_safe_public_url(body.endpoint):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unusable push endpoint")
    count = (
        await db.execute(select(func.count()).where(PushSubscription.user_id == user.id))
    ).scalar_one()
    if count >= 20:
        raise HTTPException(status.HTTP_409_CONFLICT, "Too many devices subscribed")
    values = {
        "user_id": user.id,
        "p256dh": p256dh,
        "auth": auth,
        "user_agent": (request.headers.get("user-agent") or "")[:400],
        "failures": 0,
    }
    # The endpoint is the browser's identity for this subscription. If it was
    # registered to another account (a shared device), it moves here.
    await db.execute(
        insert(PushSubscription)
        .values(endpoint=body.endpoint, **values)
        .on_conflict_do_update(index_elements=[PushSubscription.endpoint], set_=values)
    )
    await db.commit()
    return {"ok": True}


class UnsubscribeIn(BaseModel):
    endpoint: str = Field(max_length=2000)


@router.post("/push/unsubscribe")
async def unsubscribe_push(
    body: UnsubscribeIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    row = (
        await db.execute(
            select(PushSubscription).where(
                PushSubscription.endpoint == body.endpoint, PushSubscription.user_id == user.id
            )
        )
    ).scalar_one_or_none()
    if row:
        await db.delete(row)
        await db.commit()
    return {"ok": True}


@router.post("/push/test")
async def push_test(
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await enforce("push-test", user.id, 5, 600)
    nid = await notify(
        db,
        user.id,
        kind="test",
        category="security",
        title="Notifications are working",
        body="This is what a PaceStreak nudge looks like.",
        url="/settings/notifications",
    )
    await db.commit()
    background.add_task(deliver, [nid] if nid else [])
    return {"ok": True}


class EmailUnsubscribeIn(BaseModel):
    u: UUID
    c: str
    s: str = Field(max_length=64)


@router.post("/unsubscribe/one-click", include_in_schema=False)
async def one_click_unsubscribe(
    u: UUID, c: str, s: str = Query(max_length=64), db: AsyncSession = Depends(get_db)
):
    """RFC 8058: the mail client POSTs `List-Unsubscribe=One-Click` here
    directly, with the parameters in the URL from the List-Unsubscribe
    header. The body carries nothing we need, so it is not read."""
    return await email_unsubscribe(EmailUnsubscribeIn(u=u, c=c, s=s), db)


@router.post("/unsubscribe")
async def email_unsubscribe(body: EmailUnsubscribeIn, db: AsyncSession = Depends(get_db)):
    """Unauthenticated on purpose - it is clicked from a mail client. The
    signature proves the link came from us for this user and category."""
    if body.c not in CATEGORIES or CATEGORIES[body.c].get("locked"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid link")
    if not unsubscribe.verify(body.u, body.c, body.s):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid link")
    current = (
        await db.execute(
            select(NotificationPreference).where(NotificationPreference.user_id == body.u)
        )
    ).scalar_one_or_none()
    channels = dict(current.channels) if current else {}
    channels[body.c] = {**channels.get(body.c, {}), "email": False}
    await db.execute(
        insert(NotificationPreference)
        .values(user_id=body.u, channels=channels)
        .on_conflict_do_update(
            index_elements=[NotificationPreference.user_id], set_={"channels": channels}
        )
    )
    await db.commit()
    return {"detail": f"Done - no more '{CATEGORIES[body.c]['label']}' emails."}
