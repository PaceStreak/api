"""Workouts, the exercise library, routines, body metrics and streak chains."""

from datetime import UTC, date, datetime, timedelta
from uuid import UUID, uuid5

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.limits import enforce
from app.common.time import local_date, local_today, month_key, utcnow, week_start
from app.database import get_db
from app.game.service import chain_payload, pause_payload, recompute, snapshot
from app.notifications.service import deliver
from app.profile.models import Profile
from app.profile.service import (
    get_chains,
    get_profile,
    set_chain_requirements,
    set_chain_target,
)
from app.social.models import ActivityEvent
from app.social.service import emit_event
from app.training.importers import MAX_BYTES, ImportFormatError, check, parse
from app.training.library import (
    CUSTOM_PREFIX,
    DISCIPLINES,
    EXERCISE_BY_ID,
    TEMPLATE_BY_ID,
    library_payload,
)
from app.training.models import (
    BodyMetric,
    CustomExercise,
    Gear,
    Routine,
    StreakChain,
    StreakPause,
    StreakRepair,
    Workout,
    WorkoutSet,
    sync_seq,
)
from app.training.pauses import (
    PAUSE_BUDGET_DAYS,
    PauseError,
    Span,
    days_used,
    end_date_for,
    validate,
)
from app.training.schemas import (
    BatchIn,
    BodyMetricIn,
    ChainIn,
    ChainPatch,
    CustomExerciseIn,
    PauseIn,
    RepairIn,
    RequirementIn,
    RoutineIn,
    WorkoutIn,
    WorkoutOut,
    check_requirements,
)

router = APIRouter(tags=["training"])

# How far back a session can be logged through the app. Long enough for a
# forgotten session or a phone that sat offline for weeks; older history comes
# in through import, where it is marked as such.
MAX_BACKDATE_DAYS = 30
FUTURE_TOLERANCE = timedelta(minutes=10)
DISCIPLINE_BY_ID = {d.id: d for d in DISCIPLINES}


# --- library -------------------------------------------------------------------


@router.get("/library")
async def library(response: Response):
    """The built-in catalogue. Identical for every user and changes only with a
    deploy, so it is safe to let the browser cache it."""
    response.headers["Cache-Control"] = "public, max-age=3600"
    return library_payload()


# --- workouts ---------------------------------------------------------------------


async def _valid_exercise_ids(db: AsyncSession, user_id: UUID, ids: set[str]) -> set[str]:
    custom_ids = {i.removeprefix(CUSTOM_PREFIX) for i in ids if i.startswith(CUSTOM_PREFIX)}
    known = {i for i in ids if i in EXERCISE_BY_ID}
    if custom_ids:
        try:
            parsed = [UUID(c) for c in custom_ids]
        except ValueError:
            parsed = []
        rows = await db.execute(
            select(CustomExercise.id).where(
                CustomExercise.user_id == user_id, CustomExercise.id.in_(parsed)
            )
        )
        known |= {f"{CUSTOM_PREFIX}{r}" for r in rows.scalars()}
    return known


def _workout_event_data(workout: Workout, names: dict[str, str]) -> dict:
    exercises: list[str] = []
    for s in workout.sets:
        if s.kind != "warmup" and s.exercise_id not in exercises:
            exercises.append(s.exercise_id)
    discipline = DISCIPLINE_BY_ID.get(workout.discipline)
    return {
        "discipline": workout.discipline,
        "verb": discipline.verb if discipline else "Trained",
        "title": workout.title,
        "duration_sec": workout.duration_sec,
        "distance_m": workout.distance_m,
        "elevation_m": workout.elevation_m,
        "set_count": sum(1 for s in workout.sets if s.completed and s.kind != "warmup"),
        "exercises": [names.get(e, e) for e in exercises[:4]],
        "exercise_count": len(exercises),
        "feel": workout.feel,
    }


async def _exercise_names(db: AsyncSession, user_id: UUID, ids: set[str]) -> dict[str, str]:
    names = {i: EXERCISE_BY_ID[i].name for i in ids if i in EXERCISE_BY_ID}
    custom = [i.removeprefix(CUSTOM_PREFIX) for i in ids if i.startswith(CUSTOM_PREFIX)]
    if custom:
        rows = await db.execute(
            select(CustomExercise.id, CustomExercise.name).where(
                CustomExercise.user_id == user_id,
                CustomExercise.id.in_([UUID(c) for c in custom]),
            )
        )
        names |= {f"{CUSTOM_PREFIX}{r.id}": r.name for r in rows}
    return names


async def _apply_put(
    db: AsyncSession, user: User, profile: Profile, workout_id: UUID, body: WorkoutIn
) -> tuple[Workout, bool, bool]:
    """Upsert one workout. Returns (workout, created, applied)."""
    now = utcnow()
    if body.started_at > now + FUTURE_TOLERANCE:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Session starts in the future")
    if body.started_at < now - timedelta(days=MAX_BACKDATE_DAYS):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Sessions older than {MAX_BACKDATE_DAYS} days go through import",
        )

    ids = {s.exercise_id for s in body.sets}
    unknown = ids - await _valid_exercise_ids(db, user.id, ids)
    if unknown:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"Unknown exercise: {sorted(unknown)[0]}"
        )

    # Gear from another account, or deleted on another device while this
    # edit sat in an offline queue: drop the link rather than reject the
    # session - the log matters more than the shoe. Resolved before the
    # workout is touched, so the lookup cannot autoflush a half-built row.
    gear = await db.get(Gear, body.gear_id) if body.gear_id is not None else None
    gear_id = gear.id if gear is not None and gear.user_id == user.id else None

    workout = await db.get(Workout, workout_id)
    created = workout is None
    if workout is not None and workout.user_id != user.id:
        # Somebody else's id. 404 rather than 403, so ids cannot be probed.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if workout is not None and workout.client_updated_at >= body.client_updated_at:
        # An older edit arriving late - an offline queue flushing after a
        # newer change reached us from another device. Keep the newer one.
        return workout, False, False

    if workout is None:
        workout = Workout(id=workout_id, user_id=user.id)
        db.add(workout)
    else:
        workout.seq = sync_seq.next_value()

    workout.discipline = body.discipline
    workout.title = body.title
    workout.notes = body.notes
    workout.started_at = body.started_at
    workout.local_date = local_date(body.started_at, profile.timezone)
    workout.duration_sec = body.duration_sec
    workout.distance_m = body.distance_m
    workout.elevation_m = body.elevation_m
    workout.effort = body.effort
    workout.feel = body.feel
    workout.routine_id = body.routine_id
    workout.tags = body.tags
    workout.splits = [s.model_dump() for s in body.splits]
    workout.gear_id = gear_id
    workout.client_updated_at = body.client_updated_at
    workout.deleted_at = None
    workout.sets = [WorkoutSet(user_id=user.id, **s.model_dump()) for s in body.sets]
    if body.routine_id is not None:
        await db.execute(
            update(Routine)
            .where(Routine.id == body.routine_id, Routine.user_id == user.id)
            .values(last_used_at=now)
        )
    await db.flush()
    await db.refresh(workout, ["seq"])
    return workout, created, True


async def _apply_delete(db: AsyncSession, user: User, workout_id: UUID, at: datetime) -> bool:
    workout = await db.get(Workout, workout_id)
    if workout is None or workout.user_id != user.id:
        return False
    if workout.client_updated_at > at:
        return False
    workout.deleted_at = utcnow()
    workout.client_updated_at = at
    workout.seq = sync_seq.next_value()
    await db.execute(delete(ActivityEvent).where(ActivityEvent.workout_id == workout_id))
    await db.flush()
    return True


async def _emit_workout_event(db: AsyncSession, profile: Profile, workout: Workout) -> None:
    names = await _exercise_names(db, profile.user_id, {s.exercise_id for s in workout.sets})
    await emit_event(
        db,
        profile,
        "workout",
        str(workout.id),
        workout.local_date,
        _workout_event_data(workout, names),
        workout_id=workout.id,
    )


@router.get("/workouts", response_model=list[WorkoutOut])
async def list_workouts(
    before: datetime | None = None,
    limit: int = Query(default=30, ge=1, le=100),
    discipline: str | None = None,
    start: date | None = None,
    end: date | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Workout).where(Workout.user_id == user.id, Workout.deleted_at.is_(None))
    if before is not None:
        stmt = stmt.where(Workout.started_at < before)
    if discipline:
        stmt = stmt.where(Workout.discipline == discipline)
    if start:
        stmt = stmt.where(Workout.local_date >= start)
    if end:
        stmt = stmt.where(Workout.local_date <= end)
    rows = await db.execute(stmt.order_by(Workout.started_at.desc()).limit(limit))
    return rows.scalars().all()


@router.get("/workouts/changes")
async def workout_changes(
    since: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=500),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Everything changed after cursor `since`, tombstones included. The
    client keeps the returned cursor and asks again; `more` means there is
    another page waiting."""
    rows = (
        (
            await db.execute(
                select(Workout)
                .where(Workout.user_id == user.id, Workout.seq > since)
                .order_by(Workout.seq)
                .limit(limit + 1)
            )
        )
        .scalars()
        .all()
    )
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "workouts": [WorkoutOut.model_validate(w).model_dump(mode="json") for w in rows],
        "cursor": rows[-1].seq if rows else since,
        "more": more,
    }


@router.get("/workouts/{workout_id}", response_model=WorkoutOut)
async def get_workout(
    workout_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    workout = await db.get(Workout, workout_id)
    if workout is None or workout.user_id != user.id or workout.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return workout


@router.put("/workouts/{workout_id}")
async def put_workout(
    workout_id: UUID,
    body: WorkoutIn,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await enforce("workout-write", user.id, 240, 3600)
    profile = await get_profile(db, user.id)
    workout, created, applied = await _apply_put(db, user, profile, workout_id, body)
    outcome = None
    if applied:
        outcome = await recompute(db, user.id, workout_id=workout.id)
        await _emit_workout_event(db, profile, workout)
    await db.commit()
    if outcome:
        background.add_task(deliver, outcome.notification_ids)
    return {
        "workout": WorkoutOut.model_validate(workout).model_dump(mode="json"),
        "created": created,
        "applied": applied,
        "outcome": outcome.public() if outcome else None,
    }


@router.delete("/workouts/{workout_id}")
async def delete_workout(
    workout_id: UUID,
    client_updated_at: datetime | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    applied = await _apply_delete(db, user, workout_id, client_updated_at or utcnow())
    outcome = await recompute(db, user.id, notify=False) if applied else None
    await db.commit()
    return {"applied": applied, "outcome": outcome.public() if outcome else None}


@router.post("/workouts/batch")
async def batch(
    body: BatchIn,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The offline outbox's flush. Applies every operation, recomputes once.

    Each op succeeds or fails on its own: one rejected session (say, a typo'd
    date in the future) must not strand the rest of a queue behind it.
    """
    await enforce("workout-write", user.id, 240, 3600)
    profile = await get_profile(db, user.id)
    results = []
    touched: list[Workout] = []
    for op in body.ops:
        try:
            async with db.begin_nested():
                if op.op == "put":
                    if op.workout is None:
                        raise HTTPException(422, "put needs a workout")
                    workout, created, applied = await _apply_put(
                        db, user, profile, op.id, op.workout
                    )
                    if applied:
                        touched.append(workout)
                    results.append(
                        {
                            "id": str(op.id),
                            "ok": True,
                            "applied": applied,
                            "created": created,
                            "workout": WorkoutOut.model_validate(workout).model_dump(mode="json"),
                        }
                    )
                else:
                    applied = await _apply_delete(db, user, op.id, op.client_updated_at)
                    results.append({"id": str(op.id), "ok": True, "applied": applied})
        except HTTPException as err:
            results.append(
                {"id": str(op.id), "ok": False, "status": err.status_code, "detail": err.detail}
            )

    outcome = None
    if any(r.get("applied") for r in results):
        latest = touched[-1].id if len(touched) == 1 else None
        outcome = await recompute(db, user.id, workout_id=latest)
        for workout in touched:
            await _emit_workout_event(db, profile, workout)
    await db.commit()
    if outcome:
        background.add_task(deliver, outcome.notification_ids)
    return {"results": results, "outcome": outcome.public() if outcome else None}


# --- exercise history -------------------------------------------------------------


@router.get("/exercises/last")
async def last_performance(
    ids: str = Query(max_length=2000),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The most recent completed sets for each exercise - the ghost values
    the logger shows as "last time"."""
    wanted = [i for i in ids.split(",") if i][:40]
    out: dict[str, dict] = {}
    for exercise_id in wanted:
        latest = (
            await db.execute(
                select(Workout.id, Workout.local_date)
                .join(WorkoutSet, WorkoutSet.workout_id == Workout.id)
                .where(
                    Workout.user_id == user.id,
                    Workout.deleted_at.is_(None),
                    WorkoutSet.exercise_id == exercise_id,
                    WorkoutSet.completed.is_(True),
                )
                .order_by(Workout.started_at.desc())
                .limit(1)
            )
        ).first()
        if latest is None:
            continue
        sets = (
            await db.execute(
                select(WorkoutSet)
                .where(WorkoutSet.workout_id == latest.id, WorkoutSet.exercise_id == exercise_id)
                .order_by(WorkoutSet.set_index)
            )
        ).scalars()
        out[exercise_id] = {
            "date": latest.local_date.isoformat(),
            "sets": [
                {
                    "kind": s.kind,
                    "weight_kg": s.weight_kg,
                    "reps": s.reps,
                    "rpe": s.rpe,
                    "duration_sec": s.duration_sec,
                }
                for s in sets
            ],
        }
    return out


@router.get("/exercises/{exercise_id}/history")
async def exercise_history(
    exercise_id: str,
    limit: int = Query(default=30, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.game.models import PersonalRecord
    from app.game.records import e1rm

    rows = (
        await db.execute(
            select(WorkoutSet, Workout.local_date, Workout.id.label("wid"))
            .join(Workout, Workout.id == WorkoutSet.workout_id)
            .where(
                WorkoutSet.user_id == user.id,
                WorkoutSet.exercise_id == exercise_id,
                Workout.deleted_at.is_(None),
                WorkoutSet.completed.is_(True),
            )
            .order_by(Workout.started_at.desc(), WorkoutSet.set_index)
        )
    ).all()
    sessions: dict[str, dict] = {}
    for s, day, wid in rows:
        entry = sessions.setdefault(
            str(wid),
            {
                "workout_id": str(wid),
                "date": day.isoformat(),
                "sets": [],
                "best_e1rm": 0,
                "volume_kg": 0.0,
                "top_weight_kg": 0.0,
            },
        )
        entry["sets"].append(
            {
                "kind": s.kind,
                "weight_kg": s.weight_kg,
                "reps": s.reps,
                "rpe": s.rpe,
                "duration_sec": s.duration_sec,
            }
        )
        if s.kind != "warmup" and s.weight_kg and s.reps:
            entry["volume_kg"] += s.weight_kg * s.reps
            entry["top_weight_kg"] = max(entry["top_weight_kg"], s.weight_kg)
            entry["best_e1rm"] = max(entry["best_e1rm"], round(e1rm(s.weight_kg, s.reps), 1))
    records = (
        (
            await db.execute(
                select(PersonalRecord)
                .where(
                    PersonalRecord.user_id == user.id,
                    PersonalRecord.key.like(f"%:{exercise_id}"),
                )
                .order_by(PersonalRecord.achieved_on.desc())
            )
        )
        .scalars()
        .all()
    )
    return {
        "exercise_id": exercise_id,
        "sessions": list(sessions.values())[:limit],
        "records": [
            {
                "key": r.key,
                "value": r.value,
                "previous": r.previous,
                "gain_pct": r.gain_pct,
                "date": r.achieved_on.isoformat(),
                "current": r.is_current,
                "flagged": r.flagged,
            }
            for r in records
        ],
    }


# --- custom exercises ---------------------------------------------------------------


def _custom_out(c: CustomExercise) -> dict:
    return {
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
        "custom": True,
        "aliases": [],
    }


@router.get("/exercises/custom")
async def list_custom(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = await db.execute(
        select(CustomExercise)
        .where(CustomExercise.user_id == user.id)
        .order_by(CustomExercise.name)
    )
    return [_custom_out(c) for c in rows.scalars()]


@router.post("/exercises/custom", status_code=201)
async def create_custom(
    body: CustomExerciseIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    count = (
        await db.execute(select(func.count()).where(CustomExercise.user_id == user.id))
    ).scalar_one()
    if count >= 300:
        raise HTTPException(status.HTTP_409_CONFLICT, "That is a lot of custom exercises")
    custom = CustomExercise(user_id=user.id, **body.model_dump())
    db.add(custom)
    await db.commit()
    return _custom_out(custom)


async def _own_custom(db: AsyncSession, user: User, exercise_id: str) -> CustomExercise:
    try:
        cid = UUID(exercise_id.removeprefix(CUSTOM_PREFIX))
    except ValueError as err:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found") from err
    custom = await db.get(CustomExercise, cid)
    if custom is None or custom.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return custom


@router.put("/exercises/custom/{exercise_id}")
async def update_custom(
    exercise_id: str,
    body: CustomExerciseIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    custom = await _own_custom(db, user, exercise_id)
    for key, value in body.model_dump().items():
        setattr(custom, key, value)
    await db.commit()
    return _custom_out(custom)


@router.delete("/exercises/custom/{exercise_id}", status_code=204)
async def delete_custom(
    exercise_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    custom = await _own_custom(db, user, exercise_id)
    used = (
        await db.execute(
            select(WorkoutSet.id).where(WorkoutSet.exercise_id == custom.exercise_id).limit(1)
        )
    ).scalar_one_or_none()
    if used:
        # History still refers to it by id; archiving keeps the name.
        custom.archived = True
    else:
        await db.delete(custom)
    await db.commit()


# --- routines -------------------------------------------------------------------------


def _routine_out(r: Routine) -> dict:
    return {
        "id": str(r.id),
        "name": r.name,
        "discipline": r.discipline,
        "notes": r.notes,
        "items": r.items,
        "position": r.position,
        "last_used_at": r.last_used_at.isoformat() if r.last_used_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


@router.get("/routines")
async def list_routines(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = await db.execute(
        select(Routine).where(Routine.user_id == user.id).order_by(Routine.position, Routine.name)
    )
    return [_routine_out(r) for r in rows.scalars()]


async def _check_items(db: AsyncSession, user: User, body: RoutineIn) -> None:
    ids = {i.exercise_id for i in body.items}
    unknown = ids - await _valid_exercise_ids(db, user.id, ids)
    if unknown:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"Unknown exercise: {sorted(unknown)[0]}"
        )


@router.post("/routines", status_code=201)
async def create_routine(
    body: RoutineIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await _check_items(db, user, body)
    count = (await db.execute(select(func.count()).where(Routine.user_id == user.id))).scalar_one()
    if count >= 100:
        raise HTTPException(status.HTTP_409_CONFLICT, "Routine limit reached")
    routine = Routine(user_id=user.id, **body.model_dump(mode="json"))
    db.add(routine)
    await db.commit()
    await db.refresh(routine)
    return _routine_out(routine)


@router.post("/routines/from-template/{template_id}", status_code=201)
async def routine_from_template(
    template_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    template = TEMPLATE_BY_ID.get(template_id)
    if template is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such template")
    routine = Routine(
        user_id=user.id,
        name=template["name"],
        discipline=template["discipline"],
        notes=template["summary"],
        items=template["items"],
    )
    db.add(routine)
    await db.commit()
    await db.refresh(routine)
    return _routine_out(routine)


async def _own_routine(db: AsyncSession, user: User, routine_id: UUID) -> Routine:
    routine = await db.get(Routine, routine_id)
    if routine is None or routine.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return routine


@router.put("/routines/{routine_id}")
async def update_routine(
    routine_id: UUID,
    body: RoutineIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    routine = await _own_routine(db, user, routine_id)
    await _check_items(db, user, body)
    for key, value in body.model_dump(mode="json").items():
        setattr(routine, key, value)
    await db.commit()
    await db.refresh(routine)
    return _routine_out(routine)


@router.delete("/routines/{routine_id}", status_code=204)
async def delete_routine(
    routine_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await db.delete(await _own_routine(db, user, routine_id))
    await db.commit()


# --- body metrics ----------------------------------------------------------------------


def _metric_out(m: BodyMetric) -> dict:
    return {
        "date": m.measured_on.isoformat(),
        "weight_kg": m.weight_kg,
        "body_fat_pct": m.body_fat_pct,
        "waist_cm": m.waist_cm,
        "resting_hr": m.resting_hr,
        "sleep_hours": m.sleep_hours,
        "note": m.note,
    }


@router.get("/body-metrics")
async def list_metrics(
    days: int = Query(default=365, ge=1, le=3650),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    profile = await get_profile(db, user.id)
    since = local_today(profile.timezone) - timedelta(days=days)
    rows = await db.execute(
        select(BodyMetric)
        .where(BodyMetric.user_id == user.id, BodyMetric.measured_on >= since)
        .order_by(BodyMetric.measured_on)
    )
    return [_metric_out(m) for m in rows.scalars()]


@router.put("/body-metrics/{day}")
async def put_metric(
    day: date,
    body: BodyMetricIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    profile = await get_profile(db, user.id)
    if day > local_today(profile.timezone):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That day has not happened yet")
    if all(v is None for v in body.model_dump().values()):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Nothing to record")
    metric = (
        await db.execute(
            select(BodyMetric).where(BodyMetric.user_id == user.id, BodyMetric.measured_on == day)
        )
    ).scalar_one_or_none()
    if metric is None:
        metric = BodyMetric(user_id=user.id, measured_on=day)
        db.add(metric)
    for key, value in body.model_dump().items():
        setattr(metric, key, value)
    await db.flush()
    await recompute(db, user.id, notify=True)
    await db.commit()
    return _metric_out(metric)


@router.delete("/body-metrics/{day}", status_code=204)
async def delete_metric(
    day: date, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await db.execute(
        delete(BodyMetric).where(BodyMetric.user_id == user.id, BodyMetric.measured_on == day)
    )
    await db.commit()


# --- chains ------------------------------------------------------------------------------


@router.get("/chains")
async def list_chains(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    snap = await snapshot(db, user.id)
    await db.commit()
    return {
        "chains": [chain_payload(v, weeks=52) for v in snap.chains],
        "repair_available": not snap.repair_used_this_month,
    }


@router.post("/chains", status_code=201)
async def create_chain(
    body: ChainIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    profile = await get_profile(db, user.id)
    chains = await get_chains(db, profile)
    if len(chains) >= 6:
        raise HTTPException(status.HTTP_409_CONFLICT, "Six chains is the limit")
    try:
        check_requirements(body.requirements, body.target, body.disciplines)
    except ValueError as err:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(err)) from err
    this_week = week_start(local_today(profile.timezone), profile.week_starts_on)
    chain = StreakChain(
        user_id=user.id,
        name=body.name,
        disciplines=body.disciplines,
        target_history=[{"from": "2000-01-03", "target": body.target}],
        requirements_history=(
            [
                {
                    "from": this_week.isoformat(),
                    "requirements": [r.model_dump() for r in body.requirements],
                }
            ]
            if body.requirements
            else []
        ),
        position=max(c.position for c in chains) + 1,
    )
    db.add(chain)
    await db.commit()
    return {"id": str(chain.id)}


async def _own_chain(db: AsyncSession, user: User, chain_id: UUID) -> StreakChain:
    chain = await db.get(StreakChain, chain_id)
    if chain is None or chain.user_id != user.id or chain.archived:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return chain


@router.patch("/chains/{chain_id}")
async def update_chain(
    chain_id: UUID,
    body: ChainPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    chain = await _own_chain(db, user, chain_id)
    profile = await get_profile(db, user.id)
    if body.name is not None:
        chain.name = body.name
    if body.disciplines is not None:
        chain.disciplines = body.disciplines
    if body.position is not None:
        chain.position = body.position
    this_week = week_start(local_today(profile.timezone), profile.week_starts_on)
    target = body.target if body.target is not None else chain.target
    if body.requirements is not None or body.target is not None or body.disciplines is not None:
        reqs = (
            body.requirements
            if body.requirements is not None
            else [RequirementIn(**r) for r in chain.requirements]
        )
        try:
            check_requirements(reqs, target, chain.disciplines)
        except ValueError as err:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(err)) from err
    if body.target is not None and body.target != chain.target:
        # Effective from the current week: this week is judged by the new
        # number, every closed week keeps the one it was judged by.
        set_chain_target(chain, body.target, this_week.isoformat())
    if body.requirements is not None:
        new = [r.model_dump() for r in body.requirements]
        if new != chain.requirements:
            set_chain_requirements(chain, new, this_week.isoformat())
    await db.flush()
    await recompute(db, user.id, notify=False)
    await db.commit()
    return {"id": str(chain.id)}


@router.delete("/chains/{chain_id}", status_code=204)
async def archive_chain(
    chain_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    chain = await _own_chain(db, user, chain_id)
    profile = await get_profile(db, user.id)
    if len(await get_chains(db, profile)) <= 1:
        raise HTTPException(status.HTTP_409_CONFLICT, "You need at least one streak")
    chain.archived = True
    await db.commit()


@router.post("/chains/{chain_id}/repair")
async def repair_week(
    chain_id: UUID,
    body: RepairIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    chain = await _own_chain(db, user, chain_id)
    snap = await snapshot(db, user.id)
    view = next((v for v in snap.chains if v.chain.id == chain.id), None)
    if view is None or view.result.repairable_week != body.week_start:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "That week cannot be repaired - one repair a month, for a missed week in the last two.",
        )
    db.add(
        StreakRepair(
            user_id=user.id,
            chain_id=chain.id,
            week_start=body.week_start,
            month=month_key(snap.today),
        )
    )
    await db.flush()
    outcome = await recompute(db, user.id, notify=False)
    await db.commit()
    return {"outcome": outcome.public()}


# --- file import -------------------------------------------------------------------------

# Imported sessions get a deterministic id from who, when and what, so
# uploading the same file twice - or the same run as a GPX and then as a FIT
# - lands on the same row instead of doubling a week's count.
IMPORT_NAMESPACE = UUID("6f1c2a52-6b8e-4c0e-9d7e-3a1f5b8c9e01")
DUPLICATE_WINDOW = timedelta(minutes=3)


@router.post("/workouts/import")
async def import_file(
    file: UploadFile = File(...),
    discipline: str | None = Form(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Import sessions from a GPX, FIT or CSV file.

    Imported sessions count for the personal streak and history but are
    marked `source="import"`: they never count for challenges, never post to
    the feed, and records inside them earn nothing - backfilling a year of
    history must not be a way to top a board."""
    await enforce("import_file", user.id, 30, 3600)
    if discipline is not None and discipline not in DISCIPLINE_BY_ID:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown discipline")
    data = await file.read(MAX_BYTES + 1)
    profile = await get_profile(db, user.id)
    try:
        parsed = parse(file.filename or "", data, profile.timezone, discipline)
    except ImportFormatError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(error)) from error

    now = utcnow()
    problems = list(parsed.problems)
    imported = duplicates = 0
    for session in sorted(parsed.sessions, key=lambda s: s.started_at):
        reason = check(session, now)
        if reason:
            problems.append(f"Session on {session.started_at.date().isoformat()} {reason}.")
            continue
        workout_id = uuid5(
            IMPORT_NAMESPACE,
            f"{user.id}:{session.discipline}:{session.started_at.astimezone(UTC).isoformat()}",
        )
        clash = (
            await db.execute(
                select(Workout.id).where(
                    Workout.user_id == user.id,
                    Workout.deleted_at.is_(None),
                    Workout.started_at.between(
                        session.started_at - DUPLICATE_WINDOW,
                        session.started_at + DUPLICATE_WINDOW,
                    ),
                )
            )
        ).first()
        existing = await db.get(Workout, workout_id)
        if clash is not None or (existing is not None and existing.deleted_at is None):
            duplicates += 1
            continue
        workout = existing or Workout(id=workout_id, user_id=user.id)
        if existing is None:
            db.add(workout)
        else:
            workout.seq = sync_seq.next_value()
        workout.discipline = session.discipline
        workout.title = session.title
        workout.notes = session.notes
        workout.started_at = session.started_at
        workout.local_date = local_date(session.started_at, profile.timezone)
        workout.duration_sec = session.duration_sec
        workout.distance_m = session.distance_m
        workout.elevation_m = session.elevation_m
        workout.effort = session.effort
        workout.feel = session.feel
        workout.splits = session.splits
        workout.source = "import"
        workout.client_updated_at = now
        workout.deleted_at = None
        workout.sets = []
        await db.flush()
        imported += 1

    if imported:
        await recompute(db, user.id, notify=False)
    await db.commit()
    return {
        "format": parsed.format,
        "found": len(parsed.sessions),
        "imported": imported,
        "duplicates": duplicates,
        "problems": problems[:50],
        "more_problems": max(0, len(problems) - 50),
    }


# --- pauses ------------------------------------------------------------------------------


async def _pauses(db: AsyncSession, user_id: UUID) -> list[StreakPause]:
    return list(
        (
            await db.execute(
                select(StreakPause)
                .where(StreakPause.user_id == user_id)
                .order_by(StreakPause.starts_on)
            )
        ).scalars()
    )


async def _pause_state(db: AsyncSession, user: User) -> dict:
    profile = await get_profile(db, user.id)
    today = local_today(profile.timezone)
    pauses = await _pauses(db, user.id)
    used = days_used([Span(p.starts_on, p.ends_on) for p in pauses], today)
    return {
        "pauses": [pause_payload(p, today) for p in pauses],
        "budget": {"days_used": used, "days_allowed": PAUSE_BUDGET_DAYS},
    }


@router.get("/pauses")
async def list_pauses(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    state = await _pause_state(db, user)
    await db.commit()
    return state


@router.post("/pauses", status_code=201)
async def create_pause(
    body: PauseIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Declare a break. Weeks it covers for four days or more no longer break
    the streak, and reminders stop while it runs."""
    await enforce("pause", user.id, 20, 86400)
    profile = await get_profile(db, user.id)
    today = local_today(profile.timezone)
    existing = [Span(p.starts_on, p.ends_on) for p in await _pauses(db, user.id)]
    try:
        validate(Span(body.starts_on, body.ends_on), existing, today)
    except PauseError as error:
        raise HTTPException(status.HTTP_409_CONFLICT, str(error)) from error
    pause = StreakPause(
        user_id=user.id,
        starts_on=body.starts_on,
        ends_on=body.ends_on,
        reason=body.reason,
        note=(body.note or "").strip() or None,
    )
    db.add(pause)
    await db.flush()
    await recompute(db, user.id, notify=False)
    await db.commit()
    return pause_payload(pause, today)


async def _own_pause(db: AsyncSession, user: User, pause_id: UUID) -> StreakPause:
    pause = await db.get(StreakPause, pause_id)
    if pause is None or pause.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return pause


@router.post("/pauses/{pause_id}/end")
async def end_pause(
    pause_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Back today. Today is the first day that counts again; a pause that has
    not started yet is simply removed."""
    pause = await _own_pause(db, user, pause_id)
    profile = await get_profile(db, user.id)
    today = local_today(profile.timezone)
    span = Span(pause.starts_on, pause.ends_on)
    if span.effective_end() < today:
        raise HTTPException(status.HTTP_409_CONFLICT, "That pause has already ended")
    end = end_date_for(span, today)
    if end is None:
        await db.delete(pause)
    else:
        pause.ends_on = end
    await db.flush()
    await recompute(db, user.id, notify=False)
    await db.commit()
    return await _pause_state(db, user)


@router.delete("/pauses/{pause_id}", status_code=204)
async def delete_pause(
    pause_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Remove a pause that has not started, or undo one declared by mistake
    within a day. A pause that has already sheltered weeks is ended, not
    deleted - deleting it would silently break a streak it has been holding."""
    pause = await _own_pause(db, user, pause_id)
    profile = await get_profile(db, user.id)
    today = local_today(profile.timezone)
    recent = pause.created_at >= utcnow() - timedelta(hours=24)
    if pause.starts_on <= today and not recent:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "A pause that has started can be ended, not deleted"
        )
    await db.delete(pause)
    await db.flush()
    await recompute(db, user.id, notify=False)
    await db.commit()
