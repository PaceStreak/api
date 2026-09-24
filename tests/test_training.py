import io
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from tests.conftest import bearer, csrf_headers, login, person, register


def now() -> datetime:
    return datetime.now(UTC)


def workout(**extra) -> dict:
    return {
        "discipline": "strength",
        "started_at": (now() - timedelta(hours=1)).isoformat(),
        "client_updated_at": now().isoformat(),
        "duration_sec": 3600,
        "sets": [
            {"exercise_id": "back-squat", "position": 0, "set_index": 0, "weight_kg": 100, "reps": 5, "rpe": 8},
            {"exercise_id": "back-squat", "position": 0, "set_index": 1, "weight_kg": 100, "reps": 5},
        ],
    } | extra


def test_login_returns_csrf_token_in_body_and_refresh_accepts_it(client):
    register(client, "csrf@example.com")
    response = client.post("/v1/auth/login", json={"email": "csrf@example.com", "password": "correct-horse-battery-staple"})
    body = response.json()
    assert body["csrf_token"] == client.cookies.get("csrf_token")
    refreshed = client.post("/v1/auth/refresh", headers={"X-CSRF-Token": body["csrf_token"]})
    assert refreshed.status_code == 200
    assert refreshed.json()["csrf_token"] == client.cookies.get("csrf_token")


def test_me_reports_onboarding_needed(client):
    register(client, "fresh@example.com")
    token = login(client, "fresh@example.com")
    me = client.get("/v1/me", headers=bearer(token)).json()
    assert me["needs_onboarding"] is True
    assert me["profile"]["handle"] is None


def test_onboarding_refuses_under_thirteen(client):
    register(client, "kid@example.com")
    token = login(client, "kid@example.com")
    year = now().year
    response = client.post(
        "/v1/me/onboarding",
        json={"handle": "kid", "birth_year": year - 10, "accept_terms": True},
        headers=bearer(token),
    )
    assert response.status_code == 403


def test_teen_is_forced_private(client):
    register(client, "teen@example.com")
    token = login(client, "teen@example.com")
    response = client.post(
        "/v1/me/onboarding",
        json={"handle": "teen", "birth_year": now().year - 14, "accept_terms": True, "visibility": "public"},
        headers=bearer(token),
    )
    assert response.json()["profile"]["visibility"] == "private"
    me = client.get("/v1/me", headers=bearer(token)).json()
    assert me["social_allowed"] is False


def test_handles_are_unique_and_validated(client):
    person(client, "a@example.com", "taken")
    register(client, "b@example.com")
    token = login(client, "b@example.com")
    assert client.get("/v1/handles/taken", headers=bearer(token)).json()["available"] is False
    assert client.get("/v1/handles/Bad Handle", headers=bearer(token)).json()["available"] is False
    assert client.get("/v1/handles/admin", headers=bearer(token)).json()["available"] is False
    assert client.get("/v1/handles/free_one", headers=bearer(token)).json()["available"] is True


def test_put_is_idempotent_and_returns_outcome(client):
    token = person(client, "lift@example.com", "lifter")
    wid = str(uuid4())
    body = workout()
    first = client.put(f"/v1/workouts/{wid}", json=body, headers=bearer(token))
    assert first.status_code == 200, first.text
    data = first.json()
    assert data["created"] is True and data["applied"] is True
    outcome = data["outcome"]
    assert outcome["total_xp"] > 0
    assert any(a["id"] == "first_session" for a in outcome["new_achievements"])

    # The same save again (an outbox retry) changes nothing.
    again = client.put(f"/v1/workouts/{wid}", json=body, headers=bearer(token)).json()
    assert again["applied"] is False
    listed = client.get("/v1/workouts", headers=bearer(token)).json()
    assert len(listed) == 1
    assert len(listed[0]["sets"]) == 2


def test_older_edit_arriving_late_is_ignored(client):
    token = person(client, "lww@example.com", "lww")
    wid = str(uuid4())
    newer = workout(title="Newer", client_updated_at=now().isoformat())
    older = workout(title="Older", client_updated_at=(now() - timedelta(minutes=5)).isoformat())
    client.put(f"/v1/workouts/{wid}", json=newer, headers=bearer(token))
    response = client.put(f"/v1/workouts/{wid}", json=older, headers=bearer(token)).json()
    assert response["applied"] is False
    assert client.get(f"/v1/workouts/{wid}", headers=bearer(token)).json()["title"] == "Newer"


def test_cannot_touch_someone_elses_workout(client):
    owner = person(client, "owner@example.com", "owner")
    other = person(client, "other@example.com", "other")
    wid = str(uuid4())
    client.put(f"/v1/workouts/{wid}", json=workout(), headers=bearer(owner))
    later = workout(client_updated_at=(now() + timedelta(seconds=1)).isoformat())
    assert client.put(f"/v1/workouts/{wid}", json=later, headers=bearer(other)).status_code == 404
    assert client.get(f"/v1/workouts/{wid}", headers=bearer(other)).status_code == 404


def test_rejects_unknown_exercise_and_future_sessions(client):
    token = person(client, "val@example.com", "validator")
    bad = workout(sets=[{"exercise_id": "made-up", "position": 0, "set_index": 0, "reps": 5}])
    assert client.put(f"/v1/workouts/{uuid4()}", json=bad, headers=bearer(token)).status_code == 422
    future = workout(started_at=(now() + timedelta(days=1)).isoformat())
    assert client.put(f"/v1/workouts/{uuid4()}", json=future, headers=bearer(token)).status_code == 422


def test_changes_feed_includes_tombstones(client):
    token = person(client, "sync@example.com", "syncer")
    a, b = str(uuid4()), str(uuid4())
    client.put(f"/v1/workouts/{a}", json=workout(), headers=bearer(token))
    client.put(f"/v1/workouts/{b}", json=workout(discipline="run", sets=[], distance_m=5000), headers=bearer(token))
    first = client.get("/v1/workouts/changes?since=0", headers=bearer(token)).json()
    assert {w["id"] for w in first["workouts"]} == {a, b}
    cursor = first["cursor"]

    client.delete(f"/v1/workouts/{a}", params={"client_updated_at": (now() + timedelta(seconds=1)).isoformat()},
                  headers=bearer(token))
    delta = client.get(f"/v1/workouts/changes?since={cursor}", headers=bearer(token)).json()
    assert [w["id"] for w in delta["workouts"]] == [a]
    assert delta["workouts"][0]["deleted_at"] is not None


def test_batch_applies_what_it_can(client):
    token = person(client, "batch@example.com", "batcher")
    ok_id, bad_id = str(uuid4()), str(uuid4())
    ops = [
        {"op": "put", "id": ok_id, "workout": workout(), "client_updated_at": now().isoformat()},
        {"op": "put", "id": bad_id, "workout": workout(started_at=(now() + timedelta(days=3)).isoformat()),
         "client_updated_at": now().isoformat()},
    ]
    result = client.post("/v1/workouts/batch", json={"ops": ops}, headers=bearer(token)).json()
    assert [r["ok"] for r in result["results"]] == [True, False]
    assert result["outcome"] is not None
    assert len(client.get("/v1/workouts", headers=bearer(token)).json()) == 1


def test_stats_streak_and_records(client):
    token = person(client, "stats@example.com", "statsy")
    for days_ago, weight in ((9, 100), (2, 104)):
        started = now() - timedelta(days=days_ago)
        body = workout(started_at=started.isoformat(), client_updated_at=now().isoformat(),
                       sets=[{"exercise_id": "bench-press", "position": 0, "set_index": 0,
                              "weight_kg": weight, "reps": 5}])
        client.put(f"/v1/workouts/{uuid4()}", json=body, headers=bearer(token))
    stats = client.get("/v1/me/stats", headers=bearer(token)).json()
    assert stats["totals"]["sessions"] == 2
    assert stats["chains"][0]["target"] == 3
    assert len(stats["heatmap"]) == 2
    records = client.get("/v1/me/records", headers=bearer(token)).json()
    bench = next(r for r in records["current"] if r["key"] == "e1rm:bench-press")
    assert bench["value"] > 116 and bench["previous"] is not None
    history = client.get("/v1/exercises/bench-press/history", headers=bearer(token)).json()
    assert len(history["sessions"]) == 2
    last = client.get("/v1/exercises/last?ids=bench-press", headers=bearer(token)).json()
    assert last["bench-press"]["sets"][0]["weight_kg"] == 104


def test_chains_target_change_and_repair_rules(client):
    token = person(client, "chain@example.com", "chainer")
    chains = client.get("/v1/chains", headers=bearer(token)).json()
    main = chains["chains"][0]
    assert main["name"] == "Everything"
    created = client.post("/v1/chains", json={"name": "Running", "disciplines": ["run"], "target": 2},
                          headers=bearer(token))
    assert created.status_code == 201
    patched = client.patch(f"/v1/chains/{main['id']}", json={"target": 4}, headers=bearer(token))
    assert patched.status_code == 200
    after = client.get("/v1/chains", headers=bearer(token)).json()["chains"]
    assert [c["name"] for c in after] == ["Everything", "Running"]
    assert after[0]["target"] == 4
    # Nothing to repair: there is no missed week.
    bad = client.post(f"/v1/chains/{main['id']}/repair", json={"week_start": "2026-01-05"}, headers=bearer(token))
    assert bad.status_code == 409


def test_custom_exercise_routine_and_body_metrics(client):
    token = person(client, "custom@example.com", "customer")
    custom = client.post("/v1/exercises/custom", json={"name": "Sled push", "pattern": "carry",
                         "equipment": "machine", "primary": ["quads"]}, headers=bearer(token)).json()
    assert custom["id"].startswith("custom-")
    body = workout(sets=[{"exercise_id": custom["id"], "position": 0, "set_index": 0, "weight_kg": 80, "reps": 10}])
    assert client.put(f"/v1/workouts/{uuid4()}", json=body, headers=bearer(token)).status_code == 200

    routine = client.post("/v1/routines/from-template/tpl-upper", headers=bearer(token))
    assert routine.status_code == 201
    assert len(client.get("/v1/routines", headers=bearer(token)).json()) == 1

    day = (now() - timedelta(days=1)).date().isoformat()
    assert client.put(f"/v1/body-metrics/{day}", json={"weight_kg": 80.5}, headers=bearer(token)).status_code == 200
    assert client.get("/v1/body-metrics", headers=bearer(token)).json()[0]["weight_kg"] == 80.5


def test_export_and_import_roundtrip(client):
    token = person(client, "export@example.com", "exporter")
    client.put(f"/v1/workouts/{uuid4()}", json=workout(title="Leg day"), headers=bearer(token))
    exported = client.get("/v1/me/export?format=json", headers=bearer(token))
    assert exported.status_code == 200
    data = exported.json()
    assert data["format"] == "pacestreak-export" and len(data["workouts"]) == 1

    csv_zip = client.get("/v1/me/export?format=csv", headers=bearer(token))
    assert csv_zip.headers["content-type"] == "application/zip"
    ics = client.get("/v1/me/export?format=ics", headers=bearer(token))
    assert "BEGIN:VEVENT" in ics.text

    # Importing someone else's export re-mints the ids and never touches theirs.
    other = person(client, "import@example.com", "importer")
    files = {"file": ("export.json", io.BytesIO(json.dumps(data).encode()), "application/json")}
    result = client.post("/v1/me/import", files=files, headers=bearer(other)).json()
    assert result == {"imported": 1, "skipped": 0}
    theirs = client.get("/v1/workouts", headers=bearer(other)).json()
    assert theirs[0]["source"] == "import" and theirs[0]["id"] != data["workouts"][0]["id"]
    # Importing it again is a no-op for the original owner.
    files = {"file": ("export.json", io.BytesIO(json.dumps(data).encode()), "application/json")}
    again = client.post("/v1/me/import", files=files, headers=bearer(token)).json()
    assert again == {"imported": 0, "skipped": 1}


def test_account_deletion_is_scheduled_and_cancellable(client):
    token = person(client, "bye@example.com", "leaver")
    response = client.post("/v1/me/delete", json={"password": "correct-horse-battery-staple"},
                           headers=bearer(token))
    assert response.status_code == 200
    # Every session was ended...
    assert client.get("/v1/me", headers=bearer(token)).status_code == 401
    # ...and signing back in is how it gets cancelled.
    token = login(client, "bye@example.com")
    me = client.get("/v1/me", headers=bearer(token)).json()
    assert me["profile"]["deletion_scheduled_at"] is not None
    assert client.post("/v1/me/delete/cancel", headers=bearer(token)).json() == {"cancelled": True}
    events = client.get("/v1/me/security-events", headers=bearer(token)).json()
    kinds = [e["kind"] for e in events]
    assert "deletion_scheduled" in kinds and "login" in kinds


def test_library_is_cacheable(client):
    response = client.get("/v1/library")
    assert "max-age" in response.headers["cache-control"]
    lib = response.json()
    assert {d["id"] for d in lib["disciplines"]} >= {"strength", "run", "ride", "climb"}
    assert len(lib["exercises"]) > 60


def test_unused_csrf_helper_still_works(client):
    register(client, "x@example.com")
    login(client, "x@example.com")
    assert csrf_headers(client)["X-CSRF-Token"]
