"""Journal, insights, adaptive expenditure, recipes, habit routines and
habit import."""

import io
import zipfile
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

from app.habits.importer import HabitImportError, parse
from app.insights.engine import find
from app.nutrition.expenditure import Estimate, estimate, suggest
from tests.conftest import bearer, person

TODAY = datetime.now(UTC).date()


def _days(n: int, end: date = date(2026, 9, 30)) -> list[date]:
    return [end - timedelta(days=i) for i in range(n)]


# --- insights engine ------------------------------------------------------------------


def test_engine_finds_a_real_pattern_and_ignores_noise():
    days = _days(40)
    sleep = {d: (8.0 if i % 2 else 6.0) for i, d in enumerate(days)}
    # Habits track sleep closely; mood is unrelated noise.
    habits = {d: (0.9 if sleep[d] == 8 else 0.4) + (i % 3) * 0.02 for i, d in enumerate(days)}
    mood = {d: 3 + (i % 5 == 0) for i, d in enumerate(days)}
    found = find({"sleep_hours": sleep, "habits": habits, "mood": mood})
    assert [(i.driver, i.outcome) for i in found] == [("sleep_hours", "habits")]
    assert "7.0 h+ of sleep" in found[0].text and "%" in found[0].text


def test_engine_needs_enough_days_on_both_sides():
    days = _days(12)
    sleep = {d: 8.0 for d in days}
    habits = {d: 1.0 for d in days}
    assert find({"sleep_hours": sleep, "habits": habits}) == []


def test_engine_keeps_one_insight_per_outcome():
    days = _days(40)
    flag = {d: float(i % 2) for i, d in enumerate(days)}
    sleep = {d: 5 if flag[d] else 2 for d in days}
    habits = {d: 0.9 if flag[d] else 0.3 for d in days}
    found = find({"trained": flag, "sleep": sleep, "habits": habits})
    assert len([i for i in found if i.outcome == "habits"]) == 1


# --- adaptive expenditure -------------------------------------------------------------


def test_expenditure_from_intake_and_a_falling_trend():
    end = date(2026, 9, 30)
    days = _days(28, end)
    intake = {d: 2000.0 for d in days}
    # Losing 0.5 kg a week: 0.5 * 7700 / 7 = 550 kcal a day of deficit.
    weights = {d: 80 + (end - d).days * 0.5 / 7 for d in days[::2]}
    est = estimate(intake, weights, end)
    assert est.status == "ok" and abs(est.tdee - 2550) <= 5
    assert est.trend_kg_per_week == -0.5 and est.confidence == "good"


def test_expenditure_refuses_thin_or_impossible_data():
    end = date(2026, 9, 30)
    assert estimate({d: 2000 for d in _days(10, end)}, {}, end).status == "not_enough"
    days = _days(28, end)
    # 500 kcal a day while gaining weight: meals weren't logged.
    gaining = {d: 80 - (end - d).days * 0.5 / 7 for d in days[::2]}
    assert estimate({d: 500 for d in days}, gaining, end).status == "inconsistent"


def test_suggestions_are_gentle():
    est = Estimate("ok", 28, 14, tdee=1800, trend_kg=60)
    lose = suggest(est, 50)
    # 0.5% of 60 kg a week is 0.3 kg, about 330 kcal a day under.
    assert lose["goal"] == "lose" and lose["kcal"] == 1470 and lose["rate_kg_per_week"] >= -0.31
    assert suggest(Estimate("ok", 28, 14, tdee=1300, trend_kg=90), 60)["kcal"] == 1200
    assert suggest(est, 60.5)["goal"] == "maintain"
    assert suggest(est, None)["kcal"] == 1800
    assert suggest(Estimate("not_enough", 3, 1), 50) is None


def test_expenditure_endpoint_reports_what_is_missing(client):
    h = bearer(person(client, "tdee@example.com", "tdeer"))
    got = client.get("/v1/nutrition/expenditure", headers=h).json()
    assert got["status"] == "not_enough" and got["suggestion"] is None


# --- recipes -------------------------------------------------------------------------


def test_recipe_logs_per_serving_and_snapshots_foods(client):
    h = bearer(person(client, "chef@example.com", "chef"))
    rice = client.post(
        "/v1/nutrition/foods", json={"name": "Rice", "kcal": 200, "carbs_g": 44}, headers=h
    ).json()
    chicken = client.post(
        "/v1/nutrition/foods", json={"name": "Chicken", "kcal": 165, "protein_g": 31}, headers=h
    ).json()
    recipe = client.post(
        "/v1/nutrition/recipes",
        json={
            "name": "Rice bowl",
            "serves": 2,
            "items": [{"food_id": rice["id"], "servings": 2}, {"food_id": chicken["id"]}],
        },
        headers=h,
    ).json()
    assert recipe["kcal"] == 282.5 and recipe["protein_g"] == 15.5
    body = {"date": TODAY.isoformat(), "meal": "dinner", "recipe_id": recipe["id"], "servings": 2}
    entry = client.put(f"/v1/nutrition/entries/{uuid4()}", json=body, headers=h).json()
    assert entry["name"] == "Rice bowl" and entry["kcal"] == 565
    # Changing a food doesn't rewrite the recipe until it's saved again.
    client.put(f"/v1/nutrition/foods/{rice['id']}", json={"name": "Rice", "kcal": 400}, headers=h)
    assert client.get("/v1/nutrition/recipes", headers=h).json()[0]["kcal"] == 282.5
    other = bearer(person(client, "nosy2@example.com", "nosy2"))
    stolen = {"name": "Mine", "items": [{"food_id": rice["id"]}]}
    assert client.post("/v1/nutrition/recipes", json=stolen, headers=other).status_code == 404
    assert client.get("/v1/me/export?format=json", headers=h).json()["recipes"][0]["serves"] == 2


# --- journal and insights ------------------------------------------------------------


def test_journal_round_trip_search_and_privacy(client):
    h = bearer(person(client, "diary@example.com", "diarist"))
    other = bearer(person(client, "peek2@example.com", "peeker2"))
    day = TODAY.isoformat()
    body = {"mood": 4, "note": "Long walk by the river"}
    assert client.put(f"/v1/journal/{day}", json=body, headers=h).json()["mood"] == 4
    assert client.get("/v1/journal?q=river", headers=h).json()[0]["note"] == body["note"]
    assert client.get("/v1/journal?q=mountain", headers=h).json() == []
    assert client.get("/v1/journal", headers=other).json() == []
    future = (TODAY + timedelta(days=2)).isoformat()
    assert client.put(f"/v1/journal/{future}", json=body, headers=h).status_code == 422
    assert client.put(f"/v1/journal/{day}", json={"mood": 9}, headers=h).status_code == 422
    assert client.get("/v1/me/export?format=json", headers=h).json()["journal"][0]["mood"] == 4
    assert client.put(f"/v1/journal/{day}", json={}, headers=h).json() is None
    assert client.get("/v1/journal", headers=h).json() == []


def test_insights_endpoint_from_logged_data(client):
    h = bearer(person(client, "insight@example.com", "insighter"))
    # Mood is high on readiness-good days, for 30 days.
    for i in range(1, 31):
        day = (TODAY - timedelta(days=i)).isoformat()
        good = i % 2 == 0
        client.put(f"/v1/journal/{day}", json={"mood": 5 if good else 2}, headers=h)
        if i <= 2:
            client.put(
                f"/v1/readiness/{day}", json={"sleep": 5, "energy": 4, "soreness": 1}, headers=h
            )
    got = client.get("/v1/insights", headers=h).json()
    assert got["coverage"]["mood"] == 30
    # Two readiness days are nowhere near enough to claim a pattern.
    assert got["insights"] == []


# --- habit routines ------------------------------------------------------------------


def _habit(client, h, name: str) -> str:
    response = client.post("/v1/habits", json={"name": name}, headers=h)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_habit_routine_orders_live_habits(client):
    h = bearer(person(client, "routine@example.com", "routiner"))
    a, b = _habit(client, h, "Water"), _habit(client, h, "Stretch")
    made = client.post(
        "/v1/habit-routines", json={"name": "Morning", "habit_ids": [b, a, b]}, headers=h
    ).json()
    assert made["habit_ids"] == [b, a]
    client.post(f"/v1/habits/{a}/archive", headers=h)
    assert client.get("/v1/habit-routines", headers=h).json()[0]["habit_ids"] == [b]
    other = bearer(person(client, "routine2@example.com", "routiner2"))
    bad = {"name": "Theirs", "habit_ids": [b]}
    assert client.post("/v1/habit-routines", json=bad, headers=other).status_code == 404
    assert client.delete(f"/v1/habit-routines/{made['id']}", headers=other).status_code == 404


# --- habit import --------------------------------------------------------------------


def _loop_zip() -> bytes:
    rows = ["Date,Meditate,Read"]
    for i in range(1, 15):
        day = (TODAY - timedelta(days=i)).isoformat()
        rows.append(f"{day},{2 if i % 2 else 0},{2 if i % 7 == 0 else 1}")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr("Checkmarks.csv", "\n".join(rows))
        z.writestr("Habits.csv", "Position,Name\n1,Meditate\n2,Read\n")
    return buffer.getvalue()


def test_parse_loop_zip_counts_only_manual_ticks():
    habits = {h.name: h for h in parse("Loop Habits CSV.zip", _loop_zip())}
    assert len(habits["Meditate"].days) == 7 and habits["Meditate"].binary
    assert len(habits["Read"].days) == 2


def test_parse_long_csv_and_rejects_ambiguous_dates():
    text = "Date;Habit;Value\n2026-09-01;Pages;12\n2026-09-02;Pages;0\n2026-09-02;Walk;1\n"
    habits = {h.name: h for h in parse("habitify.csv", text.encode())}
    assert habits["Pages"].days == {date(2026, 9, 1): 12} and not habits["Pages"].binary
    assert habits["Walk"].binary
    try:
        parse("x.csv", b"Date,Habit\n03/04/2026,Walk\n")
    except HabitImportError as error:
        assert "year first" in str(error)
    else:
        raise AssertionError("ambiguous dates were accepted")


def test_import_merges_creates_and_never_overwrites(client):
    h = bearer(person(client, "switch@example.com", "switcher"))
    existing = _habit(client, h, "meditate")
    yesterday = (TODAY - timedelta(days=1)).isoformat()
    client.put(
        f"/v1/habits/{existing}/days/{yesterday}", json={"amount": 1, "note": "mine"}, headers=h
    )
    files = {"file": ("loop.zip", _loop_zip(), "application/zip")}
    preview = client.post(
        "/v1/habits/import", files=files, data={"dry_run": "true"}, headers=h
    ).json()
    assert {p["name"]: p["merge"] for p in preview["habits"]} == {"Meditate": True, "Read": False}
    assert len(client.get("/v1/habits", headers=h).json()) == 1

    done = client.post("/v1/habits/import", files=files, headers=h).json()
    # Meditate: 7 ticks, of which yesterday was already here. Read: 2.
    assert done["imported_days"] == 6 + 2
    habits = client.get("/v1/habits", headers=h).json()
    assert sorted(x["name"] for x in habits) == ["Read", "meditate"]
    again = client.post("/v1/habits/import", files=files, headers=h).json()
    assert again["imported_days"] == 0
    bad = {"file": ("x.csv", b"nothing,here\n1,2\n", "text/csv")}
    assert client.post("/v1/habits/import", files=bad, headers=h).status_code == 422
