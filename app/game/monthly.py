"""The monthly strength recap: one calendar month of lifting, summed up.

Every number is measured against the person's own history - how a lift's best
estimated 1RM this month compares with their best before it - so it reads the
same for a beginner and a veteran. Like the weekly recap it reports no volume
or tonnage: bigger totals are not the point, getting a little better is.
"""

from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.game.records import e1rm
from app.game.service import Snapshot, exercise_meta
from app.training.models import CustomExercise, Workout, WorkoutSet

TOP_LIFTS = 5


def month_bounds(month: str) -> tuple[date, date]:
    first = date.fromisoformat(f"{month}-01")
    nxt = (first.replace(day=28) + timedelta(days=4)).replace(day=1)
    return first, nxt - timedelta(days=1)


async def build_month(db: AsyncSession, snap: Snapshot, month: str) -> dict | None:
    first, last = month_bounds(month)
    uid = snap.profile.user_id
    rows = (
        await db.execute(
            select(
                WorkoutSet.exercise_id, WorkoutSet.weight_kg, WorkoutSet.reps, Workout.local_date
            )
            .join(Workout, Workout.id == WorkoutSet.workout_id)
            .where(
                WorkoutSet.user_id == uid,
                Workout.deleted_at.is_(None),
                WorkoutSet.completed.is_(True),
                WorkoutSet.kind != "warmup",
                Workout.local_date <= last,
                WorkoutSet.weight_kg > 0,
                WorkoutSet.reps > 0,
            )
        )
    ).all()
    sessions = (
        (
            await db.execute(
                select(Workout.local_date).where(
                    Workout.user_id == uid,
                    Workout.deleted_at.is_(None),
                    Workout.local_date.between(first, last),
                )
            )
        )
        .scalars()
        .all()
    )
    if not sessions:
        return None
    customs = {
        c.exercise_id: c
        for c in (
            await db.execute(select(CustomExercise).where(CustomExercise.user_id == uid))
        ).scalars()
    }

    before: dict[str, float] = defaultdict(float)
    during: dict[str, float] = defaultdict(float)
    days: dict[str, set[date]] = defaultdict(set)
    for exercise_id, kg, reps, day in rows:
        value = e1rm(kg, reps) or 0
        if day < first:
            before[exercise_id] = max(before[exercise_id], value)
        else:
            during[exercise_id] = max(during[exercise_id], value)
            days[exercise_id].add(day)

    lifts = []
    for exercise_id in sorted(days, key=lambda x: (-len(days[x]), x))[:TOP_LIFTS]:
        now, then = during[exercise_id], before.get(exercise_id)
        lifts.append(
            {
                "exercise_id": exercise_id,
                "name": exercise_meta(exercise_id, customs)[0],
                "sessions": len(days[exercise_id]),
                "best_e1rm": round(now, 1),
                "previous_best": round(then, 1) if then else None,
                "change_pct": round((now - then) / then * 100, 1) if then else None,
            }
        )

    prs = [e for e in snap.events if e.rewarded and first <= e.day <= last]
    weeks = [
        c
        for c in snap.chains[0].result.weeks
        if first <= c.week_start + timedelta(days=6) and c.week_start <= last
    ]
    steadiest = lifts[0] if lifts else None
    return {
        "month": month,
        "starts_on": first.isoformat(),
        "ends_on": last.isoformat(),
        "complete": last < snap.today,
        "sessions": len(sessions),
        "active_days": len(set(sessions)),
        "weeks_kept": sum(1 for c in weeks if c.status == "kept"),
        "weeks": len([c for c in weeks if c.status != "open"]),
        "records": len(prs),
        "lifts": lifts,
        "steadiest": steadiest["name"] if steadiest and steadiest["sessions"] > 1 else None,
        "pr_streak": snap.pr_streak.current if snap.pr_streak else 0,
    }
