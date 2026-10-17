"""Body data on the server: tape measurements, opt-in photo backup, and the
habit fixes that shipped with them."""

import io
import zipfile
from datetime import UTC, date, datetime, timedelta
from uuid import UUID, uuid4

from app.habits.engine import HabitDay, first_week_target, view_habit
from app.training.photos import _object_key
from tests.conftest import bearer, person

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
JPEG_TYPE = "image/jpeg"


def test_tape_measurements_round_trip_and_export(client):
    h = bearer(person(client, "tape@example.com", "taper"))
    day = datetime.now(UTC).date().isoformat()
    body = {"chest_cm": 101.5, "arm_cm": 36, "thigh_cm": 58.2, "waist_cm": 82}
    assert client.put(f"/v1/body-metrics/{day}", json=body, headers=h).status_code == 200
    got = client.get("/v1/body-metrics", headers=h).json()[0]
    assert {k: got[k] for k in body} == body and got["neck_cm"] is None
    assert client.put(f"/v1/body-metrics/{day}", json={"calf_cm": 0}, headers=h).status_code == 422
    exported = client.get("/v1/me/export?format=json", headers=h).json()
    assert exported["body_metrics"][0]["chest_cm"] == 101.5
    csv_zip = zipfile.ZipFile(io.BytesIO(client.get("/v1/me/export?format=csv", headers=h).content))
    assert "chest_cm" in csv_zip.read("body_metrics.csv").decode().splitlines()[0]


def _put_bytes(fake_storage, user_id: str, pid, data: bytes, content_type: str = JPEG_TYPE):
    """Stands in for the client's browser PUTting bytes straight to R2 - the
    thing `/upload` merely hands out a URL for. See conftest's fake_storage."""
    key = _object_key(UUID(user_id), pid)
    fake_storage[key] = (data, content_type)


def test_photo_backup_is_owner_only_and_checked(client, fake_storage):
    h = bearer(person(client, "photo@example.com", "photoer"))
    other = bearer(person(client, "peek@example.com", "peeker"))
    pid = uuid4()
    uid = client.get("/v1/me", headers=h).json()["user"]["id"]
    today = datetime.now(UTC).date().isoformat()
    body = {"date": today, "pose": "front", "content_type": JPEG_TYPE}

    # Step 1: ask for an upload URL.
    started = client.post(f"/v1/body-photos/{pid}/upload", json=body, headers=h)
    assert started.status_code == 200 and started.json()["upload_url"]
    # Step 2, after the (faked) browser PUT: verify and commit.
    _put_bytes(fake_storage, uid, pid, JPEG)
    assert (
        client.post(f"/v1/body-photos/{pid}/upload/complete", json=body, headers=h).status_code
        == 200
    )
    # A retry replaces rather than duplicates.
    _put_bytes(fake_storage, uid, pid, JPEG)
    assert (
        client.post(f"/v1/body-photos/{pid}/upload/complete", json=body, headers=h).status_code
        == 200
    )
    assert [p["id"] for p in client.get("/v1/body-photos", headers=h).json()] == [str(pid)]

    got = client.get(f"/v1/body-photos/{pid}", headers=h)
    assert got.status_code == 200 and got.json()["url"]
    assert client.get(f"/v1/body-photos/{pid}", headers=other).status_code == 404
    # Someone else can't overwrite it by reusing the id, at either step.
    assert client.post(f"/v1/body-photos/{pid}/upload", json=body, headers=other).status_code == 409
    assert (
        client.post(f"/v1/body-photos/{pid}/upload/complete", json=body, headers=other).status_code
        == 409
    )
    # The declared type must match the bytes actually sitting in R2 - checked
    # (and rejected) as its own upload, not the one already backed up above.
    bad = uuid4()
    _put_bytes(fake_storage, uid, bad, b"<svg/>")
    assert (
        client.post(f"/v1/body-photos/{bad}/upload/complete", json=body, headers=h).status_code
        == 415
    )
    # The rejected upload never lingers in the bucket or the database.
    assert _object_key(UUID(uid), bad) not in fake_storage
    assert client.get(f"/v1/body-photos/{bad}", headers=h).status_code == 404
    # ...and only images are accepted in the first place.
    text_body = {**body, "content_type": "text/html"}
    assert (
        client.post(f"/v1/body-photos/{bad}/upload", json=text_body, headers=h).status_code == 415
    )
    # Completing without ever having uploaded anything is refused, not a 500.
    missing = uuid4()
    assert (
        client.post(f"/v1/body-photos/{missing}/upload/complete", json=body, headers=h).status_code
        == 400
    )
    # The original, valid photo is unaffected by all of the above.
    assert client.get(f"/v1/body-photos/{pid}", headers=h).status_code == 200

    csv_zip = zipfile.ZipFile(io.BytesIO(client.get("/v1/me/export?format=csv", headers=h).content))
    assert any(n.startswith("photos/") for n in csv_zip.namelist())

    assert client.delete(f"/v1/body-photos/{pid}", headers=other).status_code == 204
    assert len(client.get("/v1/body-photos", headers=h).json()) == 1
    assert client.delete("/v1/body-photos", headers=h).status_code == 204
    assert client.get("/v1/body-photos", headers=h).json() == []


def test_oversized_upload_is_rejected_and_swept_from_r2(client, fake_storage):
    h = bearer(person(client, "big@example.com", "bigger"))
    uid = client.get("/v1/me", headers=h).json()["user"]["id"]
    pid = uuid4()
    today = datetime.now(UTC).date().isoformat()
    body = {"date": today, "pose": "front", "content_type": JPEG_TYPE}
    from app.training.models import MAX_BODY_PHOTO_BYTES

    oversized = JPEG + b"\x00" * MAX_BODY_PHOTO_BYTES
    _put_bytes(fake_storage, uid, pid, oversized)
    resp = client.post(f"/v1/body-photos/{pid}/upload/complete", json=body, headers=h)
    assert resp.status_code == 413
    # Rejected uploads don't linger in the bucket, and never reach the database.
    assert _object_key(UUID(uid), pid) not in fake_storage
    assert client.get("/v1/body-photos", headers=h).json() == []


def test_a_habit_started_mid_week_can_keep_its_first_week():
    mon = date(2026, 9, 14)
    thu = mon + timedelta(days=3)
    assert first_week_target(7, thu, mon) == 4
    assert first_week_target(3, thu, mon) == 3
    assert first_week_target(7, thu, mon + timedelta(days=7)) == 7
    # Daily from a Thursday through the next Sunday: both weeks count.
    v = view_habit(
        kind="check",
        daily_goal=None,
        weekly_target=7,
        started_on=thu,
        logs=[HabitDay(thu + timedelta(days=i), 1) for i in range(11)],
        today=thu + timedelta(days=10),
        week_starts_on=0,
        paused_days=set(),
    )
    assert v.chain.current == 2 and v.chain.weeks[0].status == "kept"


def test_habit_list_carries_the_last_seven_days(client):
    h = bearer(person(client, "recent@example.com", "recenter"))
    habit = client.post("/v1/habits", json={"template_id": "water"}, headers=h).json()
    today = datetime.now(UTC).date()
    yesterday = (today - timedelta(days=1)).isoformat()
    client.put(f"/v1/habits/{habit['id']}/days/{yesterday}", json={"amount": 3}, headers=h)
    recent = client.get("/v1/habits", headers=h).json()[0]["recent"]
    assert len(recent) == 7 and recent[-1]["date"] == today.isoformat()
    assert recent[-2] == {"date": yesterday, "amount": 3.0, "note": None}


def test_habit_day_notes_survive_a_tick_and_can_stand_alone(client):
    h = bearer(person(client, "notes@example.com", "noter"))
    habit = client.post("/v1/habits", json={"template_id": "journal"}, headers=h).json()
    day = datetime.now(UTC).date().isoformat()
    url = f"/v1/habits/{habit['id']}/days/{day}"

    def note():
        return client.get(f"/v1/habits/{habit['id']}", headers=h).json()["days"]

    client.put(url, json={"amount": 1, "note": "wrote two pages"}, headers=h)
    # A plain tick later, with no note sent, keeps it.
    client.put(url, json={"amount": 1}, headers=h)
    assert note() == [{"date": day, "amount": 1.0, "note": "wrote two pages"}]
    # Unticking keeps a day that still has a note, as not done.
    client.put(url, json={"amount": 0}, headers=h)
    assert note()[0]["amount"] == 0 and note()[0]["note"] == "wrote two pages"
    assert client.get("/v1/habits", headers=h).json()[0]["today"]["done"] is False
    # Clearing both removes the day.
    client.put(url, json={"amount": 0, "note": ""}, headers=h)
    assert note() == []
