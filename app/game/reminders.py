"""When to nudge. Pure: no I/O.

"Smart" reminders learn when someone usually trains and nudge an hour
before, so a morning runner isn't reminded at 6pm when the day's chance has
gone. Deliberately simple and explainable: the most common start hour over
recent sessions, not a model. Too little history, or a learned hour that
falls in quiet hours, and the person's own fixed hour is used instead.
"""

from collections import Counter
from collections.abc import Iterable

MIN_SESSIONS = 6
LEAD_HOURS = 1


def in_quiet_hours(hour: int, quiet_start: int, quiet_end: int) -> bool:
    if quiet_start == quiet_end:
        return False
    if quiet_start < quiet_end:
        return quiet_start <= hour < quiet_end
    return hour >= quiet_start or hour < quiet_end


def learn_reminder_hour(
    local_start_hours: Iterable[int], quiet_start: int, quiet_end: int
) -> int | None:
    """An hour before the most common training hour, or None. Ties go to the
    earlier hour, so the nudge comes before either habit, not after one."""
    hours = [h % 24 for h in local_start_hours]
    if len(hours) < MIN_SESSIONS:
        return None
    counts = Counter(hours)
    best = max(counts.values())
    usual = min(h for h, n in counts.items() if n == best)
    reminder = (usual - LEAD_HOURS) % 24
    if in_quiet_hours(reminder, quiet_start, quiet_end):
        return None
    return reminder


def reminder_hour(mode: str, fixed: int, learned: int | None) -> int:
    return learned if mode == "smart" and learned is not None else fixed
