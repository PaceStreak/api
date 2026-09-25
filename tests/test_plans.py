"""Training plans: the pure week matcher, and the API around it."""

from datetime import UTC, date, datetime, timedelta

from app.training.plans import match_week
from tests.conftest import bearer, person
from tests.test_social import log_session

MON = date(2026, 9, 7)


def _s(day: int, discipline: str = "run") -> dict:
    return {"day": day, "discipline": discipline, "title": "x"}


def test_a_session_on_its_day_is_done():
    out = match_week([_s(0), _s(2)], MON, [(MON, "run")], today=MON + timedelta(days=3))
    assert [(s["status"], s["moved"]) for s in out] == [("done", False), ("skipped", False)]


def test_a_moved_session_still_counts_that_week():
    # Monday's run happened on Tuesday.
    out = match_week(
        [_s(0), _s(4)], MON, [(MON + timedelta(days=1), "run")], today=MON + timedelta(days=2)
    )
    assert out[0]["status"] == "done" and out[0]["moved"] is True
    assert out[1]["status"] == "upcoming"


def test_exact_matches_win_over_moved_ones():
    # Two runs planned (Mon, Wed); runs logged on Wed and Thu. Wed's run is
    # Wed's; Thu's covers Monday's.
    done = [(MON + timedelta(days=2), "run"), (MON + timedelta(days=3), "run")]
    out = match_week([_s(0), _s(2)], MON, done, today=MON + timedelta(days=4))
    assert [(s["status"], s["moved"]) for s in out] == [("done", True), ("done", False)]


def test_the_wrong_kind_of_session_does_not_count():
    out = match_week([_s(0, "strength")], MON, [(MON, "run")], today=MON)
    assert out[0]["status"] == "today"


def test_templates_create_routines_and_start_this_week(client):
    token = person(client, "plan@example.com", "planner")
    templates = client.get("/v1/plans/templates", headers=bearer(token)).json()
    assert {t["id"] for t in templates} >= {"plan-run-from-zero", "plan-strength-foundations"}

    plan = client.post(
        "/v1/plans", json={"template_id": "plan-strength-foundations"}, headers=bearer(token)
    )
    assert plan.status_code == 201, plan.text
    body = plan.json()
    routine_ids = {s["routine_id"] for w in body["weeks"] for s in w}
    routines = {
        r["id"]: r["name"] for r in client.get("/v1/routines", headers=bearer(token)).json()
    }
    assert routine_ids <= set(routines) and set(routines.values()) >= {"Full body A", "Full body B"}

    # Twice from the same template reuses the routines instead of copying them.
    client.post(
        "/v1/plans", json={"template_id": "plan-strength-foundations"}, headers=bearer(token)
    )
    assert len(client.get("/v1/routines", headers=bearer(token)).json()) == len(routines)

    started = client.post(
        f"/v1/plans/{body['id']}/start", json={"when": "this"}, headers=bearer(token)
    )
    assert started.status_code == 200
    assert started.json()["current_week"] == 0
    active = client.get("/v1/plans/active", headers=bearer(token)).json()
    assert active["id"] == body["id"]


def test_one_plan_runs_at_a_time_and_logging_completes_it(client):
    token = person(client, "plan2@example.com", "planner2")
    a = client.post(
        "/v1/plans", json={"template_id": "plan-run-from-zero"}, headers=bearer(token)
    ).json()
    today_idx = datetime.now(UTC).weekday()  # profile week starts Monday, tz UTC
    custom = {
        "name": "Every day",
        "weeks": [[{"day": d, "discipline": "run", "title": "Run"} for d in range(7)]],
    }
    b = client.post("/v1/plans", json={"plan": custom}, headers=bearer(token)).json()
    client.post(f"/v1/plans/{a['id']}/start", json={}, headers=bearer(token))
    client.post(f"/v1/plans/{b['id']}/start", json={}, headers=bearer(token))
    plans = {p["id"]: p for p in client.get("/v1/plans", headers=bearer(token)).json()}
    assert plans[b["id"]]["active"] and not plans[a["id"]]["active"]

    before = client.get("/v1/plans/active", headers=bearer(token)).json()
    assert before["today"][0]["status"] == "today"
    log_session(client, token)
    after = client.get("/v1/plans/active", headers=bearer(token)).json()
    assert after["today"][0]["status"] == "done"
    assert after["progress"]["done"] == 1
    assert after["progress"]["due"] == today_idx + 1


def test_plans_are_private_and_validated(client):
    a = person(client, "plan3@example.com", "planner3")
    b = person(client, "plan4@example.com", "planner4")
    mine = client.post(
        "/v1/plans", json={"template_id": "plan-two-a-week"}, headers=bearer(a)
    ).json()
    assert client.get(f"/v1/plans/{mine['id']}", headers=bearer(b)).status_code == 404
    bad = client.post(
        "/v1/plans",
        json={"plan": {"name": "x", "weeks": [[{"day": 9, "discipline": "run", "title": "x"}]]}},
        headers=bearer(a),
    )
    assert bad.status_code == 422
    # A routine that belongs to someone else can't be referenced.
    their_routine = mine["weeks"][1][1]["routine_id"]
    stolen = client.post(
        "/v1/plans",
        json={
            "plan": {
                "name": "x",
                "weeks": [
                    [
                        {
                            "day": 0,
                            "discipline": "strength",
                            "title": "x",
                            "routine_id": their_routine,
                        }
                    ]
                ],
            }
        },
        headers=bearer(b),
    )
    assert stolen.status_code == 422
