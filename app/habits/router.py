"""Habits: anything worth doing regularly, alongside training.

Private to their owner. Each keeps its own week-based streak; days can be
filled in or corrected up to BACKFILL_DAYS back, because a tracker that can't
fix yesterday's missed tick is the most common complaint about these apps.
"""

from datetime import date, timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.time import local_today, utcnow
from app.database import get_db
from app.game.service import recompute, weeks_payload
from app.habits.catalog import TEMPLATE_BY_ID, catalog_payload
from app.habits.models import HABIT_CATEGORIES, Habit, HabitLog
from app.habits.service import habit_summary, habit_views
from app.profile.service import get_profile
from app.training.models import StreakPause
from app.training.pauses import Span, paused_days

router = APIRouter(prefix="/habits", tags=["habits"])

MAX_HABITS = 30
BACKFILL_DAYS = 60
Kind = Literal["check", "duration", "count", "quit"]
TimeOfDay = Literal["morning", "afternoon", "evening", "anytime"]


class HabitIn(BaseModel):
    template_id: str | None = None
    name: str | None = Field(default=None, min_length=1, max_length=60)
    emoji: str | None = Field(default=None, min_length=1, max_length=8)
    category: str | None = None
    kind: Kind | None = None
    unit: str | None = Field(default=None, max_length=20)
    daily_goal: float | None = Field(default=None, gt=0, le=100_000)
    weekly_target: int | None = Field(default=None, ge=1, le=7)
    time_of_day: TimeOfDay | None = None
    cue: str | None = Field(default=None, max_length=120)
    why: str | None = Field(default=None, max_length=200)
    total_goal: float | None = Field(default=None, gt=0, le=10_000_000)
    remind_hour: int | None = Field(default=None, ge=0, le=23)

    @field_validator("category")
    @classmethod
    def _category(cls, v: str | None) -> str | None:
        if v is not None and v not in HABIT_CATEGORIES:
            raise ValueError("unknown category")
        return v


class DayIn(BaseModel):
    amount: float = Field(ge=0, le=100_000)
    note: str | None = Field(default=None, max_length=280)


class AddIn(BaseModel):
    amount: float = Field(default=1, gt=0, le=100_000)


async def _context(db: AsyncSession, user: User):
    profile = await get_profile(db, user.id)
    today = local_today(profile.timezone)
    pauses = (await db.execute(select(StreakPause).where(StreakPause.user_id == user.id))).scalars()
    sheltered = paused_days([Span(p.starts_on, p.ends_on) for p in pauses])
    return profile, today, sheltered


async def _own(db: AsyncSession, user: User, habit_id: UUID) -> Habit:
    habit = await db.get(Habit, habit_id)
    if habit is None or habit.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return habit


async def _one(db: AsyncSession, user: User, habit: Habit, days: int = 0) -> dict:
    profile, today, sheltered = await _context(db, user)
    for h, v, logs in await habit_views(
        db, user.id, today, profile.week_starts_on, sheltered, include_archived=True
    ):
        if h.id != habit.id:
            continue
        out = habit_summary(h, v, today, logs)
        if days:
            since = today - timedelta(days=days)
            out["days"] = [
                {"date": entry.day.isoformat(), "amount": entry.amount}
                for entry in sorted(logs, key=lambda e: e.day)
                if entry.day >= since
            ]
            out["weeks"] = weeks_payload(v.chain, 26)
        return out
    raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")


@router.get("/catalog")
async def catalog(response: Response):
    response.headers["Cache-Control"] = "public, max-age=3600"
    return catalog_payload()


@router.get("")
async def list_habits(
    archived: bool = False,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    profile, today, sheltered = await _context(db, user)
    views = await habit_views(
        db, user.id, today, profile.week_starts_on, sheltered, include_archived=archived
    )
    return [
        habit_summary(h, v, today, logs)
        for h, v, logs in views
        if archived or h.archived_at is None
    ]


@router.post("", status_code=201)
async def create_habit(
    body: HabitIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    count = (
        await db.execute(
            select(func.count())
            .select_from(Habit)
            .where(Habit.user_id == user.id, Habit.archived_at.is_(None))
        )
    ).scalar_one()
    if count >= MAX_HABITS:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{MAX_HABITS} habits at once is the limit. Fewer, kept, beats more, dropped.",
        )
    fields = body.model_dump(exclude_unset=True)
    base: dict = {}
    if body.template_id:
        template = TEMPLATE_BY_ID.get(body.template_id)
        if template is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such template")
        base = {
            "name": template.name,
            "emoji": template.emoji,
            "category": template.category,
            "kind": template.kind,
            "unit": template.unit,
            "daily_goal": template.daily_goal,
            "weekly_target": template.weekly_target,
            "time_of_day": template.time_of_day,
            "cue": template.cue,
            "total_goal": template.total_goal,
        }
    data = base | {k: v for k, v in fields.items() if k != "template_id"}
    if not data.get("name"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Give the habit a name")
    kind = data.get("kind") or "check"
    if kind in ("duration", "count") and not data.get("daily_goal"):
        data["daily_goal"] = 1
    profile, today, _ = await _context(db, user)
    habit = Habit(
        user_id=user.id,
        name=data["name"].strip(),
        emoji=data.get("emoji") or "✨",
        category=data.get("category") or ("break" if kind == "quit" else "other"),
        kind=kind,
        unit=(data.get("unit") or "minutes") if kind == "duration" else data.get("unit"),
        daily_goal=data.get("daily_goal") if kind in ("duration", "count") else None,
        weekly_target=data.get("weekly_target") or 7,
        time_of_day=data.get("time_of_day") or "anytime",
        cue=(data.get("cue") or "").strip() or None,
        why=(data.get("why") or "").strip() or None,
        total_goal=data.get("total_goal") if kind in ("duration", "count") else None,
        remind_hour=data.get("remind_hour"),
        template_id=body.template_id,
        started_on=today,
        position=count,
    )
    db.add(habit)
    await db.flush()
    await recompute(db, user.id, notify=False)
    await db.commit()
    return await _one(db, user, habit)


class OrderIn(BaseModel):
    ids: list[UUID] = Field(max_length=MAX_HABITS * 3)


@router.put("/order", status_code=204)
async def reorder(
    body: OrderIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    for index, habit_id in enumerate(body.ids):
        habit = await db.get(Habit, habit_id)
        if habit is not None and habit.user_id == user.id:
            habit.position = index
    await db.commit()


@router.get("/{habit_id}")
async def get_habit(
    habit_id: UUID,
    days: int = Query(default=365, ge=7, le=730),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _one(db, user, await _own(db, user, habit_id), days=days)


@router.patch("/{habit_id}")
async def update_habit(
    habit_id: UUID,
    body: HabitIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Change anything but the kind. Clearing a field (cue, reminder, goals)
    is sending it as null."""
    habit = await _own(db, user, habit_id)
    data = body.model_dump(exclude_unset=True)
    data.pop("template_id", None)
    if "kind" in data and data["kind"] != habit.kind:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "A habit's kind can't change, since its history means something different. "
            "Start a new one instead.",
        )
    for key, value in data.items():
        if key == "name" and not value:
            continue
        if isinstance(value, str):
            value = value.strip() or None
        setattr(habit, key, value)
    await db.flush()
    await recompute(db, user.id, notify=False)
    await db.commit()
    return await _one(db, user, habit)


@router.post("/{habit_id}/archive")
async def archive_habit(
    habit_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Stop tracking without losing the history. XP already earned stays."""
    habit = await _own(db, user, habit_id)
    habit.archived_at = habit.archived_at or utcnow()
    await db.commit()
    return await _one(db, user, habit)


@router.post("/{habit_id}/unarchive")
async def unarchive_habit(
    habit_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    habit = await _own(db, user, habit_id)
    habit.archived_at = None
    await db.commit()
    return await _one(db, user, habit)


@router.delete("/{habit_id}", status_code=204)
async def delete_habit(
    habit_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    habit = await _own(db, user, habit_id)
    await db.delete(habit)
    await db.flush()
    await recompute(db, user.id, notify=False)
    await db.commit()


async def _day(db: AsyncSession, user: User, habit: Habit, day: date) -> HabitLog | None:
    return (
        await db.execute(select(HabitLog).where(HabitLog.habit_id == habit.id, HabitLog.day == day))
    ).scalar_one_or_none()


def _check_day(day: date, today: date) -> None:
    if day > today:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That day hasn't happened yet")
    if day < today - timedelta(days=BACKFILL_DAYS):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Days can be filled in up to {BACKFILL_DAYS} days back",
        )


@router.put("/{habit_id}/days/{day}")
async def set_day(
    habit_id: UUID,
    day: date,
    body: DayIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Set a day's amount outright: 1 for a check, minutes, a count, or for a
    quit habit the number of slips. Zero clears the day. Idempotent, so an
    offline retry is harmless."""
    habit = await _own(db, user, habit_id)
    _, today, _ = await _context(db, user)
    _check_day(day, today)
    row = await _day(db, user, habit, day)
    if body.amount <= 0:
        if row is not None:
            await db.delete(row)
    else:
        if row is None:
            row = HabitLog(habit_id=habit.id, user_id=user.id, day=day, amount=body.amount)
            db.add(row)
        row.amount = body.amount
        row.note = (body.note or "").strip() or None
        # Filling in a day before the habit began moves its start back.
        habit.started_on = min(habit.started_on, day)
    await db.flush()
    await recompute(db, user.id, notify=True)
    await db.commit()
    return await _one(db, user, habit)


@router.post("/{habit_id}/days/{day}/add")
async def add_to_day(
    habit_id: UUID,
    day: date,
    body: AddIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add to a day: another glass, ten more minutes. Not idempotent, so the
    app sends absolute amounts with PUT when it may need to retry."""
    habit = await _own(db, user, habit_id)
    _, today, _ = await _context(db, user)
    _check_day(day, today)
    row = await _day(db, user, habit, day)
    if row is None:
        row = HabitLog(habit_id=habit.id, user_id=user.id, day=day, amount=0)
        db.add(row)
    row.amount = min(100_000, row.amount + body.amount)
    habit.started_on = min(habit.started_on, day)
    await db.flush()
    await recompute(db, user.id, notify=True)
    await db.commit()
    return await _one(db, user, habit)
