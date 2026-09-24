"""The pure engines: streaks, records, XP, levels. No database."""

from datetime import date, timedelta

from app.game.levels import level_for_xp, xp_for_level, xp_to_reach
from app.game.records import Observation, detect, e1rm
from app.game.streak import compute_chain, target_resolver
from app.game.xp import DAY_XP, EXTRA_DAY_XP, DayActivity, compute_xp

MON = date(2026, 9, 7)  # a Monday


def days(*offsets: int) -> list[date]:
    return [MON + timedelta(days=o) for o in offsets]


def fixed(target: int):
    return lambda _week: target


def test_week_is_kept_when_target_met_and_rest_days_cost_nothing():
    # Three sessions in week one (Mon/Wed/Fri), today is the next Tuesday.
    r = compute_chain(days(0, 2, 4), MON + timedelta(days=8), 0, fixed(3))
    assert r.weeks[0].status == "kept"
    assert r.current == 1


def test_current_week_never_breaks_the_streak():
    r = compute_chain(days(0, 2, 4), MON + timedelta(days=7), 0, fixed(3))
    assert r.weeks[-1].status == "open"
    assert r.current == 1


def test_missed_week_breaks_without_freeze():
    r = compute_chain(days(0, 2, 4, 14, 16, 18), MON + timedelta(days=21), 0, fixed(3))
    assert [w.status for w in r.weeks] == ["kept", "missed", "kept", "open"]
    assert r.current == 1
    assert r.longest == 1


def test_freeze_is_earned_every_four_kept_weeks_and_spent_automatically():
    active = [d for w in range(4) for d in days(w * 7, w * 7 + 2, w * 7 + 4)]
    # Weeks 0-3 kept, week 4 missed, week 5 kept, today in week 6.
    active += days(35, 37, 39)
    r = compute_chain(active, MON + timedelta(days=43), 0, fixed(3))
    statuses = [w.status for w in r.weeks]
    assert statuses[:6] == ["kept", "kept", "kept", "kept", "frozen", "kept"]
    assert r.current == 6
    assert r.freezes_available == 0


def test_repair_counts_a_missed_week():
    active = days(0, 2, 4, 14, 16, 18)
    r = compute_chain(active, MON + timedelta(days=15), 0, fixed(3), repaired=[MON + timedelta(days=7)])
    assert [w.status for w in r.weeks] == ["kept", "repaired", "open"]
    assert r.current == 2


def test_repairable_week_is_offered_only_when_available():
    active = days(0, 2, 4)
    today = MON + timedelta(days=15)
    assert compute_chain(active, today, 0, fixed(3), repair_available=True).repairable_week == MON + timedelta(days=7)
    assert compute_chain(active, today, 0, fixed(3), repair_available=False).repairable_week is None


def test_raising_the_target_does_not_rejudge_past_weeks():
    history = [{"from": "2000-01-03", "target": 3}, {"from": (MON + timedelta(days=7)).isoformat(), "target": 5}]
    r = compute_chain(days(0, 2, 4, 7, 8, 9), MON + timedelta(days=15), 0, target_resolver(history))
    assert r.weeks[0].status == "kept"  # judged by 3
    assert r.weeks[1].status == "missed"  # judged by 5, only 3 days
    assert r.weeks[1].target == 5


def test_at_risk_when_every_remaining_day_is_needed():
    # Target 4, one session on Monday; today is Friday: needs 3, has Fri/Sat/Sun.
    r = compute_chain(days(0), MON + timedelta(days=4), 0, fixed(4))
    assert r.needed == 3 and r.days_left == 3 and r.at_risk


def test_week_start_respects_preference():
    # Weeks starting Sunday (6): Sunday the 13th opens a new week.
    r = compute_chain([date(2026, 9, 13)], date(2026, 9, 14), 6, fixed(1))
    assert r.weeks[-1].week_start == date(2026, 9, 13)
    assert r.weeks[-1].status == "kept"


def test_e1rm():
    assert e1rm(100, 1) == 100
    assert round(e1rm(100, 5), 1) == 116.7
    assert e1rm(100, 20) == 0  # not graded past a dozen reps


def test_pr_detection_flags_implausible_jumps_and_respects_cooldown():
    d0 = date(2026, 1, 1)
    obs = [
        Observation("e1rm:bench", 100, d0, "a"),
        Observation("e1rm:bench", 105, d0 + timedelta(days=3), "b"),  # +5%: rewarded
        Observation("e1rm:bench", 108, d0 + timedelta(days=5), "c"),  # within 7-day cooldown
        Observation("e1rm:bench", 200, d0 + timedelta(days=20), "d"),  # +85%: flagged
    ]
    events, bests = detect(obs)
    assert [(e.value, e.rewarded, e.flagged) for e in events] == [
        (105, True, False),
        (108, False, False),
        (200, False, True),
    ]
    assert bests["e1rm:bench"].value == 200


def test_lower_is_better_for_pace():
    d0 = date(2026, 1, 1)
    events, _ = detect([
        Observation("pace_5k:run", 330, d0, "a", higher_is_better=False),
        Observation("pace_5k:run", 320, d0 + timedelta(days=10), "b", higher_is_better=False),
    ])
    assert events[0].rewarded and round(events[0].gain_pct, 1) == 3.0


def test_same_day_sets_are_one_pr():
    d0 = date(2026, 1, 1)
    events, _ = detect([
        Observation("e1rm:squat", 100, d0, "a"),
        Observation("e1rm:squat", 104, d0 + timedelta(days=8), "b"),
        Observation("e1rm:squat", 106, d0 + timedelta(days=8), "b"),
    ])
    assert len(events) == 1 and events[0].value == 106


def test_xp_does_not_reward_training_every_day():
    week = [DayActivity(MON + timedelta(days=i), 1, False) for i in range(7)]
    items = compute_xp(week, 0, fixed(3), [], [], [], [])
    day_xp = [i.amount for i in items if i.source == "training_day"]
    # target 3 + 1 pay full; the other three pay the reduced rate
    assert day_xp == [DAY_XP] * 4 + [EXTRA_DAY_XP] * 3


def test_xp_ignores_load_entirely():
    light = compute_xp([DayActivity(MON, 1, True)], 0, fixed(3), [], [], [], [])
    heavy = compute_xp([DayActivity(MON, 1, True)], 0, fixed(3), [], [], [], [])
    assert sum(i.amount for i in light) == sum(i.amount for i in heavy)


def test_level_curve_is_monotonic_and_consistent():
    assert level_for_xp(0) == 1
    assert level_for_xp(xp_for_level(1)) == 2
    for level in range(1, 30):
        assert level_for_xp(xp_to_reach(level)) == level
        assert xp_for_level(level + 1) > xp_for_level(level)
