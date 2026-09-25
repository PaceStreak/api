"""Year in review, and the history behind each personal record.

Same rules as the weekly recap (app/game/recap.py): attendance, not volume.
A year is described by the weeks kept, the days shown up, the records that
moved against the person's own history and the badges earned - never by
tonnage, total distance or calories, which would turn a look back into a
leaderboard against your past self that rewards the wrong things.

Everything is derived from the same Snapshot the rest of the app reads, so
the review can never disagree with the grid or the streak screen.
"""

from collections import Counter
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.game import achievements as ach
from app.game.models import UserAchievement
from app.game.recap import DISCIPLINE_NAMES
from app.game.service import Snapshot, record_label
from app.training.models import Workout

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)


async def build_year(db: AsyncSession, snap: Snapshot, year: int) -> dict | None:
    """The review for a calendar year, or None if nothing was logged in it.

    A week belongs to the year it starts in, so no week is counted twice
    across New Year.
    """
    start, end = date(year, 1, 1), min(date(year, 12, 31), snap.today)
    if start > snap.today:
        return None

    rows = (
        await db.execute(
            select(Workout.discipline, Workout.local_date).where(
                Workout.user_id == snap.profile.user_id,
                Workout.deleted_at.is_(None),
                Workout.local_date >= start,
                Workout.local_date <= end,
            )
        )
    ).all()
    if not rows:
        return None

    days = sorted({r.local_date for r in rows})
    main = snap.chains[0].result
    weeks = [c for c in main.weeks if c.week_start.year == year and c.status != "open"]
    kept = [c for c in weeks if c.counts]
    scored = [c for c in weeks if c.status != "paused"]

    # Longest run inside the year, from the per-week run counter the engine
    # already keeps (a run that started last December still counts its length
    # as of each week, which is what "your longest streak this year" means).
    longest_in_year = max((c.run for c in weeks), default=0)

    per_month = Counter(d.month for d in days)
    best_month, best_month_days = per_month.most_common(1)[0]
    per_weekday = Counter(d.weekday() for d in days)
    favourite_day = per_weekday.most_common(1)[0][0]
    disciplines = Counter(r.discipline for r in rows)

    records = [e for e in snap.events if e.rewarded and e.day.year == year]
    top = sorted(records, key=lambda e: e.gain_pct, reverse=True)[:5]

    badges = []
    if snap.profile.gamification_enabled:
        for row in (
            await db.execute(
                select(UserAchievement).where(
                    UserAchievement.user_id == snap.profile.user_id,
                    UserAchievement.unlocked_on >= start,
                    UserAchievement.unlocked_on <= end,
                )
            )
        ).scalars():
            rule = ach.RULE_BY_ID.get(row.achievement_id)
            if rule is not None:
                badges.append({"id": rule.id, "title": rule.title, "tier": row.tier})

    milestones = [
        {"weeks": length, "week_start": w.isoformat()}
        for length, w in main.milestones_hit
        if w.year == year
    ]

    return {
        "year": year,
        "complete": end == date(year, 12, 31),
        "first_day": days[0].isoformat(),
        "days_trained": len(days),
        "sessions": len(rows),
        "weeks_kept": len(kept),
        "weeks_closed": len(weeks),
        "weeks_paused": sum(1 for c in weeks if c.status == "paused"),
        "consistency": round(sum(c.score for c in scored) / len(scored)) if scored else 0,
        "longest_streak": longest_in_year,
        "best_month": {"month": MONTHS[best_month - 1], "days": best_month_days},
        "favourite_weekday": WEEKDAYS[favourite_day],
        "months": [{"month": MONTHS[m - 1][:3], "days": per_month.get(m, 0)} for m in range(1, 13)],
        "disciplines": [
            {"id": d, "name": DISCIPLINE_NAMES.get(d, d.title()), "sessions": n}
            for d, n in disciplines.most_common()
        ],
        "records_count": len(records),
        "top_records": [
            {
                "label": record_label(e.key, snap.exercise_names),
                "gain_pct": e.gain_pct,
                "day": e.day.isoformat(),
            }
            for e in top
        ],
        "badges": badges,
        "milestones": milestones,
    }


def record_history(snap: Snapshot, key: str) -> dict | None:
    """Every time one record moved, oldest first, starting from the first
    value it was ever measured at. Includes moves that paid no XP (imported,
    cooling down or flagged as implausible) - this is the person's history,
    not the reward ledger - but says which is which."""
    events = [e for e in snap.events if e.key == key]
    best = snap.bests.get(key)
    if best is None:
        return None
    points = []
    if events:
        points.append({"value": events[0].previous, "day": None, "kind": "first"})
    for e in events:
        points.append(
            {
                "value": e.value,
                "day": e.day.isoformat(),
                "kind": "flagged" if e.flagged else "record",
                "gain_pct": e.gain_pct,
                "workout_id": e.workout_id,
            }
        )
    if not events:
        points.append(
            {
                "value": best.value,
                "day": best.day.isoformat(),
                "kind": "first",
                "workout_id": best.workout_id,
            }
        )
    kind, _, subject = key.partition(":")
    return {
        "key": key,
        "kind": kind,
        "subject": subject,
        "label": record_label(key, snap.exercise_names),
        "current": best.value,
        "since": best.day.isoformat(),
        "points": points,
    }
