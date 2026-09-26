"""Weekly quests and the PR streak. Pure: history in, verdicts out.

Quests reward habits, never magnitude: training early in the week, a
balanced week, rating effort honestly, a short session that still counts,
logging a rest day. None rewards more volume, more load or a number on the
scale - the morning weigh-in quest pays for the habit of weighing at a
consistent time, never for what the scale says.

Each week offers three quests, the same three for everyone, picked from the
pool by the week's date. A weigh-in quest is only in someone's pool once they
have weighed in before that week, so nobody is nudged to start. Paused weeks
offer none. Everything is recomputed from history, so there is no state to
drift: completing a quest is simply the log saying so.

The PR streak counts consecutive four-week blocks with at least one rewarded
personal record. Blocks are fixed to a calendar anchor, not to the person,
so "this block" means the same span every time it is computed. The block in
progress never breaks the run - like the week in progress for streaks.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, timedelta

from app.common.time import week_start

QUEST_XP = 15
PER_WEEK = 3
BLOCK_DAYS = 28
# A Monday. Blocks are [anchor + 28k, anchor + 28k + 27].
BLOCK_ANCHOR = date(2024, 1, 1)


@dataclass(frozen=True)
class QuestDef:
    id: str
    title: str
    description: str
    goal: int


POOL: tuple[QuestDef, ...] = (
    QuestDef("early_week", "Early start", "Train in the first three days of the week.", 1),
    QuestDef("balanced", "Balanced week", "A push, a pull and a leg movement this week.", 3),
    QuestDef("rpe", "Honest effort", "Rate how hard 8 working sets were (RPE).", 8),
    QuestDef("short_counts", "A short one counts", "Log a session of 20 minutes or less.", 1),
    QuestDef("new_exercise", "Something new", "Try an exercise you've never logged.", 1),
    QuestDef("rest_day", "Rest on purpose", "Log a rest day. Recovery is training.", 1),
    QuestDef("morning_weigh", "Same time, every time", "Weigh in after waking on 5 days.", 5),
    QuestDef("habit_week", "Every habit, kept", "Keep the weekly target on all your habits.", 1),
)
BY_ID = {q.id: q for q in POOL}


@dataclass(frozen=True)
class WeekFacts:
    """Everything a quest can look at for one week."""

    active_days: frozenset[date] = frozenset()
    patterns: frozenset[str] = frozenset()
    rpe_sets: int = 0
    short_sessions: int = 0
    new_exercises: int = 0
    rest_days: int = 0
    waking_weigh_days: int = 0
    habits_kept: int = 0
    habits_total: int = 0


def progress_of(quest: QuestDef, facts: WeekFacts, week: date) -> int:
    if quest.id == "early_week":
        return int(any(d < week + timedelta(days=3) for d in facts.active_days))
    if quest.id == "balanced":
        push = bool(facts.patterns & {"push_h", "push_v"})
        pull = bool(facts.patterns & {"pull_h", "pull_v"})
        legs = bool(facts.patterns & {"squat", "hinge", "lunge"})
        return push + pull + legs
    if quest.id == "rpe":
        return facts.rpe_sets
    if quest.id == "short_counts":
        return facts.short_sessions
    if quest.id == "new_exercise":
        return facts.new_exercises
    if quest.id == "rest_day":
        return facts.rest_days
    if quest.id == "morning_weigh":
        return facts.waking_weigh_days
    if quest.id == "habit_week":
        return int(facts.habits_total > 0 and facts.habits_kept >= facts.habits_total)
    return 0


def quests_for(week: date, weighs: bool, has_habits: bool = False) -> list[QuestDef]:
    """This week's three. Deterministic in the week and in what the person
    tracks, so they never reshuffle on a recompute."""
    pool = [
        q
        for q in POOL
        if (weighs or q.id != "morning_weigh") and (has_habits or q.id != "habit_week")
    ]
    seed = week.toordinal() // 7
    picked: list[QuestDef] = []
    i = seed
    while len(picked) < PER_WEEK:
        q = pool[(i * 5 + seed) % len(pool)]
        if q not in picked:
            picked.append(q)
        i += 1
    return picked


@dataclass
class QuestWeek:
    week_start: date
    quests: list[tuple[QuestDef, int]] = field(default_factory=list)

    @property
    def done(self) -> list[QuestDef]:
        return [q for q, p in self.quests if p >= q.goal]


def compute_quests(
    weeks: list[date],
    facts_for: Callable[[date], WeekFacts],
    first_weigh_in: date | None,
    paused: set[date],
    first_habit: date | None = None,
) -> list[QuestWeek]:
    out: list[QuestWeek] = []
    for w in weeks:
        if w in paused:
            continue
        facts = facts_for(w)
        weighs = first_weigh_in is not None and first_weigh_in < w
        tracked = first_habit is not None and first_habit < w
        picks = quests_for(w, weighs, tracked)
        out.append(QuestWeek(w, [(q, progress_of(q, facts, w)) for q in picks]))
    return out


# --- PR streak ------------------------------------------------------------------


def block_of(day: date) -> int:
    return (day - BLOCK_ANCHOR).days // BLOCK_DAYS


def block_start(index: int) -> date:
    return BLOCK_ANCHOR + timedelta(days=index * BLOCK_DAYS)


@dataclass
class PrStreak:
    current: int
    longest: int
    this_block_has_pr: bool
    block_ends: date


def compute_pr_streak(pr_days: list[date], today: date) -> PrStreak:
    blocks = {block_of(d) for d in pr_days if d <= today}
    now = block_of(today)
    longest = run = 0
    prev: int | None = None
    for b in sorted(blocks):
        run = run + 1 if prev is not None and b == prev + 1 else 1
        longest = max(longest, run)
        prev = b
    # The current run ends in this block, or - since the block in progress
    # can't break it - in the one before.
    current = 0
    b = now if now in blocks else now - 1
    while b in blocks:
        current += 1
        b -= 1
    return PrStreak(current, longest, now in blocks, block_start(now + 1) - timedelta(days=1))


def weeks_between(first: date, last: date, week_starts_on: int) -> list[date]:
    out = []
    w = week_start(first, week_starts_on)
    while w <= last:
        out.append(w)
        w += timedelta(weeks=1)
    return out
