"""The daily coach: a few lines of feedback built from the person's own data
by fixed rules - streak pace, readiness, habits and yesterday's food.

No model writes these and nothing leaves the server. Private to the owner;
it reads habits, so it must never be shown to anyone else.
"""

from dataclasses import asdict, dataclass
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.database import get_db
from app.game.service import snapshot
from app.nutrition.models import MealEntry
from app.nutrition.router import get_target, totals
from app.training.models import Readiness

router = APIRouter(prefix="/coach", tags=["coach"])

# Days without training before the coach says something.
IDLE_DAYS = 5
MAX_NOTES = 4


@dataclass
class Note:
    kind: str
    tone: Literal["nudge", "praise", "rest", "info"]
    title: str
    body: str
    # Lower sorts first: what to do today beats what went well.
    rank: int = 50


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def streak_notes(chains, today: date, last_active: date | None) -> list[Note]:
    notes = []
    for c in chains:
        r = c.result
        if r.paused_now:
            continue
        name = c.chain.name or "Your streak"
        if r.needed <= 0:
            notes.append(
                Note(
                    "week_kept",
                    "praise",
                    f"{name}: week kept",
                    f"{r.this_week_days} of {r.this_week_target} done. Anything more is a bonus.",
                    rank=70,
                )
            )
        elif r.at_risk:
            notes.append(
                Note(
                    "at_risk",
                    "nudge",
                    f"{name} needs you today",
                    f"{_plural(r.needed, 'more session')} with {_plural(r.days_left, 'day')} "
                    "left. Today is the day that keeps the week.",
                    rank=10,
                )
            )
        else:
            notes.append(
                Note(
                    "on_pace",
                    "info",
                    f"{name}: {r.this_week_days} of {r.this_week_target}",
                    f"{_plural(r.needed, 'more')} to go, {_plural(r.days_left, 'day')} to do it.",
                    rank=40,
                )
            )
    if last_active is not None and (today - last_active).days >= IDLE_DAYS:
        notes.append(
            Note(
                "idle",
                "nudge",
                "It's been a few days",
                f"Last session {(today - last_active).days} days ago. Something short counts: "
                "twenty minutes beats a perfect plan you don't start.",
                rank=20,
            )
        )
    return notes


def readiness_notes(r: Readiness | None) -> list[Note]:
    if r is None:
        return []
    if r.sleep <= 2 or r.energy <= 2 or r.soreness >= 4:
        reason = (
            "Short on sleep" if r.sleep <= 2 else "Low on energy" if r.energy <= 2 else "Still sore"
        )
        return [
            Note(
                "go_easy",
                "rest",
                f"{reason}: go easy",
                "Train lighter or make it mobility today. An easy day still counts; an injury "
                "costs weeks.",
                rank=15,
            )
        ]
    if r.sleep >= 4 and r.energy >= 4 and r.soreness <= 2:
        return [
            Note(
                "go_hard",
                "praise",
                "Good day to push",
                "Slept well, fresh legs. If a hard session is on the plan, today suits it.",
                rank=45,
            )
        ]
    return []


def habit_notes(habits) -> list[Note]:
    """Counts only, never names: the coach card may sit on a screen someone
    else can see over a shoulder."""
    short = [
        v
        for _, v, _ in habits
        if v.chain.this_week_days < v.chain.this_week_target and not v.chain.paused_now
    ]
    if not short:
        return []
    tight = [v for v in short if v.chain.at_risk]
    if tight:
        return [
            Note(
                "habits_at_risk",
                "nudge",
                f"{_plural(len(tight), 'habit')} at risk this week",
                "Only just enough days left to keep them. Check Today for which.",
                rank=25,
            )
        ]
    return [
        Note(
            "habits_open",
            "info",
            f"{_plural(len(short), 'habit')} still open this week",
            "Plenty of time, but a tick today makes the end of the week easier.",
            rank=60,
        )
    ]


def food_notes(eaten: dict | None, target) -> list[Note]:
    """Yesterday against the target. Gentle by design: under-eating gets the
    same tone as over-eating, and no target means no judgement."""
    if eaten is None or target is None:
        return []
    notes = []
    if target.protein_g and eaten["protein_g"] < 0.8 * target.protein_g:
        notes.append(
            Note(
                "protein_low",
                "nudge",
                "Protein ran short yesterday",
                f"{eaten['protein_g']:g} g of {target.protein_g:g} g. Front-load some at "
                "breakfast today.",
                rank=35,
            )
        )
    if target.kcal:
        ratio = eaten["kcal"] / target.kcal
        if ratio < 0.75:
            notes.append(
                Note(
                    "kcal_low",
                    "info",
                    "Yesterday was well under target",
                    f"{eaten['kcal']:g} of {target.kcal:g} kcal. Training on too little makes "
                    "recovery harder; if you forgot to log, ignore this.",
                    rank=38,
                )
            )
        elif ratio > 1.2:
            notes.append(
                Note(
                    "kcal_high",
                    "info",
                    "Yesterday was over target",
                    f"{eaten['kcal']:g} of {target.kcal:g} kcal. One day changes nothing; the "
                    "weekly trend is what counts.",
                    rank=55,
                )
            )
        elif not notes:
            notes.append(
                Note(
                    "food_on_target",
                    "praise",
                    "Food on target yesterday",
                    f"{eaten['kcal']:g} kcal, {eaten['protein_g']:g} g protein.",
                    rank=65,
                )
            )
    return notes


@router.get("/today")
async def today(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    snap = await snapshot(db, user.id)
    await db.commit()
    day = snap.today
    if snap.paused_today:
        notes = [
            Note(
                "paused",
                "rest",
                "Streaks are paused",
                "Nothing is counting down. Rest properly; the grid will be here.",
                rank=0,
            )
        ]
    else:
        readiness = (
            await db.execute(
                select(Readiness).where(Readiness.user_id == user.id, Readiness.day == day)
            )
        ).scalar_one_or_none()
        yesterday = day - timedelta(days=1)
        meals = (
            (
                await db.execute(
                    select(MealEntry).where(
                        MealEntry.user_id == user.id, MealEntry.day == yesterday
                    )
                )
            )
            .scalars()
            .all()
        )
        notes = (
            streak_notes(snap.chains, day, snap.last_active)
            + readiness_notes(readiness)
            + habit_notes(snap.habits)
            + food_notes(totals(meals) if meals else None, await get_target(db, user.id))
        )
        notes.sort(key=lambda n: n.rank)
        notes = notes[:MAX_NOTES]
        if not notes:
            notes = [
                Note(
                    "start",
                    "info",
                    "Nothing to flag",
                    "Log a session, a meal or a check-in and this fills with feedback.",
                )
            ]
    return {
        "date": day.isoformat(),
        "notes": [{k: v for k, v in asdict(n).items() if k != "rank"} for n in notes],
    }
