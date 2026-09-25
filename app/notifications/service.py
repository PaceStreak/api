"""Creating and delivering notifications.

Every notification is written to the inbox first; that write is the only part
that can fail a request. Push and email are best-effort extras on top, chosen
per category by the user, and are delivered after the response via
`deliver()` so a slow push service never slows down logging a set.
"""

import asyncio
import json
import logging
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.common.time import local_now, utcnow
from app.config import get_settings
from app.email import send_email
from app.notifications.models import Notification, NotificationPreference, PushSubscription
from app.profile.models import Profile

logger = logging.getLogger(__name__)
settings = get_settings()

# Category -> default channels. The inbox is always on and not listed.
CATEGORIES: dict[str, dict] = {
    "streak_risk": {"label": "Streak at risk", "push": True, "email": False},
    "reminder": {"label": "Training reminders", "push": False, "email": False},
    "digest": {"label": "Weekly summary", "push": False, "email": True},
    "achievements": {"label": "Achievements and records", "push": False, "email": False},
    "social": {"label": "Follows, kudos and comments", "push": True, "email": False},
    "groups": {"label": "Groups and challenges", "push": True, "email": False},
    # Opt-in on every channel: a monthly nudge to download a copy of your own
    # data. It carries a link into the app, never the data or a download
    # token, so nothing sensitive ever sits in an inbox.
    "backup": {"label": "Monthly backup reminder", "push": False, "email": False},
    # Security notices always email and cannot be turned off - they are how
    # someone learns their account was touched by somebody else.
    "security": {"label": "Security", "push": True, "email": True, "locked": True},
}


def channels_for(prefs: dict | None, category: str) -> dict[str, bool]:
    base = CATEGORIES.get(category, {"push": False, "email": False})
    chosen = (prefs or {}).get(category, {})
    if base.get("locked"):
        return {"push": bool(chosen.get("push", base["push"])), "email": True}
    return {
        "push": bool(chosen.get("push", base["push"])),
        "email": bool(chosen.get("email", base["email"])),
    }


async def notify(
    db: AsyncSession,
    user_id: UUID,
    *,
    kind: str,
    category: str,
    title: str,
    body: str | None = None,
    url: str | None = None,
    actor_id: UUID | None = None,
    data: dict | None = None,
    dedupe_key: str | None = None,
) -> UUID | None:
    """Insert into the inbox. Returns the id, or None when de-duplicated."""
    stmt = (
        insert(Notification)
        .values(
            user_id=user_id,
            kind=kind,
            category=category,
            title=title[:120],
            body=body[:400] if body else None,
            url=url,
            actor_id=actor_id,
            data=data,
            dedupe_key=dedupe_key,
        )
        .on_conflict_do_nothing(constraint="uq_notification_dedupe")
        .returning(Notification.id)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


# --- delivery ------------------------------------------------------------------


@lru_cache(maxsize=1)
def vapid_key() -> str | None:
    """Path to the VAPID private key. pywebpush wants a file, so a key injected
    as VAPID_PRIVATE_KEY_PEM is written once to a 0600 file in a private
    temporary directory."""
    if settings.vapid_private_key_pem:
        import os
        import tempfile

        directory = tempfile.mkdtemp(prefix="pacestreak-vapid-")
        target = Path(directory) / "vapid_private.pem"
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(settings.vapid_private_key_pem.replace("\\n", "\n").strip() + "\n")
        return str(target)
    path = Path(settings.vapid_private_key_path)
    return str(path) if path.is_file() else None


@lru_cache(maxsize=1)
def vapid_public_key() -> str | None:
    """The applicationServerKey the browser needs: the raw uncompressed P-256
    point, base64url without padding."""
    path = vapid_key()
    if path is None:
        return None
    import base64

    from cryptography.hazmat.primitives import serialization

    private = serialization.load_pem_private_key(Path(path).read_bytes(), password=None)
    raw = private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _in_quiet_hours(profile: Profile | None) -> bool:
    if profile is None:
        return False
    hour = local_now(profile.timezone).hour
    start, end = profile.quiet_start, profile.quiet_end
    if start == end:
        return False
    if start > end:  # wraps midnight, e.g. 22 -> 7
        return hour >= start or hour < end
    return start <= hour < end


@dataclass
class _Push:
    subscription_id: UUID
    endpoint: str
    keys: dict


def _send_push(push: _Push, payload: str) -> int:
    """Blocking; run in a thread. Returns the HTTP status (0 on transport error)."""
    from pywebpush import WebPushException, webpush

    try:
        response = webpush(
            subscription_info={"endpoint": push.endpoint, "keys": push.keys},
            data=payload,
            vapid_private_key=vapid_key(),
            vapid_claims={"sub": settings.vapid_subject},
            ttl=60 * 60 * 12,
            timeout=10,
        )
        return response.status_code
    except WebPushException as err:
        return err.response.status_code if err.response is not None else 0
    except Exception:
        logger.exception("push delivery failed")
        return 0


async def deliver(notification_ids: list[UUID]) -> None:
    """Push and email for freshly created notifications. Opens its own
    session: this runs after the request's session has closed."""
    if not notification_ids:
        return
    from app.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        rows = (
            (await db.execute(select(Notification).where(Notification.id.in_(notification_ids))))
            .scalars()
            .all()
        )
        for note in rows:
            try:
                await _deliver_one(db, note)
            except Exception:
                logger.exception("delivering notification %s failed", note.id)
        await db.commit()


async def _deliver_one(db: AsyncSession, note: Notification) -> None:
    prefs = (
        await db.execute(
            select(NotificationPreference.channels).where(
                NotificationPreference.user_id == note.user_id
            )
        )
    ).scalar_one_or_none()
    channels = channels_for(prefs, note.category)
    group_id = (note.data or {}).get("group_id")
    if group_id:
        from app.groups.models import GroupMember

        muted = (
            await db.execute(
                select(GroupMember.muted).where(
                    GroupMember.group_id == UUID(group_id), GroupMember.user_id == note.user_id
                )
            )
        ).scalar_one_or_none()
        if muted:
            return
    profile = (
        await db.execute(select(Profile).where(Profile.user_id == note.user_id))
    ).scalar_one_or_none()

    if (
        channels["push"]
        and vapid_key()
        and (note.category == "security" or not _in_quiet_hours(profile))
    ):
        subs = (
            (
                await db.execute(
                    select(PushSubscription).where(PushSubscription.user_id == note.user_id)
                )
            )
            .scalars()
            .all()
        )
        payload = json.dumps(
            {
                "title": note.title,
                "body": note.body or "",
                "url": note.url or "/",
                "tag": note.kind,
                "id": str(note.id),
            }
        )
        for sub in subs:
            status = await asyncio.to_thread(
                _send_push,
                _Push(sub.id, sub.endpoint, {"p256dh": sub.p256dh, "auth": sub.auth}),
                payload,
            )
            if status in (404, 410):
                # The browser unsubscribed or the subscription expired; the
                # push service is telling us never to use it again.
                await db.delete(sub)
            elif 200 <= status < 300:
                sub.last_success_at = utcnow()
                sub.failures = 0
            else:
                sub.failures += 1
                if sub.failures >= 10:
                    await db.delete(sub)

    if channels["email"]:
        user = await db.get(User, note.user_id)
        if (
            user is not None
            and user.is_active
            and (user.is_verified or note.category == "security")
        ):
            from app.notifications.unsubscribe import list_headers

            headers = (
                list_headers(note.user_id, note.category) if note.category != "security" else None
            )
            await send_email(user.email, note.title, _email_body(note), headers)


def _email_body(note: Notification) -> str:
    from app.notifications.unsubscribe import unsubscribe_link

    lines = [note.body or note.title, ""]
    if note.url:
        lines += [f"Open PaceStreak: {settings.frontend_url}{note.url}", ""]
    if note.category != "security":
        label = CATEGORIES.get(note.category, {}).get("label", note.category)
        lines += [
            "---",
            f"You get these because '{label}' email is on.",
            f"Turn it off: {unsubscribe_link(note.user_id, note.category)}",
        ]
    return "\n".join(lines)
