"""Smart reminder timing, monthly goals and logged rest days."""

from datetime import UTC, datetime, timedelta

from app.game.reminders import in_quiet_hours, learn_reminder_hour, reminder_hour
from tests.conftest import bearer, person
from tests.test_social import log_session


def test_learns_an_hour_before_the_usual_time():
    assert learn_reminder_hour([7, 7, 7, 7, 18, 18], 22, 6) == 6
    # Ties go to the earlier habit.
    assert learn_reminder_hour([7, 7, 7, 18, 18, 18], 22, 6) == 6


def test_needs_enough_history():
    assert learn_reminder_hour([7, 7, 7], 22, 7) is None


def test_never_learns_a_quiet_hour():
    # Usually trains at 6am; 5am is inside quiet hours 22-7, so fall back.
    assert learn_reminder_hour([6] * 8, 22, 7) is None
    assert in_quiet_hours(23, 22, 7) and in_quiet_hours(3, 22, 7) and not in_quiet_hours(12, 22, 7)
    assert not in_quiet_hours(5, 7, 7)


def test_mode_chooses_the_hour():
    assert reminder_hour("smart", 18, 6) == 6
    assert reminder_hour("smart", 18, None) == 18
    assert reminder_hour("fixed", 18, 6) == 18


def test_profile_exposes_smart_mode(client):
    token = person(client, "smart@example.com", "smarty")
    r = client.patch("/v1/me/profile", json={"reminder_mode": "smart"}, headers=bearer(token))
    assert r.status_code == 200, r.text
    profile = client.get("/v1/me", headers=bearer(token)).json()["profile"]
    assert profile["reminder_mode"] == "smart"
    assert profile["learned_reminder_hour"] is None  # one session isn't a habit
    assert (
        client.patch(
            "/v1/me/profile", json={"reminder_mode": "psychic"}, headers=bearer(token)
        ).status_code
        == 422
    )


def test_monthly_goal_counts_distinct_days(client):
    token = person(client, "goal@example.com", "goaly")
    month = datetime.now(UTC).strftime("%Y-%m")
    log_session(client, token)
    log_session(client, token)  # same day: still one day
    set_ = client.put(
        "/v1/me/monthly-goal", json={"month": month, "days": 12}, headers=bearer(token)
    )
    assert set_.status_code == 200, set_.text
    view = client.get("/v1/me/monthly-goal", headers=bearer(token)).json()
    assert view["goal"] == 12 and view["done"] == 1
    assert (
        client.put(
            "/v1/me/monthly-goal", json={"month": "2020-01", "days": 5}, headers=bearer(token)
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/v1/me/monthly-goal", json={"month": "2099-02", "days": 30}, headers=bearer(token)
        ).status_code
        == 422
    )
    client.delete(f"/v1/me/monthly-goal/{month}", headers=bearer(token))
    assert client.get("/v1/me/monthly-goal", headers=bearer(token)).json()["goal"] is None


def test_rest_days_are_private_and_never_count(client):
    token = person(client, "rest@example.com", "resty")
    today = datetime.now(UTC).date()
    r = client.put(
        f"/v1/me/rest-days/{today}",
        json={"kind": "sleep", "note": "  early night "},
        headers=bearer(token),
    )
    assert r.status_code == 200 and r.json()["note"] == "early night"
    # Upsert, not duplicate.
    client.put(f"/v1/me/rest-days/{today}", json={"kind": "mobility"}, headers=bearer(token))
    days = client.get("/v1/me/rest-days", headers=bearer(token)).json()
    assert days == [{"day": today.isoformat(), "kind": "mobility", "note": None}]
    stats = client.get("/v1/me/stats", headers=bearer(token)).json()
    assert stats["chains"][0]["this_week_days"] == 0
    too_far = today + timedelta(days=30)
    assert (
        client.put(f"/v1/me/rest-days/{too_far}", json={}, headers=bearer(token)).status_code == 422
    )
    assert (
        client.put(
            f"/v1/me/rest-days/{today}", json={"kind": "lazy"}, headers=bearer(token)
        ).status_code
        == 422
    )
