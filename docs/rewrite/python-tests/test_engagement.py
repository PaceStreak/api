"""Quests, PR streaks, wagers, gyms, exercise notes, the weight goal, the
monthly recap and similar-activity boards."""

import io
import json
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

from app.game.quests import (
    BY_ID,
    PER_WEEK,
    WeekFacts,
    compute_pr_streak,
    compute_quests,
    progress_of,
    quests_for,
)
from app.game.streak import FREEZE_CAP, compute_chain
from tests.conftest import bearer, person
from tests.test_training import workout

MON = date(2026, 9, 7)


def fixed(target: int):
    return lambda _week: target


# --- pure engines -------------------------------------------------------------------


def test_a_kept_wager_earns_a_freeze_and_a_lost_one_costs_nothing():
    wk = [MON + timedelta(weeks=i) for i in range(3)]
    kept = [wk[0] + timedelta(days=d) for d in (0, 1, 2, 3)]  # four days, target three
    # Today is early in the next week, which is still open, so nothing spends it.
    today = wk[1] + timedelta(days=1)
    won = compute_chain(kept, today, 0, fixed(3), wagers={wk[0]: 4})
    assert won.wagers_won == [wk[0]] and won.freezes_available == 1

    three = kept[:3]
    lost = compute_chain(three, today, 0, fixed(3), wagers={wk[0]: 4})
    assert lost.wagers_won == [] and lost.freezes_available == 0
    # Losing the wager did not touch the week itself.
    assert lost.weeks[0].status == "kept"

    # Never past the cap.
    many = [wk[0] + timedelta(weeks=i, days=d) for i in range(3) for d in range(4)]
    capped = compute_chain(many, wk[2] + timedelta(days=22), 0, fixed(3), wagers={w: 4 for w in wk})
    assert capped.freezes_available <= FREEZE_CAP


def test_quests_are_the_same_three_for_everyone_and_weigh_ins_need_history():
    week = MON
    picks = quests_for(week, weighs=True)
    assert len(picks) == PER_WEEK == len({q.id for q in picks})
    assert picks == quests_for(week, weighs=True)
    for i in range(20):
        w = week + timedelta(weeks=i)
        assert "morning_weigh" not in {q.id for q in quests_for(w, weighs=False)}
    # Over a stretch of weeks, everything in the pool comes round.
    seen = {q.id for i in range(20) for q in quests_for(week + timedelta(weeks=i), True, True)}
    assert seen == set(BY_ID)


def test_quest_progress_reads_the_week():
    facts = WeekFacts(
        active_days=frozenset({MON + timedelta(days=1)}),
        patterns=frozenset({"push_h", "pull_v", "squat"}),
        rpe_sets=9,
        short_sessions=1,
        waking_weigh_days=4,
    )
    assert progress_of(BY_ID["early_week"], facts, MON) == 1
    assert progress_of(BY_ID["balanced"], facts, MON) == 3
    assert progress_of(BY_ID["rpe"], facts, MON) == 9
    assert progress_of(BY_ID["morning_weigh"], facts, MON) == 4
    late = WeekFacts(active_days=frozenset({MON + timedelta(days=5)}))
    assert progress_of(BY_ID["early_week"], late, MON) == 0


def test_paused_weeks_offer_no_quests():
    out = compute_quests([MON, MON + timedelta(weeks=1)], lambda w: WeekFacts(), None, {MON})
    assert [q.week_start for q in out] == [MON + timedelta(weeks=1)]


def test_pr_streak_counts_blocks_and_the_open_block_never_breaks_it():
    anchor = date(2024, 1, 1)
    block = lambda i, d=0: anchor + timedelta(days=28 * i + d)  # noqa: E731
    # PRs in blocks 10, 11, 12; today early in block 13 with none yet.
    prs = [block(10, 3), block(11, 20), block(12, 1)]
    s = compute_pr_streak(prs, block(13, 2))
    assert (s.current, s.longest, s.this_block_has_pr) == (3, 3, False)
    # Block 13 closes empty: the run is over.
    s = compute_pr_streak(prs, block(14, 0))
    assert s.current == 0 and s.longest == 3


# --- API --------------------------------------------------------------------------


def test_gyms_carry_equipment_and_plates_and_stay_private(client):
    token = person(client, "gym@example.com", "gymrat")
    home = client.post(
        "/v1/gyms",
        json={"name": "Garage", "equipment": ["barbell", "dumbbell"], "plates_kg": [5, 20, 10, 20]},
        headers=bearer(token),
    )
    assert home.status_code == 201
    assert home.json()["is_default"] is True  # the first gym is the default
    assert home.json()["plates_kg"] == [20, 10, 5]
    bad = client.post(
        "/v1/gyms", json={"name": "X", "equipment": ["trampoline"]}, headers=bearer(token)
    )
    assert bad.status_code == 422
    work = client.post(
        "/v1/gyms", json={"name": "Work", "is_default": True}, headers=bearer(token)
    ).json()
    listed = client.get("/v1/gyms", headers=bearer(token)).json()
    assert [(g["name"], g["is_default"]) for g in listed] == [("Work", True), ("Garage", False)]

    wid = uuid4()
    body = workout(gym_id=home.json()["id"])
    saved = client.put(f"/v1/workouts/{wid}", json=body, headers=bearer(token)).json()
    assert saved["workout"]["gym_id"] == home.json()["id"]

    # Someone else's gym id is dropped, not an error.
    other = person(client, "notmygym@example.com", "notmine")
    theirs = client.put(f"/v1/workouts/{uuid4()}", json=body, headers=bearer(other)).json()
    assert theirs["workout"]["gym_id"] is None
    assert client.delete(f"/v1/gyms/{work['id']}", headers=bearer(other)).status_code == 404

    assert client.delete(f"/v1/gyms/{home.json()['id']}", headers=bearer(token)).status_code == 204
    after = client.get("/v1/workouts", headers=bearer(token)).json()
    assert after[0]["gym_id"] is None  # the session survives its gym


def test_exercise_notes_stick_to_the_exercise(client):
    token = person(client, "notes@example.com", "noter")
    put = client.put(
        "/v1/exercise-notes/back-squat",
        json={"note": " Seat 4, narrow grip "},
        headers=bearer(token),
    )
    assert put.json() == {"exercise_id": "back-squat", "note": "Seat 4, narrow grip"}
    assert client.get("/v1/exercise-notes", headers=bearer(token)).json() == {
        "back-squat": "Seat 4, narrow grip"
    }
    assert (
        client.put(
            "/v1/exercise-notes/not-a-lift", json={"note": "x"}, headers=bearer(token)
        ).status_code
        == 404
    )
    client.put("/v1/exercise-notes/back-squat", json={"note": ""}, headers=bearer(token))
    assert client.get("/v1/exercise-notes", headers=bearer(token)).json() == {}


def test_weight_goal_starts_from_the_trend_and_is_private(client):
    token = person(client, "goal@example.com", "goalie")
    goal = {"target_kg": 75, "milestone_kg": 2}
    assert client.put("/v1/weight-goal", json=goal, headers=bearer(token)).status_code == 409
    now = datetime.now(UTC)
    for hours, kg in ((30, 80.0), (2, 81.0)):
        client.put(
            f"/v1/weigh-ins/{uuid4()}",
            json={
                "weighed_at": (now - timedelta(hours=hours)).isoformat(),
                "moment": "waking",
                "weight_kg": kg,
            },
            headers=bearer(token),
        )
    saved = client.put("/v1/weight-goal", json=goal, headers=bearer(token)).json()
    assert saved["start_kg"] == 80.5 and saved["target_kg"] == 75
    assert client.get("/v1/weight-goal", headers=bearer(token)).json()["target_kg"] == 75
    # Nothing about it in stats, XP or the public profile.
    stats = client.get("/v1/me/stats", headers=bearer(token)).text
    assert "target_kg" not in stats
    other = person(client, "peek@example.com", "peeker")
    public = client.get("/v1/people/goalie", headers=bearer(other)).text
    assert "target_kg" not in public and "start_kg" not in public
    assert client.delete("/v1/weight-goal", headers=bearer(token)).status_code == 204
    assert client.get("/v1/weight-goal", headers=bearer(token)).json() is None


def test_wager_rules(client):
    token = person(client, "wager@example.com", "wagerer")
    state = client.get("/v1/me/stats", headers=bearer(token)).json()["wager"]
    this, nxt = state["options"]
    assert this["blocked"] is None and this["days"] == 4  # default target 3, plus one
    made = client.post("/v1/me/wager", json={"week": "this"}, headers=bearer(token))
    assert made.status_code == 201
    assert made.json()["current"]["status"] == "open"
    # One a calendar month.
    second = client.post("/v1/me/wager", json={"week": "next"}, headers=bearer(token))
    same_month = this["week_start"][:7] == nxt["week_start"][:7]
    assert second.status_code == (409 if same_month else 201)
    # Can be taken back until the week's first session...
    week = this["week_start"]
    assert client.delete(f"/v1/me/wager/{week}", headers=bearer(token)).status_code == 204
    # ...and can't be made once the week has started.
    client.put(f"/v1/workouts/{uuid4()}", json=workout(), headers=bearer(token))
    again = client.post("/v1/me/wager", json={"week": "this"}, headers=bearer(token))
    assert again.status_code == 409


def test_stats_carry_quests_and_pr_streak_unless_gamification_is_off(client):
    token = person(client, "quest@example.com", "quester")
    client.put(f"/v1/workouts/{uuid4()}", json=workout(), headers=bearer(token))
    stats = client.get("/v1/me/stats", headers=bearer(token)).json()
    assert len(stats["quests"]["items"]) == 3
    assert {"current", "longest"} <= set(stats["pr_streak"])
    client.patch("/v1/me/profile", json={"gamification_enabled": False}, headers=bearer(token))
    assert client.get("/v1/me/stats", headers=bearer(token)).json()["quests"] is None


def test_favourite_disciplines_round_trip(client):
    token = person(client, "favdisc@example.com", "favdisc")
    assert (
        client.get("/v1/me", headers=bearer(token)).json()["profile"]["favourite_disciplines"] == []
    )
    res = client.patch(
        "/v1/me/profile",
        json={"favourite_disciplines": ["running", "climbing"]},
        headers=bearer(token),
    )
    assert res.status_code == 200
    assert res.json()["profile"]["favourite_disciplines"] == ["running", "climbing"]
    # Persists across requests, not just echoed back.
    assert client.get("/v1/me", headers=bearer(token)).json()["profile"][
        "favourite_disciplines"
    ] == [
        "running",
        "climbing",
    ]


def test_monthly_recap_compares_with_your_own_history(client):
    token = person(client, "month@example.com", "monthly")
    old = (datetime.now(UTC) - timedelta(days=20)).isoformat()
    client.put(
        f"/v1/workouts/{uuid4()}",
        json=workout(started_at=old, client_updated_at=old),
        headers=bearer(token),
    )
    heavier = workout()
    for s in heavier["sets"]:
        s["weight_kg"] = 110
    client.put(f"/v1/workouts/{uuid4()}", json=heavier, headers=bearer(token))
    month = datetime.now(UTC).strftime("%Y-%m")
    recap = client.get(f"/v1/me/recap/month?month={month}", headers=bearer(token))
    assert recap.status_code == 200
    body = recap.json()
    assert body["lifts"][0]["name"] == "Back squat"
    assert "tonnage" not in json.dumps(body) and "volume" not in json.dumps(body)
    assert client.get("/v1/me/recap/month?month=2099-01", headers=bearer(token)).status_code == 422
    assert client.get("/v1/me/recap/month?month=2001-01", headers=bearer(token)).status_code == 404


def test_similar_board_pairs_people_who_train_about_as_often(client):
    a = person(client, "similar-a@example.com", "similara")
    b = person(client, "similar-b@example.com", "similarb")
    for t in (a, b):
        client.patch("/v1/me/profile", json={"leaderboard_opt_in": True}, headers=bearer(t))
    rows = client.get("/v1/leaderboards/streak?scope=similar", headers=bearer(a))
    assert rows.status_code == 200
    handles = {r["handle"] for r in rows.json()["rows"]}
    assert {"similara", "similarb"} <= handles


def test_export_and_import_carry_gyms_notes_goal(client):
    token = person(client, "carry@example.com", "carrier")
    gym = client.post("/v1/gyms", json={"name": "Home"}, headers=bearer(token)).json()
    client.put(f"/v1/workouts/{uuid4()}", json=workout(gym_id=gym["id"]), headers=bearer(token))
    client.put("/v1/exercise-notes/back-squat", json={"note": "Belt on"}, headers=bearer(token))
    data = client.get("/v1/me/export?format=json", headers=bearer(token)).json()
    assert data["gyms"][0]["name"] == "Home"
    assert data["exercise_notes"] == [{"exercise_id": "back-squat", "note": "Belt on"}]
    assert data["workouts"][0]["gym_id"] == gym["id"]

    other = person(client, "carried@example.com", "carried")
    files = {"file": ("e.json", io.BytesIO(json.dumps(data).encode()), "application/json")}
    assert client.post("/v1/me/import", files=files, headers=bearer(other)).status_code == 200
    gyms = client.get("/v1/gyms", headers=bearer(other)).json()
    assert [g["name"] for g in gyms] == ["Home"] and gyms[0]["id"] != gym["id"]
    assert client.get("/v1/workouts", headers=bearer(other)).json()[0]["gym_id"] == gyms[0]["id"]
    assert client.get("/v1/exercise-notes", headers=bearer(other)).json() == {
        "back-squat": "Belt on"
    }
