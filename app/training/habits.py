"""Monthly goals and logged rest days: two small, private habits.

Neither touches the streak. A monthly goal is a personal target of active
days for one month; a rest day is a day off recorded on purpose so the grid
shows it as a choice. Both are private and never ranked.
"""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.time import local_today
from app.database import get_db
from app.profile.service import get_profile
from app.training.models import MonthlyGoal, RestDay, Workout

router = APIRouter(prefix="/me", tags=["training"])

MONTH = r"^\d{4}-(0[1-9]|1[0-2])$"
REST_BACK_DAYS = 365
REST_AHEAD_DAYS = 7


def _bounds(month: str) -> tuple[date, date]:
    y, m = (int(x) for x in month.split("-"))
    first = date(y, m, 1)
    last = (date(y + (m == 12), m % 12 + 1, 1)) - timedelta(days=1)
    return first, last


class GoalIn(BaseModel):
    month: str = Field(pattern=MONTH)
    days: int = Field(ge=1, le=31)


async def _goal_view(db: AsyncSession, user: User, month: str) -> dict:
    profile = await get_profile(db, user.id)
    today = local_today(profile.timezone)
    first, last = _bounds(month)
    goal = (
        await db.execute(
            select(MonthlyGoal.days).where(
                MonthlyGoal.user_id == user.id, MonthlyGoal.month == month
            )
        )
    ).scalar_one_or_none()
    done = (
        await db.execute(
            select(func.count(func.distinct(Workout.local_date))).where(
                Workout.user_id == user.id,
                Workout.deleted_at.is_(None),
                Workout.local_date >= first,
                Workout.local_date <= min(last, today),
            )
        )
    ).scalar_one()
    days_left = 0 if today > last else (last - max(today, first)).days + 1
    return {
        "month": month,
        "goal": goal,
        "done": done,
        "days_in_month": last.day,
        "days_left": days_left,
        "reachable": goal is None or done + days_left >= goal,
    }


@router.get("/monthly-goal")
async def get_goal(
    month: str | None = Query(default=None, pattern=MONTH),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if month is None:
        month = local_today((await get_profile(db, user.id)).timezone).strftime("%Y-%m")
    return await _goal_view(db, user, month)


@router.put("/monthly-goal")
async def set_goal(
    body: GoalIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    first, last = _bounds(body.month)
    if body.days > last.day:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"{body.month} has {last.day} days"
        )
    today = local_today((await get_profile(db, user.id)).timezone)
    if last < today.replace(day=1):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That month is over")
    await db.execute(
        insert(MonthlyGoal)
        .values(user_id=user.id, month=body.month, days=body.days)
        .on_conflict_do_update(constraint="uq_monthly_goal", set_={"days": body.days})
    )
    await db.commit()
    return await _goal_view(db, user, body.month)


@router.delete("/monthly-goal/{month}", status_code=204)
async def clear_goal(
    month: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await db.execute(
        delete(MonthlyGoal).where(MonthlyGoal.user_id == user.id, MonthlyGoal.month == month)
    )
    await db.commit()


class RestIn(BaseModel):
    kind: str = Field(default="rest", pattern="^(rest|sleep|mobility|sick)$")
    note: str | None = Field(default=None, max_length=200)

    @field_validator("note")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return (v or "").strip() or None


def _rest_out(r: RestDay) -> dict:
    return {"day": r.day.isoformat(), "kind": r.kind, "note": r.note}


@router.get("/rest-days")
async def list_rest_days(
    since: date | None = Query(default=None, alias="from"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    today = local_today((await get_profile(db, user.id)).timezone)
    start = since or today - timedelta(days=REST_BACK_DAYS)
    rows = (
        (
            await db.execute(
                select(RestDay)
                .where(RestDay.user_id == user.id, RestDay.day >= start)
                .order_by(RestDay.day)
            )
        )
        .scalars()
        .all()
    )
    return [_rest_out(r) for r in rows]


@router.put("/rest-days/{day}")
async def put_rest_day(
    day: date,
    body: RestIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    today = local_today((await get_profile(db, user.id)).timezone)
    if day > today + timedelta(days=REST_AHEAD_DAYS) or day < today - timedelta(
        days=REST_BACK_DAYS
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Rest days can be logged up to {REST_AHEAD_DAYS} days ahead and a year back",
        )
    row = (
        await db.execute(
            insert(RestDay)
            .values(user_id=user.id, day=day, kind=body.kind, note=body.note)
            .on_conflict_do_update(
                constraint="uq_rest_day", set_={"kind": body.kind, "note": body.note}
            )
            .returning(RestDay)
        )
    ).scalar_one()
    await db.commit()
    return _rest_out(row)


@router.delete("/rest-days/{day}", status_code=204)
async def delete_rest_day(
    day: date, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await db.execute(delete(RestDay).where(RestDay.user_id == user.id, RestDay.day == day))
    await db.commit()
