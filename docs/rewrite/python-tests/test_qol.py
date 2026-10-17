"""Trash and restore, bulk fill-in, snooze and notification actions, the
evening habit summary, search, and the one-day view."""

import time
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from sqlalchemy import update

from app.database import AsyncSessionLocal
from app.habits.actions import action_url, sign
from app.habits.models import Habit
from app.notifications.models import Notification
from app.worker import habit_reminders, habit_summary, snoozed_reminders
from tests.conftest import bearer, person
from tests.test_training import workout
from tests.test_worker import run

TODAY = datetime.now(UTC).date()


def _db(stmt_fn):
    async def go():
        async with AsyncSessionLocal() as db:
            result = await stmt_fn(db)
            await db.commit()
            return result

    return run(go)


# --- trash ---------------------------------------------------------------------------


def test_deleted_habit_comes_back_with_its_history(client):
    h = bearer(person(client, "trash@example.com", "trasher"))
    habit = client.post(
        "/v1/habits", json={"name": "Read", "cue": "After dinner"}, headers=h
    ).json()
    days = [(TODAY - timedelta(days=i)).isoformat() for i in range(3)]
    for d in days:
        client.put(
            f"/v1/habits/{habit['id']}/days/{d}", json={"amount": 1, "note": f"n{d}"}, headers=h
        )
    gone = client.delete(f"/v1/habits/{habit['id']}", headers=h)
    assert gone.status_code == 200 and gone.json()["trash_id"]
    assert client.get("/v1/habits", headers=h).json() == []

    trash = client.get("/v1/trash", headers=h).json()
    assert [t["kind"] for t in trash] == ["habit"] and "Read" in trash[0]["label"]
    other = bearer(person(client, "trash2@example.com", "trasher2"))
    assert client.get("/v1/trash", headers=other).json() == []
    assert client.post(f"/v1/trash/{trash[0]['id']}/restore", headers=other).status_code == 404

    assert client.post(f"/v1/trash/{trash[0]['id']}/restore", headers=h).status_code == 200
    back = client.get(f"/v1/habits/{habit['id']}?days=10", headers=h).json()
    assert back["cue"] == "After dinner"
    assert sorted(d["date"] for d in back["days"]) == sorted(days)
    assert client.get("/v1/trash", headers=h).json() == []


def test_meal_food_recipe_journal_and_routine_restore(client):
    h = bearer(person(client, "trash3@example.com", "trasher3"))
    day = TODAY.isoformat()
    food = client.post("/v1/nutrition/foods", json={"name": "Oats", "kcal": 150}, headers=h).json()
    eid = str(uuid4())
    client.put(
        f"/v1/nutrition/entries/{eid}",
        json={"date": day, "meal": "breakfast", "food_id": food["id"]},
        headers=h,
    )
    recipe = client.post(
        "/v1/nutrition/recipes",
        json={"name": "Porridge", "items": [{"food_id": food["id"]}]},
        headers=h,
    ).json()
    client.put(f"/v1/journal/{day}", json={"mood": 4, "note": "good"}, headers=h)
    a = client.post("/v1/habits", json={"name": "Water"}, headers=h).json()
    routine = client.post(
        "/v1/habit-routines", json={"name": "AM", "habit_ids": [a["id"]]}, headers=h
    ).json()

    ids = [
        client.delete(f"/v1/nutrition/entries/{eid}", headers=h).json()["trash_id"],
        client.delete(f"/v1/nutrition/foods/{food['id']}", headers=h).json()["trash_id"],
        client.delete(f"/v1/nutrition/recipes/{recipe['id']}", headers=h).json()["trash_id"],
        client.delete(f"/v1/journal/{day}", headers=h).json()["trash_id"],
        client.delete(f"/v1/habit-routines/{routine['id']}", headers=h).json()["trash_id"],
    ]
    # Deleting again is idempotent where the app queues deletes offline.
    assert client.delete(f"/v1/nutrition/entries/{eid}", headers=h).json() == {"trash_id": None}
    assert client.delete(f"/v1/journal/{day}", headers=h).json() == {"trash_id": None}
    assert {t["kind"] for t in client.get("/v1/trash", headers=h).json()} == {
        "meal",
        "food",
        "recipe",
        "journal",
        "habit_routine",
    }
    # Food first, so the restored meal points at it again.
    for tid in [ids[1], ids[0], ids[2], ids[3], ids[4]]:
        assert client.post(f"/v1/trash/{tid}/restore", headers=h).status_code == 200, tid
    entries = client.get(f"/v1/nutrition/days/{day}", headers=h).json()["entries"]
    assert entries[0]["food_id"] == food["id"] and entries[0]["kcal"] == 150
    assert client.get("/v1/journal", headers=h).json()[0]["note"] == "good"
    assert client.get("/v1/habit-routines", headers=h).json()[0]["habit_ids"] == [a["id"]]


def test_restore_refuses_a_clash_and_changes_nothing(client):
    h = bearer(person(client, "trash4@example.com", "trasher4"))
    day = TODAY.isoformat()
    client.put(f"/v1/journal/{day}", json={"mood": 2, "note": "old"}, headers=h)
    tid = client.delete(f"/v1/journal/{day}", headers=h).json()["trash_id"]
    client.put(f"/v1/journal/{day}", json={"mood": 5, "note": "new"}, headers=h)
    assert client.post(f"/v1/trash/{tid}/restore", headers=h).status_code == 409
    assert client.get("/v1/journal", headers=h).json()[0]["note"] == "new"
    assert len(client.get("/v1/trash", headers=h).json()) == 1
    assert client.delete(f"/v1/trash/{tid}", headers=h).status_code == 204
    assert client.get("/v1/trash", headers=h).json() == []


def test_deleted_workout_restores_and_syncs(client):
    h = bearer(person(client, "trash5@example.com", "trasher5"))
    wid = str(uuid4())
    assert client.put(f"/v1/workouts/{wid}", json=workout(), headers=h).status_code == 200
    client.delete(f"/v1/workouts/{wid}", headers=h)
    client.delete(f"/v1/workouts/{wid}", headers=h)  # twice: one trash entry
    trash = client.get("/v1/trash", headers=h).json()
    assert [t["kind"] for t in trash] == ["workout"]
    before = client.get("/v1/workouts/changes?since=0", headers=h).json()
    assert client.post(f"/v1/trash/{trash[0]['id']}/restore", headers=h).status_code == 200
    after = client.get(f"/v1/workouts/changes?since={before['cursor']}", headers=h).json()
    restored = [w for w in after["workouts"] if w["id"] == wid]
    assert restored and restored[0]["deleted_at"] is None


def test_undo_by_resaving_a_workout_clears_its_trash_entry(client):
    h = bearer(person(client, "trash6@example.com", "trasher6"))
    wid = str(uuid4())
    client.put(f"/v1/workouts/{wid}", json=workout(), headers=h)
    client.delete(f"/v1/workouts/{wid}", headers=h)
    assert len(client.get("/v1/trash", headers=h).json()) == 1
    again = workout(client_updated_at=(datetime.now(UTC) + timedelta(seconds=5)).isoformat())
    assert client.put(f"/v1/workouts/{wid}", json=again, headers=h).status_code == 200
    assert client.get("/v1/trash", headers=h).json() == []


# --- bulk fill-in --------------------------------------------------------------------


def test_bulk_days_fill_clear_and_validate(client):
    h = bearer(person(client, "bulk@example.com", "bulker"))
    habit = client.post("/v1/habits", json={"name": "Stretch"}, headers=h).json()
    days = [(TODAY - timedelta(days=i)).isoformat() for i in range(5)]
    got = client.put(
        f"/v1/habits/{habit['id']}/days",
        json={"days": [{"date": d, "amount": 1} for d in days]},
        headers=h,
    )
    assert got.status_code == 200
    detail = client.get(f"/v1/habits/{habit['id']}?days=10", headers=h).json()
    assert len(detail["days"]) == 5
    clear = {"days": [{"date": days[0], "amount": 0}]}
    client.put(f"/v1/habits/{habit['id']}/days", json=clear, headers=h)
    assert len(client.get(f"/v1/habits/{habit['id']}?days=10", headers=h).json()["days"]) == 4
    dup = {"days": [{"date": days[0], "amount": 1}, {"date": days[0], "amount": 1}]}
    assert client.put(f"/v1/habits/{habit['id']}/days", json=dup, headers=h).status_code == 422
    future = {"days": [{"date": (TODAY + timedelta(days=2)).isoformat(), "amount": 1}]}
    assert client.put(f"/v1/habits/{habit['id']}/days", json=future, headers=h).status_code == 422


# --- snooze, actions and summary -------------------------------------------------------


def _expire_snooze(habit_id: str) -> None:
    _db(
        lambda db: db.execute(
            update(Habit)
            .where(Habit.id == habit_id)
            .values(snoozed_until=datetime.now(UTC) - timedelta(minutes=1))
        )
    )


def test_snooze_reminds_once_unless_done(client):
    h = bearer(person(client, "snooze@example.com", "snoozer"))
    habit = client.post("/v1/habits", json={"name": "Walk"}, headers=h).json()
    assert (
        client.post(f"/v1/habits/{habit['id']}/snooze", json={"minutes": 5}, headers=h).status_code
        == 422
    )
    assert (
        client.post(f"/v1/habits/{habit['id']}/snooze", json={"minutes": 60}, headers=h).status_code
        == 200
    )
    assert run(snoozed_reminders) == []  # not due yet
    _expire_snooze(habit["id"])
    assert len(run(snoozed_reminders)) == 1
    assert run(snoozed_reminders) == []  # cleared after firing

    client.post(f"/v1/habits/{habit['id']}/snooze", json={"minutes": 60}, headers=h)
    client.put(f"/v1/habits/{habit['id']}/days/{TODAY}", json={"amount": 1}, headers=h)
    _expire_snooze(habit["id"])
    assert run(snoozed_reminders) == []  # done in the meantime


def test_reminder_push_actions_are_signed_and_scoped(client):
    token = person(client, "actions@example.com", "actioner")
    h = bearer(token)
    hour = datetime.now(UTC).hour
    habit = client.post("/v1/habits", json={"name": "Floss", "remind_hour": hour}, headers=h).json()
    [nid] = run(habit_reminders)
    note = _db(lambda db: db.get(Notification, nid))
    actions = {a["action"]: a["url"] for a in note.data["actions"]}
    assert set(actions) == {"done", "snooze"}

    def post(url):
        parts = urlparse(url)
        return client.post(f"{parts.path}?{parts.query}")

    snoozed = post(actions["snooze"])
    assert snoozed.status_code == 200 and snoozed.json()["snoozed_until"]
    # Tampering with any part of the link breaks it.
    q = parse_qs(urlparse(actions["done"]).query)
    other = client.post("/v1/habits", json={"name": "Other"}, headers=h).json()
    assert (
        client.post(
            f"/v1/habits/{other['id']}/action?a=done&u={q['u'][0]}&d={q['d'][0]}&e={q['e'][0]}&s={q['s'][0]}"
        ).status_code
        == 403
    )
    expired = int(time.time()) - 10
    stale = sign(q["u"][0], habit["id"], "done", q["d"][0], expired)
    assert (
        client.post(
            f"/v1/habits/{habit['id']}/action?a=done&u={q['u'][0]}&d={q['d'][0]}&e={expired}&s={stale}"
        ).status_code
        == 403
    )

    assert post(actions["done"]).json() == {"done": True}
    assert post(actions["done"]).status_code == 200  # idempotent
    mine = client.get("/v1/habits", headers=h).json()
    assert next(x for x in mine if x["id"] == habit["id"])["today"]["done"] is True
    assert action_url  # imported for the signature check above


def test_summary_replaces_per_habit_reminders_and_names_nothing(client):
    h = bearer(person(client, "summary@example.com", "summariser"))
    hour = datetime.now(UTC).hour
    for name in ("Secret habit", "Another"):
        client.post("/v1/habits", json={"name": name, "remind_hour": hour}, headers=h)
    prefs = client.put(
        "/v1/notifications/preferences", json={"habit_summary_hour": hour}, headers=h
    )
    assert prefs.status_code == 200 and prefs.json()["habit_summary_hour"] == hour
    # Channels survive a summary-only update.
    assert prefs.json()["categories"]
    assert run(habit_reminders) == []
    [nid] = run(habit_summary)
    note = _db(lambda db: db.get(Notification, nid))
    assert note.title == "2 habits still open today" and "Secret" not in (note.body or "")
    assert run(habit_summary) == []  # once a day
    off = client.put("/v1/notifications/preferences", json={"habit_summary_hour": None}, headers=h)
    assert off.json()["habit_summary_hour"] is None


# --- search and the day view -----------------------------------------------------------


def test_search_finds_everything_escapes_wildcards_and_is_private(client):
    h = bearer(person(client, "search@example.com", "searcher"))
    habit = client.post(
        "/v1/habits", json={"name": "Guitar practice", "cue": "after coffee"}, headers=h
    ).json()
    client.put(
        f"/v1/habits/{habit['id']}/days/{TODAY}",
        json={"amount": 1, "note": "learned a barre chord"},
        headers=h,
    )
    client.put(f"/v1/journal/{TODAY}", json={"note": "felt 100% today"}, headers=h)
    client.put(f"/v1/workouts/{uuid4()}", json=workout(title="Hill repeats"), headers=h)
    client.post(
        "/v1/nutrition/foods",
        json={"name": "Greek yoghurt", "brand": "Fage", "kcal": 97},
        headers=h,
    )

    def kinds(q, headers=h):
        return {
            r["kind"] for r in client.get(f"/v1/search?q={q}", headers=headers).json()["results"]
        }

    assert kinds("guitar") == {"habit"}
    assert kinds("barre") == {"habit_note"}
    assert kinds("hill") == {"workout"}
    assert kinds("fage") == {"food"}
    assert kinds("100%25") == {"journal"}  # "100%" literally
    assert kinds("1_0") == set()  # _ is not a wildcard
    other = bearer(person(client, "search2@example.com", "searcher2"))
    assert kinds("guitar", other) == set()
    assert client.get("/v1/search?q=a", headers=h).status_code == 422


def test_day_view_gathers_one_date(client):
    h = bearer(person(client, "day@example.com", "dayer"))
    day = TODAY.isoformat()
    habit = client.post(
        "/v1/habits", json={"name": "Water", "kind": "count", "daily_goal": 8}, headers=h
    ).json()
    client.put(f"/v1/habits/{habit['id']}/days/{day}", json={"amount": 8}, headers=h)
    client.put(
        f"/v1/nutrition/entries/{uuid4()}",
        json={"date": day, "meal": "lunch", "name": "Soup", "kcal": 300, "protein_g": 12},
        headers=h,
    )
    client.put(f"/v1/journal/{day}", json={"mood": 4}, headers=h)
    client.put(f"/v1/workouts/{uuid4()}", json=workout(), headers=h)
    got = client.get(f"/v1/day/{day}", headers=h).json()
    assert got["habits"][0]["done"] is True and got["food"]["kcal"] == 300
    assert got["journal"]["mood"] == 4 and len(got["workouts"]) == 1
    other = bearer(person(client, "day2@example.com", "dayer2"))
    empty = client.get(f"/v1/day/{day}", headers=other).json()
    assert empty["habits"] == [] and empty["workouts"] == [] and empty["journal"] is None


# --- monthly backup with the export attached -----------------------------------------


def test_backup_attachment_is_opt_in_and_round_trips(client, sent, monkeypatch):
    import io
    import json
    import zipfile

    from app import email as email_module
    from app.notifications.service import deliver, notify

    h = bearer(person(client, "backup@example.com", "backupper"))
    client.post("/v1/habits", json={"name": "Private habit"}, headers=h)
    prefs = client.get("/v1/notifications/preferences", headers=h).json()
    assert prefs["backup_attachment"] is False
    got = client.put(
        "/v1/notifications/preferences",
        json={"backup_attachment": True, "channels": {"backup": {"email": True}}},
        headers=h,
    ).json()
    assert got["backup_attachment"] is True
    uid = client.get("/v1/me", headers=h).json()["user"]["id"]

    captured = {}

    async def fake_send(to, subject, body, headers=None, html=None, attachments=None):
        captured.update(to=to, body=body, attachments=attachments)

    monkeypatch.setattr("app.notifications.service.send_email", fake_send)

    async def make():
        async with AsyncSessionLocal() as db:
            nid = await notify(
                db,
                uid,
                kind="monthly_backup",
                category="backup",
                title="Your monthly PaceStreak backup",
                data={"export_attachment": True},
            )
            await db.commit()
        await deliver([nid])

    run(make)
    [(name, blob, mime)] = captured["attachments"]
    assert name.endswith(".zip") and mime == "application/zip"
    inner = zipfile.ZipFile(io.BytesIO(blob))
    data = json.loads(inner.read(inner.namelist()[0]))
    assert data["habits"][0]["name"] == "Private habit"
    # The attachment is the export, so it imports straight back.
    other = bearer(person(client, "restore@example.com", "restorer"))
    files = {"file": ("e.json", io.BytesIO(json.dumps(data).encode()), "application/json")}
    assert client.post("/v1/me/import", files=files, headers=other).status_code == 200

    # A message with an attachment is still well formed.
    msg = email_module.build_message("a@b.c", "s", "body", attachments=[(name, blob, mime)])
    assert [p.get_filename() for p in msg.iter_attachments()] == [name]


def test_backup_falls_back_to_a_link_when_too_big(client, monkeypatch):
    from app.account import backup

    h = bearer(person(client, "bigbackup@example.com", "bigbackup"))
    uid = client.get("/v1/me", headers=h).json()["user"]["id"]
    monkeypatch.setattr(backup, "MAX_ATTACHMENT_BYTES", 10)

    async def go():
        async with AsyncSessionLocal() as db:
            return await backup.export_attachment(db, uid)

    assert run(go) is None


def test_preference_updates_merge_instead_of_resetting(client):
    h = bearer(person(client, "merge@example.com", "merger"))
    client.put(
        "/v1/notifications/preferences", json={"channels": {"digest": {"email": False}}}, headers=h
    )
    got = client.put(
        "/v1/notifications/preferences", json={"channels": {"backup": {"email": True}}}, headers=h
    ).json()
    cats = {c["id"]: c for c in got["categories"]}
    assert cats["backup"]["email"] is True
    assert cats["digest"]["email"] is False  # untouched by the second update
    assert cats["security"]["email"] is True  # locked
