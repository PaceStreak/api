"""Leaderboards. Opt-in, adherence-first, and structurally hard to cheat.

Four boards, all computed from the user_stats projection:

- consistency: mean weekly score over the last four closed weeks, where each
  week is capped at 100% of the person's own target. Training more than your
  plan cannot raise it, so it never rewards overtraining.
- streak: current kept-week streak.
- season_xp: this quarter's XP. XP never scales with load or volume.
- season_prs: this quarter's personal records - each one relative to the
  person's own history, so being big or lying about weight wins nothing.
- life_streak: the whole-life streak (training or any habit), for those who
  turned it on.

Any board can be narrowed to "similar": people who train about as often as
you, so someone on two days a week is not ranked against someone on six.

There is deliberately no board for weight lifted, distance, or anything
body-related (see the scorefit ED-safety review this inherits).
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.time import season_id, utcnow
from app.database import get_db
from app.game.models import UserStats
from app.groups.models import GroupMember
from app.profile.models import Profile
from app.profile.service import get_profile
from app.social.models import Follow
from app.social.router import person
from app.social.service import can_see_clause, not_blocked_clause, social_ok_clause

router = APIRouter(prefix="/leaderboards", tags=["leaderboards"])

SIMILAR_BAND = 1.0

BOARDS = {
    "consistency": UserStats.consistency,
    "streak": UserStats.current_streak,
    "season_xp": UserStats.season_xp,
    "season_prs": UserStats.season_prs,
    # Weeks in a row with any training or habit, for people who turned the
    # whole-life streak on. Attendance again: never which habit, or how much.
    "life_streak": UserStats.life_streak,
}


@router.get("/{board}")
async def leaderboard(
    board: str,
    scope: str = Query(default="global", pattern="^(global|following|group|similar)$"),
    group_id: UUID | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    column = BOARDS.get(board)
    if column is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such board")
    me = await get_profile(db, user.id)
    if not me.social_allowed(utcnow().year):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Leaderboards are not available")

    conditions = [
        social_ok_clause(),
        Profile.gamification_enabled.is_(True),
        not_blocked_clause(user.id, Profile.user_id),
    ]
    if board.startswith("season"):
        conditions.append(UserStats.season_id == season_id(utcnow().date()))
    if scope == "global":
        conditions.append(Profile.leaderboard_opt_in.is_(True))
    elif scope == "similar":
        # Opted-in people who train about as often as you do: within a day a
        # week of your own four-week average, so the board is winnable
        # whichever end of the range you train at.
        mine = (
            await db.execute(select(UserStats.weekly_days_4w).where(UserStats.user_id == user.id))
        ).scalar_one_or_none() or 0.0
        conditions += [
            Profile.leaderboard_opt_in.is_(True),
            UserStats.weekly_days_4w.between(mine - SIMILAR_BAND, mine + SIMILAR_BAND),
        ]
    elif scope == "following":
        followees = select(Follow.followee_id).where(
            Follow.follower_id == user.id, Follow.status == "accepted"
        )
        conditions += [
            (Profile.user_id == user.id) | Profile.user_id.in_(followees),
            can_see_clause(user.id),
        ]
    else:
        if group_id is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "group_id is required")
        member = (
            await db.execute(
                select(GroupMember.id).where(
                    GroupMember.group_id == group_id, GroupMember.user_id == user.id
                )
            )
        ).scalar_one_or_none()
        if member is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
        conditions += [
            Profile.user_id.in_(
                select(GroupMember.user_id).where(GroupMember.group_id == group_id)
            ),
            Profile.visibility != "private",
        ]

    ranked = (
        select(
            Profile.user_id.label("user_id"),
            column.label("value"),
            func.rank().over(order_by=column.desc()).label("rank"),
        )
        .join(UserStats, UserStats.user_id == Profile.user_id)
        .where(*conditions)
        .subquery()
    )
    base = (
        select(Profile, UserStats, ranked.c.value, ranked.c.rank)
        .join(ranked, ranked.c.user_id == Profile.user_id)
        .join(UserStats, UserStats.user_id == Profile.user_id)
    )
    rows = (await db.execute(base.order_by(ranked.c.rank, Profile.handle).limit(50))).all()
    mine = (await db.execute(base.where(ranked.c.user_id == user.id))).first()
    total = (await db.execute(select(func.count()).select_from(ranked))).scalar_one()

    def row(p, s, value, rank):
        return person(p, s, value=value, rank=rank, me=p.user_id == user.id)

    return {
        "board": board,
        "scope": scope,
        "participants": total,
        "opted_in": me.leaderboard_opt_in,
        "rows": [row(*r) for r in rows],
        "me": row(*mine) if mine else None,
    }
