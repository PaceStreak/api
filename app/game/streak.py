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


@dataclass
class WeekCell:
    week_start: date
    days: int
    target: int
    # kept | frozen | repaired | missed | open (current, not yet met)
    status: str
    run: int = 0

    @property
    def counts(self) -> bool:
        return self.status in ("kept", "frozen", "repaired")

    @property
    def score(self) -> int:
        """0-100 adherence, capped: training beyond the target never raises it."""
        return min(100, round(self.days / self.target * 100)) if self.target else 100


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


def compute_chain(
    active_days: Iterable[date],
    today: date,
    week_starts_on: int,
    target_for: Callable[[date], int],
    repaired: Iterable[date] = (),
    repair_available: bool = False,
) -> ChainResult:
    days = set(active_days)
    repaired_weeks = set(repaired)
    current_week = week_start(today, week_starts_on)

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

    w = earliest
    while w <= current_week:
        count = per_week.get(w, 0)
        target = max(1, target_for(w))
        if w == current_week:
            status = "kept" if count >= target else "open"
        elif count >= target:
            status = "kept"
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
        cells.append(WeekCell(w, count, target, status, run))
        w += timedelta(weeks=1)

    this_week = cells[-1]
    week_end = current_week + timedelta(days=6)
    trained_today = today in days
    days_left = (week_end - today).days + (0 if trained_today else 1)
    needed = max(0, this_week.target - this_week.days)
    at_risk = needed > 0 and needed >= days_left
    will_freeze = needed > days_left and freezes > 0 and run > 0

    repairable: date | None = None
    if repair_available:
        closed = [c for c in cells[:-1]][-REPAIR_WINDOW_WEEKS:]
        for cell in reversed(closed):
            if cell.status == "missed":
                repairable = cell.week_start
                break

    closed_cells = cells[:-1][-4:]
    consistency = (
        round(sum(c.score for c in closed_cells) / len(closed_cells)) if closed_cells else 0
    )

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
    )
