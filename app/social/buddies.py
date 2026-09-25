"""Buddy streaks and encouragement.

A buddy streak is two people's streak kept together: the week counts only
when both keep their own (see app/game/joint.py for the rules, including how
pauses and freezes carry over). It is consistency-based by construction -
nobody's volume, distance or load is ever compared.

Who can pair: two people who already have an accepted follow in at least one
direction, both allowed social features, neither blocking the other. That
keeps invitations from strangers out entirely. Blocking ends a pair.

Encouragement is a small set of fixed messages, never free text: there is
nothing to moderate, nothing to harass with, and each pair can send at most
one a day.
"""

from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.limits import enforce
from app.common.time import local_date, local_today, utcnow, week_start
from app.database import get_db
from app.game.joint import joint_streak
from app.game.models import UserStats
from app.groups.models import GroupMember
from app.notifications.service import deliver, notify
from app.profile.models import Profile
from app.social.models import BuddyPair, Follow
from app.social.router import _profile_by_handle, person, require_social
from app.social.service import is_blocked

router = APIRouter(tags=["social"])

MAX_BUDDIES = 5

PRESETS: dict[str, str] = {
    "you-got-this": "You've got this.",
    "one-more": "One more session keeps it going.",
    "proud": "Proud of you for showing up.",
    "rest-well": "Rest well. The streak will wait.",
    "lets-go": "Training today too. Let's go.",
    "welcome-back": "Good to see you back.",
}


class InviteIn(BaseModel):
    handle: str = Field(min_length=1, max_length=31)


class EncourageIn(BaseModel):
    preset: str = Field(max_length=20)


def _pair_key(a: UUID, b: UUID) -> tuple[UUID, UUID]:
    return (a, b) if a < b else (b, a)


def _other(pair: BuddyPair, me: UUID) -> UUID:
    return pair.user_b if pair.user_a == me else pair.user_a


async def _follow_either_way(db: AsyncSession, a: UUID, b: UUID) -> bool:
    return (
        await db.execute(
            select(
                exists().where(
                    Follow.status == "accepted",
                    or_(
                        and_(Follow.follower_id == a, Follow.followee_id == b),
                        and_(Follow.follower_id == b, Follow.followee_id == a),
                    ),
                )
            )
        )
    ).scalar_one()


async def _stats(db: AsyncSession, ids: list[UUID]) -> dict[UUID, UserStats]:
    rows = (await db.execute(select(UserStats).where(UserStats.user_id.in_(ids)))).scalars()
    return {s.user_id: s for s in rows}


def _weeks_since(profile: Profile, started) -> int:
    """How many of this person's weeks, including the current one, have
    passed since the pair started."""
    today = local_today(profile.timezone)
    start = week_start(
        local_date(started, profile.timezone) if started else today, profile.week_starts_on
    )
    return (week_start(today, profile.week_starts_on) - start).days // 7 + 1


def pair_view(pair: BuddyPair, me: Profile, them: Profile, stats: dict[UUID, UserStats]) -> dict:
    mine, theirs = stats.get(me.user_id), stats.get(them.user_id)
    out = {
        "id": str(pair.id),
        "status": pair.status,
        "incoming": pair.status == "pending" and pair.requested_by != me.user_id,
        "buddy": person(them, theirs),
        "started_at": pair.started_at.isoformat() if pair.started_at else None,
    }
    if pair.status != "active" or mine is None or theirs is None:
        return out
    result = joint_streak(
        [mine.recent_weeks, theirs.recent_weeks],
        threshold=1.0,
        max_weeks=_weeks_since(me, pair.started_at),
    )
    their_now = theirs.recent_weeks[-1] if theirs.recent_weeks else "open"
    return out | {
        "current": result.current,
        "longest": result.longest,
        "weeks": [w.status for w in result.weeks[-12:]],
        "me": {"days": mine.this_week_days, "target": mine.this_week_target},
        # Progress only - the pause reason, notes and sessions stay private.
        "them": {
            "days": theirs.this_week_days,
            "target": theirs.this_week_target,
            "paused": their_now == "paused",
        },
    }


async def _visible_pairs(db: AsyncSession, user_id: UUID) -> list[BuddyPair]:
    return list(
        (
            await db.execute(
                select(BuddyPair)
                .where(
                    or_(BuddyPair.user_a == user_id, BuddyPair.user_b == user_id),
                    BuddyPair.status.in_(("pending", "active")),
                )
                .order_by(BuddyPair.created_at)
            )
        ).scalars()
    )


@router.get("/buddies")
async def list_buddies(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    me = await require_social(db, user)
    pairs = await _visible_pairs(db, user.id)
    others = [_other(p, user.id) for p in pairs]
    profiles = {
        p.user_id: p
        for p in (await db.execute(select(Profile).where(Profile.user_id.in_(others)))).scalars()
    }
    stats = await _stats(db, [user.id, *others])
    return [
        pair_view(p, me, profiles[_other(p, user.id)], stats)
        for p in pairs
        if _other(p, user.id) in profiles
    ]


@router.post("/buddies", status_code=201)
async def invite(
    body: InviteIn,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    me = await require_social(db, user)
    await enforce("buddy-invite", user.id, 10, 86_400)
    them = await _profile_by_handle(db, body.handle)
    if them.user_id == user.id:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "You can't buddy up with yourself"
        )
    # One message for every reason someone can't be invited, so this never
    # reveals whether a person blocked you or is under 16.
    unavailable = HTTPException(
        status.HTTP_403_FORBIDDEN, "You can buddy up with people you follow or who follow you."
    )
    if (
        not them.social_allowed(utcnow().year)
        or await is_blocked(db, user.id, them.user_id)
        or not await _follow_either_way(db, user.id, them.user_id)
    ):
        raise unavailable
    count = (
        await db.execute(
            select(func.count())
            .select_from(BuddyPair)
            .where(
                or_(BuddyPair.user_a == user.id, BuddyPair.user_b == user.id),
                BuddyPair.status.in_(("pending", "active")),
            )
        )
    ).scalar_one()
    if count >= MAX_BUDDIES:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"{MAX_BUDDIES} buddies at a time is the limit"
        )

    a, b = _pair_key(user.id, them.user_id)
    pair = (
        await db.execute(select(BuddyPair).where(BuddyPair.user_a == a, BuddyPair.user_b == b))
    ).scalar_one_or_none()
    if pair is not None and pair.status in ("pending", "active"):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "You're already buddies, or an invite is waiting"
        )
    if pair is None:
        pair = BuddyPair(user_a=a, user_b=b, requested_by=user.id)
        db.add(pair)
    else:
        pair.requested_by, pair.status, pair.started_at, pair.ended_at = (
            user.id,
            "pending",
            None,
            None,
        )
    await db.flush()
    nid = await notify(
        db,
        them.user_id,
        kind="buddy_invite",
        category="social",
        title=f"@{me.handle} wants to be streak buddies",
        body="A week counts when you both keep yours. You'd see each other's weekly progress.",
        url="/buddies",
        actor_id=user.id,
        dedupe_key=f"buddy-invite:{pair.id}:{utcnow().date().isoformat()}",
    )
    await db.commit()
    background.add_task(deliver, [nid] if nid else [])
    stats = await _stats(db, [user.id, them.user_id])
    return pair_view(pair, me, them, stats)


async def _own_pair(db: AsyncSession, user: User, pair_id: UUID) -> BuddyPair:
    pair = await db.get(BuddyPair, pair_id)
    if pair is None or user.id not in (pair.user_a, pair.user_b):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return pair


@router.post("/buddies/{pair_id}/accept")
async def accept(
    pair_id: UUID,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    me = await require_social(db, user)
    pair = await _own_pair(db, user, pair_id)
    if pair.status != "pending" or pair.requested_by == user.id:
        raise HTTPException(status.HTTP_409_CONFLICT, "There's nothing to accept")
    other = _other(pair, user.id)
    them = (await db.execute(select(Profile).where(Profile.user_id == other))).scalar_one()
    if not them.social_allowed(utcnow().year) or await is_blocked(db, user.id, other):
        raise HTTPException(status.HTTP_409_CONFLICT, "This invite is no longer available")
    pair.status, pair.started_at = "active", utcnow()
    nid = await notify(
        db,
        other,
        kind="buddy_accepted",
        category="social",
        title=f"@{me.handle} is your streak buddy now",
        body="This week is your first together.",
        url="/buddies",
        actor_id=user.id,
    )
    await db.commit()
    background.add_task(deliver, [nid] if nid else [])
    return pair_view(pair, me, them, await _stats(db, [user.id, other]))


@router.post("/buddies/{pair_id}/end", status_code=204)
async def end(
    pair_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Decline an invite, withdraw one, or end a pair. No notification: ending
    a buddy streak should never become a thing someone is told about."""
    pair = await _own_pair(db, user, pair_id)
    if pair.status == "ended":
        return
    pair.status, pair.ended_at = "ended", utcnow()
    await db.commit()


# --- encouragement ------------------------------------------------------------------


@router.get("/encouragement/presets")
async def presets():
    return [{"id": k, "text": v} for k, v in PRESETS.items()]


async def _may_encourage(db: AsyncSession, sender: UUID, recipient: UUID) -> bool:
    """The recipient already chose a connection with the sender: they follow
    the sender, are their active buddy, or share a group."""
    follows_sender = exists().where(
        Follow.follower_id == recipient, Follow.followee_id == sender, Follow.status == "accepted"
    )
    a, b = _pair_key(sender, recipient)
    buddies = exists().where(
        BuddyPair.user_a == a, BuddyPair.user_b == b, BuddyPair.status == "active"
    )
    mine = select(GroupMember.group_id).where(GroupMember.user_id == sender)
    shared_group = exists().where(GroupMember.user_id == recipient, GroupMember.group_id.in_(mine))
    return (await db.execute(select(or_(follows_sender, buddies, shared_group)))).scalar_one()


@router.post("/people/{handle}/encourage", status_code=202)
async def encourage(
    handle: str,
    body: EncourageIn,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    me = await require_social(db, user)
    text = PRESETS.get(body.preset)
    if text is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Pick one of the messages")
    await enforce("encourage", user.id, 20, 86_400)
    them = await _profile_by_handle(db, handle)
    if (
        them.user_id == user.id
        or not them.social_allowed(utcnow().year)
        or await is_blocked(db, user.id, them.user_id)
        or not await _may_encourage(db, user.id, them.user_id)
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You can encourage people who follow you, your buddies and your groups.",
        )
    # Once a day per pair: the dedupe key makes a second one a silent no-op.
    nid = await notify(
        db,
        them.user_id,
        kind="encouragement",
        category="social",
        title=f"@{me.handle}: {text}",
        body=None,
        url=f"/u/{me.handle}",
        actor_id=user.id,
        dedupe_key=f"encourage:{user.id}:{utcnow().date().isoformat()}",
    )
    await db.commit()
    background.add_task(deliver, [nid] if nid else [])
    return {"sent": nid is not None}
