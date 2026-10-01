"""Habit routines: an ordered set of habits to step through together. The
routine holds only the order; each step is logged on the habit itself."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.database import get_db
from app.habits.models import Habit, HabitRoutine

router = APIRouter(prefix="/habit-routines", tags=["habits"])

MAX_ROUTINES = 10
MAX_STEPS = 20


class RoutineIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    emoji: str = Field(default="🌅", min_length=1, max_length=8)
    time_of_day: Literal["morning", "afternoon", "evening", "anytime"] = "morning"
    habit_ids: list[UUID] = Field(min_length=1, max_length=MAX_STEPS)


async def _live_ids(db: AsyncSession, user: User) -> set[str]:
    rows = await db.execute(
        select(Habit.id).where(Habit.user_id == user.id, Habit.archived_at.is_(None))
    )
    return {str(i) for i in rows.scalars()}


def _out(r: HabitRoutine, live: set[str]) -> dict:
    return {
        "id": str(r.id),
        "name": r.name,
        "emoji": r.emoji,
        "time_of_day": r.time_of_day,
        # Archived or deleted habits drop out of the run without editing it.
        "habit_ids": [h for h in r.habit_ids if h in live],
    }


async def _own(db: AsyncSession, user: User, routine_id: UUID) -> HabitRoutine:
    routine = await db.get(HabitRoutine, routine_id)
    if routine is None or routine.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return routine


async def _fill(db: AsyncSession, user: User, routine: HabitRoutine, body: RoutineIn) -> set[str]:
    live = await _live_ids(db, user)
    ids = list(dict.fromkeys(str(i) for i in body.habit_ids))
    if any(i not in live for i in ids):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "A habit in this routine doesn't exist")
    routine.name, routine.emoji = body.name.strip(), body.emoji
    routine.time_of_day, routine.habit_ids = body.time_of_day, ids
    return live


@router.get("")
async def list_routines(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    live = await _live_ids(db, user)
    rows = await db.execute(
        select(HabitRoutine)
        .where(HabitRoutine.user_id == user.id)
        .order_by(HabitRoutine.created_at)
    )
    return [_out(r, live) for r in rows.scalars()]


@router.post("", status_code=201)
async def create_routine(
    body: RoutineIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    count = (
        await db.execute(
            select(func.count()).select_from(HabitRoutine).where(HabitRoutine.user_id == user.id)
        )
    ).scalar_one()
    if count >= MAX_ROUTINES:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{MAX_ROUTINES} routines is the limit")
    routine = HabitRoutine(user_id=user.id)
    live = await _fill(db, user, routine, body)
    db.add(routine)
    await db.commit()
    return _out(routine, live)


@router.put("/{routine_id}")
async def update_routine(
    routine_id: UUID,
    body: RoutineIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    routine = await _own(db, user, routine_id)
    live = await _fill(db, user, routine, body)
    await db.commit()
    return _out(routine, live)


@router.delete("/{routine_id}", status_code=204)
async def delete_routine(
    routine_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    routine = await _own(db, user, routine_id)
    await db.delete(routine)
    await db.commit()
