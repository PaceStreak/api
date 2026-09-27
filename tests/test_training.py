import io
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from tests.conftest import bearer, csrf_headers, login, person, register
from tests.test_social import log_session


def now() -> datetime:
    return datetime.now(UTC)


def workout(**extra) -> dict:
    return {
        "discipline": "strength",
        "started_at": (now() - timedelta(hours=1)).isoformat(),
        "client_updated_at": now().isoformat(),
        "duration_sec": 3600,
        "sets": [
            {
                "exercise_id": "back-squat",
                "position": 0,
                "set_index": 0,
                "weight_kg": 100,
                "reps": 5,
                "rpe": 8,
            },
            {
                "exercise_id": "back-squat",
                "position": 0,
                "set_index": 1,
                "weight_kg": 100,
                "reps": 5,
            },
        ],
    } | extra


def test_login_returns_csrf_token_in_body_and_refresh_accepts_it(client):
    register(client, "csrf@example.com")
    response = client.post(
        "/v1/auth/login",
        json={"email": "csrf@example.com", "password": "correct-horse-battery-staple"},
    )
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
        json={
            "handle": "teen",
            "birth_year": now().year - 14,
            "accept_terms": True,
            "visibility": "public",
        },
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


def test_single_badge_cannot_be_awarded_twice_by_a_race(client):
    """UserAchievement.tier is NULL for a single (non-tiered) badge, and
    Postgres treats NULL as distinct under a unique constraint - so two
    concurrent recompute() calls (an offline outbox retry racing a live
    request) could both pass the "already held" check and insert the same
    badge twice, double-paying its XP. A partial unique index on
    (user_id, achievement_id) WHERE tier IS NULL closes that, and the insert
    goes through ON CONFLICT DO NOTHING for the tier-less case."""
    import asyncio

    from sqlalchemy import select
    from sqlalchemy.dialects.postgresql import insert

    from app.auth.models import User
    from app.database import AsyncSessionLocal, engine
    from app.game.models import UserAchievement

    token = person(client, "race@example.com", "racer")
    wid = str(uuid4())
    client.put(f"/v1/workouts/{wid}", json=workout(), headers=bearer(token))

    async def race():
        async with AsyncSessionLocal() as db:
            uid = (
                await db.execute(select(User.id).where(User.email == "race@example.com"))
            ).scalar_one()

            async def attempt():
                await db.execute(
                    insert(UserAchievement)
                    .values(
                        user_id=uid,
                        achievement_id="first_session",
                        tier=None,
                        unlocked_on=now().date(),
                        evidence={"value": 1},
                    )
                    .on_conflict_do_nothing(
                        index_elements=["user_id", "achievement_id"],
                        index_where=UserAchievement.tier.is_(None),
                    )
                )

            # The badge is already held from the PUT above; two more attempts
            # stand in for two concurrent recompute() calls racing each other -
            # both must land on the same "already there" outcome.
            await attempt()
            await attempt()
            await db.commit()
            rows = (
                (
                    await db.execute(
                        select(UserAchievement).where(
                            UserAchievement.user_id == uid,
                            UserAchievement.achievement_id == "first_session",
                        )
                    )
                )
                .scalars()
                .all()
            )
            return rows

    # The pool holds connections bound to the TestClient's own event loop;
    # asyncio.run() below starts a new one, so they must be dropped first
    # (see clean_database's own note on this).
    asyncio.run(engine.dispose())
    rows = asyncio.run(race())
    assert len(rows) == 1


def test_recompute_is_serialized_across_concurrent_calls(client):
    """Two requests that both trigger recompute() for the same user (e.g. an
    offline outbox flush landing at the same moment as a live workout save)
    each read a `previous` UserStats row to decide what's new (level-ups,
    milestones). Without serializing them, both could read the same stale
    `previous` and race on the read-then-write. recompute() now takes a
    Postgres advisory transaction lock keyed on the user id before it reads
    anything, so two genuinely concurrent calls run one after the other
    instead of interleaving - this proves that holds (no deadlock, no crash)
    and leaves exactly one consistent UserStats row behind."""
    import asyncio

    from sqlalchemy import select

    from app.auth.models import User
    from app.database import AsyncSessionLocal, engine
    from app.game.models import UserStats
    from app.game.service import recompute

    token = person(client, "racecompute@example.com", "racecompute")
    wid = str(uuid4())
    client.put(f"/v1/workouts/{wid}", json=workout(), headers=bearer(token))

    async def one(uid):
        async with AsyncSessionLocal() as db:
            await recompute(db, uid, notify=False)
            await db.commit()

    async def race():
        async with AsyncSessionLocal() as db:
            uid = (
                await db.execute(select(User.id).where(User.email == "racecompute@example.com"))
            ).scalar_one()
        # Each task owns its own session/transaction, exactly like two
        # concurrent requests would - the advisory lock is released when each
        # commits, so the other proceeds rather than deadlocking.
        await asyncio.gather(one(uid), one(uid))
        async with AsyncSessionLocal() as db:
            rows = (
                (await db.execute(select(UserStats).where(UserStats.user_id == uid)))
                .scalars()
                .all()
            )
            return rows

    # The pool holds connections bound to the TestClient's own event loop;
    # asyncio.run() below starts a new one, so they must be dropped first
    # (see clean_database's own note on this).
    asyncio.run(engine.dispose())
    rows = asyncio.run(race())
    assert len(rows) == 1
    assert rows[0].total_xp >= 0


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
    assert (
        client.put(f"/v1/workouts/{uuid4()}", json=future, headers=bearer(token)).status_code == 422
    )


def test_changes_feed_includes_tombstones(client):
    token = person(client, "sync@example.com", "syncer")
    a, b = str(uuid4()), str(uuid4())
    client.put(f"/v1/workouts/{a}", json=workout(), headers=bearer(token))
    client.put(
        f"/v1/workouts/{b}",
        json=workout(discipline="run", sets=[], distance_m=5000),
        headers=bearer(token),
    )
    first = client.get("/v1/workouts/changes?since=0", headers=bearer(token)).json()
    assert {w["id"] for w in first["workouts"]} == {a, b}
    cursor = first["cursor"]

    client.delete(
        f"/v1/workouts/{a}",
        params={"client_updated_at": (now() + timedelta(seconds=1)).isoformat()},
        headers=bearer(token),
    )
    delta = client.get(f"/v1/workouts/changes?since={cursor}", headers=bearer(token)).json()
    assert [w["id"] for w in delta["workouts"]] == [a]
    assert delta["workouts"][0]["deleted_at"] is not None


def test_batch_applies_what_it_can(client):
    token = person(client, "batch@example.com", "batcher")
    ok_id, bad_id = str(uuid4()), str(uuid4())
    ops = [
        {"op": "put", "id": ok_id, "workout": workout(), "client_updated_at": now().isoformat()},
        {
            "op": "put",
            "id": bad_id,
            "workout": workout(started_at=(now() + timedelta(days=3)).isoformat()),
            "client_updated_at": now().isoformat(),
        },
    ]
    result = client.post("/v1/workouts/batch", json={"ops": ops}, headers=bearer(token)).json()
    assert [r["ok"] for r in result["results"]] == [True, False]
    assert result["outcome"] is not None
    assert len(client.get("/v1/workouts", headers=bearer(token)).json()) == 1


def test_stats_streak_and_records(client):
    token = person(client, "stats@example.com", "statsy")
    for days_ago, weight in ((9, 100), (2, 104)):
        started = now() - timedelta(days=days_ago)
        body = workout(
            started_at=started.isoformat(),
            client_updated_at=now().isoformat(),
            sets=[
                {
                    "exercise_id": "bench-press",
                    "position": 0,
                    "set_index": 0,
                    "weight_kg": weight,
                    "reps": 5,
                }
            ],
        )
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
    created = client.post(
        "/v1/chains",
        json={"name": "Running", "disciplines": ["run"], "target": 2},
        headers=bearer(token),
    )
    assert created.status_code == 201
    patched = client.patch(f"/v1/chains/{main['id']}", json={"target": 4}, headers=bearer(token))
    assert patched.status_code == 200
    after = client.get("/v1/chains", headers=bearer(token)).json()["chains"]
    assert [c["name"] for c in after] == ["Everything", "Running"]
    assert after[0]["target"] == 4
    # Nothing to repair: there is no missed week.
    bad = client.post(
        f"/v1/chains/{main['id']}/repair", json={"week_start": "2026-01-05"}, headers=bearer(token)
    )
    assert bad.status_code == 409


def test_custom_exercise_routine_and_body_metrics(client):
    token = person(client, "custom@example.com", "customer")
    custom = client.post(
        "/v1/exercises/custom",
        json={
            "name": "Sled push",
            "pattern": "carry",
            "equipment": "machine",
            "primary": ["quads"],
        },
        headers=bearer(token),
    ).json()
    assert custom["id"].startswith("custom-")
    body = workout(
        sets=[
            {
                "exercise_id": custom["id"],
                "position": 0,
                "set_index": 0,
                "weight_kg": 80,
                "reps": 10,
            }
        ]
    )
    assert (
        client.put(f"/v1/workouts/{uuid4()}", json=body, headers=bearer(token)).status_code == 200
    )

    routine = client.post("/v1/routines/from-template/tpl-upper", headers=bearer(token))
    assert routine.status_code == 201
    assert len(client.get("/v1/routines", headers=bearer(token)).json()) == 1

    day = (now() - timedelta(days=1)).date().isoformat()
    assert (
        client.put(
            f"/v1/body-metrics/{day}", json={"sleep_hours": 7.5}, headers=bearer(token)
        ).status_code
        == 200
    )
    assert client.get("/v1/body-metrics", headers=bearer(token)).json()[0]["sleep_hours"] == 7.5


def test_weigh_ins_several_a_day_private_and_owned(client):
    token = person(client, "scale@example.com", "scaler")
    morning, evening = uuid4(), uuid4()
    first = client.put(
        f"/v1/weigh-ins/{morning}",
        json={
            "weighed_at": (now() - timedelta(hours=10)).isoformat(),
            "moment": "waking",
            "weight_kg": 80.456,
        },
        headers=bearer(token),
    )
    assert first.status_code == 200 and first.json()["weight_kg"] == 80.46
    body = {"weighed_at": (now() - timedelta(hours=1)).isoformat(), "moment": "bedtime"}
    client.put(f"/v1/weigh-ins/{evening}", json=body | {"weight_kg": 81.2}, headers=bearer(token))
    # A retried save updates the same row instead of adding another.
    client.put(f"/v1/weigh-ins/{evening}", json=body | {"weight_kg": 81.0}, headers=bearer(token))
    listed = client.get("/v1/weigh-ins", headers=bearer(token)).json()
    assert [(w["moment"], w["weight_kg"]) for w in listed] == [("waking", 80.46), ("bedtime", 81.0)]

    # Validation: moments are a fixed set; no future, no naive times.
    bad = [
        body | {"weight_kg": 80, "moment": "lunch"},
        body | {"weight_kg": 0},
        {
            "weighed_at": (now() + timedelta(hours=2)).isoformat(),
            "moment": "other",
            "weight_kg": 80,
        },
        {"weighed_at": "2026-01-01T08:00:00", "moment": "other", "weight_kg": 80},
        {
            "weighed_at": (now() - timedelta(days=40)).isoformat(),
            "moment": "other",
            "weight_kg": 80,
        },
    ]
    for payload in bad:
        assert (
            client.put(f"/v1/weigh-ins/{uuid4()}", json=payload, headers=bearer(token)).status_code
            == 422
        ), payload

    # Someone else's id is not found, for writes and deletes alike.
    other = person(client, "nosy@example.com", "nosy")
    assert (
        client.put(
            f"/v1/weigh-ins/{morning}", json=body | {"weight_kg": 50}, headers=bearer(other)
        ).status_code
        == 404
    )
    client.delete(f"/v1/weigh-ins/{morning}", headers=bearer(other))
    assert client.get("/v1/weigh-ins", headers=bearer(other)).json() == []
    assert len(client.get("/v1/weigh-ins", headers=bearer(token)).json()) == 2

    # The day's summary on Progress is the mean; nothing leaks to the profile.
    progress = client.get("/v1/me/progress", headers=bearer(token)).json()
    assert [b["weight_kg"] for b in progress["body"] if b["weight_kg"]] in ([80.73], [80.46, 81.0])
    assert "80.4" not in client.get("/v1/people/scaler", headers=bearer(other)).text

    assert client.delete(f"/v1/weigh-ins/{evening}", headers=bearer(token)).status_code == 204
    assert len(client.get("/v1/weigh-ins", headers=bearer(token)).json()) == 1


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


def test_weigh_ins_export_and_import_including_legacy_daily_weight(client):
    token = person(client, "legacy@example.com", "legacy")
    day = (now() - timedelta(days=3)).date().isoformat()
    at = (now() - timedelta(hours=2)).isoformat()
    legacy = {
        "format": "pacestreak-export",
        "version": 2,
        "workouts": [],
        "body_metrics": [{"date": day, "weight_kg": 79.9, "sleep_hours": 8}],
        "weigh_ins": [
            {"id": str(uuid4()), "weighed_at": at, "moment": "waking", "weight_kg": 79.5}
        ],
    }

    def send(data: dict, who: str) -> None:
        files = {"file": ("e.json", io.BytesIO(json.dumps(data).encode()), "application/json")}
        assert client.post("/v1/me/import", files=files, headers=bearer(who)).status_code == 200

    send(legacy, token)
    send(legacy, token)  # twice: no duplicates
    weighs = client.get("/v1/weigh-ins", headers=bearer(token)).json()
    assert sorted((w["moment"], w["weight_kg"]) for w in weighs) == [
        ("other", 79.9),
        ("waking", 79.5),
    ]
    assert next(w for w in weighs if w["moment"] == "other")["date"] == day
    assert client.get("/v1/body-metrics", headers=bearer(token)).json()[0]["sleep_hours"] == 8

    exported = client.get("/v1/me/export?format=json", headers=bearer(token)).json()
    assert exported["version"] == 3 and len(exported["weigh_ins"]) == 2
    assert "weight_kg" not in exported["body_metrics"][0]
    # Someone else importing it gets their own copies, and the owner keeps theirs.
    other = person(client, "copy@example.com", "copier")
    send(exported, other)
    theirs = client.get("/v1/weigh-ins", headers=bearer(other)).json()
    assert len(theirs) == 2 and not {w["id"] for w in theirs} & {w["id"] for w in weighs}


def test_account_deletion_is_scheduled_and_cancellable(client):
    token = person(client, "bye@example.com", "leaver")
    response = client.post(
        "/v1/me/delete", json={"password": "correct-horse-battery-staple"}, headers=bearer(token)
    )
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


def test_chain_requirements_validate_and_report_progress(client):
    token = person(client, "reqs@example.com", "reqs")
    main = client.get("/v1/chains", headers=bearer(token)).json()["chains"][0]

    too_many = client.patch(
        f"/v1/chains/{main['id']}",
        json={
            "requirements": [
                {"disciplines": ["run"], "days": 2},
                {"disciplines": ["strength"], "days": 2},
            ]
        },
        headers=bearer(token),
    )
    assert too_many.status_code == 422  # four required days, target three
    assert "weekly target" in too_many.json()["detail"]

    ok = client.patch(
        f"/v1/chains/{main['id']}",
        json={
            "target": 4,
            "requirements": [
                {"disciplines": ["run"], "days": 2},
                {"disciplines": ["strength"], "days": 2},
            ],
        },
        headers=bearer(token),
    )
    assert ok.status_code == 200, ok.text

    log_session(client, token)  # one run, today
    chain = client.get("/v1/chains", headers=bearer(token)).json()["chains"][0]
    assert chain["requirements"] == [
        {"disciplines": ["run"], "days": 2, "done": 1},
        {"disciplines": ["strength"], "days": 2, "done": 0},
    ]
    assert "consistency_12" in chain and "consistency_52" in chain

    runs_only = client.post(
        "/v1/chains",
        json={
            "name": "Runs",
            "disciplines": ["run"],
            "target": 3,
            "requirements": [{"disciplines": ["strength"], "days": 1}],
        },
        headers=bearer(token),
    )
    assert runs_only.status_code == 422  # strength never counts on a runs-only chain


def test_tags_are_normalised_and_private(client):
    token = person(client, "tags@example.com", "tagger")
    saved = log_session(client, token, tags=["#Hill Reps", "hill-reps", "With Sam!", "  "])
    assert saved["workout"]["tags"] == ["hill-reps", "with-sam"]
    listed = client.get("/v1/workouts", headers=bearer(token)).json()
    assert listed[0]["tags"] == ["hill-reps", "with-sam"]


def test_gear_mileage_follows_the_log(client):
    token = person(client, "gear@example.com", "gearhead")
    shoes = client.post(
        "/v1/gear",
        json={
            "name": "Trail shoes",
            "kind": "shoes",
            "default_for": ["run"],
            "limit_km": 700,
            "initial_km": 100,
        },
        headers=bearer(token),
    )
    assert shoes.status_code == 201, shoes.text
    gid = shoes.json()["id"]

    first = log_session(client, token, gear_id=gid, distance_m=10_000)
    log_session(client, token, gear_id=gid, distance_m=5_000)
    gear = client.get("/v1/gear", headers=bearer(token)).json()[0]
    assert gear["distance_m"] == 115_000  # 100 km before + 15 km logged
    assert gear["sessions"] == 2
    assert gear["worn"] == round(115 / 700, 3)

    # Deleting a session corrects the mileage; nothing is stored to drift.
    client.delete(f"/v1/workouts/{first['workout']['id']}", headers=bearer(token))
    assert client.get("/v1/gear", headers=bearer(token)).json()[0]["distance_m"] == 105_000

    # A second pair taking over as the running default releases the first.
    road = client.post(
        "/v1/gear", json={"name": "Road shoes", "default_for": ["run"]}, headers=bearer(token)
    ).json()
    items = {g["id"]: g for g in client.get("/v1/gear", headers=bearer(token)).json()}
    assert items[gid]["default_for"] == [] and items[road["id"]]["default_for"] == ["run"]

    # Retiring clears defaults; deleting keeps the sessions.
    client.patch(f"/v1/gear/{road['id']}", json={"retired": True}, headers=bearer(token))
    assert client.delete(f"/v1/gear/{gid}", headers=bearer(token)).status_code == 204
    remaining = client.get("/v1/workouts", headers=bearer(token)).json()
    assert len(remaining) == 1 and remaining[0]["gear_id"] is None


def test_someone_elses_gear_is_dropped_not_linked(client):
    a = person(client, "gear-a@example.com", "geara")
    b = person(client, "gear-b@example.com", "gearb")
    theirs = client.post("/v1/gear", json={"name": "Not yours"}, headers=bearer(a)).json()
    saved = log_session(client, b, gear_id=theirs["id"])
    assert saved["workout"]["gear_id"] is None
    assert (
        client.patch(f"/v1/gear/{theirs['id']}", json={"name": "x"}, headers=bearer(b)).status_code
        == 404
    )


def test_export_carries_tags_and_gear_and_import_restores_them(client):
    token = person(client, "carry@example.com", "carrier")
    shoes = client.post(
        "/v1/gear", json={"name": "Racers", "limit_km": 400}, headers=bearer(token)
    ).json()
    log_session(client, token, tags=["race"], gear_id=shoes["id"])
    exported = client.get("/v1/me/export?format=json", headers=bearer(token)).json()
    assert exported["version"] == 3
    assert exported["gear"][0]["name"] == "Racers"
    assert exported["workouts"][0]["tags"] == ["race"]

    other = person(client, "carry2@example.com", "carrier2")
    files = {"file": ("export.json", json.dumps(exported), "application/json")}
    assert client.post("/v1/me/import", files=files, headers=bearer(other)).json()["imported"] == 1
    gear = client.get("/v1/gear", headers=bearer(other)).json()
    assert [g["name"] for g in gear] == ["Racers"]
    assert gear[0]["distance_m"] == 5000
    # Importing twice never duplicates the gear.
    client.post("/v1/me/import", files=files, headers=bearer(other))
    assert len(client.get("/v1/gear", headers=bearer(other)).json()) == 1
