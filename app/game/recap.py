"""The weekly recap: one closed week, summed up.

One builder serves both the in-app recap screen (GET /v1/me/recap) and the
worker's Monday-morning digest, so the notification and the screen it links
to can never disagree about how the week went.

What it reports is attendance: days against target, the verdict, the streak,
records measured against the person's own history, and badges. It
deliberately reports no volume - no tonnage, no total distance, no calories -
for the same reason no leaderboard does.
"""

from collections import Counter
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.time import week_start
from app.game import achievements as ach
from app.game.models import UserAchievement
from app.game.service import Snapshot, record_label
from app.training.library import DISCIPLINES
from app.training.models import Workout

DISCIPLINE_NAMES = {d.id: d.name for d in DISCIPLINES}

VERDICTS = {
    "kept": "Week kept.",
    "frozen": "A freeze covered it.",
    "repaired": "Repaired.",
    "paused": "Paused. Rest up, the streak will wait.",
    "missed": "Missed. It happens, and this week is a fresh one.",
    "open": "Still open.",
}


def last_closed_week(snap: Snapshot) -> date:
    return week_start(snap.today, snap.profile.week_starts_on) - timedelta(days=7)


async def build_recap(db: AsyncSession, snap: Snapshot, week: date) -> dict | None:
    """The recap for the week starting `week`, or None if there is nothing to
    say about it (no sessions and no streak cell - before the person started)."""
    week = week_start(week, snap.profile.week_starts_on)
    end = week + timedelta(days=6)
    main = snap.chains[0]
    cell = next((c for c in main.result.weeks if c.week_start == week), None)
    previous = next(
        (c for c in main.result.weeks if c.week_start == week - timedelta(days=7)), None
    )

    workouts = (
        await db.execute(
            select(Workout.discipline, Workout.local_date).where(
                Workout.user_id == snap.profile.user_id,
                Workout.deleted_at.is_(None),
                Workout.local_date >= week,
                Workout.local_date <= end,
            )
        )
    ).all()
    if cell is None and not workouts:
        return None

    status = cell.status if cell else "missed"
    days_trained = sorted({w.local_date for w in workouts})
    by_discipline = Counter(w.discipline for w in workouts)

    records = [
        {"label": record_label(e.key, snap.exercise_names), "day": e.day.isoformat()}
        for e in snap.events
        if e.rewarded and week <= e.day <= end
    ]
    badges = []
    if snap.profile.gamification_enabled:
        rows = (
            await db.execute(
                select(UserAchievement).where(
                    UserAchievement.user_id == snap.profile.user_id,
                    UserAchievement.unlocked_on >= week,
                    UserAchievement.unlocked_on <= end,
                )
            )
        ).scalars()
        for row in rows:
            rule = ach.RULE_BY_ID.get(row.achievement_id)
            if rule is not None:
                badges.append({"id": rule.id, "title": rule.title, "tier": row.tier})

    return {
        "week_start": week.isoformat(),
        "week_end": end.isoformat(),
        "status": status,
        "verdict": VERDICTS[status],
        "days": cell.days if cell else len(days_trained),
        "target": cell.target if cell else main.chain.target,
        "sessions": len(workouts),
        "trained_on": [d.isoformat() for d in days_trained],
        "disciplines": [
            {"id": d, "name": DISCIPLINE_NAMES.get(d, d.title()), "sessions": n}
            for d, n in by_discipline.most_common()
        ],
        "previous_days": previous.days if previous else None,
        "streak": main.result.current,
        "longest": main.result.longest,
        "freezes_available": main.result.freezes_available,
        "records": records,
        "badges": badges,
        "this_week_target": main.result.this_week_target,
    }


def digest_lines(recap: dict) -> tuple[str, str]:
    """(title, body) for the notification version of a recap."""
    s = "s" if recap["sessions"] != 1 else ""
    d = "s" if recap["days"] != 1 else ""
    lines = [
        f"{recap['sessions']} session{s} on {recap['days']} day{d} against a target of "
        f"{recap['target']}. {recap['verdict']}",
        f"Streak: {recap['streak']} week{'s' if recap['streak'] != 1 else ''}.",
    ]
    if recap["records"]:
        n = len(recap["records"])
        lines.append(f"{n} new personal record{'s' if n != 1 else ''}.")
    if recap["badges"]:
        n = len(recap["badges"])
        lines.append(f"{n} new badge{'s' if n != 1 else ''}.")
    title = f"Your week: {recap['verdict'].split('.')[0]}"
    return title, "\n".join(lines)


async def recap_for_user(db: AsyncSession, snap: Snapshot, week: date | None) -> dict | None:
    return await build_recap(db, snap, week or last_closed_week(snap))
