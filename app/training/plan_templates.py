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
)

PLAN_TEMPLATE_BY_ID = {t["id"]: t for t in PLAN_TEMPLATES}
