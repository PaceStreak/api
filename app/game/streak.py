"""Week-based streaks. Pure: no I/O, no clock - `today` is always passed in.

The unit is the *kept week*, not the day. A daily chain punishes planned rest
and pushes people to train sore or injured just to keep a number alive; the
predecessor project reached the same conclusion. A week is kept when the
number of distinct days trained reaches that week's target, so with a target
of four, three rest days cost nothing at all.

Three things forgive a bad week, in this order:

1. The week in progress never breaks anything. Until it closes, it is open.
2. A repair, which the user applies by hand to one missed week per month.
3. A freeze, earned automatically (one per four kept weeks, holding at most
   two) and spent automatically on a missed week - but only when there is a
   streak to protect, so a freeze is never wasted on a week with no run.
   A kept wager (an opt-in promise of extra days in one week) also earns one,
   within the same cap. A lost wager costs nothing.

A declared pause (injury, illness, life) sits outside that ladder. A week the
pause covers for at least PAUSE_MIN_DAYS days, and which was not kept anyway,
is "paused": it neither breaks the run nor extends it, spends no freeze, earns
no freeze, pays no XP and is left out of the consistency score. It exists so
nobody trains hurt to protect a number, which is the whole reason the unit is
a week in the first place.

A chain can also carry requirements ("at least two of those days are runs"):
a week is kept only when the total target *and* every requirement are met.
Requirements have a history like targets do, and apply only from the week
they were set, so adding one never breaks weeks that were already kept.

Everything is recomputed from history on every read. There is no cron that
"closes" a week, so there is no stored state that can drift from the logs.
"""

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date, timedelta

from app.common.time import week_start

FREEZE_EVERY = 4
FREEZE_CAP = 2
LOOKBACK_WEEKS = 260
REPAIR_WINDOW_WEEKS = 2
MILESTONES = (4, 8, 12, 26, 52, 104, 156)
# A pause must cover most of a week to shelter it, so a one-day pause dropped
# into every week cannot turn a three-day target into a two-day one.
PAUSE_MIN_DAYS = 4


@dataclass(frozen=True)
class Requirement:
    """At least `days` distinct days this week on one of `disciplines`."""

    disciplines: frozenset[str]
    days: int


@dataclass
class WeekCell:
    week_start: date
    days: int
    target: int
    # kept | frozen | repaired | paused | missed | open (current, not yet met)
    status: str
    run: int = 0
    # The weakest requirement's completion, 0-1. 1 when there are none.
    requirement_ratio: float = 1.0

    @property
    def counts(self) -> bool:
        return self.status in ("kept", "frozen", "repaired")

    @property
    def score(self) -> int:
        """0-100 adherence, capped: training beyond the target never raises it.
        With requirements, the weakest part of the week decides - four runs
        do not make up for the strength session that was the point."""
        base = min(1.0, self.days / self.target) if self.target else 1.0
        return round(min(base, self.requirement_ratio) * 100)


@dataclass
class ChainResult:
    current: int
    longest: int
    weeks: list[WeekCell]
    freezes_available: int
    this_week_days: int
    this_week_target: int
    days_left: int
    needed: int
    at_risk: bool
    will_freeze: bool
    repairable_week: date | None
    run_started: date | None
    consistency: int
    milestones_hit: list[tuple[int, date]] = field(default_factory=list)
    paused_now: bool = False
    # Mean score over the last 12 and 52 closed, unpaused weeks: the gentle
    # number that survives a broken streak.
    consistency_12: int = 0
    consistency_52: int = 0
    # This week, per requirement: (requirement, distinct days done so far).
    requirements_progress: list[tuple[Requirement, int]] = field(default_factory=list)
    # Weeks whose wager was met.
    wagers_won: list[date] = field(default_factory=list)


def target_resolver(history: list[dict], default: int = 3) -> Callable[[date], int]:
    """Target in force for a given week. `history` is [{"from": iso, "target": n}],
    ascending. Weeks before the first entry use the first target - a chain
    created today still judges last month's sessions by something sensible."""
    points = sorted(
        ((date.fromisoformat(h["from"]), int(h["target"])) for h in history),
        key=lambda p: p[0],
    )

    def resolve(week: date) -> int:
        if not points:
            return default
        current = points[0][1]
        for start, target in points:
            if start <= week:
                current = target
            else:
                break
        return current

    return resolve


def requirements_resolver(history: list[dict]) -> Callable[[date], list[Requirement]]:
    """Requirements in force for a week. `history` is
    [{"from": iso, "requirements": [{"disciplines": [...], "days": n}]}],
    ascending. Unlike targets, weeks before the first entry have none: a
    requirement is a new rule, and old weeks were never played under it."""
    points = sorted(
        (
            (
                date.fromisoformat(h["from"]),
                [
                    Requirement(frozenset(r["disciplines"]), int(r["days"]))
                    for r in h.get("requirements", [])
                ],
            )
            for h in history
        ),
        key=lambda p: p[0],
    )

    def resolve(week: date) -> list[Requirement]:
        current: list[Requirement] = []
        for start, reqs in points:
            if start <= week:
                current = reqs
            else:
                break
        return current

    return resolve


def _mean_score(cells: list[WeekCell]) -> int:
    return round(sum(c.score for c in cells) / len(cells)) if cells else 0


def compute_chain(
    active_days: Iterable[date],
    today: date,
    week_starts_on: int,
    target_for: Callable[[date], int],
    repaired: Iterable[date] = (),
    repair_available: bool = False,
    paused_days: Iterable[date] = (),
    requirements_for: Callable[[date], list[Requirement]] | None = None,
    day_disciplines: dict[date, set[str]] | None = None,
    wagers: dict[date, int] | None = None,
) -> ChainResult:
    days = set(active_days)
    day_disciplines = day_disciplines or {}

    def requirement_days(week: date, req: Requirement) -> int:
        return sum(
            1
            for i in range(7)
            if (d := week + timedelta(days=i)) <= today
            and day_disciplines.get(d, set()) & req.disciplines
        )

    repaired_weeks = set(repaired)
    current_week = week_start(today, week_starts_on)

    paused_per_week: dict[date, int] = {}
    for d in set(paused_days):
        w = week_start(d, week_starts_on)
        paused_per_week[w] = paused_per_week.get(w, 0) + 1
    paused_weeks = {w for w, n in paused_per_week.items() if n >= PAUSE_MIN_DAYS}

    per_week: dict[date, int] = {}
    for d in days:
        if d > today:
            continue
        w = week_start(d, week_starts_on)
        per_week[w] = per_week.get(w, 0) + 1

    earliest = min(per_week) if per_week else current_week
    floor = current_week - timedelta(weeks=LOOKBACK_WEEKS - 1)
    earliest = max(earliest, floor)

    cells: list[WeekCell] = []
    freezes = 0
    kept_toward_freeze = 0
    run = 0
    longest = 0
    run_started: date | None = None
    milestones: list[tuple[int, date]] = []
    wagers = wagers or {}
    wagers_won: list[date] = []

    w = earliest
    while w <= current_week:
        count = per_week.get(w, 0)
        target = max(1, target_for(w))
        reqs = requirements_for(w) if requirements_for else []
        ratio = min(
            (min(1.0, requirement_days(w, r) / r.days) for r in reqs if r.days > 0),
            default=1.0,
        )
        if count >= target and ratio >= 1.0:
            status = "kept"
        elif w in paused_weeks:
            status = "paused"
        elif w == current_week:
            status = "open"
        elif w in repaired_weeks:
            status = "repaired"
        elif freezes > 0 and run > 0:
            status = "frozen"
            freezes -= 1
        else:
            status = "missed"

        if status == "kept" and w != current_week:
            kept_toward_freeze += 1
            if kept_toward_freeze >= FREEZE_EVERY:
                kept_toward_freeze = 0
                freezes = min(FREEZE_CAP, freezes + 1)
            if w in wagers and count >= wagers[w]:
                wagers_won.append(w)
                freezes = min(FREEZE_CAP, freezes + 1)

        if status in ("kept", "frozen", "repaired"):
            if run == 0:
                run_started = w
            run += 1
            if run in MILESTONES:
                milestones.append((run, w))
        elif status == "missed":
            run = 0
            run_started = None
        longest = max(longest, run)
        cells.append(WeekCell(w, count, target, status, run, ratio))
        w += timedelta(weeks=1)

    this_week = cells[-1]
    week_end = current_week + timedelta(days=6)
    trained_today = today in days
    days_left = (week_end - today).days + (0 if trained_today else 1)
    this_week_paused = this_week.status == "paused"
    progress = [
        (r, requirement_days(current_week, r))
        for r in (requirements_for(current_week) if requirements_for else [])
    ]
    # Days still owed: the total shortfall, or the requirements' combined
    # shortfall if that is larger (two runs and a lift still to do is three
    # days, even if only one more day reaches the total).
    shortfall = max(
        this_week.target - this_week.days,
        sum(max(0, r.days - done) for r, done in progress),
    )
    needed = 0 if this_week_paused or this_week.status == "kept" else max(0, shortfall)
    at_risk = needed > 0 and needed >= days_left
    will_freeze = needed > days_left and freezes > 0 and run > 0

    repairable: date | None = None
    if repair_available:
        closed = [c for c in cells[:-1]][-REPAIR_WINDOW_WEEKS:]
        for cell in reversed(closed):
            if cell.status == "missed":
                repairable = cell.week_start
                break

    closed_cells = [c for c in cells[:-1] if c.status != "paused"]
    consistency = _mean_score(closed_cells[-4:])

    return ChainResult(
        current=run,
        longest=longest,
        weeks=cells,
        freezes_available=freezes,
        this_week_days=this_week.days,
        this_week_target=this_week.target,
        days_left=days_left,
        needed=needed,
        at_risk=at_risk,
        will_freeze=will_freeze,
        repairable_week=repairable,
        run_started=run_started,
        consistency=consistency,
        milestones_hit=milestones,
        paused_now=this_week_paused,
        consistency_12=_mean_score(closed_cells[-12:]),
        consistency_52=_mean_score(closed_cells[-52:]),
        requirements_progress=progress,
        wagers_won=wagers_won,
    )
