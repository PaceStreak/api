"""Built-in training plans, copied into an account when chosen.

Deliberately conservative. They are starting points for healthy adults, not
coaching or medical advice (see /terms), and every one repeats the same two
rules: an easy effort means you could talk in sentences, and a sore or hurt
body gets a rest day or a pause, never a push. A plan is a schedule of
suggestions; the streak counts what you actually did.

Days are offsets from the person's own week start (0 = first day of the
week), so a plan fits a Sunday-start week as naturally as a Monday one.
"""

EASY = "Easy means you could hold a conversation. Slower is fine."


def _runwalk(run: float, walk: float, reps: int) -> dict:
    run_s = f"{run:g} min"
    walk_s = f"{walk:g} min"
    minutes = round(5 + reps * (run + walk) + 5)
    return {
        "discipline": "run",
        "title": f"Run {run_s} / walk {walk_s}, x{reps}",
        "minutes": minutes,
        "note": f"5 min brisk walk to warm up and cool down. {EASY}",
    }


def _run(minutes: int, title: str | None = None, note: str = EASY) -> dict:
    return {
        "discipline": "run",
        "title": title or f"Easy run, {minutes} min",
        "minutes": minutes,
        "note": note,
    }


def _week(days: tuple[int, ...], *sessions: dict) -> list[dict]:
    return [{"day": d} | s for d, s in zip(days, sessions, strict=True)]


RUN_DAYS = (0, 2, 5)

RUN_FROM_ZERO = [
    _week(RUN_DAYS, _runwalk(1, 1.5, 8), _runwalk(1, 1.5, 8), _runwalk(1, 1.5, 8)),
    _week(RUN_DAYS, _runwalk(1.5, 2, 6), _runwalk(1.5, 2, 6), _runwalk(2, 2, 5)),
    _week(RUN_DAYS, _runwalk(2, 1.5, 6), _runwalk(2, 1.5, 6), _runwalk(3, 1.5, 5)),
    _week(RUN_DAYS, _runwalk(3, 1.5, 5), _runwalk(4, 1.5, 4), _runwalk(4, 1.5, 4)),
    _week(RUN_DAYS, _runwalk(5, 1.5, 3), _runwalk(6, 1.5, 3), _runwalk(8, 2, 2)),
    _week(RUN_DAYS, _runwalk(8, 1.5, 2), _runwalk(10, 1.5, 2), _run(15)),
    _week(RUN_DAYS, _run(18), _run(20), _run(22)),
    _week(
        RUN_DAYS,
        _run(25),
        _run(25),
        _run(30, "Run 30 minutes without stopping", "The goal of the whole plan. Any pace counts."),
    ),
]

FIVE_TO_TEN = [
    _week(
        RUN_DAYS,
        _run(30),
        _run(
            25,
            "Strides: easy 20 min + 4 x 20 s quick",
            "Quick, not sprinting. Walk back between each.",
        ),
        _run(40, "Long run, 40 min"),
    ),
    _week(RUN_DAYS, _run(30), _run(30), _run(45, "Long run, 45 min")),
    _week(
        RUN_DAYS,
        _run(35),
        _run(
            30,
            "Tempo: 10 min easy, 10 min steady, 10 min easy",
            "Steady = comfortably hard, a few words at a time.",
        ),
        _run(50, "Long run, 50 min"),
    ),
    _week(
        RUN_DAYS,
        _run(30),
        _run(30),
        _run(40, "Long run, 40 min", "A lighter week on purpose. Absorb the work."),
    ),
    _week(
        RUN_DAYS,
        _run(35),
        _run(35, "Tempo: 10 easy, 15 steady, 10 easy"),
        _run(55, "Long run, 55 min"),
    ),
    _week(RUN_DAYS, _run(40), _run(35), _run(60, "Long run, 60 min")),
    _week(
        RUN_DAYS,
        _run(40),
        _run(35, "Tempo: 10 easy, 20 steady, 5 easy"),
        _run(65, "Long run, 65 min"),
    ),
    _week(
        RUN_DAYS,
        _run(30),
        _run(20, "Short and easy, with 4 strides"),
        _run(
            65,
            "10 km, or 65 minutes",
            "Run the distance at an even, easy pace. Finishing is the goal.",
        ),
    ),
]

STRENGTH_DAYS = (0, 2, 4)


def _lift(template: str, title: str) -> dict:
    return {
        "discipline": "strength",
        "title": title,
        "minutes": 50,
        "routine_template": template,
        "note": "Add a little weight only when every set reached the top of the rep range.",
    }


A = _lift("tpl-full-body-a", "Full body A")
B = _lift("tpl-full-body-b", "Full body B")
STRENGTH_FOUNDATIONS = [
    _week(STRENGTH_DAYS, A, B, A) if w % 2 == 0 else _week(STRENGTH_DAYS, B, A, B) for w in range(6)
]

HABIT_DAYS = (1, 4)
HABIT = [
    _week(
        HABIT_DAYS,
        {
            "discipline": "walk",
            "title": "Walk, 20 min",
            "minutes": 20,
            "note": "Anything counts. The habit is the point.",
        },
        {
            "discipline": "yoga",
            "title": "Mobility, 15 min",
            "minutes": 15,
            "note": "Gentle. Stop anything that pinches.",
        },
    ),
    _week(
        HABIT_DAYS,
        {"discipline": "walk", "title": "Walk, 25 min", "minutes": 25},
        {
            "discipline": "strength",
            "title": "No-equipment circuit",
            "minutes": 20,
            "routine_template": "tpl-no-equipment",
        },
    ),
    _week(
        HABIT_DAYS,
        {"discipline": "walk", "title": "Brisk walk, 30 min", "minutes": 30},
        {
            "discipline": "strength",
            "title": "No-equipment circuit",
            "minutes": 25,
            "routine_template": "tpl-no-equipment",
        },
    ),
    _week(
        HABIT_DAYS,
        {"discipline": "walk", "title": "Brisk walk, 30 min", "minutes": 30},
        {
            "discipline": "strength",
            "title": "No-equipment circuit",
            "minutes": 25,
            "routine_template": "tpl-no-equipment",
        },
    ),
]


def _session(
    discipline: str, title: str, minutes: int, note: str | None = None, tpl: str | None = None
) -> dict:
    out = {"discipline": discipline, "title": title, "minutes": minutes}
    if note:
        out["note"] = note
    if tpl:
        out["routine_template"] = tpl
    return out


def _routine(tpl: str, title: str, minutes: int = 50) -> dict:
    return _lift(tpl, title) | {"minutes": minutes}


def _alternate(days: tuple[int, ...], a: dict, b: dict, weeks: int) -> list[list[dict]]:
    """A/B/A one week, B/A/B the next: the classic three-day alternation."""
    return [_week(days, *[(a, b)[(w + i) % 2] for i in range(len(days))]) for w in range(weeks)]


def _build(minutes: list[int], make) -> list[list[dict]]:
    return [make(m, i) for i, m in enumerate(minutes)]


FIVE_BY_FIVE = _alternate(
    STRENGTH_DAYS,
    _routine("tpl-5x5-a", "Five by five A", 45),
    _routine("tpl-5x5-b", "Five by five B", 45),
    12,
)

PPL_DAYS = (0, 1, 2, 3, 4, 5)
PUSH = _routine("tpl-push", "Push", 60)
PULL = _routine("tpl-pull", "Pull", 60)
LEGS = _routine("tpl-legs", "Legs", 60)
PPL_SIX = [_week(PPL_DAYS, PUSH, PULL, LEGS, PUSH, PULL, LEGS) for _ in range(8)]
PPL_THREE = [_week(STRENGTH_DAYS, PUSH, PULL, LEGS) for _ in range(8)]

UL_DAYS = (0, 1, 3, 4)
UPPER_LOWER = [
    _week(
        UL_DAYS,
        _routine("tpl-upper-power", "Upper power", 60),
        _routine("tpl-lower-power", "Lower power", 60),
        _routine("tpl-upper-hypertrophy", "Upper volume", 60),
        _routine("tpl-lower-hypertrophy", "Lower volume", 60),
    )
    for _ in range(10)
]

DUMBBELLS = _alternate(
    STRENGTH_DAYS,
    _routine("tpl-dumbbell-a", "Dumbbells A", 45),
    _routine("tpl-dumbbell-b", "Dumbbells B", 45),
    8,
)

KETTLEBELL = [
    _week(
        STRENGTH_DAYS,
        _routine("tpl-kettlebell", "Kettlebell basics", 35),
        _session("walk", "Walk, 30 min", 30, "Easy. Recovery is part of the plan."),
        _routine("tpl-kettlebell", "Kettlebell basics", 35),
    )
    for _ in range(6)
]

CALISTHENICS = _alternate(
    STRENGTH_DAYS,
    _routine("tpl-calisthenics-a", "Bodyweight A", 45),
    _routine("tpl-calisthenics-b", "Bodyweight B", 45),
    10,
)

GLUTES = [
    _week(
        (0, 2, 4),
        _routine("tpl-glutes", "Glutes and hamstrings", 55),
        _routine("tpl-upper", "Upper", 50),
        _routine("tpl-lower", "Lower", 55),
    )
    for _ in range(8)
]

GYM_FIRST_MONTH = [
    _week(
        (0, 3),
        _routine("tpl-machines", "Machine circuit", 40),
        _routine("tpl-machines", "Machine circuit", 40),
    )
    for _ in range(2)
] + [
    _week(
        STRENGTH_DAYS,
        _routine("tpl-machines", "Machine circuit", 40),
        _routine("tpl-full-body-a", "Full body A", 50),
        _routine("tpl-machines", "Machine circuit", 40),
    )
    for _ in range(2)
]

HYBRID = [
    _week(
        (0, 1, 2, 4, 5),
        _routine("tpl-full-body-a", "Full body A", 50),
        _run(30 + 5 * min(w, 4)),
        _routine("tpl-full-body-b", "Full body B", 50),
        _run(25, "Easy run with 6 x 20 s strides", "Strides are quick and relaxed, not sprints."),
        _run(40 + 5 * w if w % 4 != 3 else 35, "Long easy run"),
    )
    for w in range(8)
]

CONDITIONING = [
    _week(
        (0, 2, 4),
        _session(
            "hiit",
            f"Circuit, {r} rounds",
            20 + 5 * r,
            "Hard but repeatable; rest as long as you need between rounds.",
            "tpl-conditioning",
        ),
        _session("walk", "Easy walk or ride", 30, "Low effort on purpose."),
        _session("hiit", f"Circuit, {r} rounds", 20 + 5 * r, None, "tpl-conditioning"),
    )
    for r in (2, 2, 3, 3, 4, 3)
]

CORE_DAILY = [_week((0, 2, 4), *[_routine("tpl-core", "Core, 15 min", 15)] * 3) for _ in range(4)]

# Endurance: never more than about 10% more time a week, every fourth week lighter.
RIDE_MINUTES = [45, 50, 55, 45, 60, 65, 70, 55, 75, 80, 90, 60]
RIDE_BASE = _build(
    RIDE_MINUTES,
    lambda m, i: _week(
        (1, 3, 5),
        _session("ride", "Easy ride", max(30, m // 2), EASY),
        _session(
            "ride",
            "Ride with 4 x 4 min steady" if i % 4 != 3 else "Easy ride",
            max(40, m * 2 // 3),
            "Steady is comfortably hard; spin easily between.",
        ),
        _session("ride", f"Long ride, {m} min", m, EASY),
    ),
)

SWIM_STEPS = [
    ("4 x 25 m, rest 30 s", 20),
    ("6 x 25 m, rest 30 s", 25),
    ("4 x 50 m, rest 30 s", 25),
    ("6 x 50 m, rest 30 s", 30),
    ("4 x 100 m, rest 45 s", 30),
    ("3 x 150 m, rest 45 s", 35),
    ("2 x 200 m, rest 60 s", 35),
    ("400 m continuous", 30),
]
SWIM_LAPS = [
    _week(
        (0, 3),
        _session("swim", f"Swim {sets}", m, "Any stroke. Rest at the wall as long as you need."),
        _session("swim", f"Swim {sets}", m, "Same again, a little smoother."),
    )
    for sets, m in SWIM_STEPS
]

ROW_BASE = _build(
    [20, 24, 28, 20, 30, 34, 38, 28],
    lambda m, i: _week(
        STRENGTH_DAYS,
        _session("row", f"Easy row, {m} min", m, "Rate 18-22, legs first."),
        _session("row", "Row 5 x 3 min steady, 1 min easy", 25 if i % 4 != 3 else 20),
        _session("row", f"Easy row, {m + 5} min", m + 5, EASY),
    ),
)

MOBILITY = [
    _week(
        (0, 1, 2, 3, 4),
        *[
            _session(
                "yoga",
                f"Mobility, {10 + 2 * w} min",
                10 + 2 * w,
                "Hips, spine, shoulders. Gentle; stop anything that pinches.",
            )
        ]
        * 5,
    )
    for w in range(4)
]

WALKING = _build(
    [20, 25, 30, 25, 35, 40],
    lambda m, i: _week(
        (0, 1, 3, 4, 6),
        *[_session("walk", f"Brisk walk, {m} min", m, "Brisk: you can talk, but not sing.")] * 5,
    ),
)

COMEBACK = [
    _week(
        (0, 3),
        _routine("tpl-full-body-a", "Full body A, lighter", 40),
        _session("walk", "Walk, 30 min", 30),
    ),
    _week(
        (0, 3),
        _routine("tpl-full-body-b", "Full body B, lighter", 40),
        _session("walk", "Walk, 30 min", 30),
    ),
    _week(
        STRENGTH_DAYS,
        _routine("tpl-full-body-a", "Full body A", 45),
        _session("walk", "Walk, 35 min", 35),
        _routine("tpl-full-body-b", "Full body B", 45),
    ),
    _week(
        STRENGTH_DAYS,
        _routine("tpl-full-body-b", "Full body B", 50),
        _run(20),
        _routine("tpl-full-body-a", "Full body A", 50),
    ),
]

PLAN_TEMPLATES: tuple[dict, ...] = (
    {
        "id": "plan-two-a-week",
        "name": "Two a week",
        "summary": (
            "Four gentle weeks to make training a habit: a walk and a short session, twice a week."
        ),
        "weeks": HABIT,
    },
    {
        "id": "plan-run-from-zero",
        "name": "Run from zero",
        "summary": (
            "Eight weeks of run/walk intervals, three times a week, "
            "to 30 minutes of continuous running."
        ),
        "weeks": RUN_FROM_ZERO,
    },
    {
        "id": "plan-5k-to-10k",
        "name": "5 km to 10 km",
        "summary": (
            "For someone who runs 30 minutes comfortably: eight weeks, three runs a week, one long."
        ),
        "weeks": FIVE_TO_TEN,
    },
    {
        "id": "plan-strength-foundations",
        "name": "Strength foundations",
        "summary": "Six weeks of three full-body sessions, alternating A and B. Add weight slowly.",
        "weeks": STRENGTH_FOUNDATIONS,
    },
    {
        "id": "plan-five-by-five",
        "name": "Five by five",
        "summary": (
            "Twelve weeks of the classic beginner barbell plan: three days, five sets of "
            "five, a little more weight every session."
        ),
        "weeks": FIVE_BY_FIVE,
    },
    {
        "id": "plan-gym-first-month",
        "name": "First month in the gym",
        "summary": (
            "Four weeks on guided machines, then the first free-weight session. Learn the "
            "room before the barbell."
        ),
        "weeks": GYM_FIRST_MONTH,
    },
    {
        "id": "plan-ppl-three",
        "name": "Push, pull, legs",
        "summary": "Eight weeks, three days: one push, one pull and one legs session.",
        "weeks": PPL_THREE,
    },
    {
        "id": "plan-ppl-six",
        "name": "Push, pull, legs x2",
        "summary": (
            "Eight weeks, six days: the split run twice. For people who recover well and have "
            "the time."
        ),
        "weeks": PPL_SIX,
    },
    {
        "id": "plan-upper-lower",
        "name": "Upper / lower, power and volume",
        "summary": (
            "Ten weeks, four days: a heavy upper and lower day, then a lighter, higher-rep pair."
        ),
        "weeks": UPPER_LOWER,
    },
    {
        "id": "plan-dumbbells-home",
        "name": "Dumbbells at home",
        "summary": (
            "Eight weeks, three days, nothing but a pair of dumbbells and a bench or the floor."
        ),
        "weeks": DUMBBELLS,
    },
    {
        "id": "plan-kettlebell",
        "name": "Kettlebell basics",
        "summary": "Six weeks: two kettlebell sessions and a walk each week.",
        "weeks": KETTLEBELL,
    },
    {
        "id": "plan-calisthenics",
        "name": "Bodyweight strength",
        "summary": (
            "Ten weeks with a pull-up bar and the floor: harder variations instead of heavier "
            "weights."
        ),
        "weeks": CALISTHENICS,
    },
    {
        "id": "plan-glutes-legs",
        "name": "Glutes and legs",
        "summary": "Eight weeks, three days: a glute-focused day, an upper day and a lower day.",
        "weeks": GLUTES,
    },
    {
        "id": "plan-hybrid",
        "name": "Lift and run",
        "summary": "Eight weeks: two full-body lifts and three easy runs, one of them long.",
        "weeks": HYBRID,
    },
    {
        "id": "plan-conditioning",
        "name": "Conditioning",
        "summary": (
            "Six weeks of circuits, building from two rounds to four, with an easy day between."
        ),
        "weeks": CONDITIONING,
    },
    {
        "id": "plan-core",
        "name": "Fifteen-minute core",
        "summary": (
            "Four weeks, three short core sessions a week. Pairs with any other plan's days off."
        ),
        "weeks": CORE_DAILY,
    },
    {
        "id": "plan-ride-base",
        "name": "Cycling base",
        "summary": (
            "Twelve weeks, three rides a week, building the long ride from 45 to 90 minutes."
        ),
        "weeks": RIDE_BASE,
    },
    {
        "id": "plan-swim-laps",
        "name": "Swim 400 m",
        "summary": (
            "Eight weeks, two pool sessions a week, from lengths with rests to 400 m without "
            "stopping."
        ),
        "weeks": SWIM_LAPS,
    },
    {
        "id": "plan-row-base",
        "name": "Rowing base",
        "summary": "Eight weeks, three sessions on the rowing machine, easy most of the time.",
        "weeks": ROW_BASE,
    },
    {
        "id": "plan-mobility",
        "name": "Daily mobility",
        "summary": "Four weeks, five short sessions a week, from 10 to 16 minutes.",
        "weeks": MOBILITY,
    },
    {
        "id": "plan-walking",
        "name": "Walk most days",
        "summary": "Six weeks, five brisk walks a week, from 20 to 40 minutes.",
        "weeks": WALKING,
    },
    {
        "id": "plan-comeback",
        "name": "Coming back",
        "summary": (
            "Four weeks back after a break or an injury that has healed: lighter lifting and "
            "walking first."
        ),
        "weeks": COMEBACK,
    },
)

PLAN_TEMPLATE_BY_ID = {t["id"]: t for t in PLAN_TEMPLATES}
