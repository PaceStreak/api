"""The signed-in person: bootstrap, onboarding, and settings."""

import re
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.account.service import record as record_security_event
from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.time import is_valid_timezone, local_today, utcnow, week_start
from app.config import get_settings
from app.database import get_db
from app.game.service import recompute
from app.notifications.models import Notification
from app.notifications.service import vapid_public_key
from app.profile.models import MIN_AGE, SOCIAL_MIN_AGE, Profile
from app.profile.service import get_chains, get_profile, set_chain_target
from app.social.models import Follow

settings = get_settings()
router = APIRouter(tags=["me"])

HANDLE_RE = re.compile(r"^[a-z0-9_]{3,30}$")
# Handles that would read as official, or collide with an app route.
RESERVED = frozenset(
    {
        "admin",
        "administrator",
        "api",
        "app",
        "blog",
        "feed",
        "help",
        "me",
        "mod",
        "moderator",
        "pacestreak",
        "privacy",
        "root",
        "security",
        "settings",
        "staff",
        "status",
        "support",
        "system",
        "team",
        "terms",
        "www",
        "official",
        "null",
        "undefined",
    }
)


BRAND = "pacestreak"
# Look-alike characters folded back before the brand check, so "Pace5treak",
# "pace_streak" and "PACE.STREAK" read as what they are.
_CONFUSABLES = str.maketrans(
    {"0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "$": "s", "@": "a", "|": "l"}
)


def mentions_brand(text: str) -> bool:
    folded = text.lower().translate(_CONFUSABLES)
    return BRAND in "".join(ch for ch in folded if ch.isalpha())


def is_reserved(handle: str) -> bool:
    """Handles only an official account may hold: the reserved words, and
    anything that spells the brand however it is dressed up."""
    return handle in RESERVED or mentions_brand(handle)


def check_display_name(name: str | None, profile: Profile) -> None:
    if name and not profile.is_official and mentions_brand(name):
        raise HTTPException(status.HTTP_409_CONFLICT, "Display names can't use the PaceStreak name")


def profile_out(p: Profile) -> dict:
    return {
        "handle": p.handle,
        "display_name": p.display_name,
        "official": p.is_official,
        "bio": p.bio,
        "avatar_hue": p.avatar_hue,
        "timezone": p.timezone,
        "week_starts_on": p.week_starts_on,
        "weight_unit": p.weight_unit,
        "distance_unit": p.distance_unit,
        "training_days": p.training_days,
        "max_hr": p.max_hr,
        "onboarded_at": p.onboarded_at.isoformat() if p.onboarded_at else None,
        "birth_year": p.birth_year,
        "onboarded": p.onboarded_at is not None,
        "visibility": p.visibility,
        "sharing_paused": p.sharing_paused,
        "gamification_enabled": p.gamification_enabled,
        "leaderboard_opt_in": p.leaderboard_opt_in,
        "social_suspended": p.social_suspended_at is not None,
        "deletion_scheduled_at": (
            p.deletion_scheduled_at.isoformat() if p.deletion_scheduled_at else None
        ),
        "reminder_hour": p.reminder_hour,
        "reminder_mode": p.reminder_mode,
        "learned_reminder_hour": p.learned_reminder_hour,
        "quiet_start": p.quiet_start,
        "quiet_end": p.quiet_end,
    }


def _check_handle(handle: str, allow_reserved: bool = False) -> str:
    handle = handle.strip().lower().lstrip("@")
    if not HANDLE_RE.match(handle):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Handles are 3-30 characters: lowercase letters, numbers and underscores.",
        )
    if not allow_reserved and is_reserved(handle):
        raise HTTPException(status.HTTP_409_CONFLICT, "That handle is reserved")
    return handle


async def _handle_taken(db: AsyncSession, handle: str, user_id: UUID) -> bool:
    row = await db.execute(
        select(Profile.user_id).where(Profile.handle == handle, Profile.user_id != user_id)
    )
    return row.scalar_one_or_none() is not None


@router.get("/me")
async def me(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Everything the client needs to render its shell in one request."""
    profile = await get_profile(db, user.id)
    unread = (
        await db.execute(
            select(func.count()).where(
                Notification.user_id == user.id, Notification.read_at.is_(None)
            )
        )
    ).scalar_one()
    requests = (
        await db.execute(
            select(func.count()).where(Follow.followee_id == user.id, Follow.status == "pending")
        )
    ).scalar_one()
    await db.commit()
    year = utcnow().year
    return {
        "user": {
            "id": str(user.id),
            "email": user.email,
            "is_verified": user.is_verified,
            "role": user.role.value if hasattr(user.role, "value") else user.role,
            "totp_enabled": user.totp_enabled,
        },
        "profile": profile_out(profile),
        "needs_onboarding": profile.onboarded_at is None,
        # Onboarded under an older wording: the app asks them to accept the
        # current one before carrying on.
        "needs_terms": profile.onboarded_at is not None
        and profile.accepted_terms_version != settings.terms_version,
        "terms_version": settings.terms_version,
        "social_allowed": profile.social_allowed(year),
        "min_age": MIN_AGE,
        "social_min_age": SOCIAL_MIN_AGE,
        "unread_notifications": unread,
        "follow_requests": requests,
        "push_public_key": vapid_public_key(),
    }


class OnboardingIn(BaseModel):
    handle: str = Field(min_length=3, max_length=31)
    display_name: str | None = Field(default=None, max_length=50)
    birth_year: int = Field(ge=1900, le=2100)
    accept_terms: bool
    timezone: str = "UTC"
    week_starts_on: int = Field(default=0, ge=0, le=6)
    weight_unit: str = Field(default="kg", pattern="^(kg|lb)$")
    distance_unit: str = Field(default="km", pattern="^(km|mi)$")
    weekly_target: int = Field(default=3, ge=1, le=7)
    visibility: str = Field(default="followers", pattern="^(private|followers|public)$")


@router.post("/me/onboarding")
async def onboarding(
    body: OnboardingIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    if not body.accept_terms:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Please accept the terms")
    year = utcnow().year
    if year - body.birth_year < MIN_AGE:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, f"PaceStreak is for people aged {MIN_AGE} and over."
        )
    if not is_valid_timezone(body.timezone):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown timezone")
    handle = _check_handle(body.handle)
    if await _handle_taken(db, handle, user.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "That handle is taken")

    profile = await get_profile(db, user.id)
    check_display_name(body.display_name, profile)
    profile.handle = handle
    profile.display_name = (body.display_name or "").strip() or None
    profile.birth_year = body.birth_year
    profile.accepted_terms_at = utcnow()
    profile.accepted_terms_version = settings.terms_version
    profile.timezone = body.timezone
    profile.week_starts_on = body.week_starts_on
    profile.weight_unit = body.weight_unit
    profile.distance_unit = body.distance_unit
    # Under the social age, nothing is ever shown to anyone, whatever the
    # form asked for.
    profile.visibility = body.visibility if year - body.birth_year >= SOCIAL_MIN_AGE else "private"
    profile.onboarded_at = profile.onboarded_at or utcnow()

    chains = await get_chains(db, profile)
    main = chains[0]
    main.target_history = [{"from": "2000-01-03", "target": body.weekly_target}]
    await db.flush()
    await recompute(db, user.id, notify=False)
    await db.commit()
    return {"profile": profile_out(profile)}


class TermsIn(BaseModel):
    version: str = Field(max_length=20)


@router.post("/me/terms")
async def accept_terms(
    body: TermsIn,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Accept the current terms. The version must match what the server
    considers current, so an app that loaded an old version can't accept a
    wording the person never saw."""
    if body.version != settings.terms_version:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "The terms changed again. Reload and review them."
        )
    profile = await get_profile(db, user.id)
    profile.accepted_terms_at = utcnow()
    profile.accepted_terms_version = settings.terms_version
    await record_security_event(db, user.id, "terms_accepted", request, {"version": body.version})
    await db.commit()
    return {"accepted": settings.terms_version}


class ProfilePatch(BaseModel):
    handle: str | None = Field(default=None, max_length=31)
    display_name: str | None = Field(default=None, max_length=50)
    bio: str | None = Field(default=None, max_length=160)
    avatar_hue: int | None = Field(default=None, ge=0, le=359)
    timezone: str | None = None
    week_starts_on: int | None = Field(default=None, ge=0, le=6)
    weight_unit: str | None = Field(default=None, pattern="^(kg|lb)$")
    distance_unit: str | None = Field(default=None, pattern="^(km|mi)$")
    training_days: int | None = Field(default=None, ge=0, le=127)
    max_hr: int | None = Field(default=None, ge=100, le=230)
    visibility: str | None = Field(default=None, pattern="^(private|followers|public)$")
    sharing_paused: bool | None = None
    gamification_enabled: bool | None = None
    leaderboard_opt_in: bool | None = None
    reminder_hour: int | None = Field(default=None, ge=0, le=23)
    reminder_mode: str | None = Field(default=None, pattern="^(fixed|smart)$")
    quiet_start: int | None = Field(default=None, ge=0, le=23)
    quiet_end: int | None = Field(default=None, ge=0, le=23)
    weekly_target: int | None = Field(default=None, ge=1, le=7)

    @field_validator("display_name", "bio")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v


@router.patch("/me/profile")
async def patch_profile(
    body: ProfilePatch, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    profile = await get_profile(db, user.id)
    data = body.model_dump(exclude_unset=True)
    year = utcnow().year

    if "handle" in data and data["handle"] is not None:
        handle = _check_handle(data.pop("handle"))
        if await _handle_taken(db, handle, user.id):
            raise HTTPException(status.HTTP_409_CONFLICT, "That handle is taken")
        profile.handle = handle
    data.pop("handle", None)
    if "timezone" in data and not is_valid_timezone(data["timezone"] or ""):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown timezone")
    if data.get("visibility") in ("followers", "public") and not profile.social_allowed(year):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Sharing is not available on this account.")
    if data.get("leaderboard_opt_in") and not profile.social_allowed(year):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Leaderboards are not available on this account."
        )
    if data.get("gamification_enabled") is False:
        # Opting out of the game layer takes you off the boards too.
        profile.leaderboard_opt_in = False
        data.pop("leaderboard_opt_in", None)

    if "display_name" in data:
        check_display_name(data["display_name"], profile)

    target = data.pop("weekly_target", None)
    for key, value in data.items():
        if key in ("display_name", "bio"):
            value = value or None
        setattr(profile, key, value)

    if target is not None:
        main = (await get_chains(db, profile))[0]
        this_week = week_start(local_today(profile.timezone), profile.week_starts_on)
        if target != main.target:
            set_chain_target(main, target, this_week.isoformat())

    await db.flush()
    if target is not None or "week_starts_on" in data or "timezone" in data:
        await recompute(db, user.id, notify=False)
    await db.commit()
    return {"profile": profile_out(profile)}


@router.get("/handles/{handle}")
async def handle_available(
    handle: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    try:
        clean = _check_handle(handle)
    except HTTPException as err:
        return {"handle": handle, "available": False, "reason": err.detail}
    taken = await _handle_taken(db, clean, user.id)
    return {"handle": clean, "available": not taken, "reason": "Taken" if taken else None}
