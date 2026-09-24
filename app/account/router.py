"""Leaving with your data, bringing it back, and leaving for good."""

import csv
import io
import json
import zipfile
from datetime import UTC, timedelta
from uuid import UUID, uuid4

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.account import service as security
from app.account.models import SecurityEvent
from app.auth.dependencies import get_current_db_user, get_current_user
from app.auth.models import User
from app.auth.security import verify_password
from app.auth.service import finish_revoke_all, revoke_all_sessions
from app.common.limits import enforce
from app.common.time import local_date, utcnow
from app.config import get_settings
from app.database import get_db
from app.game.models import PersonalRecord, UserAchievement
from app.game.service import recompute
from app.groups.models import Challenge, ChallengeParticipant, Group, GroupMember
from app.notifications.models import NotificationPreference
from app.notifications.service import deliver, notify
from app.profile.router import profile_out
from app.profile.service import get_chains, get_profile
from app.social.models import Block, Comment, Follow
from app.training.library import CUSTOM_PREFIX, DISCIPLINE_IDS, EXERCISE_BY_ID
from app.training.models import (
    BodyMetric,
    CustomExercise,
    Routine,
    StreakRepair,
    Workout,
    WorkoutSet,
)

router = APIRouter(prefix="/me", tags=["account"])
settings = get_settings()

EXPORT_VERSION = 1
MAX_IMPORT_BYTES = 25 * 1024 * 1024
MAX_IMPORT_WORKOUTS = 25_000


def _iso(v):
    return v.isoformat() if v is not None else None


async def _workouts(db: AsyncSession, user_id: UUID) -> list[Workout]:
    return (
        (
            await db.execute(
                select(Workout)
                .where(Workout.user_id == user_id, Workout.deleted_at.is_(None))
                .order_by(Workout.started_at)
            )
        )
        .scalars()
        .all()
    )


def _names(customs: list[CustomExercise]) -> dict[str, str]:
    return {e.id: e.name for e in EXERCISE_BY_ID.values()} | {
        c.exercise_id: c.name for c in customs
    }


async def build_export(db: AsyncSession, user: User) -> dict:
    uid = user.id
    profile = await get_profile(db, uid)
    chains = await get_chains(db, profile)
    customs = (
        (await db.execute(select(CustomExercise).where(CustomExercise.user_id == uid)))
        .scalars()
        .all()
    )
    workouts = await _workouts(db, uid)

    async def all_of(model, *where):
        return (await db.execute(select(model).where(*where))).scalars().all()

    follows = (
        (
            await db.execute(
                select(Follow).where(or_(Follow.follower_id == uid, Follow.followee_id == uid))
            )
        )
        .scalars()
        .all()
    )
    from app.profile.models import Profile

    handles = {
        p.user_id: p.handle
        for p in (
            await db.execute(
                select(Profile).where(
                    Profile.user_id.in_(
                        [f.follower_id for f in follows] + [f.followee_id for f in follows]
                    )
                )
            )
        ).scalars()
    }
    memberships = (
        await db.execute(
            select(GroupMember, Group)
            .join(Group, Group.id == GroupMember.group_id)
            .where(GroupMember.user_id == uid)
        )
    ).all()
    challenges = (
        await db.execute(
            select(ChallengeParticipant, Challenge)
            .join(Challenge, Challenge.id == ChallengeParticipant.challenge_id)
            .where(ChallengeParticipant.user_id == uid)
        )
    ).all()
    prefs = (
        await db.execute(
            select(NotificationPreference.channels).where(NotificationPreference.user_id == uid)
        )
    ).scalar_one_or_none()

    return {
        "format": "pacestreak-export",
        "version": EXPORT_VERSION,
        "exported_at": utcnow().isoformat(),
        "account": {
            "email": user.email,
            "created_at": _iso(user.created_at),
            "email_verified": user.is_verified,
            "two_factor": user.totp_enabled,
        },
        "profile": profile_out(profile) | {"accepted_terms_at": _iso(profile.accepted_terms_at)},
        "chains": [
            {
                "id": str(c.id),
                "name": c.name,
                "disciplines": c.disciplines,
                "target_history": c.target_history,
            }
            for c in chains
        ],
        "repairs": [
            {"chain_id": str(r.chain_id), "week_start": r.week_start.isoformat(), "month": r.month}
            for r in await all_of(StreakRepair, StreakRepair.user_id == uid)
        ],
        "custom_exercises": [
            {
                "id": c.exercise_id,
                "name": c.name,
                "pattern": c.pattern,
                "equipment": c.equipment,
                "primary": c.primary,
                "secondary": c.secondary,
                "load_type": c.load_type,
                "rest_sec": c.rest_sec,
                "unilateral": c.unilateral,
                "cue": c.cue,
                "archived": c.archived,
            }
            for c in customs
        ],
        "workouts": [
            {
                "id": str(w.id),
                "discipline": w.discipline,
                "title": w.title,
                "notes": w.notes,
                "started_at": w.started_at.isoformat(),
                "local_date": w.local_date.isoformat(),
                "duration_sec": w.duration_sec,
                "distance_m": w.distance_m,
                "elevation_m": w.elevation_m,
                "effort": w.effort,
                "feel": w.feel,
                "routine_id": str(w.routine_id) if w.routine_id else None,
                "source": w.source,
                "sets": [
                    {
                        "exercise_id": s.exercise_id,
                        "position": s.position,
                        "set_index": s.set_index,
                        "kind": s.kind,
                        "weight_kg": s.weight_kg,
                        "reps": s.reps,
                        "rpe": s.rpe,
                        "duration_sec": s.duration_sec,
                        "distance_m": s.distance_m,
                        "completed": s.completed,
                    }
                    for s in w.sets
                ],
            }
            for w in workouts
        ],
        "routines": [
            {
                "id": str(r.id),
                "name": r.name,
                "discipline": r.discipline,
                "notes": r.notes,
                "items": r.items,
            }
            for r in await all_of(Routine, Routine.user_id == uid)
        ],
        "body_metrics": [
            {
                "date": m.measured_on.isoformat(),
                "weight_kg": m.weight_kg,
                "body_fat_pct": m.body_fat_pct,
                "waist_cm": m.waist_cm,
                "resting_hr": m.resting_hr,
                "sleep_hours": m.sleep_hours,
                "note": m.note,
            }
            for m in await all_of(BodyMetric, BodyMetric.user_id == uid)
        ],
        "achievements": [
            {"id": a.achievement_id, "tier": a.tier, "unlocked_on": a.unlocked_on.isoformat()}
            for a in await all_of(UserAchievement, UserAchievement.user_id == uid)
        ],
        "personal_records": [
            {
                "key": r.key,
                "value": r.value,
                "previous": r.previous,
                "date": r.achieved_on.isoformat(),
                "current": r.is_current,
            }
            for r in await all_of(PersonalRecord, PersonalRecord.user_id == uid)
        ],
        "social": {
            "following": [
                handles.get(f.followee_id)
                for f in follows
                if f.follower_id == uid and f.status == "accepted"
            ],
            "followers": [
                handles.get(f.follower_id)
                for f in follows
                if f.followee_id == uid and f.status == "accepted"
            ],
            "blocked": len(await all_of(Block, Block.blocker_id == uid)),
            "comments": [
                {
                    "id": str(c.id),
                    "event_id": str(c.event_id),
                    "body": c.body,
                    "created_at": _iso(c.created_at),
                }
                for c in await all_of(Comment, Comment.author_id == uid)
            ],
            "groups": [
                {
                    "name": g.name,
                    "role": m.role,
                    "joined_at": _iso(m.created_at),
                    "shares_with_coach": m.shares_with_coach,
                }
                for m, g in memberships
            ],
            "challenges": [
                {
                    "title": c.title,
                    "starts_on": c.starts_on.isoformat(),
                    "ends_on": c.ends_on.isoformat(),
                    "final_score": p.final_score,
                    "final_rank": p.final_rank,
                }
                for p, c in challenges
            ],
        },
        "notification_preferences": prefs or {},
    }


@router.get("/export")
async def export(
    request: Request,
    format: str = Query(default="json", pattern="^(json|csv|ics)$"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await enforce("export", user.id, 20, 3600)
    stamp = utcnow().strftime("%Y-%m-%d")
    await security.record(db, user.id, "data_exported", request, {"format": format})
    if format == "json":
        payload = await build_export(db, user)
        await db.commit()
        return Response(
            json.dumps(payload, indent=2, ensure_ascii=False),
            media_type="application/json",
            headers={
                "Content-Disposition": f'attachment; filename="pacestreak-{stamp}.json"',
                "Cache-Control": "private, no-store",
            },
        )

    customs = (
        (await db.execute(select(CustomExercise).where(CustomExercise.user_id == user.id)))
        .scalars()
        .all()
    )
    names = _names(list(customs))
    workouts = await _workouts(db, user.id)
    await db.commit()

    if format == "ics":
        lines = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//PaceStreak//Export//EN",
            "CALSCALE:GREGORIAN",
        ]
        for w in workouts:
            start = w.started_at.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
            summary = (w.title or w.discipline.title()).replace(",", r"\,").replace(";", r"\;")
            if w.distance_m:
                summary += f" · {w.distance_m / 1000:.1f} km"
            lines += [
                "BEGIN:VEVENT",
                f"UID:{w.id}@pacestreak.com",
                f"DTSTAMP:{start}",
                f"DTSTART:{start}",
                f"DURATION:PT{max(1, (w.duration_sec or 1800) // 60)}M",
                f"SUMMARY:{summary}",
                "END:VEVENT",
            ]
        lines.append("END:VCALENDAR")
        return Response(
            "\r\n".join(lines) + "\r\n",
            media_type="text/calendar",
            headers={
                "Content-Disposition": f'attachment; filename="pacestreak-{stamp}.ics"',
                "Cache-Control": "private, no-store",
            },
        )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:

        def sheet(name: str, header: list[str], rows) -> None:
            text = io.StringIO()
            writer = csv.writer(text)
            writer.writerow(header)
            writer.writerows(rows)
            archive.writestr(name, text.getvalue())

        sheet(
            "workouts.csv",
            [
                "id",
                "date",
                "started_at",
                "discipline",
                "title",
                "duration_sec",
                "distance_m",
                "elevation_m",
                "effort",
                "feel",
                "notes",
                "source",
            ],
            (
                [
                    w.id,
                    w.local_date,
                    w.started_at.isoformat(),
                    w.discipline,
                    w.title,
                    w.duration_sec,
                    w.distance_m,
                    w.elevation_m,
                    w.effort,
                    w.feel,
                    w.notes,
                    w.source,
                ]
                for w in workouts
            ),
        )
        sheet(
            "sets.csv",
            [
                "workout_id",
                "date",
                "exercise_id",
                "exercise",
                "position",
                "set",
                "kind",
                "weight_kg",
                "reps",
                "rpe",
                "duration_sec",
                "distance_m",
                "completed",
            ],
            (
                [
                    w.id,
                    w.local_date,
                    s.exercise_id,
                    names.get(s.exercise_id, s.exercise_id),
                    s.position,
                    s.set_index,
                    s.kind,
                    s.weight_kg,
                    s.reps,
                    s.rpe,
                    s.duration_sec,
                    s.distance_m,
                    s.completed,
                ]
                for w in workouts
                for s in w.sets
            ),
        )
        metrics = (
            (await db.execute(select(BodyMetric).where(BodyMetric.user_id == user.id)))
            .scalars()
            .all()
        )
        sheet(
            "body_metrics.csv",
            ["date", "weight_kg", "body_fat_pct", "waist_cm", "resting_hr", "sleep_hours", "note"],
            (
                [
                    m.measured_on,
                    m.weight_kg,
                    m.body_fat_pct,
                    m.waist_cm,
                    m.resting_hr,
                    m.sleep_hours,
                    m.note,
                ]
                for m in metrics
            ),
        )
        archive.writestr(
            "README.txt",
            "PaceStreak export.\n\nWeights are always kilograms and distances always metres,\n"
            "whatever units the app displays. The JSON export contains everything,\n"
            "including social data; these CSVs cover training.\n",
        )
    return Response(
        buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="pacestreak-{stamp}.zip"',
            "Cache-Control": "private, no-store",
        },
    )


@router.post("/import")
async def import_data(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Bring a PaceStreak JSON export back in - into this account or another.

    Idempotent: importing the same file twice changes nothing the second
    time. Ids that already belong to someone else are re-minted, so importing
    a friend's export can never touch the friend's rows.
    """
    await enforce("import", user.id, 5, 3600)
    raw = await file.read(MAX_IMPORT_BYTES + 1)
    if len(raw) > MAX_IMPORT_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "That file is too large")
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as err:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Not a JSON file") from err
    if not isinstance(data, dict) or data.get("format") != "pacestreak-export":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Not a PaceStreak export")
    workouts = data.get("workouts") or []
    if len(workouts) > MAX_IMPORT_WORKOUTS:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Too many sessions in one file")

    profile = await get_profile(db, user.id)
    from app.training.schemas import CustomExerciseIn, SetIn

    # Custom exercises first, remembering how their ids map.
    id_map: dict[str, str] = {}
    existing = {
        c.name.lower(): c
        for c in (
            await db.execute(select(CustomExercise).where(CustomExercise.user_id == user.id))
        ).scalars()
    }
    for item in data.get("custom_exercises") or []:
        try:
            spec = CustomExerciseIn.model_validate(item)
        except Exception:
            continue
        match = existing.get(spec.name.lower())
        if match is None:
            match = CustomExercise(user_id=user.id, **spec.model_dump())
            db.add(match)
            await db.flush()
            existing[spec.name.lower()] = match
        id_map[str(item.get("id"))] = match.exercise_id

    imported = skipped = 0
    for item in workouts:
        try:
            wid = UUID(str(item["id"]))
            if item["discipline"] not in DISCIPLINE_IDS:
                raise ValueError
            from datetime import datetime

            started = datetime.fromisoformat(item["started_at"])
            if started.tzinfo is None:
                raise ValueError
            sets = []
            for s in item.get("sets") or []:
                s = dict(s)
                s["exercise_id"] = id_map.get(s.get("exercise_id"), s.get("exercise_id"))
                if not (
                    s["exercise_id"] in EXERCISE_BY_ID
                    or str(s["exercise_id"]).startswith(CUSTOM_PREFIX)
                ):
                    continue
                sets.append(SetIn.model_validate(s))
        except Exception:
            skipped += 1
            continue
        current = await db.get(Workout, wid)
        if current is not None and current.user_id != user.id:
            wid = uuid4()
            current = None
        if current is not None:
            skipped += 1
            continue
        db.add(
            Workout(
                id=wid,
                user_id=user.id,
                discipline=item["discipline"],
                title=(item.get("title") or None) and str(item["title"])[:80],
                notes=(item.get("notes") or None) and str(item["notes"])[:1000],
                started_at=started,
                local_date=local_date(started, profile.timezone),
                duration_sec=item.get("duration_sec"),
                distance_m=item.get("distance_m"),
                elevation_m=item.get("elevation_m"),
                effort=item.get("effort"),
                feel=item.get("feel"),
                source="import",
                client_updated_at=utcnow(),
                sets=[WorkoutSet(user_id=user.id, **s.model_dump()) for s in sets],
            )
        )
        imported += 1
        if imported % 500 == 0:
            await db.flush()

    for m in data.get("body_metrics") or []:
        try:
            from datetime import date as date_

            day = date_.fromisoformat(m["date"])
        except Exception:
            continue
        exists = (
            await db.execute(
                select(BodyMetric.id).where(
                    BodyMetric.user_id == user.id, BodyMetric.measured_on == day
                )
            )
        ).scalar_one_or_none()
        if exists is None:
            db.add(
                BodyMetric(
                    user_id=user.id,
                    measured_on=day,
                    **{
                        k: m.get(k)
                        for k in (
                            "weight_kg",
                            "body_fat_pct",
                            "waist_cm",
                            "resting_hr",
                            "sleep_hours",
                            "note",
                        )
                    },
                )
            )
    await db.flush()
    await recompute(db, user.id, notify=False)
    await db.commit()
    return {"imported": imported, "skipped": skipped}


# --- deletion ------------------------------------------------------------------------


class DeleteIn(BaseModel):
    password: str = Field(min_length=1, max_length=256)


@router.post("/delete")
async def schedule_deletion(
    body: DeleteIn,
    request: Request,
    user: User = Depends(get_current_db_user),
    db: AsyncSession = Depends(get_db),
):
    """Schedule deletion after a grace period, and sign out everywhere.

    Signing back in during the grace period is how it is cancelled - the
    client shows a banner with the date and a cancel button.
    """
    if not verify_password(body.password, user.hashed_password):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Incorrect password")
    profile = await get_profile(db, user.id)
    when = utcnow() + timedelta(days=settings.deletion_grace_days)
    profile.deletion_scheduled_at = when
    await security.record(db, user.id, "deletion_scheduled", request)
    nid = await notify(
        db,
        user.id,
        kind="deletion_scheduled",
        category="security",
        title="Your PaceStreak account is scheduled for deletion",
        body=f"Everything will be deleted on {when:%d %B %Y}. Sign in before then to cancel.",
        url="/settings/data",
    )
    await revoke_all_sessions(db, user)
    await db.commit()
    await finish_revoke_all(user.id)
    await deliver([nid] if nid else [])
    return {"deletion_scheduled_at": when.isoformat()}


@router.post("/delete/cancel")
async def cancel_deletion(
    request: Request, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    profile = await get_profile(db, user.id)
    if profile.deletion_scheduled_at is None:
        return {"cancelled": False}
    profile.deletion_scheduled_at = None
    await security.record(db, user.id, "deletion_cancelled", request)
    await db.commit()
    return {"cancelled": True}


@router.get("/security-events")
async def security_events(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    rows = (
        (
            await db.execute(
                select(SecurityEvent)
                .where(SecurityEvent.user_id == user.id)
                .order_by(SecurityEvent.created_at.desc())
                .limit(100)
            )
        )
        .scalars()
        .all()
    )
    return [
        {
            "id": str(e.id),
            "kind": e.kind,
            "label": security.LABELS.get(e.kind, e.kind),
            "ip_address": e.ip_address,
            "user_agent": e.user_agent,
            "meta": e.meta,
            "created_at": e.created_at.isoformat(),
        }
        for e in rows
    ]
