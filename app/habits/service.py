"""Loading habits with their streaks, for the API and for the game engine."""

from collections import defaultdict
from datetime import date, timedelta
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.habits.engine import HabitDay, HabitView, view_habit
from app.habits.models import Habit, HabitLog


async def habit_views(
    db: AsyncSession,
    user_id: UUID,
    today: date,
    week_starts_on: int,
    paused: set[date],
    include_archived: bool = False,
) -> list[tuple[Habit, HabitView, list[HabitDay]]]:
    query = select(Habit).where(Habit.user_id == user_id)
    if not include_archived:
        query = query.where(Habit.archived_at.is_(None))
    habits = list((await db.execute(query.order_by(Habit.position, Habit.created_at))).scalars())
    if not habits:
        return []
    logs: dict[UUID, list[HabitDay]] = defaultdict(list)
    for habit_id, day, amount in (
        await db.execute(
            select(HabitLog.habit_id, HabitLog.day, HabitLog.amount).where(
                HabitLog.user_id == user_id
            )
        )
    ).all():
        logs[habit_id].append(HabitDay(day, amount))
    return [
        (
            h,
            view_habit(
                kind=h.kind,
                daily_goal=h.daily_goal,
                weekly_target=h.weekly_target,
                started_on=h.started_on,
                logs=logs[h.id],
                today=today,
                week_starts_on=week_starts_on,
                paused_days=paused,
            ),
            logs[h.id],
        )
        for h in habits
    ]


def habit_summary(h: Habit, v: HabitView, today: date, logs: list[HabitDay] = ()) -> dict:
    r = v.chain
    by_day = {entry.day: entry.amount for entry in logs}
    return {
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
        "archived": h.archived_at is not None,
        "position": h.position,
        "today": {
            "amount": v.today_amount,
            "done": today in v.done_days,
        },
        "streak": {
            "current": r.current,
            "longest": r.longest,
            "this_week_days": r.this_week_days,
            "this_week_target": r.this_week_target,
            "needed": r.needed,
            "days_left": r.days_left,
            "at_risk": r.at_risk,
            "freezes_available": r.freezes_available,
            "consistency": r.consistency,
        },
        "strength": v.strength,
        "total": v.total,
        "clean_run": v.clean_run,
        "best_clean_run": v.best_clean_run,
        "last_slip": v.last_slip.isoformat() if v.last_slip else None,
        # The last seven days, oldest first, for the week strip on each row.
        "recent": [
            {"date": d.isoformat(), "amount": by_day.get(d, 0.0)}
            for d in (today - timedelta(days=i) for i in range(6, -1, -1))
        ],
    }
