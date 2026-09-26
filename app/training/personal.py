"""Gyms, exercise notes, the weight goal, training blocks, readiness check-ins
and weekly reflections. All private to their owner."""

from datetime import date, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.time import local_today, utcnow, week_start
from app.database import get_db
from app.profile.service import get_profile
from app.training.library import CUSTOM_PREFIX, EXERCISE_BY_ID
from app.training.models import (
    CustomExercise,
    ExerciseNote,
    Gym,
    Readiness,
    TrainingBlock,
    WeekReflection,
    WeighIn,
    WeightGoal,
)
from app.training.schemas import (
    BlockIn,
    ExerciseNoteIn,
    GymIn,
    ReadinessIn,
    ReflectionIn,
    WeightGoalIn,
)

router = APIRouter(tags=["training"])

MAX_GYMS = 10


# --- gyms ------------------------------------------------------------------------


def _gym_out(g: Gym) -> dict:
    return {
        "id": str(g.id),
        "name": g.name,
        "equipment": g.equipment,
        "plates_kg": g.plates_kg,
        "bar_kg": g.bar_kg,
        "is_default": g.is_default,
    }


async def _own_gym(db: AsyncSession, user: User, gym_id: UUID) -> Gym:
    gym = await db.get(Gym, gym_id)
    if gym is None or gym.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return gym


async def _only_default(db: AsyncSession, user: User, keep: Gym) -> None:
    if keep.is_default:
        await db.execute(
            update(Gym).where(Gym.user_id == user.id, Gym.id != keep.id).values(is_default=False)
        )


@router.get("/gyms")
async def list_gyms(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = await db.execute(
        select(Gym).where(Gym.user_id == user.id).order_by(Gym.is_default.desc(), Gym.created_at)
    )
    return [_gym_out(g) for g in rows.scalars()]


@router.post("/gyms", status_code=201)
async def create_gym(
    body: GymIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    count = (
        await db.execute(select(func.count()).select_from(Gym).where(Gym.user_id == user.id))
    ).scalar_one()
    if count >= MAX_GYMS:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{MAX_GYMS} gyms is the limit")
    gym = Gym(user_id=user.id, **(body.model_dump() | {"name": body.name.strip()}))
    # The first gym is the default one; nobody should have to say so.
    gym.is_default = body.is_default or count == 0
    db.add(gym)
    await db.flush()
    await _only_default(db, user, gym)
    await db.commit()
    return _gym_out(gym)


@router.put("/gyms/{gym_id}")
async def update_gym(
    gym_id: UUID,
    body: GymIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    gym = await _own_gym(db, user, gym_id)
    for key, value in (body.model_dump() | {"name": body.name.strip()}).items():
        setattr(gym, key, value)
    await _only_default(db, user, gym)
    await db.commit()
    return _gym_out(gym)


@router.delete("/gyms/{gym_id}", status_code=204)
async def delete_gym(
    gym_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    gym = await _own_gym(db, user, gym_id)
    await db.delete(gym)
    await db.commit()


# --- exercise notes --------------------------------------------------------------


async def _known_exercise(db: AsyncSession, user: User, exercise_id: str) -> None:
    if exercise_id in EXERCISE_BY_ID:
        return
    if exercise_id.startswith(CUSTOM_PREFIX):
        try:
            custom_id = UUID(exercise_id.removeprefix(CUSTOM_PREFIX))
        except ValueError:
            custom_id = None
        if custom_id is not None:
            custom = await db.get(CustomExercise, custom_id)
            if custom is not None and custom.user_id == user.id:
                return
    raise HTTPException(status.HTTP_404_NOT_FOUND, "No such exercise")


@router.get("/exercise-notes")
async def list_notes(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = await db.execute(select(ExerciseNote).where(ExerciseNote.user_id == user.id))
    return {n.exercise_id: n.note for n in rows.scalars()}


@router.put("/exercise-notes/{exercise_id}")
async def put_note(
    exercise_id: str,
    body: ExerciseNoteIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Set the note that stays with an exercise. An empty note removes it."""
    await _known_exercise(db, user, exercise_id)
    text = body.note.strip()
    existing = (
        await db.execute(
            select(ExerciseNote).where(
                ExerciseNote.user_id == user.id, ExerciseNote.exercise_id == exercise_id
            )
        )
    ).scalar_one_or_none()
    if not text:
        if existing is not None:
            await db.delete(existing)
        await db.commit()
        return {"exercise_id": exercise_id, "note": None}
    if existing is None:
        existing = ExerciseNote(user_id=user.id, exercise_id=exercise_id, note=text)
        db.add(existing)
    else:
        existing.note = text
    await db.commit()
    return {"exercise_id": exercise_id, "note": text}


# --- weight goal -------------------------------------------------------------------


def _goal_out(g: WeightGoal) -> dict:
    return {
        "target_kg": g.target_kg,
        "start_kg": g.start_kg,
        "milestone_kg": g.milestone_kg,
        "set_on": g.set_on.isoformat(),
    }


@router.get("/weight-goal")
async def get_goal(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    goal = (
        await db.execute(select(WeightGoal).where(WeightGoal.user_id == user.id))
    ).scalar_one_or_none()
    return _goal_out(goal) if goal else None


@router.put("/weight-goal")
async def put_goal(
    body: WeightGoalIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Private. Starts from the last week's average weigh-in, so progress is
    measured from the trend rather than from one reading."""
    profile = await get_profile(db, user.id)
    today = local_today(profile.timezone)
    start = (
        await db.execute(
            select(func.avg(WeighIn.weight_kg)).where(
                WeighIn.user_id == user.id, WeighIn.local_date > today - timedelta(days=7)
            )
        )
    ).scalar_one_or_none()
    if start is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Weigh in first, so the goal has somewhere to start"
        )
    goal = (
        await db.execute(select(WeightGoal).where(WeightGoal.user_id == user.id))
    ).scalar_one_or_none()
    if goal is None:
        goal = WeightGoal(user_id=user.id)
        db.add(goal)
    goal.target_kg = round(body.target_kg, 2)
    goal.milestone_kg = body.milestone_kg
    goal.start_kg = round(float(start), 2)
    goal.set_on = today
    await db.commit()
    return _goal_out(goal)


@router.delete("/weight-goal", status_code=204)
async def delete_goal(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await db.execute(delete(WeightGoal).where(WeightGoal.user_id == user.id))
    await db.commit()
    return Response(status_code=204)


# --- training blocks ---------------------------------------------------------------


def block_week(block: TrainingBlock, today: date) -> dict | None:
    """Where today falls in a block, or None when it hasn't started or is
    over. Reps in reserve step down evenly over the working weeks; the last
    week is lighter, with more in reserve and fewer sets."""
    index = (today - block.starts_on).days // 7
    if index < 0 or index >= block.weeks or block.ended_at is not None:
        return None
    working = block.weeks - 1
    deload = index == working
    if deload:
        rir = max(block.rir_start + 1, 4)
    elif working == 1:
        rir = block.rir_start
    else:
        step = (block.rir_start - block.rir_end) / (working - 1)
        rir = round(block.rir_start - step * index)
    return {"week": index + 1, "weeks": block.weeks, "deload": deload, "rir": rir}


def _block_out(b: TrainingBlock, today: date) -> dict:
    return {
        "id": str(b.id),
        "name": b.name,
        "starts_on": b.starts_on.isoformat(),
        "weeks": b.weeks,
        "rir_start": b.rir_start,
        "rir_end": b.rir_end,
        "ended": b.ended_at is not None or (today - b.starts_on).days >= b.weeks * 7,
        "now": block_week(b, today),
    }


async def _live_blocks(db: AsyncSession, user: User) -> list[TrainingBlock]:
    rows = await db.execute(
        select(TrainingBlock)
        .where(TrainingBlock.user_id == user.id, TrainingBlock.ended_at.is_(None))
        .order_by(TrainingBlock.starts_on.desc())
    )
    return list(rows.scalars())


@router.get("/blocks/active")
async def active_block(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """The running block, or the next one if it starts next week."""
    profile = await get_profile(db, user.id)
    today = local_today(profile.timezone)
    for b in await _live_blocks(db, user):
        out = _block_out(b, today)
        if not out["ended"]:
            return out
    return None


@router.post("/blocks", status_code=201)
async def start_block(
    body: BlockIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    if body.rir_end > body.rir_start:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Reps in reserve should fall, not rise"
        )
    profile = await get_profile(db, user.id)
    today = local_today(profile.timezone)
    # One block at a time: starting one ends the last.
    for b in await _live_blocks(db, user):
        b.ended_at = utcnow()
    start = week_start(today, profile.week_starts_on) + timedelta(
        weeks=1 if body.when == "next" else 0
    )
    block = TrainingBlock(
        user_id=user.id,
        name=body.name.strip(),
        starts_on=start,
        weeks=body.weeks,
        rir_start=body.rir_start,
        rir_end=body.rir_end,
    )
    db.add(block)
    await db.commit()
    return _block_out(block, today)


@router.post("/blocks/{block_id}/end", status_code=204)
async def end_block(
    block_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    block = await db.get(TrainingBlock, block_id)
    if block is None or block.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    block.ended_at = block.ended_at or utcnow()
    await db.commit()


# --- readiness ------------------------------------------------------------------------


def _readiness_out(r: Readiness) -> dict:
    return {"date": r.day.isoformat(), "sleep": r.sleep, "energy": r.energy, "soreness": r.soreness}


@router.get("/readiness")
async def list_readiness(
    days: int = 30, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    profile = await get_profile(db, user.id)
    since = local_today(profile.timezone) - timedelta(days=max(1, min(days, 365)))
    rows = await db.execute(
        select(Readiness)
        .where(Readiness.user_id == user.id, Readiness.day >= since)
        .order_by(Readiness.day)
    )
    return [_readiness_out(r) for r in rows.scalars()]


@router.put("/readiness/{day}")
async def put_readiness(
    day: date,
    body: ReadinessIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    profile = await get_profile(db, user.id)
    today = local_today(profile.timezone)
    if not today - timedelta(days=2) <= day <= today:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Check-ins are for today or the last two days"
        )
    row = (
        await db.execute(
            select(Readiness).where(Readiness.user_id == user.id, Readiness.day == day)
        )
    ).scalar_one_or_none()
    if row is None:
        row = Readiness(user_id=user.id, day=day)
        db.add(row)
    row.sleep, row.energy, row.soreness = body.sleep, body.energy, body.soreness
    await db.commit()
    return _readiness_out(row)


# --- weekly reflections -------------------------------------------------------------


def _reflection_out(r: WeekReflection) -> dict:
    return {"week_start": r.week_start.isoformat(), "went_well": r.went_well, "change": r.change}


@router.get("/reflections")
async def list_reflections(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    rows = await db.execute(
        select(WeekReflection)
        .where(WeekReflection.user_id == user.id)
        .order_by(WeekReflection.week_start.desc())
    )
    return [_reflection_out(r) for r in rows.scalars()]


@router.put("/reflections/{week}")
async def put_reflection(
    week: date,
    body: ReflectionIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """One reflection per week. Both fields empty removes it."""
    profile = await get_profile(db, user.id)
    start = week_start(week, profile.week_starts_on)
    if start > local_today(profile.timezone):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That week hasn't started")
    went_well = (body.went_well or "").strip() or None
    change = (body.change or "").strip() or None
    row = (
        await db.execute(
            select(WeekReflection).where(
                WeekReflection.user_id == user.id, WeekReflection.week_start == start
            )
        )
    ).scalar_one_or_none()
    if went_well is None and change is None:
        if row is not None:
            await db.delete(row)
        await db.commit()
        return None
    if row is None:
        row = WeekReflection(user_id=user.id, week_start=start)
        db.add(row)
    row.went_well, row.change = went_well, change
    await db.commit()
    return _reflection_out(row)
