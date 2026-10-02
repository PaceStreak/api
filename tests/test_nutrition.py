"""Calorie and macro logging, barcode lookup, and the rule-based daily coach."""

import io
import zipfile
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from app.nutrition import lookup
from app.nutrition.lookup import parse_product
from tests.conftest import bearer, person


def _today() -> str:
    return datetime.now(UTC).date().isoformat()


def test_meals_round_trip_with_totals_and_target(client):
    h = bearer(person(client, "eat@example.com", "eater"))
    day = _today()
    assert (
        client.put("/v1/nutrition/target", json={"kcal": 2400, "protein_g": 160}, headers=h).json()[
            "kcal"
        ]
        == 2400
    )
    oats = client.post(
        "/v1/nutrition/foods",
        json={"name": "Oats", "serving_label": "40 g", "kcal": 150, "protein_g": 5, "carbs_g": 27},
        headers=h,
    ).json()
    eid = uuid4()
    body = {"date": day, "meal": "breakfast", "food_id": oats["id"], "servings": 2}
    # A retried save with the same client id updates rather than duplicates.
    for _ in range(2):
        assert client.put(f"/v1/nutrition/entries/{eid}", json=body, headers=h).status_code == 200
    typed = {"date": day, "meal": "snack", "name": "Banana", "kcal": 105, "carbs_g": 27}
    assert client.put(f"/v1/nutrition/entries/{uuid4()}", json=typed, headers=h).status_code == 200

    got = client.get(f"/v1/nutrition/days/{day}", headers=h).json()
    assert len(got["entries"]) == 2
    assert got["totals"] == {"kcal": 405, "protein_g": 10, "carbs_g": 81, "fat_g": 0}
    assert got["target"]["protein_g"] == 160
    assert client.get("/v1/nutrition/history", headers=h).json()[0]["kcal"] == 405
    assert client.get("/v1/nutrition/recent", headers=h).json()[0]["name"] in {"Oats", "Banana"}

    # Deleting the saved food keeps the logged numbers.
    assert client.delete(f"/v1/nutrition/foods/{oats['id']}", headers=h).json()["trash_id"]
    assert client.get(f"/v1/nutrition/days/{day}", headers=h).json()["totals"]["kcal"] == 405

    exported = client.get("/v1/me/export?format=json", headers=h).json()
    assert len(exported["meals"]) == 2 and exported["nutrition_target"]["kcal"] == 2400
    csv_zip = zipfile.ZipFile(io.BytesIO(client.get("/v1/me/export?format=csv", headers=h).content))
    assert "Banana" in csv_zip.read("meals.csv").decode()


def test_meals_are_private_and_validated(client):
    h = bearer(person(client, "own@example.com", "owner"))
    other = bearer(person(client, "nosy@example.com", "nosy"))
    day = _today()
    eid = uuid4()
    body = {"date": day, "meal": "lunch", "name": "Soup", "kcal": 300}
    assert client.put(f"/v1/nutrition/entries/{eid}", json=body, headers=h).status_code == 200
    # Someone else can't overwrite it by reusing the id, or see it.
    assert client.put(f"/v1/nutrition/entries/{eid}", json=body, headers=other).status_code == 404
    assert client.get(f"/v1/nutrition/days/{day}", headers=other).json()["entries"] == []
    client.delete(f"/v1/nutrition/entries/{eid}", headers=other)
    assert len(client.get(f"/v1/nutrition/days/{day}", headers=h).json()["entries"]) == 1

    tomorrow = (datetime.now(UTC).date() + timedelta(days=2)).isoformat()
    future = body | {"date": tomorrow}
    assert client.put(f"/v1/nutrition/entries/{uuid4()}", json=future, headers=h).status_code == 422
    nameless = {"date": day, "meal": "lunch", "kcal": 300}
    assert (
        client.put(f"/v1/nutrition/entries/{uuid4()}", json=nameless, headers=h).status_code == 422
    )
    # The target clears when every field is empty.
    client.put("/v1/nutrition/target", json={"kcal": 2000}, headers=h)
    assert client.put("/v1/nutrition/target", json={}, headers=h).json() is None
    assert client.get("/v1/nutrition/target", headers=h).json() is None


def test_copy_yesterdays_breakfast(client):
    h = bearer(person(client, "copy@example.com", "copier"))
    today = datetime.now(UTC).date()
    yesterday = (today - timedelta(days=1)).isoformat()
    for meal in ("breakfast", "dinner"):
        body = {"date": yesterday, "meal": meal, "name": meal, "kcal": 500}
        client.put(f"/v1/nutrition/entries/{uuid4()}", json=body, headers=h)
    copy = {"from_date": yesterday, "to_date": today.isoformat(), "meal": "breakfast"}
    copied = client.post("/v1/nutrition/copy", json=copy, headers=h).json()
    assert [e["meal"] for e in copied] == ["breakfast"]


def test_barcode_prefers_saved_then_lookup(client, monkeypatch):
    h = bearer(person(client, "scan@example.com", "scanner"))
    calls = []

    async def fake_fetch(code):
        calls.append(code)
        return (
            {
                "name": "Skyr",
                "brand": "Arla",
                "serving_label": "100 g",
                "kcal": 63,
                "protein_g": 11,
                "carbs_g": 4,
                "fat_g": 0.2,
            }
            if code == "5701234567890"
            else None
        )

    monkeypatch.setattr("app.nutrition.router.fetch", fake_fetch)
    found = client.get("/v1/nutrition/barcode/5701234567890", headers=h).json()
    assert found["source"] == "openfoodfacts" and found["food"]["kcal"] == 63
    assert client.get("/v1/nutrition/barcode/00000000", headers=h).status_code == 404
    assert client.get("/v1/nutrition/barcode/not-a-code", headers=h).status_code == 422

    # Saving it (with a correction) makes the saved copy win from then on.
    saved = found["food"] | {"kcal": 65}
    assert client.post("/v1/nutrition/foods", json=saved, headers=h).status_code == 201
    assert client.post("/v1/nutrition/foods", json=saved, headers=h).status_code == 409
    again = client.get("/v1/nutrition/barcode/5701234567890", headers=h).json()
    assert again["source"] == "saved" and again["food"]["kcal"] == 65
    assert calls == ["5701234567890", "00000000"]


def test_barcode_lookup_unavailable_is_503(client, monkeypatch):
    h = bearer(person(client, "down@example.com", "downer"))

    async def broken(code):
        raise lookup.LookupUnavailable

    monkeypatch.setattr("app.nutrition.router.fetch", broken)
    assert client.get("/v1/nutrition/barcode/12345678", headers=h).status_code == 503


@pytest.mark.parametrize(
    ("product", "expected"),
    [
        (
            {
                "product_name": "Bar",
                "brands": "Acme, Other",
                "serving_quantity": 40,
                "serving_size": "1 bar (40 g)",
                "nutriments": {
                    "energy-kcal_serving": 180,
                    "proteins_serving": 20,
                    "energy-kcal_100g": 450,
                },
            },
            {
                "name": "Bar",
                "brand": "Acme",
                "serving_label": "1 bar (40 g)",
                "kcal": 180,
                "protein_g": 20,
                "carbs_g": 0,
                "fat_g": 0,
            },
        ),
        (
            {"product_name": "Milk", "nutriments": {"energy-kcal_100g": 64, "fat_100g": 3.6}},
            {
                "name": "Milk",
                "brand": None,
                "serving_label": "100 g",
                "kcal": 64,
                "protein_g": 0,
                "carbs_g": 0,
                "fat_g": 3.6,
            },
        ),
        ({"product_name": "Mystery", "nutriments": {}}, None),
        ({"nutriments": {"energy-kcal_100g": 10}}, None),
    ],
)
def test_parse_open_food_facts_product(product, expected):
    assert parse_product(product) == expected


def test_coach_flags_low_readiness_and_short_protein(client):
    h = bearer(person(client, "coach@example.com", "coached"))
    today = datetime.now(UTC).date()
    # Nothing logged: the coach still answers.
    first = client.get("/v1/coach/today", headers=h).json()
    assert first["notes"]

    client.put(
        f"/v1/readiness/{today.isoformat()}",
        json={"sleep": 1, "energy": 3, "soreness": 2},
        headers=h,
    )
    client.put("/v1/nutrition/target", json={"kcal": 2000, "protein_g": 150}, headers=h)
    yesterday = (today - timedelta(days=1)).isoformat()
    body = {"date": yesterday, "meal": "dinner", "name": "Pasta", "kcal": 1900, "protein_g": 40}
    client.put(f"/v1/nutrition/entries/{uuid4()}", json=body, headers=h)

    kinds = [n["kind"] for n in client.get("/v1/coach/today", headers=h).json()["notes"]]
    assert "go_easy" in kinds and "protein_low" in kinds
    assert len(kinds) <= 4
