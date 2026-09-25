"""Splits from tracks, supersets on sets, and plans shared as files."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.training import importers
from app.training.importers import km_splits
from tests.conftest import bearer, person

T0 = datetime(2026, 9, 20, 7, 0, tzinfo=UTC)


def test_splits_interpolate_the_crossing_and_keep_the_remainder():
    # Steady 4 m/s sampled every 100 m; 2.5 km in all.
    track = [(d, T0 + timedelta(seconds=d / 4)) for d in range(0, 2501, 100)]
    assert km_splits(track) == [
        {"m": 1000, "sec": 250},
        {"m": 1000, "sec": 250},
        {"m": 500, "sec": 125},
    ]


def test_sparse_samples_still_split_honestly():
    # One sample either side of the 1 km mark: the crossing is interpolated.
    track = [(0, T0), (900, T0 + timedelta(seconds=270)), (1300, T0 + timedelta(seconds=390))]
    assert km_splits(track)[0] == {"m": 1000, "sec": 300}


def test_too_short_to_split():
    assert km_splits([(0, T0), (50, T0 + timedelta(seconds=20))]) == []


def _gpx(km: float, secs_per_km: int) -> bytes:
    # Points due north: 0.001 degrees of latitude is about 111.2 m.
    n = int(km * 1000 / 111.2) + 1
    points = []
    for i in range(n):
        when = T0 + timedelta(seconds=i * 111.2 * secs_per_km / 1000)
        points.append(
            f'<trkpt lat="{51 + i * 0.001:.6f}" lon="0"><time>{when.isoformat()}</time></trkpt>'
        )
    return (
        '<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">'
        f"<trk><type>running</type><trkseg>{''.join(points)}</trkseg></trk></gpx>"
    ).encode()


def test_gpx_import_carries_splits(client):
    token = person(client, "splits@example.com", "splitter")
    up = client.post(
        "/v1/workouts/import",
        files={"file": ("run.gpx", _gpx(3.2, 300), "application/gpx+xml")},
        headers=bearer(token),
    )
    assert up.status_code == 200, up.text
    workout = client.get("/v1/workouts", headers=bearer(token)).json()[0]
    whole = [s for s in workout["splits"] if s["m"] == 1000]
    assert len(whole) == 3
    assert all(abs(s["sec"] - 300) <= 2 for s in whole)
    # Parsed directly too.
    assert importers.parse_gpx(_gpx(1.5, 360)).sessions[0].splits[0]["m"] == 1000


def test_supersets_and_splits_survive_a_client_edit(client):
    token = person(client, "superset@example.com", "supersetter")
    wid = str(uuid4())
    now = datetime.now(UTC)
    body = {
        "discipline": "strength",
        "started_at": (now - timedelta(hours=1)).isoformat(),
        "client_updated_at": now.isoformat(),
        "sets": [
            {
                "exercise_id": "bench-press",
                "position": 0,
                "set_index": 0,
                "weight_kg": 60,
                "reps": 8,
                "superset": 1,
            },
            {
                "exercise_id": "barbell-row",
                "position": 1,
                "set_index": 0,
                "weight_kg": 50,
                "reps": 8,
                "superset": 1,
            },
            {"exercise_id": "plank", "position": 2, "set_index": 0, "duration_sec": 45},
        ],
        "splits": [{"m": 1000, "sec": 300}],
    }
    saved = client.put(f"/v1/workouts/{wid}", json=body, headers=bearer(token)).json()["workout"]
    assert [s["superset"] for s in saved["sets"]] == [1, 1, None]
    assert saved["splits"] == [{"m": 1000, "sec": 300}]
    bad = body | {
        "splits": [{"m": 5000, "sec": 1}],
        "client_updated_at": (now + timedelta(seconds=1)).isoformat(),
    }
    assert client.put(f"/v1/workouts/{wid}", json=bad, headers=bearer(token)).status_code == 422


def test_plans_round_trip_as_files(client):
    a = person(client, "share-a@example.com", "sharea")
    b = person(client, "share-b@example.com", "shareb")
    plan = client.post(
        "/v1/plans", json={"template_id": "plan-strength-foundations"}, headers=bearer(a)
    ).json()
    exported = client.get(f"/v1/plans/{plan['id']}/export", headers=bearer(a))
    assert exported.status_code == 200
    data = exported.json()
    assert data["format"] == "pacestreak-plan"
    first = data["weeks"][0][0]
    assert "routine_id" not in first and first["routine"]["name"] == "Full body A"

    imported = client.post("/v1/plans/import", json=data, headers=bearer(b))
    assert imported.status_code == 201, imported.text
    their_routines = {
        r["name"]: r["id"] for r in client.get("/v1/routines", headers=bearer(b)).json()
    }
    assert imported.json()["weeks"][0][0]["routine_id"] == their_routines["Full body A"]
    # Importing again reuses the routine rather than copying it.
    client.post("/v1/plans/import", json=data, headers=bearer(b))
    assert len(client.get("/v1/routines", headers=bearer(b)).json()) == len(their_routines)

    assert (
        client.post(
            "/v1/plans/import", json=data | {"format": "something-else"}, headers=bearer(b)
        ).status_code
        == 422
    )
    # Someone else's plan can't be exported.
    assert client.get(f"/v1/plans/{plan['id']}/export", headers=bearer(b)).status_code == 404
