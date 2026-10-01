"""The daily journal (mood and a note) and the insights built from it and
everything else a person logs. All private to their owner."""

from collections import defaultdict
from dataclasses import asdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.time import local_today
from app.database import get_db
from app.habits.models import Habit, HabitLog
from app.insights.engine import find
from app.insights.models import JournalDay
from app.nutrition.models import MealEntry
from app.profile.service import get_profile
from app.training.models import BodyMetric, Readiness, Workout

router = APIRouter(tags=["insights"])

WINDOW_DAYS = 90
BACKFILL_DAYS = 60


class JournalIn(BaseModel):
    mood: int | None = Field(default=None, ge=1, le=5)
    note: str | None = Field(default=None, max_length=1000)


def _journal_out(j: JournalDay) -> dict:
    return {"date": j.day.isoformat(), "mood": j.mood, "note": j.note}


async def _today(db: AsyncSession, user: User) -> date:
    return local_today((await get_profile(db, user.id)).timezone)


@router.get("/journal")
async def list_journal(
    days: int = Query(default=366, ge=1, le=1100),
    q: str | None = Query(default=None, max_length=60),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    since = await _today(db, user) - timedelta(days=days - 1)
    query = select(JournalDay).where(JournalDay.user_id == user.id, JournalDay.day >= since)
    if q:
        query = query.where(JournalDay.note.ilike(f"%{q.replace('%', '').replace('_', '')}%"))
    rows = await db.execute(query.order_by(JournalDay.day))
    return [_journal_out(j) for j in rows.scalars()]


@router.put("/journal/{day}")
async def put_journal(
    day: date,
    body: JournalIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Both empty removes the day. Idempotent, so an offline retry is safe."""
    today = await _today(db, user)
    if not today - timedelta(days=BACKFILL_DAYS) <= day <= today:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Journal days are for today or the last {BACKFILL_DAYS} days",
        )
    note = (body.note or "").strip() or None
    row = (
        await db.execute(
            select(JournalDay).where(JournalDay.user_id == user.id, JournalDay.day == day)
        )
    ).scalar_one_or_none()
    if body.mood is None and note is None:
        if row is not None:
            await db.delete(row)
        await db.commit()
        return None
    if row is None:
        row = JournalDay(user_id=user.id, day=day)
        db.add(row)
    row.mood, row.note = body.mood, note
    await db.commit()
    return _journal_out(row)


@router.delete("/journal/{day}", status_code=204)
async def delete_journal(
    day: date, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await db.execute(delete(JournalDay).where(JournalDay.user_id == user.id, JournalDay.day == day))
    await db.commit()
    return Response(status_code=204)


async def build_series(db: AsyncSession, user_id, today: date) -> dict[str, dict[date, float]]:
    """Every daily series the engine knows, over the window before today.
    Today is left out: it isn't over, so its habits and food are partial."""
    start, end = today - timedelta(days=WINDOW_DAYS), today - timedelta(days=1)
    series: dict[str, dict[date, float]] = defaultdict(dict)

    for r in (
        await db.execute(
            select(Readiness).where(Readiness.user_id == user_id, Readiness.day.between(start, end))
        )
    ).scalars():
        series["sleep"][r.day] = r.sleep
        series["energy"][r.day] = r.energy
    for m in (
        await db.execute(
            select(BodyMetric).where(
                BodyMetric.user_id == user_id,
                BodyMetric.measured_on.between(start, end),
                BodyMetric.sleep_hours.is_not(None),
            )
        )
    ).scalars():
        series["sleep_hours"][m.measured_on] = m.sleep_hours
    for j in (
        await db.execute(
            select(JournalDay).where(
                JournalDay.user_id == user_id,
                JournalDay.day.between(start, end),
                JournalDay.mood.is_not(None),
            )
        )
    ).scalars():
        series["mood"][j.day] = j.mood

    # Training is known for every day once someone has started: no session
    # means they didn't train, not that the day is unknown.
    first = (
        await db.execute(
            select(func.min(Workout.local_date)).where(
                Workout.user_id == user_id, Workout.deleted_at.is_(None)
            )
        )
    ).scalar_one_or_none()
    if first is not None:
        trained = set(
            (
                await db.execute(
                    select(Workout.local_date).where(
                        Workout.user_id == user_id,
                        Workout.deleted_at.is_(None),
                        Workout.local_date.between(start, end),
                    )
                )
            ).scalars()
        )
        day = max(start, first)
        while day <= end:
            series["trained"][day] = 1.0 if day in trained else 0.0
            day += timedelta(days=1)

    # Habits: the share of live, non-quit habits done that day.
    habits = (
        (
            await db.execute(
                select(Habit).where(
                    Habit.user_id == user_id, Habit.archived_at.is_(None), Habit.kind != "quit"
                )
            )
        )
        .scalars()
        .all()
    )
    if habits:
        goal = {h.id: (h.daily_goal or 1) for h in habits}
        done: dict[date, int] = defaultdict(int)
        for log in (
            await db.execute(
                select(HabitLog).where(
                    HabitLog.user_id == user_id,
                    HabitLog.day.between(start, end),
                    HabitLog.habit_id.in_(goal.keys()),
                )
            )
        ).scalars():
            if log.amount >= goal[log.habit_id]:
                done[log.day] += 1
        day = start
        while day <= end:
            live = sum(1 for h in habits if h.started_on <= day)
            if live:
                series["habits"][day] = done[day] / live
            day += timedelta(days=1)

    for d, kcal, protein in await db.execute(
        select(MealEntry.day, func.sum(MealEntry.kcal), func.sum(MealEntry.protein_g))
        .where(MealEntry.user_id == user_id, MealEntry.day.between(start, end))
        .group_by(MealEntry.day)
    ):
        series["kcal"][d] = kcal
        series["protein_g"][d] = protein
    return series


@router.get("/insights")
async def insights(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    today = await _today(db, user)
    series = await build_series(db, user.id, today)
    found = find(series)
    return {
        "window_days": WINDOW_DAYS,
        "insights": [asdict(i) for i in found],
        # What's logged, so the app can say what would unlock more.
        "coverage": {k: len(v) for k, v in series.items()},
    }
