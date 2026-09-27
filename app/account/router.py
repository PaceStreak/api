"""Leaving with your data, bringing it back, and leaving for good."""

import csv
import io
import json
import zipfile
from datetime import date, datetime, time, timedelta
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

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

from app import storage
from app.account import service as security
from app.account.calendar import build_calendar
from app.account.models import SecurityEvent
from app.auth.dependencies import get_current_db_user, get_current_user
from app.auth.models import User
from app.auth.security import verify_password
from app.auth.service import finish_revoke_all, revoke_all_sessions
from app.common.limits import enforce
from app.common.time import local_date, utcnow
from app.config import get_settings
from app.database import get_db
from app.game.models import PersonalRecord, StreakWager, UserAchievement
from app.game.service import recompute
from app.groups.models import Challenge, ChallengeParticipant, Group, GroupMember
from app.habits.models import Habit, HabitLog
from app.habits.router import HabitIn
from app.notifications.models import NotificationPreference
from app.notifications.service import deliver, notify
from app.profile.router import profile_out
from app.profile.service import get_chains, get_profile
from app.social.models import Block, BuddyPair, Comment, Follow
from app.training.library import CUSTOM_PREFIX, DISCIPLINE_IDS, EXERCISE_BY_ID
from app.training.models import (
    METRIC_FIELDS,
    BodyMetric,
    BodyPhoto,
    CustomExercise,
    ExerciseNote,
    Gear,
    Gym,
    MonthlyGoal,
    Readiness,
    RestDay,
    Routine,
    StreakPause,
    StreakRepair,
    TrainingBlock,
    TrainingPlan,
    WeekReflection,
    WeighIn,
    WeightGoal,
    Workout,
    WorkoutSet,
)
from app.training.pauses import REASONS, Span

router = APIRouter(prefix="/me", tags=["account"])


def _checked_extras(item: dict) -> dict:
    """Heart rate and the after-session check-in from an export, kept only
    when in range."""

    def small(key: str, lo: int, hi: int) -> int | None:
        v = item.get(key)
        return v if isinstance(v, int) and lo <= v <= hi else None

    zones = item.get("hr_zones")
    return {
        "soreness": small("soreness", 0, 3),
        "pump": small("pump", 0, 2),
        "avg_hr": small("avg_hr", 30, 240),
        "max_hr": small("max_hr", 30, 240),
        "hr_zones": [z for z in zones if isinstance(z, int) and z >= 0][:5]
        if isinstance(zones, list)
        else [],
    }


settings = get_settings()

EXPORT_VERSION = 3
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


def _valid_splits(raw: object) -> list[dict]:
    """Imported splits are kept only if every entry is well-formed; a bad
    file loses its splits, never the session."""
    from app.training.schemas import SplitIn

    if not isinstance(raw, list) or len(raw) > 500:
        return []
    try:
        return [SplitIn.model_validate(x).model_dump() for x in raw]
    except Exception:
        return []


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
    buddy_pairs = (
        (
            await db.execute(
                select(BuddyPair).where(or_(BuddyPair.user_a == uid, BuddyPair.user_b == uid))
            )
        )
        .scalars()
        .all()
    )
    buddy_handles = {
        p.user_id: p.handle
        for p in (
            await db.execute(
                select(Profile).where(
                    Profile.user_id.in_([x for b in buddy_pairs for x in (b.user_a, b.user_b)])
                )
            )
        ).scalars()
    }

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
                "requirements_history": c.requirements_history,
            }
            for c in chains
        ],
        "repairs": [
            {"chain_id": str(r.chain_id), "week_start": r.week_start.isoformat(), "month": r.month}
            for r in await all_of(StreakRepair, StreakRepair.user_id == uid)
        ],
        "pauses": [
            {
                "starts_on": p.starts_on.isoformat(),
                "ends_on": p.ends_on.isoformat() if p.ends_on else None,
                "reason": p.reason,
                "note": p.note,
            }
            for p in await all_of(StreakPause, StreakPause.user_id == uid)
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
                "tags": w.tags,
                "splits": w.splits,
                "gear_id": str(w.gear_id) if w.gear_id else None,
                "gym_id": str(w.gym_id) if w.gym_id else None,
                "soreness": w.soreness,
                "pump": w.pump,
                "avg_hr": w.avg_hr,
                "max_hr": w.max_hr,
                "hr_zones": w.hr_zones,
                "source": w.source,
                "sets": [
                    {
                        "exercise_id": s.exercise_id,
                        "position": s.position,
                        "set_index": s.set_index,
                        "superset": s.superset,
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
        "monthly_goals": [
            {"month": g.month, "days": g.days}
            for g in await all_of(MonthlyGoal, MonthlyGoal.user_id == uid)
        ],
        "rest_days": [
            {"day": r.day.isoformat(), "kind": r.kind, "note": r.note}
            for r in await all_of(RestDay, RestDay.user_id == uid)
        ],
        "gear": [
            {
                "id": str(g.id),
                "name": g.name,
                "kind": g.kind,
                "default_for": g.default_for,
                "limit_km": g.limit_m / 1000 if g.limit_m else None,
                "initial_km": g.initial_m / 1000,
                "retired_at": _iso(g.retired_at),
                "note": g.note,
            }
            for g in await all_of(Gear, Gear.user_id == uid)
        ],
        "gyms": [
            {
                "id": str(g.id),
                "name": g.name,
                "equipment": g.equipment,
                "plates_kg": g.plates_kg,
                "bar_kg": g.bar_kg,
                "is_default": g.is_default,
            }
            for g in await all_of(Gym, Gym.user_id == uid)
        ],
        "exercise_notes": [
            {"exercise_id": n.exercise_id, "note": n.note}
            for n in await all_of(ExerciseNote, ExerciseNote.user_id == uid)
        ],
        "weight_goal": next(
            (
                {
                    "target_kg": g.target_kg,
                    "start_kg": g.start_kg,
                    "milestone_kg": g.milestone_kg,
                    "set_on": g.set_on.isoformat(),
                }
                for g in await all_of(WeightGoal, WeightGoal.user_id == uid)
            ),
            None,
        ),
        "habits": [
            {
                "id": str(h.id),
                "name": h.name,
                "emoji": h.emoji,
                "category": h.category,
                "kind": h.kind,
                "unit": h.unit,
                "daily_goal": h.daily_goal,
                "weekly_target": h.weekly_target,
                "time_of_day": h.time_of_day,
                "cue": h.cue,
                "why": h.why,
                "total_goal": h.total_goal,
                "remind_hour": h.remind_hour,
                "template_id": h.template_id,
                "started_on": h.started_on.isoformat(),
                "archived_at": _iso(h.archived_at),
                "days": [
                    {"date": log.day.isoformat(), "amount": log.amount, "note": log.note}
                    for log in await all_of(HabitLog, HabitLog.habit_id == h.id)
                ],
            }
            for h in await all_of(Habit, Habit.user_id == uid)
        ],
        "training_blocks": [
            {
                "name": b.name,
                "starts_on": b.starts_on.isoformat(),
                "weeks": b.weeks,
                "rir_start": b.rir_start,
                "rir_end": b.rir_end,
                "ended_at": _iso(b.ended_at),
            }
            for b in await all_of(TrainingBlock, TrainingBlock.user_id == uid)
        ],
        "readiness": [
            {
                "date": r.day.isoformat(),
                "sleep": r.sleep,
                "energy": r.energy,
                "soreness": r.soreness,
            }
            for r in await all_of(Readiness, Readiness.user_id == uid)
        ],
        "reflections": [
            {"week_start": r.week_start.isoformat(), "went_well": r.went_well, "change": r.change}
            for r in await all_of(WeekReflection, WeekReflection.user_id == uid)
        ],
        "streak_wagers": [
            {"week_start": x.week_start.isoformat(), "days": x.days}
            for x in await all_of(StreakWager, StreakWager.user_id == uid)
        ],
        "plans": [
            {
                "name": p.name,
                "description": p.description,
                "template_id": p.template_id,
                "weeks": p.weeks,
                "started_on": p.started_on.isoformat() if p.started_on else None,
                "finished_at": _iso(p.finished_at),
            }
            for p in await all_of(TrainingPlan, TrainingPlan.user_id == uid)
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
            {"date": m.measured_on.isoformat(), **{f: getattr(m, f) for f in METRIC_FIELDS}}
            for m in await all_of(BodyMetric, BodyMetric.user_id == uid)
        ],
        # Backed-up photos are listed here; the images themselves are in the
        # CSV export's photos/ folder, which keeps this file readable.
        "body_photos": [
            {"id": str(p.id), "date": p.taken_on.isoformat(), "pose": p.pose, "size": p.size}
            for p in await all_of(BodyPhoto, BodyPhoto.user_id == uid)
        ],
        "weigh_ins": [
            {
                "id": str(w.id),
                "weighed_at": w.weighed_at.isoformat(),
                "date": w.local_date.isoformat(),
                "moment": w.moment,
                "weight_kg": w.weight_kg,
                "note": w.note,
            }
            for w in await all_of(WeighIn, WeighIn.user_id == uid)
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
            "buddies": [
                {
                    "handle": buddy_handles.get(p.user_b if p.user_a == uid else p.user_a),
                    "status": p.status,
                    "started_at": _iso(p.started_at),
                    "ended_at": _iso(p.ended_at),
                }
                for p in buddy_pairs
            ],
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
        pauses = list(
            (await db.execute(select(StreakPause).where(StreakPause.user_id == user.id))).scalars()
        )
        body = build_calendar("PaceStreak training", list(workouts), pauses)
        return Response(
            body,
            media_type="text/calendar; charset=utf-8",
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
                "tags",
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
                    " ".join(w.tags),
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
            ["date", *METRIC_FIELDS],
            ([m.measured_on, *(getattr(m, f) for f in METRIC_FIELDS)] for m in metrics),
        )
        weigh_ins = (
            (
                await db.execute(
                    select(WeighIn).where(WeighIn.user_id == user.id).order_by(WeighIn.weighed_at)
                )
            )
            .scalars()
            .all()
        )
        sheet(
            "weigh_ins.csv",
            ["weighed_at", "date", "moment", "weight_kg", "note"],
            ([w.weighed_at, w.local_date, w.moment, w.weight_kg, w.note] for w in weigh_ins),
        )
        habit_rows = (
            await db.execute(
                select(
                    Habit.name, Habit.kind, Habit.unit, HabitLog.day, HabitLog.amount, HabitLog.note
                )
                .join(HabitLog, HabitLog.habit_id == Habit.id)
                .where(Habit.user_id == user.id)
                .order_by(Habit.name, HabitLog.day)
            )
        ).all()
        sheet(
            "habit_days.csv",
            ["habit", "kind", "unit", "date", "amount", "note"],
            ([*row] for row in habit_rows),
        )
        photos = (
            (
                await db.execute(
                    select(BodyPhoto)
                    .where(BodyPhoto.user_id == user.id)
                    .order_by(BodyPhoto.taken_on)
                )
            )
            .scalars()
            .all()
        )
        for p in photos:
            ext = {"image/png": "png", "image/webp": "webp"}.get(p.content_type, "jpg")
            data = await storage.get_object(p.object_key)
            archive.writestr(f"photos/{p.taken_on}_{p.pose}_{p.id}.{ext}", data)
        archive.writestr(
            "README.txt",
            "PaceStreak export.\n\nWeights are always kilograms and distances always metres,\n"
            "whatever units the app displays. The JSON export contains everything,\n"
            "including social data; these CSVs cover training, and photos/ holds any\n"
            "progress photos you backed up.\n",
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
    from app.training.schemas import CustomExerciseIn, GearIn, GymIn, SetIn, clean_tags

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

    # Gear next, matched by name like custom exercises, so importing twice
    # does not duplicate a pair of shoes.
    gear_map: dict[str, UUID] = {}
    owned_gear = {
        g.name.lower(): g
        for g in (await db.execute(select(Gear).where(Gear.user_id == user.id))).scalars()
    }
    for item in data.get("gear") or []:
        try:
            spec = GearIn.model_validate(item)
        except Exception:
            continue
        match = owned_gear.get(spec.name.lower())
        if match is None:
            match = Gear(
                user_id=user.id,
                name=spec.name,
                kind=spec.kind,
                default_for=[],
                limit_m=spec.limit_km * 1000 if spec.limit_km else None,
                initial_m=spec.initial_km * 1000,
                note=spec.note,
                retired_at=utcnow() if item.get("retired_at") else None,
            )
            db.add(match)
            await db.flush()
            owned_gear[spec.name.lower()] = match
        gear_map[str(item.get("id"))] = match.id

    # Gyms, matched by name like gear.
    gym_map: dict[str, UUID] = {}
    owned_gyms = {
        g.name.lower(): g
        for g in (await db.execute(select(Gym).where(Gym.user_id == user.id))).scalars()
    }
    for item in data.get("gyms") or []:
        try:
            spec = GymIn.model_validate(item)
        except Exception:
            continue
        match = owned_gyms.get(spec.name.lower())
        if match is None:
            match = Gym(user_id=user.id, **(spec.model_dump() | {"is_default": False}))
            db.add(match)
            await db.flush()
            owned_gyms[spec.name.lower()] = match
        gym_map[str(item.get("id"))] = match.id

    imported = skipped = 0
    for item in workouts:
        try:
            wid = UUID(str(item["id"]))
            if item["discipline"] not in DISCIPLINE_IDS:
                raise ValueError

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
                tags=clean_tags([t for t in item.get("tags") or [] if isinstance(t, str)]),
                splits=_valid_splits(item.get("splits")),
                gear_id=gear_map.get(str(item.get("gear_id"))),
                gym_id=gym_map.get(str(item.get("gym_id"))),
                **_checked_extras(item),
                source="import",
                client_updated_at=utcnow(),
                sets=[WorkoutSet(user_id=user.id, **s.model_dump()) for s in sets],
            )
        )
        imported += 1
        if imported % 500 == 0:
            await db.flush()

    # Pauses come back as they were, bypassing the backdating rule (they are
    # history, not a new declaration) but never overlapping one already here.
    held = [
        Span(p.starts_on, p.ends_on)
        for p in (
            await db.execute(select(StreakPause).where(StreakPause.user_id == user.id))
        ).scalars()
    ]
    for p in data.get("pauses") or []:
        try:
            span = Span(
                date.fromisoformat(p["starts_on"]),
                date.fromisoformat(p["ends_on"]) if p.get("ends_on") else None,
            )
            reason = p.get("reason") if p.get("reason") in REASONS else "other"
        except KeyError, TypeError, ValueError:
            continue
        if span.ends_on is not None and span.ends_on < span.starts_on:
            continue
        if any(span.overlaps(h) for h in held):
            continue
        held.append(span)
        db.add(
            StreakPause(
                user_id=user.id,
                starts_on=span.starts_on,
                ends_on=span.ends_on or span.effective_end(),
                reason=reason,
                note=(str(p.get("note") or "")[:280]) or None,
            )
        )

    from app.training.schemas import (
        BodyMetricIn,
        ReadinessIn,
        ReflectionIn,
        WeighInIn,
        WeightGoalIn,
    )

    tz = ZoneInfo(profile.timezone)
    known_weigh_ins = {
        (w.local_date, w.moment, w.weight_kg)
        for w in (await db.execute(select(WeighIn).where(WeighIn.user_id == user.id))).scalars()
    }

    def add_weigh_in(spec: WeighInIn, wanted_id: UUID | None = None) -> None:
        day = local_date(spec.weighed_at, profile.timezone)
        key = (day, spec.moment, round(spec.weight_kg, 2))
        if key in known_weigh_ins:
            return
        known_weigh_ins.add(key)
        w = WeighIn(
            user_id=user.id,
            weighed_at=spec.weighed_at,
            local_date=day,
            moment=spec.moment,
            weight_kg=round(spec.weight_kg, 2),
            note=spec.note,
        )
        if wanted_id is not None:
            w.id = wanted_id
        db.add(w)

    for m in data.get("body_metrics") or []:
        try:
            day = date.fromisoformat(m["date"])
            spec = BodyMetricIn.model_validate({k: v for k, v in m.items() if k != "date"})
        except Exception:
            continue
        # Exports before version 3 kept one weight per day on this row. It
        # arrives as a weigh-in at local midday, with no moment claimed.
        if m.get("weight_kg") is not None:
            try:
                add_weigh_in(
                    WeighInIn(
                        weighed_at=datetime.combine(day, time(12), tzinfo=tz),
                        moment="other",
                        weight_kg=m["weight_kg"],
                    )
                )
            except Exception:
                pass
        values = spec.model_dump()
        if all(v is None for v in values.values()):
            continue
        exists = (
            await db.execute(
                select(BodyMetric.id).where(
                    BodyMetric.user_id == user.id, BodyMetric.measured_on == day
                )
            )
        ).scalar_one_or_none()
        if exists is None:
            db.add(BodyMetric(user_id=user.id, measured_on=day, **values))

    for item in data.get("weigh_ins") or []:
        try:
            spec = WeighInIn.model_validate(item)
        except Exception:
            continue
        if spec.weighed_at.tzinfo is None:
            continue
        # Keep the original id unless it is already in use, by anyone.
        try:
            wanted = UUID(str(item.get("id")))
        except ValueError:
            wanted = None
        if wanted is not None and await db.get(WeighIn, wanted) is not None:
            wanted = None
        add_weigh_in(spec, wanted)

    noted = {
        n.exercise_id
        for n in (
            await db.execute(select(ExerciseNote).where(ExerciseNote.user_id == user.id))
        ).scalars()
    }
    for item in data.get("exercise_notes") or []:
        exercise_id = id_map.get(item.get("exercise_id"), item.get("exercise_id"))
        text = str(item.get("note") or "").strip()[:500]
        known = exercise_id in EXERCISE_BY_ID or str(exercise_id).startswith(CUSTOM_PREFIX)
        if known and text and exercise_id not in noted:
            noted.add(exercise_id)
            db.add(ExerciseNote(user_id=user.id, exercise_id=exercise_id, note=text))

    goal = data.get("weight_goal")
    has_goal = (
        await db.execute(select(WeightGoal.id).where(WeightGoal.user_id == user.id))
    ).scalar_one_or_none()
    if isinstance(goal, dict) and has_goal is None:
        try:
            spec = WeightGoalIn.model_validate(goal)
            db.add(
                WeightGoal(
                    user_id=user.id,
                    target_kg=spec.target_kg,
                    milestone_kg=spec.milestone_kg,
                    start_kg=float(goal["start_kg"]),
                    set_on=date.fromisoformat(goal["set_on"]),
                )
            )
        except Exception:
            pass
    # Habits: matched by name, like gear; days fill gaps and never overwrite.
    owned_habits = {
        h.name.lower(): h
        for h in (await db.execute(select(Habit).where(Habit.user_id == user.id))).scalars()
    }
    for item in data.get("habits") or []:
        try:
            spec = HabitIn.model_validate(
                {k: item.get(k) for k in HabitIn.model_fields if k != "template_id"}
            )
            started = date.fromisoformat(item["started_on"])
        except Exception:
            continue
        if not spec.name:
            continue
        habit = owned_habits.get(spec.name.lower())
        if habit is None:
            kind = spec.kind or "check"
            habit = Habit(
                user_id=user.id,
                name=spec.name.strip(),
                emoji=spec.emoji or "✨",
                category=spec.category or "other",
                kind=kind,
                unit=spec.unit,
                daily_goal=spec.daily_goal if kind in ("duration", "count") else None,
                weekly_target=spec.weekly_target or 7,
                time_of_day=spec.time_of_day or "anytime",
                cue=spec.cue,
                why=spec.why,
                total_goal=spec.total_goal,
                remind_hour=spec.remind_hour,
                started_on=started,
                archived_at=utcnow() if item.get("archived_at") else None,
            )
            db.add(habit)
            await db.flush()
            owned_habits[spec.name.lower()] = habit
        have_days = {
            d
            for d in (
                await db.execute(select(HabitLog.day).where(HabitLog.habit_id == habit.id))
            ).scalars()
        }
        for entry in item.get("days") or []:
            try:
                day = date.fromisoformat(entry["date"])
                amount = float(entry["amount"])
            except Exception:
                continue
            if day in have_days or not 0 < amount <= 100_000:
                continue
            have_days.add(day)
            note = str(entry.get("note") or "")[:280] or None
            db.add(HabitLog(habit_id=habit.id, user_id=user.id, day=day, amount=amount, note=note))

    # Readiness and reflections: fill gaps, never overwrite.
    have_ready = {
        d
        for d in (
            await db.execute(select(Readiness.day).where(Readiness.user_id == user.id))
        ).scalars()
    }
    for r in data.get("readiness") or []:
        try:
            day = date.fromisoformat(r["date"])
            spec = ReadinessIn.model_validate(r)
        except Exception:
            continue
        if day not in have_ready:
            have_ready.add(day)
            db.add(Readiness(user_id=user.id, day=day, **spec.model_dump()))
    have_notes = {
        d
        for d in (
            await db.execute(
                select(WeekReflection.week_start).where(WeekReflection.user_id == user.id)
            )
        ).scalars()
    }
    for r in data.get("reflections") or []:
        try:
            week = date.fromisoformat(r["week_start"])
            spec = ReflectionIn.model_validate(r)
        except Exception:
            continue
        if week not in have_notes and (spec.went_well or spec.change):
            have_notes.add(week)
            db.add(WeekReflection(user_id=user.id, week_start=week, **spec.model_dump()))
    # Not imported: training blocks (a block plans the weeks ahead, and old
    # ones would only clutter) and wagers (a freeze earned on another
    # account's history would be one this account never earned).

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
