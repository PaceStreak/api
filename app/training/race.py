"""Race plans: a schedule that runs from this week to a race day and one
recovery week after it. Pure: dates in, weeks of sessions out.

Conservative on purpose, like the templates. The long run grows about 10% a
week with a lighter week every fourth, most running stays easy, one session
a week gets a little faster once a base is built, and the last week or two
taper so the legs arrive fresh. It is a schedule of suggestions for healthy
adults, not coaching (see /terms); the streak counts whatever is logged.

Days are offsets from the person's own week start, like every plan.
"""

from dataclasses import dataclass
from datetime import date, timedelta

from app.common.time import week_start

EASY = "Easy: you could talk in sentences. Slower is fine."


@dataclass(frozen=True)
class RaceSpec:
    label: str
    distance_km: float
    start_long: int  # minutes
    peak_long: int
    taper_weeks: int
    quality: str
    min_weeks: int


RACES = {
    "5k": RaceSpec(
        "5 km", 5, 25, 50, 1, "Intervals: 6 x 2 min a little faster, 2 min easy between", 4
    ),
    "10k": RaceSpec(
        "10 km", 10, 35, 70, 1, "Intervals: 5 x 4 min comfortably hard, 2 min easy between", 5
    ),
    "half": RaceSpec(
        "half marathon",
        21.1,
        50,
        120,
        2,
        "Tempo: 2 x 12 min comfortably hard, 3 min easy between",
        8,
    ),
    "marathon": RaceSpec(
        "marathon", 42.2, 70, 180, 2, "Tempo: 3 x 12 min at goal effort, 3 min easy between", 12
    ),
}
MAX_WEEKS = 25  # plus the recovery week, within a plan's 26


class RacePlanError(ValueError):
    """A user-facing reason the plan can't be built."""


def _days(per_week: int) -> tuple[int, ...]:
    # Spread out, long run last: rest days fall between runs.
    return {3: (1, 3, 5), 4: (0, 2, 4, 6), 5: (0, 1, 3, 4, 6)}[per_week]


def build_race_plan(
    race: str, race_date: date, today: date, week_starts_on: int, per_week: int
) -> tuple[date, list[list[dict]], str]:
    """(first week's start, weeks, name). The race sits in the second-last
    week on its own weekday; the last week is recovery."""
    spec = RACES.get(race)
    if spec is None:
        raise RacePlanError("Choose 5 km, 10 km, half marathon or marathon")
    if per_week not in (3, 4, 5):
        raise RacePlanError("Three, four or five runs a week")
    first = week_start(today, week_starts_on)
    race_week = week_start(race_date, week_starts_on)
    if race_date <= today:
        raise RacePlanError("The race has to be in the future")
    weeks_to_race = (race_week - first).days // 7 + 1
    if weeks_to_race < spec.min_weeks:
        raise RacePlanError(
            f"A {spec.label} plan needs at least {spec.min_weeks} weeks; that race is sooner"
        )
    if weeks_to_race > MAX_WEEKS:
        # Start later rather than stretch the plan thin.
        first = race_week - timedelta(weeks=MAX_WEEKS - 1)
        weeks_to_race = MAX_WEEKS

    days = _days(per_week)
    build_weeks = weeks_to_race - spec.taper_weeks - 1  # before taper and race week
    base_weeks = max(1, round(build_weeks * 0.45))
    weeks: list[list[dict]] = []
    long_min = float(spec.start_long)
    peak = spec.start_long
    for i in range(build_weeks):
        cutback = (i + 1) % 4 == 0
        long_now = round(long_min * (0.8 if cutback else 1.0))
        peak = max(peak, long_now)
        easy = max(20, min(60, round(long_now * 0.55)))
        sessions = [
            {
                "discipline": "run",
                "title": f"Easy run, {easy} min",
                "minutes": easy,
                "note": EASY,
            }
            for _ in days[:-1]
        ]
        if i >= base_weeks and not cutback and len(sessions) >= 2:
            sessions[1] = {
                "discipline": "run",
                "title": spec.quality[:80],
                "minutes": easy + 10,
                "note": "10 min easy to warm up and cool down. Hard, not all out.",
            }
        sessions.append(
            {
                "discipline": "run",
                "title": f"Long run, {long_now} min" + (" (lighter week)" if cutback else ""),
                "minutes": long_now,
                "note": EASY,
            }
        )
        weeks.append([{"day": d} | s for d, s in zip(days, sessions, strict=True)])
        # Grow after a normal week, but hold before a lighter one, so the
        # week after it comes back to the same level rather than jumping.
        next_is_cutback = (i + 2) % 4 == 0
        if not cutback and not next_is_cutback:
            long_min = min(spec.peak_long, long_min * 1.1)

    for t in range(spec.taper_weeks):
        share = 0.7 if t == 0 and spec.taper_weeks == 2 else 0.55
        long_now = round(peak * share)
        easy = max(20, round(long_now * 0.5))
        sessions = [
            {"discipline": "run", "title": f"Easy run, {easy} min", "minutes": easy, "note": EASY}
            for _ in days[:-1]
        ] + [
            {
                "discipline": "run",
                "title": f"Long run, {long_now} min",
                "minutes": long_now,
                "note": "Tapering: less running so you arrive fresh. Resist adding more.",
            }
        ]
        weeks.append([{"day": d} | s for d, s in zip(days, sessions, strict=True)])

    race_day = (race_date - race_week).days
    race_sessions = [
        {
            "day": d,
            "discipline": "run",
            "title": "Easy run, 20 min",
            "minutes": 20,
            "note": "A few relaxed strides at the end. Save the legs.",
        }
        for d in days
        if d < race_day - 1
    ][:2]
    race_sessions.append(
        {
            "day": race_day,
            "discipline": "run",
            "title": f"Race day: {spec.label}",
            "distance_km": spec.distance_km,
            "note": "Start slower than feels right. Enjoy it.",
        }
    )
    weeks.append(race_sessions)
    weeks.append(
        [
            {
                "day": days[1],
                "discipline": "walk",
                "title": "Recovery walk, 30 min",
                "minutes": 30,
                "note": "Moving helps sore legs recover. No running needed yet.",
            },
            {
                "day": days[-1],
                "discipline": "run",
                "title": "Easy run, 20 min",
                "minutes": 20,
                "note": "Only if everything feels fine. Otherwise walk, or rest.",
            },
        ]
    )
    name = f"{spec.label[0].upper()}{spec.label[1:]} on {race_date.strftime('%-d %b')}"
    return first, weeks, name
