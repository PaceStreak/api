"""iCalendar output: the one-off export and the private subscription feed.

The feed is a URL a calendar app polls: `/v1/calendar/<token>.ics`. Calendar
apps cannot send a bearer token or a cookie, so the URL itself is the
credential. That shapes every decision here:

- The token is 32 random bytes, shown once, and stored only as a SHA-256, so
  a database leak does not hand out working feeds.
- It is revocable and rotatable from settings, and creating, rotating and
  revoking it are all written to the security history.
- The feed carries the minimum: when, what discipline, a title, and duration
  or distance. Never notes, sets, body metrics, or anything social.
- Responses are `private` and short-lived, and the endpoint is rate limited
  per token.
"""

import hashlib
import secrets
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.account import service as security
from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.limits import enforce
from app.common.time import local_today, utcnow
from app.config import get_settings
from app.database import get_db
from app.profile.models import Profile
from app.profile.service import get_profile
from app.training.library import DISCIPLINES
from app.training.models import StreakPause, Workout
from app.training.pauses import Span

router = APIRouter(tags=["calendar"])
settings = get_settings()

DISCIPLINE_NAMES = {d.id: d.name for d in DISCIPLINES}
BYDAY = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
FEED_HISTORY_DAYS = 400


def escape(text: str) -> str:
    """RFC 5545 §3.3.11 TEXT escaping."""
    return (
        text.replace("\\", "\\\\")
        .replace(";", r"\;")
        .replace(",", r"\,")
        .replace("\r\n", r"\n")
        .replace("\n", r"\n")
    )


def fold(line: str) -> str:
    """RFC 5545 §3.1: lines longer than 75 octets continue on the next line,
    which starts with a space. Folding counts bytes, and never splits a UTF-8
    character."""
    out: list[str] = []
    current = ""
    for char in line:
        limit = 75 if not out else 74
        if len((current + char).encode()) > limit:
            out.append(current)
            current = char
        else:
            current += char
    out.append(current)
    return "\r\n ".join(out)


def stamp(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def summary_for(workout: Workout) -> str:
    text = workout.title or DISCIPLINE_NAMES.get(workout.discipline, workout.discipline.title())
    if workout.distance_m:
        text += f" · {workout.distance_m / 1000:.1f} km"
    return text


def build_calendar(
    name: str,
    workouts: list[Workout],
    pauses: list[StreakPause] = (),
    training_days: int | None = None,
    week_anchor: date | None = None,
) -> str:
    now = stamp(utcnow())
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//PaceStreak//Calendar//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{escape(name)}",
        "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
        "X-PUBLISHED-TTL:PT6H",
    ]
    for w in workouts:
        minutes = max(1, (w.duration_sec or 1800) // 60)
        lines += [
            "BEGIN:VEVENT",
            f"UID:{w.id}@pacestreak.com",
            f"DTSTAMP:{now}",
            f"DTSTART:{stamp(w.started_at)}",
            f"DURATION:PT{minutes}M",
            f"SUMMARY:{escape(summary_for(w))}",
            "CATEGORIES:TRAINING",
            "TRANSP:TRANSPARENT",
            "END:VEVENT",
        ]
    for p in pauses:
        end = Span(p.starts_on, p.ends_on).effective_end() + timedelta(days=1)
        lines += [
            "BEGIN:VEVENT",
            f"UID:pause-{p.id}@pacestreak.com",
            f"DTSTAMP:{now}",
            f"DTSTART;VALUE=DATE:{p.starts_on.strftime('%Y%m%d')}",
            f"DTEND;VALUE=DATE:{end.strftime('%Y%m%d')}",
            "SUMMARY:Streak paused",
            "TRANSP:TRANSPARENT",
            "END:VEVENT",
        ]
    if training_days and week_anchor:
        days = ",".join(BYDAY[i] for i in range(7) if training_days & (1 << i))
        lines += [
            "BEGIN:VEVENT",
            "UID:planned-training@pacestreak.com",
            f"DTSTAMP:{now}",
            f"DTSTART;VALUE=DATE:{week_anchor.strftime('%Y%m%d')}",
            f"RRULE:FREQ=WEEKLY;BYDAY={days}",
            "SUMMARY:Planned training day",
            "TRANSP:TRANSPARENT",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(line) for line in lines) + "\r\n"


# --- the private feed --------------------------------------------------------------------


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def feed_url(token: str) -> str:
    return f"{settings.public_api_url.rstrip('/')}/v1/calendar/{token}.ics"


@router.get("/me/calendar")
async def calendar_status(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    profile = await get_profile(db, user.id)
    await db.commit()
    return {
        "enabled": profile.calendar_token_hash is not None,
        "created_at": profile.calendar_token_created_at.isoformat()
        if profile.calendar_token_created_at
        else None,
    }


@router.post("/me/calendar", status_code=201)
async def create_calendar_feed(
    request: Request, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Create the feed, or replace it: the old URL stops working at once. The
    new URL is returned once and never again."""
    await enforce("calendar_rotate", user.id, 10, 3600)
    profile = await get_profile(db, user.id)
    rotated = profile.calendar_token_hash is not None
    token = secrets.token_urlsafe(32)
    profile.calendar_token_hash = _hash(token)
    profile.calendar_token_created_at = utcnow()
    await security.record(
        db, user.id, "calendar_feed_rotated" if rotated else "calendar_feed_created", request
    )
    await db.commit()
    return {"url": feed_url(token), "created_at": profile.calendar_token_created_at.isoformat()}


@router.delete("/me/calendar", status_code=204)
async def revoke_calendar_feed(
    request: Request, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    profile = await get_profile(db, user.id)
    if profile.calendar_token_hash is not None:
        profile.calendar_token_hash = None
        profile.calendar_token_created_at = None
        await security.record(db, user.id, "calendar_feed_revoked", request)
    await db.commit()


@router.get("/calendar/{token}.ics", include_in_schema=False)
async def calendar_feed(token: str, db: AsyncSession = Depends(get_db)):
    if not 20 <= len(token) <= 100:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    # Keyed on the hash, not the token, so the token never lands in Redis.
    await enforce("calendar_feed", _hash(token)[:16], 120, 3600)
    profile = (
        await db.execute(select(Profile).where(Profile.calendar_token_hash == _hash(token)))
    ).scalar_one_or_none()
    user = await db.get(User, profile.user_id) if profile else None
    if (
        profile is None
        or user is None
        or not user.is_active
        or profile.deletion_scheduled_at is not None
    ):
        # Same answer for a wrong token and a closed account.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    since = utcnow() - timedelta(days=FEED_HISTORY_DAYS)
    workouts = list(
        (
            await db.execute(
                select(Workout)
                .where(
                    Workout.user_id == profile.user_id,
                    Workout.deleted_at.is_(None),
                    Workout.started_at >= since,
                )
                .order_by(Workout.started_at)
            )
        ).scalars()
    )
    pauses = list(
        (
            await db.execute(select(StreakPause).where(StreakPause.user_id == profile.user_id))
        ).scalars()
    )
    today = local_today(profile.timezone)
    anchor = today - timedelta(days=today.weekday())
    body = build_calendar("PaceStreak training", workouts, pauses, profile.training_days, anchor)
    await db.commit()
    return Response(
        body,
        media_type="text/calendar; charset=utf-8",
        headers={
            "Cache-Control": "private, max-age=900",
            "X-Robots-Tag": "noindex, nofollow",
            "Referrer-Policy": "no-referrer",
        },
    )
