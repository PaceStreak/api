"""Race plans, training blocks, readiness, reflections, heart rate and the
after-session check-in."""

import io
import json
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

import pytest

from app.training.importers import hr_summary, parse_gpx, zone_seconds
from app.training.models import TrainingBlock
from app.training.personal import block_week
from app.training.race import RacePlanError, build_race_plan
from tests.conftest import bearer, person
from tests.test_training import workout

MON = date(2026, 9, 7)


# --- race plans -----------------------------------------------------------------------


def test_race_plan_builds_to_race_day_then_recovers():
    race_day = MON + timedelta(weeks=10, days=5)  # a Saturday, 11th week
    first, weeks, name = build_race_plan("10k", race_day, MON + timedelta(days=2), 0, 3)
    assert first == MON
    assert len(weeks) == 12  # 11 weeks to race week, plus recovery
    race_week = weeks[-2]
    assert race_week[-1]["title"] == "Race day: 10 km" and race_week[-1]["day"] == 5
    assert all(s["day"] < 5 for s in race_week[:-1])
    longs = [w[-1]["minutes"] for w in weeks[:-3]]
    # Growth is gradual: never more than about 10% past the best so far, and
    # the week after a lighter one comes back to the level before it.
    assert all(longs[k] <= round(max(longs[:k]) * 1.12) + 1 for k in range(1, len(longs)))
    # Every fourth week is lighter than the one before.
    assert longs[3] < longs[2]
    # One faster session a week once the base is built, never in the base.
    assert not any("Intervals" in s["title"] for s in weeks[0])
    assert any("Intervals" in s["title"] for w in weeks[5:8] for s in w)
    # Taper: the last long run before the race is shorter than the peak.
    assert weeks[-3][-1]["minutes"] < max(longs)
    assert weeks[-1][0]["discipline"] == "walk"
    assert name.startswith("10 km on")


def test_race_plan_refuses_what_it_cant_do_safely():
    today = MON
    with pytest.raises(RacePlanError, match="at least 12 weeks"):
        build_race_plan("marathon", today + timedelta(weeks=6), today, 0, 4)
    with pytest.raises(RacePlanError, match="future"):
        build_race_plan("5k", today, today, 0, 3)
    # A race a year away starts later rather than stretching thin.
    first, weeks, _ = build_race_plan("half", today + timedelta(weeks=50), today, 0, 4)
    assert first > today and len(weeks) == 26


# --- training blocks --------------------------------------------------------------------


def test_block_weeks_step_reps_in_reserve_down_then_deload():
    b = TrainingBlock(starts_on=MON, weeks=5, rir_start=3, rir_end=1, ended_at=None)
    seen = [block_week(b, MON + timedelta(weeks=i, days=2)) for i in range(5)]
    assert [s["rir"] for s in seen] == [3, 2, 2, 1, 4]  # rounded steps, then lighter
    assert [s["deload"] for s in seen] == [False] * 4 + [True]
    assert block_week(b, MON - timedelta(days=1)) is None
    assert block_week(b, MON + timedelta(weeks=5)) is None


# --- heart rate --------------------------------------------------------------------------

HR_GPX = b"""<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1"
 xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
<trk><name>HR run</name><type>running</type><trkseg>
<trkpt lat="51.5000" lon="-0.1000"><time>2026-09-01T07:00:00Z</time>
<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
<trkpt lat="51.5010" lon="-0.1000"><time>2026-09-01T07:00:20Z</time>
<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>150</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
<trkpt lat="51.5020" lon="-0.1000"><time>2026-09-01T07:00:40Z</time>
<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>170</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
</trkseg></trk></gpx>"""


def test_gpx_heart_rate_and_zones():
    session = parse_gpx(HR_GPX).sessions[0]
    assert (session.avg_hr, session.max_hr) == (135, 170)
    # With a max of 200: 120 is 60% (zone 2), 150 is 75% (zone 3).
    assert zone_seconds(session.hr_samples, 200) == [0, 20, 20, 0, 0]
    t = datetime(2026, 9, 1, tzinfo=UTC)
    # A gap counts as 30 s at most; impossible readings are ignored.
    assert zone_seconds([(t, 190), (t + timedelta(hours=1), 190)], 200) == [0, 0, 0, 0, 30]
    assert hr_summary([(t, 10), (t, 300)]) == (None, None)


def test_imported_run_carries_heart_rate_zones(client):
    token = person(client, "hr@example.com", "hearty")
    client.patch("/v1/me/profile", json={"max_hr": 200}, headers=bearer(token))
    upload = {"file": ("run.gpx", io.BytesIO(HR_GPX), "application/gpx+xml")}
    assert (
        client.post("/v1/workouts/import", files=upload, headers=bearer(token)).status_code == 200
    )
    w = client.get("/v1/workouts", headers=bearer(token)).json()[0]
    assert (w["avg_hr"], w["max_hr"], w["hr_zones"]) == (135, 170, [0, 20, 20, 0, 0])
    assert client.get("/v1/me", headers=bearer(token)).json()["profile"]["max_hr"] == 200


# --- API ---------------------------------------------------------------------------------


def test_checkin_and_heart_rate_on_a_logged_session(client):
    token = person(client, "checkin@example.com", "checker")
    body = workout(soreness=2, pump=1, avg_hr=140)
    saved = client.put(f"/v1/workouts/{uuid4()}", json=body, headers=bearer(token)).json()
    assert (saved["workout"]["soreness"], saved["workout"]["pump"], saved["workout"]["avg_hr"]) == (
        2,
        1,
        140,
    )
    bad = client.put(f"/v1/workouts/{uuid4()}", json=workout(soreness=9), headers=bearer(token))
    assert bad.status_code == 422


def test_race_plan_endpoint_starts_the_plan(client):
    token = person(client, "racer@example.com", "racer")
    race_day = (datetime.now(UTC) + timedelta(weeks=9)).date().isoformat()
    made = client.post(
        "/v1/plans/race", json={"race": "10k", "race_date": race_day}, headers=bearer(token)
    )
    assert made.status_code == 201, made.text
    active = client.get("/v1/plans/active", headers=bearer(token)).json()
    assert active["id"] == made.json()["id"]
    too_soon = client.post(
        "/v1/plans/race",
        json={"race": "marathon", "race_date": race_day},
        headers=bearer(token),
    )
    assert too_soon.status_code == 422


def test_blocks_readiness_and_reflections(client):
    token = person(client, "blocky@example.com", "blocky")
    assert client.get("/v1/blocks/active", headers=bearer(token)).json() is None
    block = client.post("/v1/blocks", json={"weeks": 4}, headers=bearer(token)).json()
    assert block["now"]["week"] == 1 and block["now"]["rir"] == 3
    assert (
        client.post(
            "/v1/blocks", json={"rir_start": 1, "rir_end": 3}, headers=bearer(token)
        ).status_code
        == 422
    )
    # Starting another ends the first.
    second = client.post("/v1/blocks", json={"when": "next"}, headers=bearer(token)).json()
    assert second["now"] is None
    assert client.get("/v1/blocks/active", headers=bearer(token)).json()["id"] == second["id"]
    client.post(f"/v1/blocks/{second['id']}/end", headers=bearer(token))
    assert client.get("/v1/blocks/active", headers=bearer(token)).json() is None

    today = datetime.now(UTC).date()
    r = client.put(
        f"/v1/readiness/{today.isoformat()}",
        json={"sleep": 2, "energy": 3, "soreness": 4},
        headers=bearer(token),
    )
    assert r.status_code in (200, 422)  # 422 only if the account's day differs from UTC
    old = client.put(
        f"/v1/readiness/{(today - timedelta(days=5)).isoformat()}",
        json={"sleep": 2, "energy": 3, "soreness": 4},
        headers=bearer(token),
    )
    assert old.status_code == 422

    week = (today - timedelta(days=7)).isoformat()
    saved = client.put(
        f"/v1/reflections/{week}", json={"went_well": " Three early starts "}, headers=bearer(token)
    ).json()
    assert saved["went_well"] == "Three early starts"
    assert len(client.get("/v1/reflections", headers=bearer(token)).json()) == 1
    client.put(f"/v1/reflections/{week}", json={}, headers=bearer(token))
    assert client.get("/v1/reflections", headers=bearer(token)).json() == []

    other = person(client, "notblocky@example.com", "notblocky")
    assert client.post(f"/v1/blocks/{block['id']}/end", headers=bearer(other)).status_code == 404

    export = client.get("/v1/me/export?format=json", headers=bearer(token)).json()
    assert len(export["training_blocks"]) == 2 and "readiness" in export and "reflections" in export
    assert json.dumps(export)  # serialisable
