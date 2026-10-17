"""Strong, Hevy and FitNotes exports, end to end through the import endpoint."""

from pathlib import Path

import pytest

from app.training.lifting_import import LB, parse_lifting
from tests.conftest import bearer, person

FIXTURES = Path(__file__).parent / "fixtures" / "lifting"


def _upload(client, token, name, **form):
    data = (FIXTURES / name).read_bytes()
    return client.post(
        "/v1/workouts/import",
        files={"file": (name, data, "text/csv")},
        data=form,
        headers=bearer(token),
    )


def _sessions(client, token):
    feed = client.get("/v1/workouts/changes?since=0", headers=bearer(token)).json()["workouts"]
    return sorted((w for w in feed if not w.get("deleted_at")), key=lambda w: w["started_at"])


def test_strong_groups_sets_maps_names_and_keeps_unknowns(client):
    token = person(client, "strong@example.com", "stronglifter")
    result = _upload(client, token, "strong.csv", unit="kg")
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["format"] == "strong"
    assert (body["imported"], body["sets"]) == (2, 7)
    assert body["new_exercises"] == ["Cable Thing Nobody Has (Cable)"]

    push, legs = _sessions(client, token)
    assert push["source"] == "import" and push["discipline"] == "strength"
    assert push["title"] == "Push day" and push["duration_sec"] == 3900
    bench = [s for s in push["sets"] if s["exercise_id"] == "bench-press"]
    assert [(s["kind"], s["weight_kg"], s["reps"]) for s in bench] == [
        ("warmup", 40, 10),
        ("work", 80, 5),
        ("work", 80, 5),
    ]
    assert bench[2]["rpe"] == 8.5
    assert any(s["exercise_id"].startswith("custom-") for s in push["sets"])
    plank = next(s for s in legs["sets"] if s["exercise_id"] == "plank")
    assert plank["duration_sec"] == 60

    # Uploading the same file again changes nothing and makes no new exercise.
    again = _upload(client, token, "strong.csv", unit="kg").json()
    assert (again["imported"], again["duplicates"], again["new_exercises"]) == (0, 2, [])


def test_strong_in_pounds_is_converted():
    result = parse_lifting((FIXTURES / "strong.csv").read_bytes(), "UTC", "lb")
    first = result.sessions[0].sets[1]
    assert first.weight_kg == pytest.approx(80 * LB)


def test_hevy_set_types_supersets_and_duration(client):
    token = person(client, "hevy@example.com", "hevylifter")
    body = _upload(client, token, "hevy.csv").json()
    summary = (body["format"], body["imported"], body["sets"], body["new_exercises"])
    assert summary == ("hevy", 1, 4, [])
    (pull,) = _sessions(client, token)
    assert pull["duration_sec"] == 65 * 60
    kinds = {(s["exercise_id"], s["set_index"]): s for s in pull["sets"]}
    assert kinds[("lat-pulldown", 0)]["kind"] == "warmup"
    assert kinds[("barbell-curl", 0)]["superset"] == 1
    assert kinds[("hammer-curl", 0)]["kind"] == "drop"


def test_fitnotes_groups_by_day_in_pounds(client):
    token = person(client, "fit@example.com", "fitnoter")
    body = _upload(client, token, "fitnotes.csv").json()
    assert (body["format"], body["imported"]) == ("fitnotes", 2)
    first, second = _sessions(client, token)
    bench = [s for s in first["sets"] if s["exercise_id"] == "bench-press"]
    assert [round(s["weight_kg"], 1) for s in bench] == [61.2, 70.3]
    assert any(s["exercise_id"] == "back-squat" for s in first["sets"])
    tread = second["sets"][0]
    assert tread["distance_m"] == 5000 and tread["duration_sec"] == 1800


def test_a_plain_activity_csv_still_uses_the_old_importer(client):
    token = person(client, "plain@example.com", "plainrunner")
    csv = b"date,type,duration,distance\n2026-09-01,run,30:00,5\n"
    result = client.post(
        "/v1/workouts/import",
        files={"file": ("runs.csv", csv, "text/csv")},
        headers=bearer(token),
    )
    assert result.status_code == 200, result.text
    assert result.json()["format"] == "csv"
