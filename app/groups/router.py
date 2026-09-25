"""Groups (crews and coaching rosters) and challenges.

Joining a group is consent to share, with its members only, your handle,
your streak and your week's progress - that is what a crew is for. Nothing
beyond that crosses over: a coach sees your sessions only if you switch on
`shares_with_coach` for that group, and can lose sight of them the moment
you switch it off.
"""

from datetime import date, timedelta
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.codes import invite_code
from app.common.limits import enforce
from app.common.time import local_today, utcnow, week_start
from app.database import get_db
from app.game.models import UserStats
from app.game.service import snapshot
from app.groups.models import Challenge, ChallengeParticipant, Group, GroupMember
from app.notifications.service import deliver, notify
from app.profile.models import Profile
from app.profile.service import get_profile
from app.social.models import ActivityEvent, Kudos
from app.social.router import clean_text, person, require_social
from app.social.service import not_blocked_clause, social_ok_clause
from app.training.library import DISCIPLINE_IDS
from app.training.models import Workout

router = APIRouter(tags=["groups"])

MAX_GROUPS = 20
MAX_MEMBERS = 200
MAX_CHALLENGE_DAYS = 92
# A session counts towards a challenge only if it was logged within this long
# of when it happened. Backfilling a fortnight of "sessions" on the last day
# is exactly the thing a challenge must not reward.
LATE_LOG_GRACE = timedelta(days=3)


# --- groups ------------------------------------------------------------------------


class GroupIn(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    description: str | None = Field(default=None, max_length=280)
    kind: str = Field(default="crew", pattern="^(crew|coaching)$")
    avatar_hue: int | None = Field(default=None, ge=0, le=359)

    @field_validator("name", "description")
    @classmethod
    def _clean(cls, v: str | None) -> str | None:
        return clean_text(v) or None if v else v


class GroupPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=60)
    description: str | None = Field(default=None, max_length=280)
    avatar_hue: int | None = Field(default=None, ge=0, le=359)

    @field_validator("name", "description")
    @classmethod
    def _clean(cls, v: str | None) -> str | None:
        return clean_text(v) or None if v else v


async def _membership(db: AsyncSession, group_id: UUID, user_id: UUID) -> GroupMember | None:
    return (
        await db.execute(
            select(GroupMember).where(
                GroupMember.group_id == group_id, GroupMember.user_id == user_id
            )
        )
    ).scalar_one_or_none()


async def _group_for_member(
    db: AsyncSession, group_id: UUID, user: User
) -> tuple[Group, GroupMember]:
    group = await db.get(Group, group_id)
    member = await _membership(db, group_id, user.id) if group else None
    if group is None or member is None or group.hidden_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return group, member


def _group_out(g: Group, member: GroupMember | None, count: int) -> dict:
    manager = member is not None and member.role in ("owner", "admin")
    return {
        "id": str(g.id),
        "name": g.name,
        "description": g.description,
        "kind": g.kind,
        "avatar_hue": g.avatar_hue,
        "member_count": count,
        "my_role": member.role if member else None,
        "shares_with_coach": member.shares_with_coach if member else False,
        "muted": member.muted if member else False,
        "invite_code": g.invite_code if manager else None,
    }


@router.get("/groups")
async def my_groups(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    counts = (
        select(GroupMember.group_id, func.count().label("n"))
        .group_by(GroupMember.group_id)
        .subquery()
    )
    rows = (
        await db.execute(
            select(Group, GroupMember, counts.c.n)
            .join(GroupMember, GroupMember.group_id == Group.id)
            .join(counts, counts.c.group_id == Group.id)
            .where(GroupMember.user_id == user.id, Group.hidden_at.is_(None))
            .order_by(Group.name)
        )
    ).all()
    return [_group_out(g, m, n) for g, m, n in rows]


@router.post("/groups", status_code=201)
async def create_group(
    body: GroupIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await require_social(db, user)
    await enforce("group-create", user.id, 5, 3600)
    owned = (await db.execute(select(func.count()).where(Group.owner_id == user.id))).scalar_one()
    if owned >= MAX_GROUPS:
        raise HTTPException(status.HTTP_409_CONFLICT, "Group limit reached")
    group = Group(
        name=body.name,
        description=body.description,
        kind=body.kind,
        owner_id=user.id,
        invite_code=invite_code(),
        avatar_hue=body.avatar_hue if body.avatar_hue is not None else 200,
    )
    db.add(group)
    await db.flush()
    member = GroupMember(group_id=group.id, user_id=user.id, role="owner")
    db.add(member)
    await db.commit()
    return _group_out(group, member, 1)


class JoinIn(BaseModel):
    code: str = Field(min_length=4, max_length=16)


@router.post("/groups/join")
async def join_group(
    body: JoinIn,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    me = await require_social(db, user)
    await enforce("group-join", user.id, 20, 3600)
    group = (
        await db.execute(select(Group).where(Group.invite_code == body.code.strip().lower()))
    ).scalar_one_or_none()
    if group is None or group.hidden_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That code does not match a group")
    existing = await _membership(db, group.id, user.id)
    if existing:
        return {"id": str(group.id)}
    count = (
        await db.execute(select(func.count()).where(GroupMember.group_id == group.id))
    ).scalar_one()
    if count >= MAX_MEMBERS:
        raise HTTPException(status.HTTP_409_CONFLICT, "That group is full")
    db.add(GroupMember(group_id=group.id, user_id=user.id))
    nid = await notify(
        db,
        group.owner_id,
        kind="group_join",
        category="groups",
        title=f"{me.display_name or '@' + (me.handle or '')} joined {group.name}",
        url=f"/groups/{group.id}",
        actor_id=user.id,
        data={"group_id": str(group.id)},
        dedupe_key=f"group_join:{group.id}:{user.id}",
    )
    await db.commit()
    background.add_task(deliver, [nid] if nid else [])
    return {"id": str(group.id)}


@router.get("/groups/{group_id}")
async def get_group(
    group_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    group, me = await _group_for_member(db, group_id, user)
    rows = (
        await db.execute(
            select(GroupMember, Profile, UserStats)
            .join(Profile, Profile.user_id == GroupMember.user_id)
            .outerjoin(UserStats, UserStats.user_id == GroupMember.user_id)
            .where(
                GroupMember.group_id == group_id,
                social_ok_clause(),
                not_blocked_clause(user.id, GroupMember.user_id),
            )
        )
    ).all()
    members = [
        person(
            p,
            s,
            role=m.role,
            this_week_days=s.this_week_days if s else 0,
            this_week_target=s.this_week_target if s else None,
            consistency=s.consistency if s else 0,
            last_active=s.last_active.isoformat() if s and s.last_active else None,
            shares_with_coach=m.shares_with_coach if group.kind == "coaching" else None,
        )
        for m, p, s in rows
    ]
    members.sort(key=lambda m: (-(m.get("current_streak") or 0), m["handle"] or ""))
    return _group_out(group, me, len(rows)) | {"members": members}


@router.patch("/groups/{group_id}")
async def update_group(
    group_id: UUID,
    body: GroupPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    group, me = await _group_for_member(db, group_id, user)
    if me.role not in ("owner", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the owner or an admin can edit")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(group, key, value)
    await db.commit()
    return {"id": str(group.id)}


@router.delete("/groups/{group_id}", status_code=204)
async def delete_group(
    group_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    group, me = await _group_for_member(db, group_id, user)
    if me.role != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the owner can delete a group")
    await db.delete(group)
    await db.commit()


@router.post("/groups/{group_id}/leave", status_code=204)
async def leave_group(
    group_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    _, me = await _group_for_member(db, group_id, user)
    if me.role == "owner":
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Hand ownership to someone else, or delete the group"
        )
    await db.delete(me)
    await db.commit()


@router.post("/groups/{group_id}/invite/rotate")
async def rotate_invite(
    group_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    group, me = await _group_for_member(db, group_id, user)
    if me.role not in ("owner", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the owner or an admin can do that")
    group.invite_code = invite_code()
    await db.commit()
    return {"invite_code": group.invite_code}


class MemberPatch(BaseModel):
    role: str = Field(pattern="^(owner|admin|coach|member)$")


@router.patch("/groups/{group_id}/members/{member_id}")
async def set_role(
    group_id: UUID,
    member_id: UUID,
    body: MemberPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    group, me = await _group_for_member(db, group_id, user)
    target = await _membership(db, group_id, member_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if body.role == "owner":
        if me.role != "owner":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the owner can hand over")
        me.role = "admin"
        target.role = "owner"
        group.owner_id = member_id
    elif me.role == "owner" or (
        me.role == "admin"
        and target.role in ("coach", "member")
        and body.role in ("coach", "member")
    ):
        if target.role == "owner":
            raise HTTPException(status.HTTP_409_CONFLICT, "Hand over ownership instead")
        target.role = body.role
    else:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed")
    await db.commit()
    return {"role": target.role}


@router.delete("/groups/{group_id}/members/{member_id}", status_code=204)
async def remove_member(
    group_id: UUID,
    member_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _, me = await _group_for_member(db, group_id, user)
    target = await _membership(db, group_id, member_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if (
        target.role == "owner"
        or me.role not in ("owner", "admin")
        or (me.role == "admin" and target.role == "admin")
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed")
    await db.delete(target)
    await db.commit()


class MembershipPatch(BaseModel):
    shares_with_coach: bool | None = None
    muted: bool | None = None


@router.patch("/groups/{group_id}/me")
async def set_consent(
    group_id: UUID,
    body: MembershipPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Your own settings in one group: coach consent and mute."""
    _, me = await _group_for_member(db, group_id, user)
    if body.shares_with_coach is not None:
        me.shares_with_coach = body.shares_with_coach
    if body.muted is not None:
        me.muted = body.muted
    await db.commit()
    return {"shares_with_coach": me.shares_with_coach, "muted": me.muted}


@router.get("/groups/{group_id}/coach")
async def coach_view(
    group_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Training detail for members who chose to share it with their coach."""
    group, me = await _group_for_member(db, group_id, user)
    if group.kind != "coaching" or me.role not in ("owner", "admin", "coach"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Coaches only")
    members = (
        await db.execute(
            select(GroupMember, Profile)
            .join(Profile, Profile.user_id == GroupMember.user_id)
            .where(
                GroupMember.group_id == group_id,
                GroupMember.shares_with_coach.is_(True),
                GroupMember.user_id != user.id,
            )
        )
    ).all()
    out = []
    for m, p in members:
        snap = await snapshot(db, m.user_id)
        main = snap.chains[0].result
        recent = (
            (
                await db.execute(
                    select(Workout)
                    .where(Workout.user_id == m.user_id, Workout.deleted_at.is_(None))
                    .order_by(Workout.started_at.desc())
                    .limit(10)
                )
            )
            .scalars()
            .all()
        )
        out.append(
            person(p)
            | {
                "current_streak": main.current,
                "this_week_days": main.this_week_days,
                "this_week_target": main.this_week_target,
                "at_risk": main.at_risk,
                "consistency": main.consistency,
                "weeks": [
                    {
                        "week_start": c.week_start.isoformat(),
                        "days": c.days,
                        "target": c.target,
                        "status": c.status,
                    }
                    for c in main.weeks[-8:]
                ],
                "recent": [
                    {
                        "id": str(w.id),
                        "date": w.local_date.isoformat(),
                        "discipline": w.discipline,
                        "title": w.title,
                        "duration_sec": w.duration_sec,
                        "distance_m": w.distance_m,
                        "effort": w.effort,
                        "feel": w.feel,
                        "sets": sum(1 for s in w.sets if s.completed and s.kind != "warmup"),
                    }
                    for w in recent
                ],
            }
        )
    await db.commit()
    return {"members": out}


@router.get("/groups/{group_id}/feed")
async def group_feed(
    group_id: UUID,
    before: str | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Members' activity. Co-membership counts as a follow here, except for
    private accounts, which stay private everywhere."""
    await _group_for_member(db, group_id, user)
    member_ids = select(GroupMember.user_id).where(GroupMember.group_id == group_id)
    kudos_count = select(func.count()).where(Kudos.event_id == ActivityEvent.id).scalar_subquery()
    mine = (
        select(func.count())
        .where(Kudos.event_id == ActivityEvent.id, Kudos.user_id == user.id)
        .scalar_subquery()
    )
    stmt = (
        select(ActivityEvent, Profile, kudos_count, mine)
        .join(Profile, Profile.user_id == ActivityEvent.user_id)
        .where(
            ActivityEvent.user_id.in_(member_ids),
            ActivityEvent.hidden_at.is_(None),
            Profile.visibility != "private",
            social_ok_clause(),
            not_blocked_clause(user.id, ActivityEvent.user_id),
        )
    )
    if before:
        from datetime import datetime

        stmt = stmt.where(ActivityEvent.created_at < datetime.fromisoformat(before))
    rows = (await db.execute(stmt.order_by(ActivityEvent.created_at.desc()).limit(26))).all()
    more = len(rows) > 25
    rows = rows[:25]
    return {
        "events": [
            {
                "id": str(e.id),
                "kind": e.kind,
                "data": e.data,
                "date": e.occurred_on.isoformat(),
                "created_at": e.created_at.isoformat(),
                "author": person(p),
                "kudos": k,
                "comments": 0,
                "kudoed": bool(m),
                "mine": e.user_id == user.id,
            }
            for e, p, k, m in rows
        ],
        "next": rows[-1][0].created_at.isoformat() if more else None,
    }


# --- challenges -----------------------------------------------------------------------


class ChallengeIn(BaseModel):
    title: str = Field(min_length=3, max_length=60)
    description: str | None = Field(default=None, max_length=280)
    kind: str = Field(default="active_days", pattern="^(active_days|weekly_target)$")
    target: int | None = Field(default=None, ge=1, le=366)
    disciplines: list[str] = Field(default_factory=list, max_length=11)
    starts_on: date
    ends_on: date
    group_id: UUID | None = None

    @field_validator("title", "description")
    @classmethod
    def _clean(cls, v: str | None) -> str | None:
        return clean_text(v) or None if v else v

    @field_validator("disciplines")
    @classmethod
    def _known(cls, v: list[str]) -> list[str]:
        bad = [d for d in v if d not in DISCIPLINE_IDS]
        if bad:
            raise ValueError(f"unknown disciplines: {', '.join(bad)}")
        return v


def _challenge_status(c: Challenge, today: date) -> str:
    if c.resolved_at is not None or today > c.ends_on:
        return "finished"
    return "upcoming" if today < c.starts_on else "live"


async def _scores(db: AsyncSession, c: Challenge, today: date) -> list[dict]:
    """Live scores. Frozen ones come from the participant rows once resolved."""
    parts = (
        await db.execute(
            select(ChallengeParticipant, Profile, UserStats)
            .join(Profile, Profile.user_id == ChallengeParticipant.user_id)
            .outerjoin(UserStats, UserStats.user_id == ChallengeParticipant.user_id)
            .where(
                ChallengeParticipant.challenge_id == c.id, ChallengeParticipant.left_at.is_(None)
            )
        )
    ).all()
    end = min(c.ends_on, today)
    rows = []
    for part, profile, stats in parts:
        if c.resolved_at is not None and part.final_score is not None:
            score = part.final_score
        elif today < c.starts_on:
            score = 0
        elif c.kind == "active_days":
            stmt = select(func.count(func.distinct(Workout.local_date))).where(
                Workout.user_id == part.user_id,
                Workout.deleted_at.is_(None),
                Workout.source == "app",
                Workout.local_date >= c.starts_on,
                Workout.local_date <= end,
                Workout.created_at <= Workout.started_at + LATE_LOG_GRACE,
            )
            if c.disciplines:
                stmt = stmt.where(Workout.discipline.in_(c.disciplines))
            score = (await db.execute(stmt)).scalar_one()
        else:
            snap = await snapshot(db, part.user_id)
            wso = snap.profile.week_starts_on
            first = week_start(c.starts_on, wso)
            score = sum(
                1
                for cell in snap.chains[0].result.weeks
                if first <= cell.week_start <= c.ends_on
                and cell.status == "kept"
                and cell.days >= cell.target
            )
        rows.append({"profile": profile, "stats": stats, "score": score, "part": part})
    rows.sort(key=lambda r: -r["score"])
    ranked, last_score, rank = [], None, 0
    for i, r in enumerate(rows, start=1):
        if r["score"] != last_score:
            rank, last_score = i, r["score"]
        ranked.append(
            person(r["profile"], r["stats"])
            | {
                "score": r["score"],
                "rank": r["part"].final_rank or rank,
                "completed": r["part"].completed or bool(c.target and r["score"] >= c.target),
            }
        )
    return ranked


async def _visible_challenge(db: AsyncSession, challenge_id: UUID, user: User) -> Challenge:
    c = await db.get(Challenge, challenge_id)
    if c is None or c.hidden_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    joined = (
        await db.execute(
            select(ChallengeParticipant.id).where(
                ChallengeParticipant.challenge_id == c.id, ChallengeParticipant.user_id == user.id
            )
        )
    ).scalar_one_or_none()
    member = c.group_id and await _membership(db, c.group_id, user.id)
    if not joined and not member:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return c


def _challenge_out(
    c: Challenge, today: date, me_joined: bool, is_creator: bool, count: int | None = None
) -> dict:
    return {
        "id": str(c.id),
        "title": c.title,
        "description": c.description,
        "kind": c.kind,
        "target": c.target,
        "disciplines": c.disciplines,
        "starts_on": c.starts_on.isoformat(),
        "ends_on": c.ends_on.isoformat(),
        "group_id": str(c.group_id) if c.group_id else None,
        "status": _challenge_status(c, today),
        "joined": me_joined,
        "is_creator": is_creator,
        "invite_code": c.invite_code if (is_creator or me_joined) and not c.group_id else None,
        "participants": count,
    }


@router.get("/challenges")
async def list_challenges(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    profile = await get_profile(db, user.id)
    today = local_today(profile.timezone)
    my_groups = select(GroupMember.group_id).where(GroupMember.user_id == user.id)
    joined_ids = select(ChallengeParticipant.challenge_id).where(
        ChallengeParticipant.user_id == user.id, ChallengeParticipant.left_at.is_(None)
    )
    counts = (
        select(ChallengeParticipant.challenge_id, func.count().label("n"))
        .where(ChallengeParticipant.left_at.is_(None))
        .group_by(ChallengeParticipant.challenge_id)
        .subquery()
    )
    rows = (
        await db.execute(
            select(Challenge, counts.c.n, Challenge.id.in_(joined_ids))
            .outerjoin(counts, counts.c.challenge_id == Challenge.id)
            .where(
                Challenge.hidden_at.is_(None),
                (Challenge.id.in_(joined_ids)) | (Challenge.group_id.in_(my_groups)),
                Challenge.ends_on >= today - timedelta(days=60),
            )
            .order_by(Challenge.ends_on.desc())
        )
    ).all()
    return [
        _challenge_out(c, today, joined, c.creator_id == user.id, n or 0) for c, n, joined in rows
    ]


@router.post("/challenges", status_code=201)
async def create_challenge(
    body: ChallengeIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    profile = await require_social(db, user)
    await enforce("challenge-create", user.id, 10, 3600)
    today = local_today(profile.timezone)
    if body.ends_on < body.starts_on:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "It ends before it starts")
    if (body.ends_on - body.starts_on).days + 1 > MAX_CHALLENGE_DAYS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Challenges last up to 92 days")
    if body.starts_on < today - timedelta(days=1):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Challenges cannot start in the past"
        )
    if body.group_id:
        member = await _membership(db, body.group_id, user.id)
        if member is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    challenge = Challenge(creator_id=user.id, invite_code=invite_code(), **body.model_dump())
    db.add(challenge)
    await db.flush()
    db.add(ChallengeParticipant(challenge_id=challenge.id, user_id=user.id))
    await db.commit()
    return _challenge_out(challenge, today, True, True, 1)


@router.get("/challenges/code/{code}")
async def preview_challenge(
    code: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    profile = await require_social(db, user)
    c = (
        await db.execute(select(Challenge).where(Challenge.invite_code == code.lower()))
    ).scalar_one_or_none()
    if c is None or c.hidden_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That code does not match a challenge")
    return _challenge_out(c, local_today(profile.timezone), False, c.creator_id == user.id)


@router.get("/challenges/{challenge_id}")
async def get_challenge(
    challenge_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    c = await _visible_challenge(db, challenge_id, user)
    profile = await get_profile(db, user.id)
    today = local_today(profile.timezone)
    board = await _scores(db, c, today)
    await db.commit()
    joined = any(r["id"] == str(user.id) for r in board)
    return _challenge_out(c, today, joined, c.creator_id == user.id, len(board)) | {
        "leaderboard": board,
        "days_total": (c.ends_on - c.starts_on).days + 1,
        "days_elapsed": max(
            0, min((today - c.starts_on).days + 1, (c.ends_on - c.starts_on).days + 1)
        ),
    }


async def _join(db: AsyncSession, c: Challenge, user: User) -> None:
    part = (
        await db.execute(
            select(ChallengeParticipant).where(
                ChallengeParticipant.challenge_id == c.id, ChallengeParticipant.user_id == user.id
            )
        )
    ).scalar_one_or_none()
    if part is None:
        count = (
            await db.execute(select(func.count()).where(ChallengeParticipant.challenge_id == c.id))
        ).scalar_one()
        if count >= MAX_MEMBERS:
            raise HTTPException(status.HTTP_409_CONFLICT, "That challenge is full")
        db.add(ChallengeParticipant(challenge_id=c.id, user_id=user.id))
    else:
        part.left_at = None


@router.post("/challenges/join")
async def join_by_code(
    body: JoinIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await require_social(db, user)
    c = (
        await db.execute(
            select(Challenge).where(Challenge.invite_code == body.code.strip().lower())
        )
    ).scalar_one_or_none()
    if c is None or c.hidden_at is not None or c.resolved_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That code does not match an open challenge")
    await _join(db, c, user)
    await db.commit()
    return {"id": str(c.id)}


@router.post("/challenges/{challenge_id}/join")
async def join_challenge(
    challenge_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await require_social(db, user)
    c = await _visible_challenge(db, challenge_id, user)
    if c.resolved_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "That challenge has finished")
    await _join(db, c, user)
    await db.commit()
    return {"id": str(c.id)}


@router.post("/challenges/{challenge_id}/leave", status_code=204)
async def leave_challenge(
    challenge_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    part = (
        await db.execute(
            select(ChallengeParticipant).where(
                ChallengeParticipant.challenge_id == challenge_id,
                ChallengeParticipant.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if part is not None:
        part.left_at = utcnow()
        await db.commit()


@router.delete("/challenges/{challenge_id}", status_code=204)
async def delete_challenge(
    challenge_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    c = await db.get(Challenge, challenge_id)
    if c is None or c.creator_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await db.delete(c)
    await db.commit()


async def resolve_finished(db: AsyncSession, today: date) -> list[UUID]:
    """Freeze results for challenges that ended before `today` (UTC). Called by
    the worker. Idempotent: resolved challenges are skipped."""
    from app.social.service import emit_event

    due = (
        (
            await db.execute(
                select(Challenge).where(
                    Challenge.resolved_at.is_(None), Challenge.ends_on < today - timedelta(days=1)
                )
            )
        )
        .scalars()
        .all()
    )
    note_ids: list[UUID] = []
    for c in due:
        board = await _scores(db, c, c.ends_on)
        parts = {
            p.user_id: p
            for p in (
                await db.execute(
                    select(ChallengeParticipant).where(ChallengeParticipant.challenge_id == c.id)
                )
            ).scalars()
        }
        for row in board:
            part = parts.get(UUID(row["id"]))
            if part is None:
                continue
            part.final_score = row["score"]
            part.final_rank = row["rank"]
            part.completed = bool(c.target and row["score"] >= c.target) or (
                not c.target and row["score"] > 0
            )
            unit = "active days" if c.kind == "active_days" else "weeks kept"
            nid = await notify(
                db,
                part.user_id,
                kind="challenge_finished",
                category="groups",
                title=f"{c.title} is over - you placed #{row['rank']}",
                body=f"{row['score']} {unit}.",
                url=f"/challenges/{c.id}",
                data={"group_id": str(c.group_id)} if c.group_id else None,
                dedupe_key=f"challenge_done:{c.id}",
            )
            note_ids += [nid] if nid else []
            if part.completed:
                profile = await get_profile(db, part.user_id)
                await emit_event(
                    db,
                    profile,
                    "challenge",
                    f"challenge:{c.id}",
                    c.ends_on,
                    {"title": c.title, "rank": row["rank"], "score": row["score"], "kind": c.kind},
                )
        c.resolved_at = utcnow()
    return note_ids
