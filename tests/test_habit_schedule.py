"""Habits on chosen weekdays, and pausing one habit on its own."""

from datetime import date, timedelta

from app.habits.engine import first_week_target, pause_days, scheduled
from tests.conftest import bearer, person

MON = date(2026, 9, 28)
MWF = 0b0010101  # Monday, Wednesday, Friday


def test_scheduled_days():
    assert [scheduled(MWF, MON + timedelta(days=i)) for i in range(7)] == [
        True, False, True, False, True, False, False,
    ]  # fmt: skip
    assert scheduled(None, MON)


def test_first_week_counts_only_planned_days_left():
    # Started on Thursday: only Friday is left of Mon/Wed/Fri.
    assert first_week_target(3, MON + timedelta(days=3), MON, MWF) == 1
    assert first_week_target(3, MON, MON, MWF) == 3
    assert first_week_target(3, MON + timedelta(days=7), MON + timedelta(days=7), None) == 3


def test_pause_days_stop_at_today():
    today = MON + timedelta(days=3)
    assert pause_days(MON, None, today) == {MON + timedelta(days=i) for i in range(4)}
    assert pause_days(MON, MON + timedelta(days=1), today) == {MON, MON + timedelta(days=1)}
    assert pause_days(None, None, today) == set()


def _habit(client, h, **body):
    made = client.post("/v1/habits", json={"name": "Gym", **body}, headers=h)
    assert made.status_code == 201, made.text
    return made.json()


def test_picking_days_sets_the_target(client):
    h = bearer(person(client, "days@example.com", "dayplanner"))
    habit = _habit(client, h, days_mask=MWF)
    assert (habit["days_mask"], habit["weekly_target"]) == (MWF, 3)
    smaller = _habit(client, h, name="Read", days_mask=MWF, weekly_target=2)
    assert smaller["weekly_target"] == 2
    # A target above the planned days is brought down to them.
    too_many = client.patch(f"/v1/habits/{smaller['id']}", json={"weekly_target": 6}, headers=h)
    assert too_many.json()["weekly_target"] == 3
    # Clearing the schedule leaves the target alone.
    cleared = client.patch(f"/v1/habits/{habit['id']}", json={"days_mask": None}, headers=h).json()
    assert (cleared["days_mask"], cleared["scheduled_today"]) == (None, True)


def test_a_quit_habit_has_no_schedule(client):
    h = bearer(person(client, "quit@example.com", "quitter"))
    habit = _habit(client, h, name="No smoking", kind="quit", days_mask=MWF)
    assert habit["days_mask"] is None


def test_pause_and_resume_one_habit(client):
    h = bearer(person(client, "pause@example.com", "pauser"))
    habit = _habit(client, h)
    paused = client.post(f"/v1/habits/{habit['id']}/pause", json={}, headers=h)
    assert paused.status_code == 200, paused.text
    assert paused.json()["paused"] is True
    assert paused.json()["paused_until"] is None

    resumed = client.post(f"/v1/habits/{habit['id']}/resume", headers=h).json()
    # Paused from today, so resuming today removes it entirely.
    assert resumed["paused"] is False and resumed["paused_from"] is None


def test_pause_limits(client):
    h = bearer(person(client, "limits@example.com", "limiter"))
    habit = _habit(client, h)
    url = f"/v1/habits/{habit['id']}/pause"
    far = (date.today() + timedelta(days=90)).isoformat()
    assert client.post(url, json={"start": far}, headers=h).status_code == 422
    start = date.today().isoformat()
    before = (date.today() - timedelta(days=1)).isoformat()
    assert client.post(url, json={"start": start, "until": before}, headers=h).status_code == 422
