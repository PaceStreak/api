"""Who can see whom. Every social read goes through the rules here.

Visibility is checked twice: when an event is emitted (a paused or private
account emits nothing) and again when it is read (so going private, pausing,
blocking or being suspended retroactively hides what was already out there).
The most restrictive answer wins.
"""

from datetime import date
from uuid import UUID

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.common.time import utcnow
from app.profile.models import SOCIAL_MIN_AGE, Profile
from app.social.models import ActivityEvent, Block, Follow


def social_ok_clause(profile=Profile) -> ColumnElement[bool]:
    """SQL twin of Profile.social_allowed()."""
    year = utcnow().year
    return and_(
        profile.birth_year.is_not(None),
        profile.birth_year <= year - SOCIAL_MIN_AGE,
        profile.social_suspended_at.is_(None),
        profile.deletion_scheduled_at.is_(None),
        profile.onboarded_at.is_not(None),
    )


def not_blocked_clause(viewer_id: UUID, author_col) -> ColumnElement[bool]:
    return ~exists().where(
        or_(
            and_(Block.blocker_id == viewer_id, Block.blocked_id == author_col),
            and_(Block.blocker_id == author_col, Block.blocked_id == viewer_id),
        )
    )


def can_see_clause(viewer_id: UUID, profile=Profile) -> ColumnElement[bool]:
    """Viewer may see this author's activity."""
    follows = exists().where(
        Follow.follower_id == viewer_id,
        Follow.followee_id == profile.user_id,
        Follow.status == "accepted",
    )
    return or_(
        profile.user_id == viewer_id,
        and_(
            social_ok_clause(profile),
            not_blocked_clause(viewer_id, profile.user_id),
            or_(
                profile.visibility == "public",
                and_(profile.visibility == "followers", follows),
            ),
        ),
    )


async def is_blocked(db: AsyncSession, a: UUID, b: UUID) -> bool:
    row = await db.execute(
        select(Block.id)
        .where(
            or_(
                and_(Block.blocker_id == a, Block.blocked_id == b),
                and_(Block.blocker_id == b, Block.blocked_id == a),
            )
        )
        .limit(1)
    )
    return row.scalar_one_or_none() is not None


async def can_see(db: AsyncSession, viewer_id: UUID, author: Profile) -> bool:
    if author.user_id == viewer_id:
        return True
    result = await db.execute(
        select(Profile.id).where(Profile.id == author.id, can_see_clause(viewer_id))
    )
    return result.scalar_one_or_none() is not None


async def emit_event(
    db: AsyncSession,
    profile: Profile,
    kind: str,
    ref_key: str,
    day: date,
    data: dict,
    workout_id: UUID | None = None,
) -> None:
    """Record something shareable. Nothing is emitted for an account that
    cannot be seen by anyone - a private, paused, under-age or suspended
    profile - so there is no backlog that appears the day the setting flips."""
    if (
        profile.visibility == "private"
        or profile.sharing_paused
        or not profile.social_allowed(utcnow().year)
    ):
        return
    await db.execute(
        insert(ActivityEvent)
        .values(
            user_id=profile.user_id,
            kind=kind,
            ref_key=ref_key[:120],
            data=data,
            occurred_on=day,
            workout_id=workout_id,
        )
        .on_conflict_do_update(constraint="uq_activity_ref", set_={"data": data})
    )
