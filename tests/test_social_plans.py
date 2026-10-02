"""Plan challenges, coach-suggested plans, buddy at-risk nudges and group
announcements."""

import asyncio
from datetime import UTC, datetime, timedelta

from sqlalchemy import update

from app import cache
from app.database import AsyncSessionLocal, engine
from app.game.models import UserStats
from app.social.models import BuddyPair
from tests.conftest import bearer, person
from tests.test_social import log_session


def run(fn):
    async def go():
        await engine.dispose()
        cache._pool = None
        try:
            return await fn()
        finally:
            await engine.dispose()
            await cache.close_cache()

    return asyncio.run(go())


def _group(client, owner, kind="crew", name="Crew"):
    return client.post(
        "/v1/groups", json={"name": name, "kind": kind}, headers=bearer(owner)
    ).json()


def test_plan_challenge_gives_everyone_a_copy_and_scores_sessions(client):
    a = person(client, "pc-a@example.com", "pca")
    b = person(client, "pc-b@example.com", "pcb")
    today = datetime.now(UTC).date()
    made = client.post(
        "/v1/challenges",
        json={
            "title": "Run from zero, together",
            "kind": "plan_sessions",
            "plan_template_id": "plan-run-from-zero",
            "starts_on": today.isoformat(),
            "ends_on": today.isoformat(),
        },
        headers=bearer(a),
    )
    assert made.status_code == 201, made.text
    c = made.json()
    # The window is the plan: eight whole weeks.
    assert c["ends_on"] == (today + timedelta(weeks=8) - timedelta(days=1)).isoformat()
    assert c["plan_name"] == "Run from zero" and c["target"] == 24

    joined = client.post("/v1/challenges/join", json={"code": c["invite_code"]}, headers=bearer(b))
    assert joined.status_code == 200, joined.text
    plans = client.get("/v1/plans", headers=bearer(b)).json()
    assert len(plans) == 1 and plans[0]["active"]

    log_session(client, b)
    board = client.get(f"/v1/challenges/{c['id']}", headers=bearer(a)).json()["leaderboard"]
    scores = {r["handle"]: r["score"] for r in board}
    # Any run this week completes one of the week's three plan runs.
    assert scores == {"pca": 0, "pcb": 1}

    # Leaving stops their copy but keeps it.
    client.post(f"/v1/challenges/{c['id']}/leave", headers=bearer(b))
    plans = client.get("/v1/plans", headers=bearer(b)).json()
    assert len(plans) == 1 and not plans[0]["active"]


def test_plan_challenge_needs_a_plan(client):
    a = person(client, "pc-c@example.com", "pcc")
    today = datetime.now(UTC).date().isoformat()
    r = client.post(
        "/v1/challenges",
        json={"title": "No plan", "kind": "plan_sessions", "starts_on": today, "ends_on": today},
        headers=bearer(a),
    )
    assert r.status_code == 422


def test_coach_can_suggest_a_plan_only_with_consent(client):
    coach = person(client, "coach@example.com", "coachy")
    athlete = person(client, "athlete@example.com", "athletey")
    group = _group(client, coach, kind="coaching")
    code = client.get(f"/v1/groups/{group['id']}", headers=bearer(coach)).json()["invite_code"]
    client.post("/v1/groups/join", json={"code": code}, headers=bearer(athlete))
    athlete_id = client.get("/v1/me", headers=bearer(athlete)).json()["user"]["id"]
    url = f"/v1/groups/{group['id']}/members/{athlete_id}/plan"
    body = {"plan_template_id": "plan-5k-to-10k", "note": "Your next block"}

    assert client.post(url, json=body, headers=bearer(coach)).status_code == 403  # no consent yet
    client.patch(
        f"/v1/groups/{group['id']}/me", json={"shares_with_coach": True}, headers=bearer(athlete)
    )
    ok = client.post(url, json=body, headers=bearer(coach))
    assert ok.status_code == 201, ok.text

    plans = client.get("/v1/plans", headers=bearer(athlete)).json()
    assert len(plans) == 1 and not plans[0]["active"]  # the athlete decides when
    inbox = client.get("/v1/notifications", headers=bearer(athlete)).json()
    items = inbox["items"] if isinstance(inbox, dict) else inbox
    assert any(n["kind"] == "plan_assigned" for n in items)

    client.post(f"/v1/plans/{plans[0]['id']}/start", json={}, headers=bearer(athlete))
    roster = client.get(f"/v1/groups/{group['id']}/coach", headers=bearer(coach)).json()["members"]
    assert roster[0]["plan"]["name"] == "5 km to 10 km" and roster[0]["plan"]["from_this_coach"]
    # A member can't assign plans.
    assert (
        client.post(
            f"/v1/groups/{group['id']}/members/{athlete_id}/plan",
            json=body,
            headers=bearer(athlete),
        ).status_code
        == 403
    )


def test_announcements_are_admin_only_and_notify_members(client):
    owner = person(client, "ann-o@example.com", "anno")
    member = person(client, "ann-m@example.com", "annm")
    group = _group(client, owner)
    code = client.get(f"/v1/groups/{group['id']}", headers=bearer(owner)).json()["invite_code"]
    client.post("/v1/groups/join", json={"code": code}, headers=bearer(member))

    url = f"/v1/groups/{group['id']}/announcements"
    assert client.post(url, json={"body": "hi"}, headers=bearer(member)).status_code == 403
    posted = client.post(
        url, json={"body": "Long run Sunday, 8am.", "pinned": True}, headers=bearer(owner)
    )
    assert posted.status_code == 201, posted.text
    listed = client.get(url, headers=bearer(member)).json()
    assert listed[0]["body"] == "Long run Sunday, 8am." and listed[0]["pinned"]
    inbox = client.get("/v1/notifications", headers=bearer(member)).json()
    items = inbox["items"] if isinstance(inbox, dict) else inbox
    assert any(n["kind"] == "group_announcement" for n in items)
    assert client.delete(f"{url}/{posted.json()['id']}", headers=bearer(owner)).status_code == 204


def test_buddy_nudge_fires_once_near_the_end_of_the_week(client, monkeypatch):
    import app.worker as worker

    a = person(client, "bn-a@example.com", "bna", visibility="public")
    b = person(client, "bn-b@example.com", "bnb", visibility="public")
    client.post("/v1/people/bnb/follow", headers=bearer(a))
    pair = client.post("/v1/buddies", json={"handle": "bnb"}, headers=bearer(a)).json()
    client.post(f"/v1/buddies/{pair['id']}/accept", headers=bearer(b))
    log_session(client, b)

    # Pretend: it's 5pm for everyone, and the last day of b's week.
    monkeypatch.setattr(worker, "BUDDY_NUDGE_HOUR", datetime.now(UTC).hour)
    today = datetime.now(UTC).date()
    monkeypatch.setattr(worker, "week_start", lambda day, _starts: today - timedelta(days=6))

    async def short_this_week():
        async with AsyncSessionLocal() as db:
            await db.execute(
                update(UserStats).values(
                    recent_weeks=["kept", "open"], this_week_days=2, this_week_target=3
                )
            )
            await db.execute(update(BuddyPair).values(status="active"))
            await db.commit()

    run(short_this_week)
    first = run(worker.buddy_nudges)
    again = run(worker.buddy_nudges)
    assert len(first) == 2  # both are one short: each hears about the other
    assert again == []


def test_coaching_overview_spans_groups_and_respects_consent(client):
    from tests.test_social import log_session

    coach = person(client, "head@example.com", "headcoach")
    keen = person(client, "keen@example.com", "keenone")
    quiet = person(client, "quiet@example.com", "quietone")
    shy = person(client, "shy@example.com", "shyone")
    groups = [_group(client, coach, kind="coaching", name=n) for n in ("Mornings", "Evenings")]
    for g, members in zip(groups, ((keen, quiet), (keen, shy)), strict=True):
        code = client.get(f"/v1/groups/{g['id']}", headers=bearer(coach)).json()["invite_code"]
        for m in members:
            client.post("/v1/groups/join", json={"code": code}, headers=bearer(m))
            if m is not shy:  # shy never shares
                client.patch(
                    f"/v1/groups/{g['id']}/me", json={"shares_with_coach": True}, headers=bearer(m)
                )
    log_session(client, keen)

    overview = client.get("/v1/coaching", headers=bearer(coach)).json()
    assert [g["name"] for g in overview["groups"]] == ["Evenings", "Mornings"]
    by_handle = {p["handle"]: p for p in overview["people"]}
    assert set(by_handle) == {"keenone", "quietone"}  # no consent, no row
    assert sorted(g["name"] for g in by_handle["keenone"]["groups"]) == ["Evenings", "Mornings"]
    # Nothing logged: flagged, and listed first.
    assert by_handle["quietone"]["attention"] is True
    assert overview["people"][0]["handle"] == "quietone"
    assert by_handle["keenone"]["last_session"] is not None

    # Someone who coaches nobody gets an empty overview, not an error.
    assert client.get("/v1/coaching", headers=bearer(shy)).json() == {"groups": [], "people": []}
