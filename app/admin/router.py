"""Moderation and administration.

Moderators review reports and act on content and social privileges.
Admins can also change roles and deactivate accounts. Every action writes the
audit log, which nothing ever updates or deletes.

Suspension removes social privileges only. A suspended person can still log,
see their own history and export it: the training log is theirs, and
moderation is about what they show other people.
"""

from datetime import timedelta
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.account.models import AuditLog
from app.auth.dependencies import get_current_user
from app.auth.models import User, UserRole
from app.auth.service import finish_revoke_all, revoke_all_sessions
from app.common.time import utcnow
from app.database import get_db
from app.game.models import UserStats
from app.groups.models import Challenge, Group
from app.notifications.service import deliver, notify
from app.ops.health import worker_state
from app.profile.models import Profile
from app.profile.router import _check_handle, _handle_taken, is_reserved, mentions_brand
from app.social.models import ActivityEvent, Comment, Report
from app.training.models import Workout

router = APIRouter(prefix="/admin", tags=["admin"])


def _role(user: User) -> str:
    return user.role.value if hasattr(user.role, "value") else str(user.role)


async def require_moderator(user: User = Depends(get_current_user)) -> User:
    if _role(user) not in ("moderator", "admin"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if _role(user) != "admin":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return user


async def audit(
    db: AsyncSession,
    actor: User,
    action: str,
    target_type: str | None,
    target_id: str | None,
    detail: dict | None = None,
) -> None:
    db.add(
        AuditLog(
            actor_id=actor.id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            detail=detail,
        )
    )


def _who(p: Profile | None, u: User | None = None) -> dict | None:
    if p is None and u is None:
        return None
    return {
        "id": str(p.user_id if p else u.id),
        "handle": p.handle if p else None,
        "display_name": p.display_name if p else None,
        "email": u.email if u else None,
        "suspended": bool(p and p.social_suspended_at),
    }


@router.get("/reports")
async def reports(
    report_status: str = Query(
        default="open", alias="status", pattern="^(open|actioned|dismissed)$"
    ),
    mod: User = Depends(require_moderator),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        (
            await db.execute(
                select(Report)
                .where(Report.status == report_status)
                .order_by(Report.created_at.desc())
                .limit(200)
            )
        )
        .scalars()
        .all()
    )
    ids = {r.reporter_id for r in rows} | {r.reported_user_id for r in rows if r.reported_user_id}
    profiles = {
        p.user_id: p
        for p in (await db.execute(select(Profile).where(Profile.user_id.in_(ids)))).scalars()
    }
    prior = {
        uid: n
        for uid, n in (
            await db.execute(
                select(Report.reported_user_id, func.count())
                .where(Report.reported_user_id.in_(ids), Report.status == "actioned")
                .group_by(Report.reported_user_id)
            )
        ).all()
    }
    return [
        {
            "id": str(r.id),
            "target_type": r.target_type,
            "target_id": r.target_id,
            "reason": r.reason,
            "detail": r.detail,
            "snapshot": r.snapshot,
            "status": r.status,
            "created_at": r.created_at.isoformat(),
            "resolution": r.resolution,
            "reporter": _who(profiles.get(r.reporter_id)),
            "reported": _who(profiles.get(r.reported_user_id)) if r.reported_user_id else None,
            "prior_actioned": prior.get(r.reported_user_id, 0),
        }
        for r in rows
    ]


class ResolveIn(BaseModel):
    action: str = Field(pattern="^(dismiss|hide_content|suspend_user|hide_and_suspend)$")
    note: str | None = Field(default=None, max_length=200)


@router.post("/reports/{report_id}/resolve")
async def resolve(
    report_id: UUID,
    body: ResolveIn,
    background: BackgroundTasks,
    mod: User = Depends(require_moderator),
    db: AsyncSession = Depends(get_db),
):
    report = await db.get(Report, report_id)
    if report is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    now = utcnow()
    hidden = suspended = False
    if body.action in ("hide_content", "hide_and_suspend") and report.target_type != "user":
        model = {
            "comment": Comment,
            "event": ActivityEvent,
            "group": Group,
            "challenge": Challenge,
        }[report.target_type]
        target = await db.get(model, UUID(report.target_id))
        if target is not None:
            target.hidden_at = now
            hidden = True
    if body.action in ("suspend_user", "hide_and_suspend") and report.reported_user_id:
        profile = (
            await db.execute(select(Profile).where(Profile.user_id == report.reported_user_id))
        ).scalar_one_or_none()
        if profile is not None:
            profile.social_suspended_at = now
            profile.leaderboard_opt_in = False
            suspended = True
    report.status = "dismissed" if body.action == "dismiss" else "actioned"
    report.resolved_by = mod.id
    report.resolved_at = now
    report.resolution = body.note or body.action

    # Close sibling reports about the same thing, so one pile-on is one decision.
    siblings = (
        (
            await db.execute(
                select(Report).where(
                    Report.target_type == report.target_type,
                    Report.target_id == report.target_id,
                    Report.status == "open",
                    Report.id != report.id,
                )
            )
        )
        .scalars()
        .all()
    )
    for s in siblings:
        s.status, s.resolved_by, s.resolved_at = report.status, mod.id, now
        s.resolution = f"grouped with {report.id}"

    nid = None
    if report.reported_user_id and (hidden or suspended):
        what = "Some of your content was removed" if hidden else "Your social features are paused"
        nid = await notify(
            db,
            report.reported_user_id,
            kind="moderation",
            category="security",
            title=what,
            body="A moderator reviewed a report. Your training log is unaffected and "
            "still yours to use and export.",
            url="/settings/privacy",
        )
    await audit(
        db,
        mod,
        f"report.{body.action}",
        report.target_type,
        report.target_id,
        {"report": str(report.id), "note": body.note, "grouped": len(siblings)},
    )
    await db.commit()
    background.add_task(deliver, [nid] if nid else [])
    return {"status": report.status, "grouped": len(siblings)}


@router.get("/users")
async def users(
    q: str = Query(default="", max_length=100),
    mod: User = Depends(require_moderator),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(User, Profile).outerjoin(Profile, Profile.user_id == User.id)
    if q:
        term = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(User.email.ilike(term), Profile.handle.ilike(term)))
    rows = (await db.execute(stmt.order_by(User.created_at.desc()).limit(100))).all()
    counts = {
        uid: n
        for uid, n in (
            await db.execute(
                select(Report.reported_user_id, func.count())
                .where(Report.reported_user_id.in_([u.id for u, _ in rows]))
                .group_by(Report.reported_user_id)
            )
        ).all()
    }
    return [
        {
            "id": str(u.id),
            "email": u.email,
            "handle": p.handle if p else None,
            "display_name": p.display_name if p else None,
            "role": _role(u),
            "is_active": u.is_active,
            "is_verified": u.is_verified,
            "created_at": u.created_at.isoformat(),
            "social_suspended": bool(p and p.social_suspended_at),
            "official": bool(p and p.is_official),
            "deletion_scheduled_at": p.deletion_scheduled_at.isoformat()
            if p and p.deletion_scheduled_at
            else None,
            "reports": counts.get(u.id, 0),
        }
        for u, p in rows
    ]


class UserPatch(BaseModel):
    role: str | None = Field(default=None, pattern="^(user|moderator|admin)$")
    social_suspended: bool | None = None
    is_active: bool | None = None


@router.patch("/users/{user_id}")
async def update_user(
    user_id: UUID,
    body: UserPatch,
    mod: User = Depends(require_moderator),
    db: AsyncSession = Depends(get_db),
):
    target = await db.get(User, user_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if (body.role is not None or body.is_active is not None) and _role(mod) != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admins only")
    if target.id == mod.id and (body.role is not None or body.is_active is False):
        raise HTTPException(status.HTTP_409_CONFLICT, "Not on your own account")
    changes: dict = {}
    if body.role is not None:
        target.role = UserRole(body.role)
        changes["role"] = body.role
    if body.social_suspended is not None:
        profile = (
            await db.execute(select(Profile).where(Profile.user_id == user_id))
        ).scalar_one_or_none()
        if profile is not None:
            profile.social_suspended_at = utcnow() if body.social_suspended else None
            if body.social_suspended:
                profile.leaderboard_opt_in = False
            changes["social_suspended"] = body.social_suspended
    if body.is_active is not None:
        target.is_active = body.is_active
        changes["is_active"] = body.is_active
        if not body.is_active:
            await revoke_all_sessions(db, target)
    await audit(db, mod, "user.update", "user", str(user_id), changes)
    await db.commit()
    await finish_revoke_all(user_id)
    return {"ok": True, **changes}


class OfficialIn(BaseModel):
    official: bool
    # Granting: the handle the official account should hold (reserved handles
    # such as "pacestreak" are allowed here and nowhere else). Revoking while
    # holding a reserved handle: the ordinary handle to move it to.
    handle: str | None = Field(default=None, max_length=31)


@router.post("/users/{user_id}/official")
async def set_official(
    user_id: UUID,
    body: OfficialIn,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Mark an account as PaceStreak's own. This is the only path by which a
    reserved handle can be assigned, so the reservation itself never has to be
    loosened, and every use of it is in the audit log."""
    profile = (
        await db.execute(select(Profile).where(Profile.user_id == user_id))
    ).scalar_one_or_none()
    if profile is None or profile.onboarded_at is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    handle = None
    if body.handle is not None:
        handle = _check_handle(body.handle, allow_reserved=body.official)
        if await _handle_taken(db, handle, user_id):
            raise HTTPException(status.HTTP_409_CONFLICT, "That handle is taken")
    if not body.official and handle is None and profile.handle and is_reserved(profile.handle):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This account holds a reserved handle; give it an ordinary one to revoke",
        )

    before = {"official": profile.is_official, "handle": profile.handle}
    profile.is_official = body.official
    if handle is not None:
        profile.handle = handle
    if not body.official and profile.display_name and mentions_brand(profile.display_name):
        profile.display_name = None
    await audit(
        db,
        admin,
        "user.official",
        "user",
        str(user_id),
        {"before": before, "after": {"official": profile.is_official, "handle": profile.handle}},
    )
    await db.commit()
    return {"official": profile.is_official, "handle": profile.handle}


class MergeIn(BaseModel):
    into: UUID
    # The source account's email, typed back: the source is deleted.
    confirm_email: str = Field(min_length=3, max_length=320)
    keep_source_profile: bool = False


@router.post("/users/{user_id}/merge")
async def merge_user(
    user_id: UUID,
    body: MergeIn,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Move everything one account owns into another and delete it. For an
    owner consolidating two of their own accounts; never between people."""
    from app.admin.merge import merge_accounts
    from app.auth.cache import invalidate_user
    from app.game.service import recompute

    if user_id == body.into:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Pick two different accounts")
    if user_id == admin.id:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Sign in as another admin to merge this account away"
        )
    source = await db.get(User, user_id)
    dest = await db.get(User, body.into)
    if source is None or dest is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if body.confirm_email.strip().lower() != source.email.lower():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Type the source account's email to confirm"
        )
    source_email = source.email
    moved = await merge_accounts(db, user_id, body.into, body.keep_source_profile)
    await audit(
        db,
        admin,
        "user.merge",
        "user",
        str(body.into),
        {"source": str(user_id), "source_email": source_email, "moved": moved},
    )
    await db.commit()
    await recompute(db, body.into, notify=False)
    await db.commit()
    for uid in (user_id, body.into):
        await invalidate_user(uid)
    return {"merged_into": str(body.into), "moved": moved}


@router.get("/audit")
async def audit_log(mod: User = Depends(require_moderator), db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(AuditLog, Profile)
            .outerjoin(Profile, Profile.user_id == AuditLog.actor_id)
            .order_by(AuditLog.created_at.desc())
            .limit(200)
        )
    ).all()
    return [
        {
            "id": str(a.id),
            "action": a.action,
            "target_type": a.target_type,
            "target_id": a.target_id,
            "detail": a.detail,
            "created_at": a.created_at.isoformat(),
            "actor": p.handle if p else None,
        }
        for a, p in rows
    ]


@router.get("/metrics")
async def metrics(mod: User = Depends(require_moderator), db: AsyncSession = Depends(get_db)):
    today = utcnow().date()

    async def count(*where) -> int:
        return (await db.execute(select(func.count()).where(*where))).scalar_one()

    signups = (
        await db.execute(
            select(func.date_trunc("week", User.created_at).label("w"), func.count())
            .where(User.created_at >= utcnow() - timedelta(weeks=12))
            .group_by("w")
            .order_by("w")
        )
    ).all()
    return {
        "users": await count(User.id.is_not(None)),
        "onboarded": await count(Profile.onboarded_at.is_not(None)),
        "active_1d": await count(UserStats.last_active >= today - timedelta(days=1)),
        "active_7d": await count(UserStats.last_active >= today - timedelta(days=7)),
        "active_30d": await count(UserStats.last_active >= today - timedelta(days=30)),
        "sessions_7d": await count(
            Workout.deleted_at.is_(None), Workout.local_date >= today - timedelta(days=7)
        ),
        "open_reports": await count(Report.status == "open"),
        "suspended": await count(Profile.social_suspended_at.is_not(None)),
        "signups_by_week": [{"week": w.date().isoformat(), "count": n} for w, n in signups],
        "worker": await worker_state(),
    }
