"""Search across everything someone has logged, and everything on one day.

Both are private to the owner. Search is a plain ILIKE over a handful of
short text columns, each capped and indexed by user: at personal-log scale
that is fast and predictable, and it needs no search engine to run or
secure. Results never leave the owner.
"""

from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.database import get_db
from app.habits.engine import is_done
from app.habits.models import Habit, HabitLog
from app.insights.models import JournalDay
from app.nutrition.models import Food, MealEntry, Recipe
from app.training.models import Readiness, RestDay, WeighIn, Workout

router = APIRouter(tags=["search"])

PER_KIND = 8


def _pattern(q: str) -> str:
    # % and _ are wildcards in LIKE; a search for "50%" means the characters.
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _snippet(text: str | None, q: str, width: int = 90) -> str | None:
    if not text:
        return None
    at = text.lower().find(q.lower())
    if at < 0 or len(text) <= width:
        return text[:width]
    start = max(0, at - width // 3)
    return (
        ("…" if start else "")
        + text[start : start + width]
        + ("…" if start + width < len(text) else "")
    )


@router.get("/search")
async def search(
    q: str = Query(min_length=2, max_length=60),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = q.strip()
    like = _pattern(q)
    uid = user.id
    results: list[dict] = []

    for h in (
        await db.execute(
            select(Habit)
            .where(
                Habit.user_id == uid,
                or_(Habit.name.ilike(like), Habit.cue.ilike(like), Habit.why.ilike(like)),
            )
            .order_by(Habit.archived_at.is_not(None), Habit.position)
            .limit(PER_KIND)
        )
    ).scalars():
        results.append(
            {
                "kind": "habit",
                "id": str(h.id),
                "title": f"{h.emoji} {h.name}",
                "detail": "Archived" if h.archived_at else _snippet(h.cue or h.why, q),
                "url": f"/habits/{h.id}",
            }
        )

    for log, name, emoji in (
        await db.execute(
            select(HabitLog, Habit.name, Habit.emoji)
            .join(Habit, Habit.id == HabitLog.habit_id)
            .where(HabitLog.user_id == uid, HabitLog.note.ilike(like))
            .order_by(HabitLog.day.desc())
            .limit(PER_KIND)
        )
    ).all():
        results.append(
            {
                "kind": "habit_note",
                "id": str(log.id),
                "title": f"{emoji} {name}",
                "detail": _snippet(log.note, q),
                "date": log.day.isoformat(),
                "url": f"/habits/{log.habit_id}",
            }
        )

    for w in (
        await db.execute(
            select(Workout)
            .where(
                Workout.user_id == uid,
                Workout.deleted_at.is_(None),
                or_(Workout.title.ilike(like), Workout.notes.ilike(like)),
            )
            .order_by(Workout.started_at.desc())
            .limit(PER_KIND)
        )
    ).scalars():
        results.append(
            {
                "kind": "workout",
                "id": str(w.id),
                "title": w.title or w.discipline.title(),
                "detail": _snippet(w.notes, q),
                "date": w.local_date.isoformat(),
                "url": f"/workouts/{w.id}",
            }
        )

    for j in (
        await db.execute(
            select(JournalDay)
            .where(JournalDay.user_id == uid, JournalDay.note.ilike(like))
            .order_by(JournalDay.day.desc())
            .limit(PER_KIND)
        )
    ).scalars():
        results.append(
            {
                "kind": "journal",
                "id": str(j.id),
                "title": "Journal",
                "detail": _snippet(j.note, q),
                "date": j.day.isoformat(),
                "url": f"/day/{j.day.isoformat()}",
            }
        )

    for f in (
        await db.execute(
            select(Food)
            .where(Food.user_id == uid, or_(Food.name.ilike(like), Food.brand.ilike(like)))
            .order_by(Food.name)
            .limit(PER_KIND)
        )
    ).scalars():
        results.append(
            {
                "kind": "food",
                "id": str(f.id),
                "title": f.name,
                "detail": f"{f.brand + ' · ' if f.brand else ''}{round(f.kcal)} kcal",
                "url": "/food",
            }
        )

    for r in (
        await db.execute(
            select(Recipe)
            .where(Recipe.user_id == uid, Recipe.name.ilike(like))
            .order_by(Recipe.name)
            .limit(PER_KIND)
        )
    ).scalars():
        results.append(
            {
                "kind": "recipe",
                "id": str(r.id),
                "title": r.name,
                "detail": f"Recipe · {round(r.kcal)} kcal a serving",
                "url": "/food",
            }
        )
    return {"q": q, "results": results}


@router.get("/day/{day}")
async def one_day(
    day: date, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Everything logged on one date: training, habits, food, mood, body."""
    uid = user.id
    workouts = (
        (
            await db.execute(
                select(Workout)
                .where(
                    Workout.user_id == uid, Workout.local_date == day, Workout.deleted_at.is_(None)
                )
                .order_by(Workout.started_at)
            )
        )
        .scalars()
        .all()
    )
    habits = (
        (
            await db.execute(
                select(Habit)
                .where(Habit.user_id == uid, Habit.started_on <= day, Habit.archived_at.is_(None))
                .order_by(Habit.position)
            )
        )
        .scalars()
        .all()
    )
    logs: dict[UUID, HabitLog] = {
        log.habit_id: log
        for log in (
            await db.execute(select(HabitLog).where(HabitLog.user_id == uid, HabitLog.day == day))
        ).scalars()
    }
    meals = (
        await db.execute(
            select(
                MealEntry.meal,
                func.count(),
                func.sum(MealEntry.kcal),
                func.sum(MealEntry.protein_g),
            )
            .where(MealEntry.user_id == uid, MealEntry.day == day)
            .group_by(MealEntry.meal)
        )
    ).all()
    journal = (
        await db.execute(select(JournalDay).where(JournalDay.user_id == uid, JournalDay.day == day))
    ).scalar_one_or_none()
    readiness = (
        await db.execute(select(Readiness).where(Readiness.user_id == uid, Readiness.day == day))
    ).scalar_one_or_none()
    rest = (
        await db.execute(select(RestDay).where(RestDay.user_id == uid, RestDay.day == day))
    ).scalar_one_or_none()
    weigh_ins = (
        (
            await db.execute(
                select(WeighIn)
                .where(WeighIn.user_id == uid, WeighIn.local_date == day)
                .order_by(WeighIn.weighed_at)
            )
        )
        .scalars()
        .all()
    )
    return {
        "date": day.isoformat(),
        "workouts": [
            {
                "id": str(w.id),
                "title": w.title,
                "discipline": w.discipline,
                "duration_sec": w.duration_sec,
                "distance_m": w.distance_m,
            }
            for w in workouts
        ],
        "habits": [
            {
                "id": str(h.id),
                "name": h.name,
                "emoji": h.emoji,
                "kind": h.kind,
                "unit": h.unit,
                "amount": logs[h.id].amount if h.id in logs else 0,
                "note": logs[h.id].note if h.id in logs else None,
                "done": is_done(h.kind, logs[h.id].amount if h.id in logs else 0, h.daily_goal),
            }
            for h in habits
        ],
        "food": {
            "meals": [
                {"meal": m, "count": n, "kcal": round(k or 0, 1), "protein_g": round(p or 0, 1)}
                for m, n, k, p in meals
            ],
            "kcal": round(sum((k or 0) for _, _, k, _ in meals), 1),
            "protein_g": round(sum((p or 0) for _, _, _, p in meals), 1),
        },
        "journal": {"mood": journal.mood, "note": journal.note} if journal else None,
        "readiness": (
            {"sleep": readiness.sleep, "energy": readiness.energy, "soreness": readiness.soreness}
            if readiness
            else None
        ),
        "rest": {"kind": rest.kind, "note": rest.note} if rest else None,
        "weigh_ins": [{"weight_kg": w.weight_kg, "moment": w.moment} for w in weigh_ins],
    }
