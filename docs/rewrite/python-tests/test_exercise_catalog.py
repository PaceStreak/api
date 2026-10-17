"""The exercise library is data; these keep it consistent as it grows."""

from app.training.library import EQUIPMENT, EXERCISES, LOAD_TYPES, MUSCLES, PATTERNS


def test_ids_and_names_are_unique():
    ids = [e.id for e in EXERCISES]
    names = [e.name.lower() for e in EXERCISES]
    assert len(ids) == len(set(ids))
    assert len(names) == len(set(names))


def test_every_exercise_uses_known_keys():
    for e in EXERCISES:
        assert e.pattern in PATTERNS, e.id
        assert e.equipment in EQUIPMENT, e.id
        assert e.load_type in LOAD_TYPES, e.id
        assert e.primary, e.id
        assert all(m in MUSCLES for m in e.primary + e.secondary), e.id
        assert not set(e.primary) & set(e.secondary), e.id
        assert e.cue, e.id
        assert 30 <= e.rest_sec <= 300, e.id


def test_every_plan_template_starts_and_links_its_routines(client):
    from app.training.plan_templates import PLAN_TEMPLATES
    from tests.conftest import bearer, person

    h = bearer(person(client, "plans@example.com", "allplans"))
    templates = client.get("/v1/plans/templates", headers=h).json()
    listed = {t["id"] for t in templates}
    by_id = {t["id"]: t for t in templates}
    assert by_id["plan-run-from-zero"]["equipment"] == []
    assert by_id["plan-five-by-five"]["equipment"] == ["barbell"]
    assert listed == {t["id"] for t in PLAN_TEMPLATES}
    for template in PLAN_TEMPLATES:
        made = client.post("/v1/plans", json={"template_id": template["id"]}, headers=h)
        assert made.status_code == 201, (template["id"], made.text)
        sessions = [s for w in made.json()["weeks"] for s in w]
        wanted = [s for w in template["weeks"] for s in w if s.get("routine_template")]
        assert sum(1 for s in sessions if s.get("routine_id")) == len(wanted), template["id"]
        assert client.delete(f"/v1/plans/{made.json()['id']}", headers=h).status_code in (200, 204)


def test_every_starter_routine_can_be_added(client):
    from app.training.library import TEMPLATES
    from tests.conftest import bearer, person

    h = bearer(person(client, "routines@example.com", "allroutines"))
    for t in TEMPLATES:
        made = client.post(f"/v1/routines/from-template/{t['id']}", headers=h)
        assert made.status_code in (200, 201), (t["id"], made.text)
