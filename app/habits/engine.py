"""Habit streaks and strength. Pure: logs in, verdicts out.

A habit's streak is the same week-based streak training uses - the week is
kept when the habit was done on `weekly_target` days - so rest days, freezes,
repairs and pauses all mean the same thing everywhere. Reusing the engine
rather than writing a second one is the point: two streak rules in one app
would be two ways to be confused.

Quit habits count clean days: a day is clean unless a slip is logged on it.
Only days from the habit's start count, so a new habit doesn't inherit a
fictional clean history.

Strength is a slower, kinder number beside the streak, in the spirit of
Loop's habit score: an average over weeks of how much of the target was met.
A missed week dents it; it doesn't wipe out months.
"""

from dataclasses import dataclass
from datetime import date, timedelta

from app.game.streak import ChainResult, WeekCell, compute_chain

# Weight of each new week in the strength average: about a month's memory.
STRENGTH_ALPHA = 0.25


@dataclass
class HabitDay:
    day: date
    amount: float


@dataclass
class HabitView:
    done_days: set[date]
    chain: ChainResult
    strength: int
    total: float
    today_amount: float
    # Quit habits: consecutive clean days up to today, and the best run.
    clean_run: int | None = None
    best_clean_run: int | None = None
    last_slip: date | None = None


def is_done(kind: str, amount: float, daily_goal: float | None) -> bool:
    if kind == "quit":
        return amount <= 0
    if kind == "check":
        return amount > 0
    return amount >= (daily_goal or 1)


def done_days(
    kind: str, daily_goal: float | None, logs: list[HabitDay], started_on: date, today: date
) -> set[date]:
    by_day = {entry.day: entry.amount for entry in logs}
    if kind != "quit":
        return {
            d
            for d, a in by_day.items()
            if started_on <= d <= today and is_done(kind, a, daily_goal)
        }
    out: set[date] = set()
    d = started_on
    while d <= today:
        if by_day.get(d, 0) <= 0:
            out.add(d)
        d += timedelta(days=1)
    return out


def first_week_target(weekly_target: int, started_on: date, week: date) -> int:
    """A habit started mid-week can only be done on the days left in that
    week, so its first week asks for no more than those. Without this a habit
    begun on a Friday with a daily target fails its first week by design."""
    if week <= started_on < week + timedelta(days=7):
        return max(1, min(weekly_target, 7 - (started_on - week).days))
    return weekly_target


def strength(weeks: list[WeekCell]) -> int:
    """0-100. A slow average of how much of each week's target was met, so a
    missed week dents it and months of consistency hold it up. Paused weeks
    are skipped, and the week in progress only counts once it's met - a
    Monday before the first session is not a failure."""
    values = [
        min(1.0, c.days / c.target)
        for c in weeks
        if c.status != "paused" and (c.status != "open" or c.days >= c.target)
    ]
    if not values:
        open_week = next((c for c in reversed(weeks) if c.status == "open"), None)
        return round(min(1.0, open_week.days / open_week.target) * 100) if open_week else 0
    score = values[0]
    for value in values[1:]:
        score += STRENGTH_ALPHA * (value - score)
    return round(score * 100)


def view_habit(
    *,
    kind: str,
    daily_goal: float | None,
    weekly_target: int,
    started_on: date,
    logs: list[HabitDay],
    today: date,
    week_starts_on: int,
    paused_days: set[date],
) -> HabitView:
    done = done_days(kind, daily_goal, logs, started_on, today)
    chain = compute_chain(
        done,
        today,
        week_starts_on,
        lambda week: first_week_target(weekly_target, started_on, week),
        paused_days=paused_days,
    )
    by_day = {entry.day: entry.amount for entry in logs}
    view = HabitView(
        done_days=done,
        chain=chain,
        strength=strength(chain.weeks),
        total=round(sum(a for d, a in by_day.items() if kind != "quit" and d <= today), 2),
        today_amount=by_day.get(today, 0.0),
    )
    if kind == "quit":
        slips = sorted(d for d, a in by_day.items() if a > 0 and started_on <= d <= today)
        view.last_slip = slips[-1] if slips else None
        run = 0
        d = today
        while d >= started_on and d in done:
            run += 1
            d -= timedelta(days=1)
        view.clean_run = run
        best = current = 0
        d = started_on
        while d <= today:
            current = current + 1 if d in done else 0
            best = max(best, current)
            d += timedelta(days=1)
        view.best_clean_run = best
    return view
