"""Achievement rules. Pure and declarative: adding a badge is adding a rule.

Every rule rewards something healthy - showing up, breadth, finishing, honest
records, coming back. None rewards training every day, maximum weight, body
weight, or training through a planned rest week.

Tiered rules unlock one row per tier reached; a user who jumps straight past
bronze to silver gets both, so the trophy room reads the same however fast
someone progressed.
"""

from collections.abc import Callable
from dataclasses import dataclass, field

TIERS = ("bronze", "silver", "gold")


@dataclass
class Context:
    sessions: int = 0
    active_days: int = 0
    kept_weeks: int = 0
    longest_streak: int = 0
    distinct_exercises: int = 0
    distinct_patterns: int = 0
    distinct_disciplines: int = 0
    tonnage_kg: float = 0.0
    distance_km: float = 0.0
    hours: float = 0.0
    rewarded_prs: int = 0
    rpe_sets: int = 0
    push_sets: int = 0
    pull_sets: int = 0
    longest_gap_return: int = 0  # longest break (days) the user came back from
    early_sessions: int = 0  # started before 07:00 local
    late_sessions: int = 0  # started at or after 21:00 local
    restful_run: int = 0  # consecutive kept weeks never exceeding target + 2 days
    repaired_then_kept: bool = False
    kudos_given: int = 0
    groups_joined: int = 0
    challenges_finished: int = 0
    body_metric_days: int = 0
    pr_streak: int = 0  # longest run of four-week blocks with a PR
    habit_best_days: int = 0  # most days any one habit was done
    habit_kept_weeks: int = 0  # kept weeks across all habits
    habit_categories: int = 0  # areas of life with a habit done at least once
    habit_best_clean: int = 0  # longest clean run of a habit being broken


@dataclass(frozen=True)
class Rule:
    id: str
    title: str
    description: str
    category: str
    value: Callable[[Context], float]
    thresholds: tuple[float, ...]  # one for single badges, three for tiered
    hidden: bool = False
    unit: str = ""
    tier_names: tuple[str, ...] = field(default=())

    @property
    def tiered(self) -> bool:
        return len(self.thresholds) == 3

    def reached(self, ctx: Context) -> list[str | None]:
        v = self.value(ctx)
        if not self.tiered:
            return [None] if v >= self.thresholds[0] else []
        return [tier for tier, t in zip(TIERS, self.thresholds, strict=True) if v >= t]

    def progress(self, ctx: Context) -> dict:
        v = self.value(ctx)
        nxt = next((t for t in self.thresholds if v < t), None)
        return {"value": round(v, 1), "next": nxt, "max": self.thresholds[-1]}


RULES: tuple[Rule, ...] = (
    # --- milestones ---------------------------------------------------------
    Rule(
        "first_session",
        "First log",
        "Log your first session. The hardest one.",
        "milestone",
        lambda c: c.sessions,
        (1,),
    ),
    Rule(
        "first_kept_week",
        "Week one",
        "Hit your weekly target for the first time.",
        "milestone",
        lambda c: c.kept_weeks,
        (1,),
    ),
    # --- consistency ----------------------------------------------------------
    Rule(
        "showing_up",
        "Showing up",
        "Train on distinct days. Rest days never count against you.",
        "consistency",
        lambda c: c.active_days,
        (10, 50, 150),
        unit="days",
    ),
    Rule(
        "unbroken",
        "Unbroken",
        "Build a streak of kept weeks.",
        "consistency",
        lambda c: c.longest_streak,
        (4, 12, 26),
        unit="weeks",
    ),
    Rule(
        "year_of_the_chain",
        "A year of weeks",
        "Keep your streak for 52 weeks.",
        "consistency",
        lambda c: c.longest_streak,
        (52,),
        unit="weeks",
    ),
    Rule(
        "rest_is_training",
        "Rest is training",
        "Keep eight weeks in a row without training more than two days past your target.",
        "consistency",
        lambda c: c.restful_run,
        (8,),
        unit="weeks",
    ),
    # --- breadth -------------------------------------------------------------
    Rule(
        "explorer",
        "Explorer",
        "Log different exercises.",
        "collection",
        lambda c: c.distinct_exercises,
        (10, 25, 50),
        unit="exercises",
    ),
    Rule(
        "movement_master",
        "Movement master",
        "Train every movement pattern.",
        "collection",
        lambda c: c.distinct_patterns,
        (6, 9, 12),
        unit="patterns",
    ),
    Rule(
        "multi_sport",
        "Multi-sport",
        "Log sessions in different disciplines.",
        "collection",
        lambda c: c.distinct_disciplines,
        (2, 4, 6),
        unit="disciplines",
    ),
    # --- lifetime landmarks. Lifetime totals only ever rise, so they reward
    #     sticking around, not any single heroic day. --------------------------
    Rule(
        "tonnage",
        "Heavy lifting",
        "Accumulate lifetime tonnage.",
        "volume",
        lambda c: c.tonnage_kg,
        (25_000, 100_000, 500_000),
        unit="kg",
        tier_names=("Moved a piano", "Moved a rhino", "Moved a bus"),
    ),
    Rule(
        "distance",
        "Long way round",
        "Cover lifetime distance, on foot, wheels or water.",
        "volume",
        lambda c: c.distance_km,
        (42.2, 500, 2_000),
        unit="km",
        tier_names=("A marathon, eventually", "Across a country", "Across a continent"),
    ),
    Rule(
        "time_well_spent",
        "Time well spent",
        "Log lifetime training hours.",
        "volume",
        lambda c: c.hours,
        (10, 100, 500),
        unit="hours",
    ),
    # --- records ---------------------------------------------------------------
    Rule(
        "first_pr",
        "New best",
        "Beat one of your own records.",
        "pr",
        lambda c: c.rewarded_prs,
        (1,),
    ),
    Rule(
        "pr_collector",
        "Getting better",
        "Set personal records - your own, nobody else's.",
        "pr",
        lambda c: c.rewarded_prs,
        (10, 25, 50),
        unit="records",
    ),
    Rule(
        "always_improving",
        "Always improving",
        "A personal record in consecutive four-week blocks. Any lift, any size.",
        "pr",
        lambda c: c.pr_streak,
        (3, 6, 13),
        unit="blocks",
    ),
    # --- honest logging ------------------------------------------------------
    Rule(
        "honest_logger",
        "Honest logger",
        "Log how hard sets felt (RPE). Complete records, not heavier ones.",
        "consistency",
        lambda c: c.rpe_sets,
        (50, 200, 500),
        unit="sets",
    ),
    # --- habits --------------------------------------------------------------
    # Named generically on purpose: badges show on profiles, and a habit's
    # name - especially one being broken - never should.
    Rule(
        "sixty_six",
        "Sixty-six days",
        "Do one habit on 66 days: about how long, on average, a habit takes to feel automatic.",
        "consistency",
        lambda c: c.habit_best_days,
        (66,),
    ),
    Rule(
        "habit_keeper",
        "Habit keeper",
        "Keep the weekly target on your habits, week after week.",
        "consistency",
        lambda c: c.habit_kept_weeks,
        (10, 50, 150),
        unit="habit weeks",
    ),
    Rule(
        "well_rounded",
        "Well rounded",
        "Keep habits in three different areas of life.",
        "collection",
        lambda c: c.habit_categories,
        (3,),
    ),
    Rule(
        "held_the_line",
        "Held the line",
        "Thirty days in a row free of a habit you're breaking. Private: it never says which.",
        "consistency",
        lambda c: c.habit_best_clean,
        (30,),
    ),
    Rule(
        "measured",
        "Measured",
        "Keep a private body log on different days. Only you ever see it.",
        "consistency",
        lambda c: c.body_metric_days,
        (10,),
        unit="days",
    ),
    # --- social --------------------------------------------------------------
    Rule(
        "cheerleader",
        "Cheerleader",
        "Give kudos to other people's sessions.",
        "social",
        lambda c: c.kudos_given,
        (10,),
        unit="kudos",
    ),
    Rule("crew", "Crew", "Join or start a group.", "social", lambda c: c.groups_joined, (1,)),
    Rule(
        "finisher",
        "Finisher",
        "See a challenge through to the end.",
        "social",
        lambda c: c.challenges_finished,
        (1,),
    ),
    # --- hidden: good behaviour, discovered rather than chased ---------------
    Rule(
        "welcome_back",
        "Welcome back",
        "Return after two weeks or more away. Coming back is the part that counts.",
        "hidden",
        lambda c: c.longest_gap_return,
        (14,),
        hidden=True,
    ),
    Rule(
        "balanced",
        "Balanced",
        "Keep pushing and pulling volume within 25% of each other.",
        "hidden",
        lambda c: (
            min(c.push_sets, c.pull_sets) / max(c.push_sets, c.pull_sets) * 100
            if c.push_sets + c.pull_sets >= 40 and min(c.push_sets, c.pull_sets) > 0
            else 0
        ),
        (75,),
        hidden=True,
    ),
    Rule(
        "early_bird",
        "Early bird",
        "Five sessions started before 7am.",
        "hidden",
        lambda c: c.early_sessions,
        (5,),
        hidden=True,
    ),
    Rule(
        "night_owl",
        "Night owl",
        "Five sessions started after 9pm.",
        "hidden",
        lambda c: c.late_sessions,
        (5,),
        hidden=True,
    ),
    Rule(
        "second_chance",
        "Second chance",
        "Repair a week, then keep the next four.",
        "hidden",
        lambda c: 1 if c.repaired_then_kept else 0,
        (1,),
        hidden=True,
    ),
)

RULE_BY_ID = {r.id: r for r in RULES}
