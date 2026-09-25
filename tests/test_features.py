"""Pauses, the weekly recap, file import, the calendar feed and official
accounts: the engine rules as pure functions, then each through the API."""

import io
from datetime import UTC, date, datetime, timedelta

import pytest

from app.game.streak import compute_chain
from app.training import importers
from app.training.pauses import (
    PAUSE_BUDGET_DAYS,
    PAUSE_MAX_DAYS,
    PauseError,
    Span,
    end_date_for,
    paused_days,
    validate,
)
from tests.conftest import bearer, person
from tests.test_social import make_role

MON = date(2026, 9, 7)


def forget_cached_user(user_id: str) -> None:
    """Onboarding already cached this user with their old role; a role set
    straight in the database needs the cache entry dropped to be seen. A
    synchronous client, because the app's async one belongs to its own loop."""
    import redis

    from app.auth.cache import _key
    from app.config import get_settings

    client = redis.Redis.from_url(get_settings().redis_url)
    client.delete(_key(user_id))
    client.close()


def days(*offsets: int) -> list[date]:
    return [MON + timedelta(days=o) for o in offsets]


def fixed(target: int):
    return lambda _week: target


def kept_weeks(n: int, start: int = 0) -> list[date]:
    return [d for w in range(start, start + n) for d in days(w * 7, w * 7 + 2, w * 7 + 4)]


# --- the engine --------------------------------------------------------------------------


def test_paused_week_neither_breaks_nor_extends_the_run():
    active = kept_weeks(2) + kept_weeks(1, start=3)
    pause = paused_days([Span(MON + timedelta(days=14), MON + timedelta(days=20))])
    r = compute_chain(active, MON + timedelta(days=29), 0, fixed(3), paused_days=pause)
    assert [w.status for w in r.weeks] == ["kept", "kept", "paused", "kept", "open"]
    assert r.current == 3


def test_pause_never_spends_or_earns_a_freeze():
    active = kept_weeks(4) + kept_weeks(1, start=6)
    pause = paused_days([Span(MON + timedelta(days=28), MON + timedelta(days=34))])
    # Week 4 paused, week 5 missed: the freeze from weeks 0-3 is still there for it.
    r = compute_chain(active, MON + timedelta(days=50), 0, fixed(3), paused_days=pause)
    statuses = [w.status for w in r.weeks]
    assert statuses[4:7] == ["paused", "frozen", "kept"]


def test_a_short_pause_does_not_shelter_a_week():
    active = kept_weeks(1) + kept_weeks(1, start=2)
    pause = paused_days([Span(MON + timedelta(days=7), MON + timedelta(days=9))])  # 3 days
    r = compute_chain(active, MON + timedelta(days=22), 0, fixed(3), paused_days=pause)
    assert r.weeks[1].status == "missed"


def test_a_kept_week_inside_a_pause_is_still_kept():
    pause = paused_days([Span(MON, MON + timedelta(days=6))])
    r = compute_chain(days(0, 2, 4), MON + timedelta(days=8), 0, fixed(3), paused_days=pause)
    assert r.weeks[0].status == "kept"


def test_paused_current_week_is_not_at_risk_and_is_out_of_consistency():
    active = kept_weeks(2)
    pause = paused_days([Span(MON + timedelta(days=14), None)])
    r = compute_chain(active, MON + timedelta(days=19), 0, fixed(3), paused_days=pause)
    assert r.weeks[-1].status == "paused"
    assert r.paused_now and not r.at_risk and r.needed == 0
    assert r.consistency == 100


# --- the pause rules ---------------------------------------------------------------------


def test_pause_rules():
    today = date(2026, 9, 25)
    with pytest.raises(PauseError):
        validate(Span(today - timedelta(days=15), None), [], today)
    with pytest.raises(PauseError):
        validate(Span(today + timedelta(days=31), None), [], today)
    with pytest.raises(PauseError):
        validate(Span(today, today + timedelta(days=PAUSE_MAX_DAYS)), [], today)
    first = Span(today - timedelta(days=5), today + timedelta(days=5))
    validate(first, [], today)
    with pytest.raises(PauseError):
        validate(Span(today, None), [first], today)
    assert Span(today, None).effective_end() == today + timedelta(days=PAUSE_MAX_DAYS - 1)


def test_pause_budget_is_bounded():
    today = date(2026, 9, 25)
    held = [Span(today - timedelta(days=300), today - timedelta(days=300 - 83))]
    with pytest.raises(PauseError, match=str(PAUSE_BUDGET_DAYS)):
        validate(Span(today, today + timedelta(days=60)), held, today)


def test_ending_a_pause():
    today = date(2026, 9, 25)
    assert end_date_for(Span(today - timedelta(days=4), None), today) == today - timedelta(days=1)
    assert end_date_for(Span(today, None), today) is None


# --- pauses through the API --------------------------------------------------------------


def test_pause_lifecycle(client):
    token = person(client, "hurt@example.com", "hurt")
    h = bearer(token)
    today = datetime.now(UTC).date()
    created = client.post(
        "/v1/pauses",
        json={"starts_on": (today - timedelta(days=2)).isoformat(), "reason": "injury"},
        headers=h,
    )
    assert created.status_code == 201, created.text
    assert created.json()["active"] is True

    stats = client.get("/v1/me/stats", headers=h).json()
    assert stats["paused_today"] is True
    assert stats["pauses"][0]["reason"] == "injury"

    overlap = client.post("/v1/pauses", json={"starts_on": today.isoformat()}, headers=h)
    assert overlap.status_code == 409

    # Started more than a day ago? It must be ended, not deleted. (Created
    # just now, so deleting is allowed as an undo - check the end path.)
    ended = client.post(f"/v1/pauses/{created.json()['id']}/end", headers=h)
    assert ended.status_code == 200
    assert ended.json()["pauses"][0]["ends_on"] == (today - timedelta(days=1)).isoformat()
    assert client.get("/v1/me/stats", headers=h).json()["paused_today"] is False


def test_pauses_are_private(client):
    a = person(client, "a@example.com", "alpha")
    b = person(client, "b@example.com", "bravo")
    pause = client.post(
        "/v1/pauses", json={"starts_on": datetime.now(UTC).date().isoformat()}, headers=bearer(a)
    ).json()
    assert client.post(f"/v1/pauses/{pause['id']}/end", headers=bearer(b)).status_code == 404
    assert client.delete(f"/v1/pauses/{pause['id']}", headers=bearer(b)).status_code == 404


# --- recap -------------------------------------------------------------------------------


def test_recap_reports_attendance_not_volume(client):
    token = person(client, "recap@example.com", "recap")
    h = bearer(token)
    started = datetime.now(UTC) - timedelta(hours=2)
    client.put(
        "/v1/workouts/0192a7b8-0000-7000-8000-000000000001",
        json={
            "discipline": "run",
            "started_at": started.isoformat(),
            "client_updated_at": datetime.now(UTC).isoformat(),
            "distance_m": 5000,
            "duration_sec": 1500,
            "sets": [],
        },
        headers=h,
    )
    recap = client.get(f"/v1/me/recap?week={started.date().isoformat()}", headers=h)
    assert recap.status_code == 200, recap.text
    body = recap.json()
    assert body["sessions"] == 1
    assert body["disciplines"][0]["id"] == "run"
    assert "distance" not in str(body).lower().replace("disciplines", "")

    future = (datetime.now(UTC).date() + timedelta(days=30)).isoformat()
    assert client.get(f"/v1/me/recap?week={future}", headers=h).status_code == 422


# --- file import -------------------------------------------------------------------------

GPX = b"""<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Morning run</name><type>running</type><trkseg>
    <trkpt lat="51.5000" lon="-0.1000"><ele>10</ele><time>2026-09-01T07:00:00Z</time></trkpt>
    <trkpt lat="51.5090" lon="-0.1000"><ele>20</ele><time>2026-09-01T07:05:00Z</time></trkpt>
    <trkpt lat="51.5180" lon="-0.1000"><ele>15</ele><time>2026-09-01T07:10:00Z</time></trkpt>
  </trkseg></trk>
</gpx>"""

BOMB = b"""<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;">]>
<gpx><trk><name>&lol2;</name></trk></gpx>"""


def test_gpx_parser():
    result = importers.parse_gpx(GPX)
    assert len(result.sessions) == 1
    s = result.sessions[0]
    assert s.discipline == "run" and s.title == "Morning run"
    assert s.duration_sec == 600
    assert 1900 < s.distance_m < 2100
    assert s.elevation_m == 10.0


def test_gpx_entity_expansion_is_refused():
    with pytest.raises(importers.ImportFormatError):
        importers.parse_gpx(BOMB)


def test_csv_parser_handles_units_durations_and_bad_rows():
    data = (
        b"Date,Type,Duration,Distance,Title\n"
        b"2026-09-01,Running,0:30:00,5,Easy\n"
        b"2026-09-02T18:00:00,Weight Training,45:00,,Legs\n"
        b"not a date,Run,,,\n"
    )
    result = importers.parse_csv(data, "Europe/London")
    assert [s.discipline for s in result.sessions] == ["run", "strength"]
    assert result.sessions[0].distance_m == 5000
    assert result.sessions[0].duration_sec == 1800
    assert result.sessions[0].started_at.hour == 12  # bare date: midday local
    assert result.problems == ["Row 4 could not be read."]


def test_unknown_format_is_refused():
    with pytest.raises(importers.ImportFormatError):
        importers.parse("notes.txt", b"hello", "UTC")


def test_import_endpoint_is_idempotent_and_marks_source(client):
    token = person(client, "import@example.com", "importer")
    h = bearer(token)
    upload = {"file": ("run.gpx", io.BytesIO(GPX), "application/gpx+xml")}
    first = client.post("/v1/workouts/import", files=upload, headers=h)
    assert first.status_code == 200, first.text
    assert first.json()["imported"] == 1

    again = client.post(
        "/v1/workouts/import",
        files={"file": ("run.gpx", io.BytesIO(GPX), "application/gpx+xml")},
        headers=h,
    )
    assert again.json()["imported"] == 0 and again.json()["duplicates"] == 1

    workouts = client.get("/v1/workouts", headers=h).json()
    assert len(workouts) == 1 and workouts[0]["source"] == "import"

    bad = client.post(
        "/v1/workouts/import", files={"file": ("x.fit", io.BytesIO(b"nope"), "")}, headers=h
    )
    assert bad.status_code == 422


# --- calendar feed -----------------------------------------------------------------------


def test_calendar_feed_lifecycle(client):
    token = person(client, "cal@example.com", "cal")
    h = bearer(token)
    assert client.get("/v1/me/calendar", headers=h).json()["enabled"] is False
    url = client.post("/v1/me/calendar", headers=h).json()["url"]
    path = url.split("://", 1)[1].split("/", 1)[1]

    feed = client.get("/" + path)
    assert feed.status_code == 200
    assert feed.headers["content-type"].startswith("text/calendar")
    assert "private" in feed.headers["cache-control"]
    assert feed.text.startswith("BEGIN:VCALENDAR\r\n")

    rotated = client.post("/v1/me/calendar", headers=h).json()["url"]
    assert client.get("/" + path).status_code == 404
    new_path = rotated.split("://", 1)[1].split("/", 1)[1]
    assert client.get("/" + new_path).status_code == 200

    assert client.delete("/v1/me/calendar", headers=h).status_code == 204
    assert client.get("/" + new_path).status_code == 404

    events = client.get("/v1/me/security-events", headers=h).json()
    kinds = {e["kind"] for e in (events["events"] if isinstance(events, dict) else events)}
    assert {"calendar_feed_created", "calendar_feed_rotated", "calendar_feed_revoked"} <= kinds


def test_ics_folding_and_escaping():
    from app.account.calendar import escape, fold

    assert escape("a,b;c\\d\ne") == "a\\,b\\;c\\\\d\\ne"
    folded = fold("SUMMARY:" + "é" * 60)
    assert all(len(part.encode()) <= 75 for part in folded.split("\r\n"))


# --- official accounts -------------------------------------------------------------------


def test_brand_names_are_reserved_however_they_are_spelled(client):
    token = person(client, "fan@example.com", "fan")
    h = bearer(token)
    for handle in ("pacestreak", "real_pacestreak", "pace_streak_hq", "pac3streak"):
        assert client.get(f"/v1/handles/{handle}", headers=h).json()["available"] is False
    name = client.patch("/v1/me/profile", json={"display_name": "PaceStreak Team"}, headers=h)
    assert name.status_code == 409


def test_only_an_admin_can_grant_official_status(client):
    brand = person(client, "brand@example.com", "brandteam")
    admin = person(client, "boss@example.com", "boss")
    me = client.get("/v1/me", headers=bearer(brand)).json()
    brand_id = me["user"]["id"]

    grant = {"official": True, "handle": "pacestreak"}
    # Not an admin (and asking for itself): the endpoint does not exist.
    denied = client.post(f"/v1/admin/users/{brand_id}/official", json=grant, headers=bearer(brand))
    assert denied.status_code == 404

    make_role("boss@example.com", "admin")
    boss = client.get("/v1/me", headers=bearer(admin)).json()["user"]["id"]
    forget_cached_user(boss)
    ok = client.post(f"/v1/admin/users/{brand_id}/official", json=grant, headers=bearer(admin))
    assert ok.status_code == 200, ok.text
    assert ok.json() == {"official": True, "handle": "pacestreak"}

    profile = client.get("/v1/people/pacestreak", headers=bearer(admin)).json()
    assert profile["official"] is True or profile.get("person", {}).get("official") is True
    named = client.patch(
        "/v1/me/profile", json={"display_name": "PaceStreak"}, headers=bearer(brand)
    )
    assert named.status_code == 200

    revoke = client.post(
        f"/v1/admin/users/{brand_id}/official", json={"official": False}, headers=bearer(admin)
    )
    assert revoke.status_code == 409
    revoke = client.post(
        f"/v1/admin/users/{brand_id}/official",
        json={"official": False, "handle": "brandteam"},
        headers=bearer(admin),
    )
    assert revoke.json() == {"official": False, "handle": "brandteam"}
    audit = client.get("/v1/admin/audit", headers=bearer(admin)).json()
    assert any(a["action"] == "user.official" for a in audit)
