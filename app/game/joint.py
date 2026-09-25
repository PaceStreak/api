"""Shared streaks: a buddy pair, or a whole group. Pure - no I/O.

Each member's own streak engine has already judged their weeks (kept,
frozen, repaired, paused, missed, open). A shared week is judged from those
verdicts, so everything that forgives a personal week - a freeze, a repair,
planned rest - forgives it here too, and nobody's shared streak can ask more
of them than their own does.

- A buddy pair keeps a week when both members kept theirs.
- A group keeps a week when at least `threshold` of its members did.
- A paused member is left out of that week's count; a week where everyone
  is paused is itself paused: it neither breaks nor extends the run.
- The week in progress never breaks anything, exactly as for one person.

Weeks line up by recency, not by date: "this week" is each member's own
current week, whatever day it starts on for them. Members in different
timezones or with different week starts are each judged on their own week.
"""

from dataclasses import dataclass

COUNTS = {"kept", "frozen", "repaired"}


@dataclass
class JointWeek:
    # kept | missed | paused | open
    status: str
    kept: int
    counted: int


@dataclass
class JointResult:
    current: int
    longest: int
    # Oldest first; the last entry is the week in progress.
    weeks: list[JointWeek]


def joint_streak(
    members: list[list[str]], threshold: float, max_weeks: int | None = None
) -> JointResult:
    """`members` holds each member's week statuses, oldest first, with their
    current week last. A member with fewer weeks simply wasn't around (or
    hadn't joined) that far back. `max_weeks` caps how far back the shared
    streak reaches - a pair's streak starts the week they buddied up."""
    depth = max((len(m) for m in members), default=0)
    if max_weeks is not None:
        depth = min(depth, max(1, max_weeks))
    weeks: list[JointWeek] = []
    for back in range(depth - 1, -1, -1):
        statuses = [m[len(m) - 1 - back] for m in members if back < len(m)]
        is_current = back == 0
        counted = [s for s in statuses if s != "paused"]
        kept = sum(1 for s in counted if s in COUNTS)
        if not counted:
            status = "paused"
        elif kept >= threshold * len(counted) - 1e-9:
            status = "kept"
        elif is_current:
            status = "open"
        else:
            status = "missed"
        weeks.append(JointWeek(status, kept, len(counted)))

    run = longest = 0
    for w in weeks:
        if w.status == "kept":
            run += 1
            longest = max(longest, run)
        elif w.status == "missed":
            run = 0
    return JointResult(current=run, longest=longest, weeks=weeks)
