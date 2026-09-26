"""Habits: the engine, XP caps, quests, the API, privacy, the whole-life
streak, export/import and reminders."""

import io
import json
from datetime import UTC, date, datetime, timedelta

from app.game.quests import BY_ID, WeekFacts, progress_of, quests_for
from app.game.xp import HABIT_DAY_CAP, HABIT_DAY_XP, habit_xp
from app.habits.catalog import TEMPLATES
from app.habits.engine import HabitDay, done_days, view_habit
from app.worker import habit_reminders
from tests.conftest import bearer, person
from tests.test_training import workout
from tests.test_worker import run

MON = date(2026, 9, 7)


def days(*offsets: int) -> list[HabitDay]:
    return [HabitDay(MON + timedelta(days=o), 1) for o in offsets]


# --- engine -----------------------------------------------------------------------


def test_done_days_by_kind():
    logs = [HabitDay(MON, 5), HabitDay(MON + timedelta(days=1), 12)]
    today = MON + timedelta(days=3)
    assert done_days("count", 10, logs, MON, today) == {MON + timedelta(days=1)}
    assert done_days("check", None, logs, MON, today) == {MON, MON + timedelta(days=1)}
    # Quit: every day since the start is clean unless a slip is logged.
    assert done_days("quit", None, [HabitDay(MON + timedelta(days=1), 1)], MON, today) == {
        MON,
        MON + timedelta(days=2),
        MON + timedelta(days=3),
    }


def test_habit_streak_is_week_based_and_rest_days_are_free():
    # Three days a week, kept two weeks running; today early in week three.
    v = view_habit(
        kind="check",
        daily_goal=None,
        weekly_target=3,
        started_on=MON,
        logs=days(0, 2, 4, 7, 9, 11),
        today=MON + timedelta(days=15),
        week_starts_on=0,
        paused_days=set(),
    )
    assert v.chain.current == 2 and v.chain.weeks[-1].status == "open"
    # Two kept weeks and a new week not yet started: full strength, since
    # the open week can't count against it before it's over.
    assert v.strength == 100


def test_strength_dents_rather_than_resets():
    def weekly(skip: set[int]) -> int:
        logs = [HabitDay(MON + timedelta(days=d), 1) for d in range(70) if d // 7 not in skip]
        return view_habit(
            kind="check",
            daily_goal=None,
            weekly_target=7,
            started_on=MON,
            logs=logs,
            today=MON + timedelta(days=70),
            week_starts_on=0,
            paused_days=set(),
        ).strength

    steady = weekly(set())
    dented = weekly({9})  # the last closed week missed entirely
    assert steady == 100 and 60 <= dented < steady


def test_quit_habit_clean_runs():
    v = view_habit(
        kind="quit",
        daily_goal=None,
        weekly_target=7,
        started_on=MON,
        logs=[HabitDay(MON + timedelta(days=5), 2)],
        today=MON + timedelta(days=12),
        week_starts_on=0,
        paused_days=set(),
    )
    assert v.clean_run == 7 and v.best_clean_run == 7
    assert v.last_slip == MON + timedelta(days=5)


# --- XP and quests -------------------------------------------------------------------


class H:
    def __init__(self, kind="check", weekly_target=7):
        self.kind = kind
        self.weekly_target = weekly_target


def test_habit_xp_is_capped_per_habit_week_and_per_day():
    today = MON + timedelta(days=20)

    def v(ds, target=7):
        return view_habit(
            kind="check",
            daily_goal=None,
            weekly_target=target,
            started_on=MON,
            logs=days(*ds),
            today=today,
            week_starts_on=0,
            paused_days=set(),
        )

    # Ten habits all done on the same day: the day pays the cap, not 10x.
    many = [(H(), v([0]), []) for _ in range(10)]
    day_items = [i for i in habit_xp(many, 0, today) if i.source == "habit_day"]
    assert [i.amount for i in day_items] == [HABIT_DAY_CAP]
    # A 2-a-week habit done daily pays for two days a week only.
    twice = [(H(weekly_target=2), v(range(7), target=2), [])]
    paid = sum(i.amount for i in habit_xp(twice, 0, today) if i.source == "habit_day")
    assert paid == 2 * HABIT_DAY_XP
    # A habit being broken pays for kept weeks, never for each clean day.
    quit_view = view_habit(
        kind="quit",
        daily_goal=None,
        weekly_target=7,
        started_on=MON,
        logs=[],
        today=today,
        week_starts_on=0,
        paused_days=set(),
    )
    quit_items = habit_xp([(H(kind="quit"), quit_view, [])], 0, today)
    assert {i.source for i in quit_items} == {"habit_week"}


def test_habit_quest_only_for_people_with_habits():
    for i in range(20):
        w = MON + timedelta(weeks=i)
        assert "habit_week" not in {q.id for q in quests_for(w, weighs=True, has_habits=False)}
    seen = {q.id for i in range(30) for q in quests_for(MON + timedelta(weeks=i), True, True)}
    assert "habit_week" in seen
    q = BY_ID["habit_week"]
    assert progress_of(q, WeekFacts(habits_kept=3, habits_total=3), MON) == 1
    assert progress_of(q, WeekFacts(habits_kept=2, habits_total=3), MON) == 0
    assert progress_of(q, WeekFacts(), MON) == 0


def test_catalog_has_no_restrictive_eating_templates():
    text = " ".join(f"{t.id} {t.name} {t.blurb}".lower() for t in TEMPLATES)
    for banned in ("calorie", "fasting", "skip meal", "weight loss", "diet"):
        assert banned not in text
    assert len(TEMPLATES) >= 60 and len({t.id for t in TEMPLATES}) == len(TEMPLATES)


# --- API -------------------------------------------------------------------------------


def test_habit_lifecycle(client):
    token = person(client, "habits@example.com", "habitual")
    h = bearer(token)
    catalog = client.get("/v1/habits/catalog").json()
    assert {"learning", "mind", "break"} <= set(catalog["categories"])

    read = client.post("/v1/habits", json={"template_id": "read"}, headers=h).json()
    assert (read["kind"], read["unit"], read["daily_goal"]) == ("count", "pages", 10)
    custom = client.post(
        "/v1/habits",
        json={
            "name": "Guitar scales",
            "kind": "duration",
            "daily_goal": 15,
            "weekly_target": 5,
            "category": "learning",
            "total_goal": 6000,
            "cue": "After dinner",
        },
        headers=h,
    ).json()
    assert custom["unit"] == "minutes"
    assert client.post("/v1/habits", json={}, headers=h).status_code == 422
    assert (
        client.post("/v1/habits", json={"name": "x", "category": "nope"}, headers=h).status_code
        == 422
    )

    today = datetime.now(UTC).date()
    # Several small adds make a day.
    for _ in range(2):
        r = client.post(f"/v1/habits/{read['id']}/days/{today}/add", json={"amount": 5}, headers=h)
    assert r.json()["today"] == {"amount": 10.0, "done": True}
    # Yesterday can be filled in, and cleared again.
    yesterday = (today - timedelta(days=1)).isoformat()
    filled = client.put(f"/v1/habits/{read['id']}/days/{yesterday}", json={"amount": 12}, headers=h)
    assert filled.status_code == 200
    detail = client.get(f"/v1/habits/{read['id']}", headers=h).json()
    assert len(detail["days"]) == 2 and detail["weeks"]
    client.put(f"/v1/habits/{read['id']}/days/{yesterday}", json={"amount": 0}, headers=h)
    assert len(client.get(f"/v1/habits/{read['id']}", headers=h).json()["days"]) == 1
    # Too far back, or in the future, is refused.
    old = (today - timedelta(days=90)).isoformat()
    assert (
        client.put(f"/v1/habits/{read['id']}/days/{old}", json={"amount": 1}, headers=h).status_code
        == 422
    )
    future = (today + timedelta(days=2)).isoformat()
    assert (
        client.put(
            f"/v1/habits/{read['id']}/days/{future}", json={"amount": 1}, headers=h
        ).status_code
        == 422
    )

    # The kind can't change; other fields can, and can be cleared.
    assert (
        client.patch(f"/v1/habits/{custom['id']}", json={"kind": "check"}, headers=h).status_code
        == 422
    )
    patched = client.patch(
        f"/v1/habits/{custom['id']}", json={"cue": None, "weekly_target": 3}, headers=h
    ).json()
    assert patched["cue"] is None and patched["weekly_target"] == 3

    # Archive hides it but keeps history; delete removes it.
    client.post(f"/v1/habits/{custom['id']}/archive", headers=h)
    assert [x["id"] for x in client.get("/v1/habits", headers=h).json()] == [read["id"]]
    assert len(client.get("/v1/habits?archived=true", headers=h).json()) == 2
    assert client.delete(f"/v1/habits/{custom['id']}", headers=h).status_code == 204

    other = bearer(person(client, "nosyhabit@example.com", "nosyhabit"))
    assert client.get(f"/v1/habits/{read['id']}", headers=other).status_code == 404
    assert (
        client.put(
            f"/v1/habits/{read['id']}/days/{today}", json={"amount": 1}, headers=other
        ).status_code
        == 404
    )

    stats = client.get("/v1/me/stats", headers=h).json()
    assert stats["habits"] == {"count": 1, "done_today": 1, "kept_this_week": 0}
    assert stats["xp"]["by_source"].get("habit_day", 0) > 0


def test_quit_habit_stays_private_and_badges_never_name_it(client):
    token = person(client, "quitter@example.com", "quitter", visibility="public")
    h = bearer(token)
    habit = client.post("/v1/habits", json={"template_id": "no-smoking"}, headers=h).json()
    assert habit["kind"] == "quit" and habit["clean_run"] == 1
    today = datetime.now(UTC).date()
    slipped = client.put(
        f"/v1/habits/{habit['id']}/days/{today}", json={"amount": 1}, headers=h
    ).json()
    assert slipped["clean_run"] == 0 and slipped["last_slip"] == today.isoformat()
    viewer = bearer(person(client, "viewer@example.com", "viewer"))
    public = client.get("/v1/people/quitter", headers=viewer).text.lower()
    assert "smok" not in public
    feed = client.get("/v1/feed", headers=viewer).text.lower()
    assert "smok" not in feed


def test_whole_life_streak_counts_training_or_any_habit(client):
    token = person(client, "life@example.com", "lifer")
    h = bearer(token)
    assert client.get("/v1/me/stats", headers=h).json()["life"] is None
    client.patch("/v1/me/profile", json={"life_target": 2}, headers=h)
    habit = client.post("/v1/habits", json={"template_id": "journal"}, headers=h).json()
    today = datetime.now(UTC).date()
    client.put(f"/v1/habits/{habit['id']}/days/{today}", json={"amount": 1}, headers=h)
    client.put(f"/v1/workouts/{__import__('uuid').uuid4()}", json=workout(), headers=h)
    life = client.get("/v1/me/stats", headers=h).json()["life"]
    assert life["target"] == 2 and life["this_week_days"] >= 1
    client.patch("/v1/me/profile", json={"leaderboard_opt_in": True}, headers=h)
    board = client.get("/v1/leaderboards/life_streak?scope=global", headers=h)
    assert board.status_code == 200


def test_habits_export_and_import(client):
    token = person(client, "exporthabits@example.com", "exporthabits")
    h = bearer(token)
    habit = client.post("/v1/habits", json={"template_id": "water"}, headers=h).json()
    today = datetime.now(UTC).date().isoformat()
    client.put(
        f"/v1/habits/{habit['id']}/days/{today}", json={"amount": 6, "note": "hot day"}, headers=h
    )
    data = client.get("/v1/me/export?format=json", headers=h).json()
    assert data["habits"][0]["days"] == [{"date": today, "amount": 6.0, "note": "hot day"}]
    other = bearer(person(client, "importhabits@example.com", "importhabits"))
    files = {"file": ("e.json", io.BytesIO(json.dumps(data).encode()), "application/json")}
    for _ in range(2):  # twice: no duplicates
        assert client.post("/v1/me/import", files=files, headers=other).status_code == 200
    mine = client.get("/v1/habits", headers=other).json()
    assert len(mine) == 1 and mine[0]["today"]["done"] is True


def test_habit_reminder_fires_at_the_chosen_hour_until_done(client):
    token = person(client, "remindme@example.com", "remindme")
    h = bearer(token)
    hour = datetime.now(UTC).hour
    habit = client.post(
        "/v1/habits", json={"template_id": "meditate", "remind_hour": hour}, headers=h
    ).json()
    client.post("/v1/habits", json={"template_id": "no-vaping", "remind_hour": hour}, headers=h)
    first = run(habit_reminders)
    assert len(first) == 1  # the quit habit never reminds
    assert run(habit_reminders) == []  # once a day
    other = bearer(person(client, "remindmedone@example.com", "remindmedone"))
    done = client.post(
        "/v1/habits", json={"template_id": "meditate", "remind_hour": hour}, headers=other
    ).json()
    today = datetime.now(UTC).date()
    client.put(f"/v1/habits/{done['id']}/days/{today}", json={"amount": 10}, headers=other)
    assert run(habit_reminders) == []
    assert habit["remind_hour"] == hour
