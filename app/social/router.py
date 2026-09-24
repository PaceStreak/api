"""People, the follow graph, the feed, kudos, comments and reports."""

import unicodedata
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.limits import enforce
from app.common.time import utcnow
from app.database import get_db
from app.game.models import UserAchievement, UserStats
from app.game.service import chain_payload, snapshot
from app.groups.models import Challenge, Group
from app.notifications.service import deliver, notify
from app.profile.models import Profile
from app.profile.service import get_profile
from app.social.models import ActivityEvent, Block, Comment, Follow, Kudos, Report
from app.social.service import (
    can_see,
    can_see_clause,
    is_blocked,
    not_blocked_clause,
    social_ok_clause,
)

router = APIRouter(tags=["social"])


# --- helpers ----------------------------------------------------------------------


async def require_social(db: AsyncSession, user: User) -> Profile:
    """Social actions need an onboarded, of-age, unsuspended account and a
    confirmed email - the last one is the cheapest brake on throwaway
    accounts created to harass."""
    profile = await get_profile(db, user.id)
    if profile.onboarded_at is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Finish setting up your profile first")
    if not profile.social_allowed(utcnow().year):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Social features are not available")
    if not user.is_verified:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Confirm your email address first")
    return profile


def person(p: Profile, stats: UserStats | None = None, **extra) -> dict:
    data = {
        "id": str(p.user_id),
        "handle": p.handle,
        "display_name": p.display_name,
        "avatar_hue": p.avatar_hue,
        "visibility": p.visibility,
    }
    if stats is not None and p.gamification_enabled:
        data |= {"level": stats.level, "current_streak": stats.current_streak}
    elif stats is not None:
        data |= {"current_streak": stats.current_streak}
    return data | extra


async def _profile_by_handle(db: AsyncSession, handle: str) -> Profile:
    profile = (
        await db.execute(select(Profile).where(Profile.handle == handle.lower().lstrip("@")))
    ).scalar_one_or_none()
    if profile is None or profile.onboarded_at is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such person")
    return profile


async def _relationship(db: AsyncSession, me: UUID, them: UUID) -> dict:
    rows = (
        (
            await db.execute(
                select(Follow).where(
                    or_(
                        and_(Follow.follower_id == me, Follow.followee_id == them),
                        and_(Follow.follower_id == them, Follow.followee_id == me),
                    )
                )
            )
        )
        .scalars()
        .all()
    )
    out = {"following": None, "follows_you": None}
    for f in rows:
        if f.follower_id == me:
            out["following"] = f.status
        else:
            out["follows_you"] = f.status
    blocked = (
        await db.execute(select(Block.id).where(Block.blocker_id == me, Block.blocked_id == them))
    ).scalar_one_or_none()
    out["blocked"] = blocked is not None
    return out


def clean_text(value: str) -> str:
    """Plain text only: normalise, drop control and invisible formatting
    characters (the ones used to spoof direction or hide content), collapse
    runs of blank lines."""
    value = unicodedata.normalize("NFKC", value)
    value = "".join(
        ch for ch in value if ch in "\n\t" or unicodedata.category(ch) not in ("Cc", "Cf", "Co")
    )
    while "\n\n\n" in value:
        value = value.replace("\n\n\n", "\n\n")
    return value.strip()


# --- people -------------------------------------------------------------------------


@router.get("/people/search")
async def search(
    q: str = Query(min_length=1, max_length=40),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await require_social(db, user)
    await enforce("search", user.id, 60, 60)
    term = q.strip().lower().lstrip("@")
    like = f"{term.replace('%', '').replace('_', r'\_')}%"
    rows = (
        await db.execute(
            select(Profile, UserStats)
            .outerjoin(UserStats, UserStats.user_id == Profile.user_id)
            .where(
                Profile.user_id != user.id,
                Profile.visibility != "private",
                social_ok_clause(),
                not_blocked_clause(user.id, Profile.user_id),
                or_(Profile.handle.ilike(like), Profile.display_name.ilike(f"%{term}%")),
            )
            .order_by(func.length(Profile.handle))
            .limit(20)
        )
    ).all()
    return [person(p, s) for p, s in rows]


@router.get("/people/suggested")
async def suggested(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """People who share a group with you, or whom the people you follow follow."""
    await require_social(db, user)
    from app.groups.models import GroupMember

    my_groups = select(GroupMember.group_id).where(GroupMember.user_id == user.id)
    group_mates = select(GroupMember.user_id).where(GroupMember.group_id.in_(my_groups))
    my_follows = select(Follow.followee_id).where(
        Follow.follower_id == user.id, Follow.status == "accepted"
    )
    friends_of = select(Follow.followee_id).where(
        Follow.follower_id.in_(my_follows), Follow.status == "accepted"
    )
    rows = (
        await db.execute(
            select(Profile, UserStats)
            .outerjoin(UserStats, UserStats.user_id == Profile.user_id)
            .where(
                Profile.user_id != user.id,
                Profile.user_id.not_in(my_follows),
                or_(Profile.user_id.in_(group_mates), Profile.user_id.in_(friends_of)),
                Profile.visibility != "private",
                social_ok_clause(),
                not_blocked_clause(user.id, Profile.user_id),
            )
            .limit(12)
        )
    ).all()
    return [person(p, s) for p, s in rows]


@router.get("/people/{handle}")
async def view_person(
    handle: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    profile = await _profile_by_handle(db, handle)
    me = profile.user_id == user.id
    if not me:
        viewer = await get_profile(db, user.id)
        if (
            not viewer.social_allowed(utcnow().year)
            or await is_blocked(db, user.id, profile.user_id)
            or not profile.social_allowed(utcnow().year)
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such person")
    visible = me or await can_see(db, user.id, profile)
    rel = await _relationship(db, user.id, profile.user_id) if not me else None
    counts = {
        "followers": (
            await db.execute(
                select(func.count()).where(
                    Follow.followee_id == profile.user_id, Follow.status == "accepted"
                )
            )
        ).scalar_one(),
        "following": (
            await db.execute(
                select(func.count()).where(
                    Follow.follower_id == profile.user_id, Follow.status == "accepted"
                )
            )
        ).scalar_one(),
    }
    stats = (
        await db.execute(select(UserStats).where(UserStats.user_id == profile.user_id))
    ).scalar_one_or_none()
    data = person(profile, stats) | {
        "bio": profile.bio,
        "me": me,
        "visible": visible,
        "relationship": rel,
        "counts": counts,
    }
    if not visible:
        return data

    snap = await snapshot(db, profile.user_id)
    await db.commit()
    badges = (
        (
            await db.execute(
                select(UserAchievement)
                .where(UserAchievement.user_id == profile.user_id)
                .order_by(UserAchievement.unlocked_on.desc())
                .limit(12)
            )
        )
        .scalars()
        .all()
    )
    from app.game.achievements import RULE_BY_ID

    main = snap.chains[0]
    data |= {
        "streak": {
            k: v
            for k, v in chain_payload(main).items()
            if k in ("current", "longest", "this_week_days", "this_week_target", "weeks")
        },
        "heatmap": [{"date": h["date"], "level": h["level"]} for h in snap.heatmap],
        "totals": {"sessions": snap.sessions, "active_days": len(snap.days)},
        "achievements": [
            {
                "id": b.achievement_id,
                "title": RULE_BY_ID[b.achievement_id].title,
                "tier": b.tier,
                "date": b.unlocked_on.isoformat(),
            }
            for b in badges
            if b.achievement_id in RULE_BY_ID and profile.gamification_enabled
        ],
        "level": snap.level if profile.gamification_enabled else None,
    }
    return data


@router.get("/people/{handle}/events")
async def person_events(
    handle: str,
    before: datetime | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    profile = await _profile_by_handle(db, handle)
    if not await can_see(db, user.id, profile):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such person")
    return await _feed_page(db, user.id, [profile.user_id], before)


@router.post("/people/{handle}/follow")
async def follow(
    handle: str,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    me = await require_social(db, user)
    await enforce("follow", user.id, 60, 3600)
    target = await _profile_by_handle(db, handle)
    if target.user_id == user.id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "You cannot follow yourself")
    if (
        await is_blocked(db, user.id, target.user_id)
        or not target.social_allowed(utcnow().year)
        or target.visibility == "private"
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such person")

    existing = (
        await db.execute(
            select(Follow).where(
                Follow.follower_id == user.id, Follow.followee_id == target.user_id
            )
        )
    ).scalar_one_or_none()
    if existing:
        return {"status": existing.status}
    accepted = target.visibility == "public"
    db.add(
        Follow(
            follower_id=user.id,
            followee_id=target.user_id,
            status="accepted" if accepted else "pending",
            accepted_at=utcnow() if accepted else None,
        )
    )
    name = me.display_name or f"@{me.handle}"
    nid = await notify(
        db,
        target.user_id,
        kind="new_follower" if accepted else "follow_request",
        category="social",
        title=f"{name} followed you" if accepted else f"{name} wants to follow you",
        url=f"/u/{me.handle}" if accepted else "/people?tab=requests",
        actor_id=user.id,
        dedupe_key=f"follow:{user.id}",
    )
    await db.commit()
    background.add_task(deliver, [nid] if nid else [])
    return {"status": "accepted" if accepted else "pending"}


@router.delete("/people/{handle}/follow", status_code=204)
async def unfollow(
    handle: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    target = await _profile_by_handle(db, handle)
    await db.execute(
        delete(Follow).where(Follow.follower_id == user.id, Follow.followee_id == target.user_id)
    )
    await db.commit()


@router.delete("/people/{handle}/follower", status_code=204)
async def remove_follower(
    handle: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Remove someone from your followers without blocking them."""
    target = await _profile_by_handle(db, handle)
    await db.execute(
        delete(Follow).where(Follow.follower_id == target.user_id, Follow.followee_id == user.id)
    )
    await db.commit()


@router.get("/people/{handle}/followers")
async def followers(
    handle: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return await _follow_list(db, user, handle, incoming=True)


@router.get("/people/{handle}/following")
async def following(
    handle: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return await _follow_list(db, user, handle, incoming=False)


async def _follow_list(db: AsyncSession, user: User, handle: str, incoming: bool) -> list[dict]:
    profile = await _profile_by_handle(db, handle)
    if not await can_see(db, user.id, profile):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such person")
    join_col = Follow.follower_id if incoming else Follow.followee_id
    anchor = Follow.followee_id if incoming else Follow.follower_id
    rows = (
        await db.execute(
            select(Profile, UserStats)
            .join(Follow, join_col == Profile.user_id)
            .outerjoin(UserStats, UserStats.user_id == Profile.user_id)
            .where(
                anchor == profile.user_id,
                Follow.status == "accepted",
                social_ok_clause(),
                not_blocked_clause(user.id, Profile.user_id),
            )
            .order_by(Follow.accepted_at.desc())
            .limit(200)
        )
    ).all()
    return [person(p, s) for p, s in rows]


@router.get("/me/follow-requests")
async def follow_requests(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    rows = (
        await db.execute(
            select(Follow, Profile)
            .join(Profile, Profile.user_id == Follow.follower_id)
            .where(Follow.followee_id == user.id, Follow.status == "pending", social_ok_clause())
            .order_by(Follow.created_at.desc())
        )
    ).all()
    return [person(p, request_id=str(f.id), requested_at=f.created_at.isoformat()) for f, p in rows]


@router.post("/me/follow-requests/{request_id}/{decision}")
async def answer_request(
    request_id: UUID,
    decision: str,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if decision not in ("accept", "decline"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    request = await db.get(Follow, request_id)
    if request is None or request.followee_id != user.id or request.status != "pending":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    nid = None
    if decision == "accept":
        request.status = "accepted"
        request.accepted_at = utcnow()
        me = await get_profile(db, user.id)
        nid = await notify(
            db,
            request.follower_id,
            kind="follow_accepted",
            category="social",
            title=f"{me.display_name or '@' + (me.handle or '')} accepted your follow request",
            url=f"/u/{me.handle}",
            actor_id=user.id,
            dedupe_key=f"follow_accepted:{user.id}",
        )
    else:
        await db.delete(request)
    await db.commit()
    background.add_task(deliver, [nid] if nid else [])
    return {"status": decision}


@router.post("/people/{handle}/block", status_code=204)
async def block(
    handle: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    target = await _profile_by_handle(db, handle)
    if target.user_id == user.id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "You cannot block yourself")
    already = (
        await db.execute(
            select(Block.id).where(Block.blocker_id == user.id, Block.blocked_id == target.user_id)
        )
    ).scalar_one_or_none()
    if already is None:
        db.add(Block(blocker_id=user.id, blocked_id=target.user_id))
    # A block severs the follow graph both ways.
    await db.execute(
        delete(Follow).where(
            or_(
                and_(Follow.follower_id == user.id, Follow.followee_id == target.user_id),
                and_(Follow.follower_id == target.user_id, Follow.followee_id == user.id),
            )
        )
    )
    await db.commit()


@router.delete("/people/{handle}/block", status_code=204)
async def unblock(
    handle: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    target = await _profile_by_handle(db, handle)
    await db.execute(
        delete(Block).where(Block.blocker_id == user.id, Block.blocked_id == target.user_id)
    )
    await db.commit()


@router.get("/me/blocks")
async def my_blocks(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = (
        (
            await db.execute(
                select(Profile)
                .join(Block, Block.blocked_id == Profile.user_id)
                .where(Block.blocker_id == user.id)
            )
        )
        .scalars()
        .all()
    )
    return [person(p) for p in rows]


# --- feed --------------------------------------------------------------------------------


async def _feed_page(
    db: AsyncSession, viewer: UUID, authors: list[UUID] | None, before: datetime | None
) -> dict:
    kudos_count = select(func.count()).where(Kudos.event_id == ActivityEvent.id).scalar_subquery()
    comment_count = (
        select(func.count())
        .where(Comment.event_id == ActivityEvent.id, Comment.hidden_at.is_(None))
        .scalar_subquery()
    )
    mine = (
        select(func.count())
        .where(Kudos.event_id == ActivityEvent.id, Kudos.user_id == viewer)
        .scalar_subquery()
    )
    stmt = (
        select(ActivityEvent, Profile, kudos_count, comment_count, mine)
        .join(Profile, Profile.user_id == ActivityEvent.user_id)
        .where(ActivityEvent.hidden_at.is_(None), can_see_clause(viewer))
    )
    if authors is not None:
        stmt = stmt.where(ActivityEvent.user_id.in_(authors))
    else:
        followees = select(Follow.followee_id).where(
            Follow.follower_id == viewer, Follow.status == "accepted"
        )
        stmt = stmt.where(
            or_(ActivityEvent.user_id == viewer, ActivityEvent.user_id.in_(followees))
        )
    if before is not None:
        stmt = stmt.where(ActivityEvent.created_at < before)
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
                "comments": c,
                "kudoed": bool(m),
                "mine": e.user_id == viewer,
            }
            for e, p, k, c, m in rows
        ],
        "next": rows[-1][0].created_at.isoformat() if more else None,
    }


@router.get("/feed")
async def feed(
    before: datetime | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_profile(db, user.id)
    return await _feed_page(db, user.id, None, before)


async def _visible_event(db: AsyncSession, viewer: UUID, event_id: UUID) -> ActivityEvent:
    row = (
        await db.execute(
            select(ActivityEvent)
            .join(Profile, Profile.user_id == ActivityEvent.user_id)
            .where(
                ActivityEvent.id == event_id,
                ActivityEvent.hidden_at.is_(None),
                can_see_clause(viewer),
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return row


@router.post("/events/{event_id}/kudos")
async def give_kudos(
    event_id: UUID,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    me = await require_social(db, user)
    await enforce("kudos", user.id, 300, 3600)
    event = await _visible_event(db, user.id, event_id)
    exists_ = (
        await db.execute(
            select(Kudos.id).where(Kudos.event_id == event_id, Kudos.user_id == user.id)
        )
    ).scalar_one_or_none()
    nid = None
    if not exists_:
        db.add(Kudos(event_id=event_id, user_id=user.id))
        if event.user_id != user.id:
            nid = await notify(
                db,
                event.user_id,
                kind="kudos",
                category="social",
                title=f"{me.display_name or '@' + (me.handle or '')} gave you kudos",
                url=f"/feed/{event_id}",
                actor_id=user.id,
                dedupe_key=f"kudos:{event_id}:{user.id}",
            )
    await db.commit()
    background.add_task(deliver, [nid] if nid else [])
    count = (await db.execute(select(func.count()).where(Kudos.event_id == event_id))).scalar_one()
    return {"kudos": count, "kudoed": True}


@router.delete("/events/{event_id}/kudos")
async def take_kudos(
    event_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await db.execute(delete(Kudos).where(Kudos.event_id == event_id, Kudos.user_id == user.id))
    await db.commit()
    count = (await db.execute(select(func.count()).where(Kudos.event_id == event_id))).scalar_one()
    return {"kudos": count, "kudoed": False}


@router.get("/events/{event_id}")
async def get_event(
    event_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await _visible_event(db, user.id, event_id)
    page = await _feed_page(db, user.id, None, None)
    match = next((e for e in page["events"] if e["id"] == str(event_id)), None)
    if match is None:
        # Not in the viewer's own feed window (e.g. opened from a profile).
        event = await db.get(ActivityEvent, event_id)
        author = await get_profile(db, event.user_id)
        k = (await db.execute(select(func.count()).where(Kudos.event_id == event_id))).scalar_one()
        mine = (
            await db.execute(
                select(Kudos.id).where(Kudos.event_id == event_id, Kudos.user_id == user.id)
            )
        ).scalar_one_or_none()
        match = {
            "id": str(event.id),
            "kind": event.kind,
            "data": event.data,
            "date": event.occurred_on.isoformat(),
            "created_at": event.created_at.isoformat(),
            "author": person(author),
            "kudos": k,
            "comments": 0,
            "kudoed": bool(mine),
            "mine": event.user_id == user.id,
        }
    kudos_people = (
        (
            await db.execute(
                select(Profile)
                .join(Kudos, Kudos.user_id == Profile.user_id)
                .where(Kudos.event_id == event_id, can_see_clause(user.id))
                .order_by(Kudos.created_at.desc())
                .limit(50)
            )
        )
        .scalars()
        .all()
    )
    match["kudos_by"] = [person(p) for p in kudos_people]
    return match


@router.delete("/events/{event_id}", status_code=204)
async def delete_event(
    event_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Remove one of your own events from every feed."""
    event = await db.get(ActivityEvent, event_id)
    if event is None or event.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await db.delete(event)
    await db.commit()


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=280)

    @field_validator("body")
    @classmethod
    def _clean(cls, v: str) -> str:
        v = clean_text(v)
        if not v:
            raise ValueError("Say something")
        return v


@router.get("/events/{event_id}/comments")
async def list_comments(
    event_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    event = await _visible_event(db, user.id, event_id)
    rows = (
        await db.execute(
            select(Comment, Profile)
            .join(Profile, Profile.user_id == Comment.author_id)
            .where(
                Comment.event_id == event_id,
                Comment.hidden_at.is_(None),
                social_ok_clause(),
                not_blocked_clause(user.id, Comment.author_id),
            )
            .order_by(Comment.created_at)
            .limit(200)
        )
    ).all()
    return [
        {
            "id": str(c.id),
            "body": c.body,
            "created_at": c.created_at.isoformat(),
            "author": person(p),
            "can_delete": c.author_id == user.id or event.user_id == user.id,
            "mine": c.author_id == user.id,
        }
        for c, p in rows
    ]


@router.post("/events/{event_id}/comments", status_code=201)
async def add_comment(
    event_id: UUID,
    body: CommentIn,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    me = await require_social(db, user)
    await enforce("comment", user.id, 30, 3600)
    event = await _visible_event(db, user.id, event_id)
    comment = Comment(event_id=event_id, author_id=user.id, body=body.body)
    db.add(comment)
    await db.flush()
    nid = None
    if event.user_id != user.id:
        nid = await notify(
            db,
            event.user_id,
            kind="comment",
            category="social",
            title=f"{me.display_name or '@' + (me.handle or '')} commented",
            body=body.body[:140],
            url=f"/feed/{event_id}",
            actor_id=user.id,
        )
    await db.commit()
    background.add_task(deliver, [nid] if nid else [])
    return {
        "id": str(comment.id),
        "body": comment.body,
        "created_at": comment.created_at.isoformat()
        if comment.created_at
        else utcnow().isoformat(),
        "author": person(me),
        "can_delete": True,
        "mine": True,
    }


@router.delete("/comments/{comment_id}", status_code=204)
async def delete_comment(
    comment_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    comment = await db.get(Comment, comment_id)
    if comment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    event = await db.get(ActivityEvent, comment.event_id)
    if comment.author_id != user.id and (event is None or event.user_id != user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await db.delete(comment)
    await db.commit()


# --- reports -------------------------------------------------------------------------------


class ReportIn(BaseModel):
    target_type: str = Field(pattern="^(user|comment|event|group|challenge)$")
    target_id: str = Field(min_length=1, max_length=64)
    reason: str = Field(pattern="^(spam|harassment|inappropriate|impersonation|self_harm|other)$")
    detail: str | None = Field(default=None, max_length=500)


@router.post("/reports", status_code=201)
async def report(
    body: ReportIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await get_profile(db, user.id)
    await enforce("report", user.id, 20, 3600)
    reported_user: UUID | None = None
    snapshot_data: dict | None = None
    try:
        if body.target_type == "user":
            target = await _profile_by_handle(db, body.target_id)
            reported_user = target.user_id
            snapshot_data = {
                "handle": target.handle,
                "display_name": target.display_name,
                "bio": target.bio,
            }
        else:
            tid = UUID(body.target_id)
            if body.target_type == "comment":
                comment = await db.get(Comment, tid)
                if comment:
                    reported_user, snapshot_data = comment.author_id, {"body": comment.body}
            elif body.target_type == "event":
                event = await db.get(ActivityEvent, tid)
                if event:
                    reported_user, snapshot_data = (
                        event.user_id,
                        {"kind": event.kind, "data": event.data},
                    )
            elif body.target_type == "group":
                group = await db.get(Group, tid)
                if group:
                    reported_user, snapshot_data = (
                        group.owner_id,
                        {"name": group.name, "description": group.description},
                    )
            elif body.target_type == "challenge":
                challenge = await db.get(Challenge, tid)
                if challenge:
                    reported_user, snapshot_data = (
                        challenge.creator_id,
                        {"title": challenge.title, "description": challenge.description},
                    )
    except ValueError as err:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found") from err
    if snapshot_data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    db.add(
        Report(
            reporter_id=user.id,
            reported_user_id=reported_user,
            target_type=body.target_type,
            target_id=body.target_id,
            reason=body.reason,
            detail=clean_text(body.detail) if body.detail else None,
            snapshot=snapshot_data,
        )
    )
    await db.commit()
    return {"detail": "Thanks - a moderator will look at it."}
