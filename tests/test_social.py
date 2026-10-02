import asyncio
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

from sqlalchemy import update
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from app.auth.models import User, UserRole
from app.config import get_settings
from tests.conftest import bearer, login, person, register


def log_session(client, token, **extra):
    now = datetime.now(UTC)
    body = {
        "discipline": "run",
        "started_at": (now - timedelta(hours=1)).isoformat(),
        "client_updated_at": now.isoformat(),
        "duration_sec": 1800,
        "distance_m": 5000,
    } | extra
    response = client.put(f"/v1/workouts/{uuid4()}", json=body, headers=bearer(token))
    assert response.status_code == 200, response.text
    return response.json()


def make_role(email: str, role: str) -> None:
    """There is deliberately no API for granting a role to yourself, so tests
    do it the way an operator would: in the database. A throwaway engine,
    because the app's pooled connections belong to the TestClient's loop."""

    async def go():
        throwaway = create_async_engine(get_settings().database_url, poolclass=NullPool)
        async with throwaway.begin() as conn:
            await conn.execute(update(User).where(User.email == email).values(role=UserRole(role)))
        await throwaway.dispose()

    asyncio.run(go())


def test_follow_public_is_immediate_and_feed_shows_sessions(client):
    alice = person(client, "alice@example.com", "alice")
    bob = person(client, "bob@example.com", "bob")
    assert client.post("/v1/people/alice/follow", headers=bearer(bob)).json() == {
        "status": "accepted"
    }
    log_session(client, alice, title="Morning 5k")
    feed = client.get("/v1/feed", headers=bearer(bob)).json()
    kinds = [e["kind"] for e in feed["events"]]
    assert "workout" in kinds
    event = next(e for e in feed["events"] if e["kind"] == "workout")
    assert event["data"]["title"] == "Morning 5k"
    assert event["author"]["handle"] == "alice"
    # Private notes never leave their author.
    assert "notes" not in event["data"]
    # Alice was told.
    inbox = client.get("/v1/notifications", headers=bearer(alice)).json()["items"]
    assert any(n["kind"] == "new_follower" for n in inbox)


def test_followers_only_needs_approval(client):
    carol = person(client, "carol@example.com", "carol", visibility="followers")
    dave = person(client, "dave@example.com", "dave")
    assert client.post("/v1/people/carol/follow", headers=bearer(dave)).json() == {
        "status": "pending"
    }
    log_session(client, carol)
    assert not [
        e
        for e in client.get("/v1/feed", headers=bearer(dave)).json()["events"]
        if e["author"]["handle"] == "carol"
    ]
    profile = client.get("/v1/people/carol", headers=bearer(dave)).json()
    assert profile["visible"] is False and "heatmap" not in profile

    requests = client.get("/v1/me/follow-requests", headers=bearer(carol)).json()
    assert [r["handle"] for r in requests] == ["dave"]
    client.post(f"/v1/me/follow-requests/{requests[0]['request_id']}/accept", headers=bearer(carol))
    assert [
        e
        for e in client.get("/v1/feed", headers=bearer(dave)).json()["events"]
        if e["author"]["handle"] == "carol"
    ]
    assert client.get("/v1/people/carol", headers=bearer(dave)).json()["visible"] is True


def test_private_accounts_cannot_be_followed_or_found(client):
    person(client, "eve@example.com", "eve", visibility="private")
    frank = person(client, "frank@example.com", "frank")
    assert client.post("/v1/people/eve/follow", headers=bearer(frank)).status_code == 404
    assert client.get("/v1/people/search?q=eve", headers=bearer(frank)).json() == []


def test_block_hides_everything_both_ways(client):
    gina = person(client, "gina@example.com", "gina")
    hank = person(client, "hank@example.com", "hank")
    client.post("/v1/people/gina/follow", headers=bearer(hank))
    log_session(client, gina)
    assert client.post("/v1/people/hank/block", headers=bearer(gina)).status_code == 204
    assert client.get("/v1/people/gina", headers=bearer(hank)).status_code == 404
    assert client.get("/v1/feed", headers=bearer(hank)).json()["events"] == [] or all(
        e["author"]["handle"] != "gina"
        for e in client.get("/v1/feed", headers=bearer(hank)).json()["events"]
    )
    assert client.post("/v1/people/gina/follow", headers=bearer(hank)).status_code == 404
    assert client.get("/v1/people/search?q=gin", headers=bearer(hank)).json() == []


def test_pausing_sharing_stops_new_events(client):
    ivy = person(client, "ivy@example.com", "ivy")
    jon = person(client, "jon@example.com", "jon")
    client.post("/v1/people/ivy/follow", headers=bearer(jon))
    client.patch("/v1/me/profile", json={"sharing_paused": True}, headers=bearer(ivy))
    log_session(client, ivy)
    assert [
        e
        for e in client.get("/v1/feed", headers=bearer(jon)).json()["events"]
        if e["author"]["handle"] == "ivy"
    ] == []


def test_kudos_and_comments(client):
    kim = person(client, "kim@example.com", "kim")
    leo = person(client, "leo@example.com", "leo")
    client.post("/v1/people/kim/follow", headers=bearer(leo))
    log_session(client, kim)
    event = next(
        e
        for e in client.get("/v1/feed", headers=bearer(leo)).json()["events"]
        if e["kind"] == "workout"
    )
    assert client.post(f"/v1/events/{event['id']}/kudos", headers=bearer(leo)).json()["kudos"] == 1
    assert client.post(f"/v1/events/{event['id']}/kudos", headers=bearer(leo)).json()["kudos"] == 1

    posted = client.post(
        f"/v1/events/{event['id']}/comments",
        json={"body": "  Strong‮ work\u0000  "},
        headers=bearer(leo),
    )
    assert posted.status_code == 201
    # Bidirectional overrides and control characters are stripped.
    assert posted.json()["body"] == "Strong work"
    comments = client.get(f"/v1/events/{event['id']}/comments", headers=bearer(kim)).json()
    assert comments[0]["can_delete"] is True  # the event owner may remove it
    assert (
        client.post(
            f"/v1/events/{event['id']}/comments", json={"body": "x" * 281}, headers=bearer(leo)
        ).status_code
        == 422
    )


def test_under_sixteen_cannot_use_social(client):
    teen = person(client, "teen2@example.com", "teenager", birth_year=date.today().year - 15)
    person(client, "adult@example.com", "adult")
    assert client.post("/v1/people/adult/follow", headers=bearer(teen)).status_code == 403
    assert client.get("/v1/leaderboards/consistency", headers=bearer(teen)).status_code == 403
    assert (
        client.patch(
            "/v1/me/profile", json={"visibility": "public"}, headers=bearer(teen)
        ).status_code
        == 403
    )


def test_unverified_email_cannot_follow(client):
    person(client, "target@example.com", "target")
    client.post(
        "/v1/auth/signup",
        json={"email": "unverified@example.com", "password": "correct-horse-battery-staple"},
    )
    token = login(client, "unverified@example.com")
    client.post(
        "/v1/me/onboarding",
        json={"handle": "newcomer", "birth_year": 1990, "accept_terms": True},
        headers=bearer(token),
    )
    assert client.post("/v1/people/target/follow", headers=bearer(token)).status_code == 403


def test_report_and_moderation_hide_content_and_suspend(client):
    mona = person(client, "mona@example.com", "mona")
    ned = person(client, "ned@example.com", "ned")
    client.post("/v1/people/mona/follow", headers=bearer(ned))
    log_session(client, mona)
    event = next(
        e
        for e in client.get("/v1/feed", headers=bearer(ned)).json()["events"]
        if e["kind"] == "workout"
    )
    comment = client.post(
        f"/v1/events/{event['id']}/comments", json={"body": "rude words"}, headers=bearer(ned)
    ).json()
    assert (
        client.post(
            "/v1/reports",
            json={"target_type": "comment", "target_id": comment["id"], "reason": "harassment"},
            headers=bearer(mona),
        ).status_code
        == 201
    )

    # Not a moderator: the admin API does not exist as far as they can tell.
    assert client.get("/v1/admin/reports", headers=bearer(mona)).status_code == 404

    register(client, "mod@example.com")
    make_role("mod@example.com", "moderator")
    mod = login(client, "mod@example.com")
    queue = client.get("/v1/admin/reports", headers=bearer(mod)).json()
    assert queue[0]["snapshot"] == {"body": "rude words"}
    resolved = client.post(
        f"/v1/admin/reports/{queue[0]['id']}/resolve",
        json={"action": "hide_and_suspend"},
        headers=bearer(mod),
    )
    assert resolved.status_code == 200
    assert client.get(f"/v1/events/{event['id']}/comments", headers=bearer(mona)).json() == []
    # Suspended: no social, but the training log still works.
    assert client.post("/v1/people/mona/follow", headers=bearer(ned)).status_code == 403
    log_session(client, ned)
    audit = client.get("/v1/admin/audit", headers=bearer(mod)).json()
    assert audit[0]["action"] == "report.hide_and_suspend"
    # Moderators cannot change roles.
    target = client.get("/v1/admin/users?q=ned", headers=bearer(mod)).json()[0]
    assert (
        client.patch(
            f"/v1/admin/users/{target['id']}", json={"role": "admin"}, headers=bearer(mod)
        ).status_code
        == 403
    )


def test_groups_challenges_and_leaderboards(client):
    olga = person(client, "olga@example.com", "olga")
    pete = person(client, "pete@example.com", "pete")
    group = client.post(
        "/v1/groups", json={"name": "Dawn crew", "kind": "coaching"}, headers=bearer(olga)
    ).json()
    assert group["invite_code"]
    assert (
        client.post(
            "/v1/groups/join", json={"code": group["invite_code"]}, headers=bearer(pete)
        ).status_code
        == 200
    )
    detail = client.get(f"/v1/groups/{group['id']}", headers=bearer(pete)).json()
    assert detail["member_count"] == 2
    assert detail["invite_code"] is None  # members do not see the code

    # Coach view shows only members who opted in.
    log_session(client, pete)
    assert (
        client.get(f"/v1/groups/{group['id']}/coach", headers=bearer(olga)).json()["members"] == []
    )
    client.patch(
        f"/v1/groups/{group['id']}/me", json={"shares_with_coach": True}, headers=bearer(pete)
    )
    coach = client.get(f"/v1/groups/{group['id']}/coach", headers=bearer(olga)).json()
    assert [m["handle"] for m in coach["members"]] == ["pete"]
    assert client.get(f"/v1/groups/{group['id']}/coach", headers=bearer(pete)).status_code == 403

    today = date.today()
    challenge = client.post(
        "/v1/challenges",
        json={
            "title": "Ten days",
            "kind": "active_days",
            "target": 10,
            "group_id": group["id"],
            "starts_on": today.isoformat(),
            "ends_on": (today + timedelta(days=13)).isoformat(),
        },
        headers=bearer(olga),
    ).json()
    client.post(f"/v1/challenges/{challenge['id']}/join", headers=bearer(pete))
    board = client.get(f"/v1/challenges/{challenge['id']}", headers=bearer(pete)).json()
    scores = {r["handle"]: r["score"] for r in board["leaderboard"]}
    assert scores == {"pete": 1, "olga": 0}

    # Leaderboards are opt-in globally, automatic within a group.
    assert client.get("/v1/leaderboards/streak", headers=bearer(olga)).json()["rows"] == []
    client.patch("/v1/me/profile", json={"leaderboard_opt_in": True}, headers=bearer(pete))
    rows = client.get("/v1/leaderboards/season_xp", headers=bearer(olga)).json()["rows"]
    assert [r["handle"] for r in rows] == ["pete"]
    grouped = client.get(
        f"/v1/leaderboards/consistency?scope=group&group_id={group['id']}", headers=bearer(olga)
    ).json()
    assert {r["handle"] for r in grouped["rows"]} == {"olga", "pete"}
    assert client.get("/v1/leaderboards/bodyweight", headers=bearer(olga)).status_code == 404


def test_notification_preferences_and_unsubscribe(client):
    token = person(client, "notes@example.com", "noter")
    prefs = client.get("/v1/notifications/preferences", headers=bearer(token)).json()
    security = next(c for c in prefs["categories"] if c["id"] == "security")
    assert security["locked"] and security["email"]
    client.put(
        "/v1/notifications/preferences",
        json={"channels": {"digest": {"email": False}, "security": {"email": False}}},
        headers=bearer(token),
    )
    prefs = client.get("/v1/notifications/preferences", headers=bearer(token)).json()
    by_id = {c["id"]: c for c in prefs["categories"]}
    assert by_id["digest"]["email"] is False
    assert by_id["security"]["email"] is True  # cannot be switched off

    from app.notifications.unsubscribe import sign

    me = client.get("/v1/me", headers=bearer(token)).json()
    uid = me["user"]["id"]
    bad = client.post("/v1/notifications/unsubscribe", json={"u": uid, "c": "social", "s": "nope"})
    assert bad.status_code == 400
    good = client.post(
        "/v1/notifications/unsubscribe", json={"u": uid, "c": "social", "s": sign(uid, "social")}
    )
    assert good.status_code == 200


def test_muting_a_group_keeps_its_notifications_in_the_inbox(client):
    owner = person(client, "own@example.com", "olive")
    joiner = person(client, "join@example.com", "joiner")
    group = client.post("/v1/groups", json={"name": "Quiet"}, headers=bearer(owner)).json()
    muted = client.patch(
        f"/v1/groups/{group['id']}/me", json={"muted": True}, headers=bearer(owner)
    )
    assert muted.json()["muted"] is True
    assert client.get(f"/v1/groups/{group['id']}", headers=bearer(owner)).json()["muted"] is True

    client.post("/v1/groups/join", json={"code": group["invite_code"]}, headers=bearer(joiner))
    inbox = client.get("/v1/notifications", headers=bearer(owner)).json()
    items = inbox["items"] if isinstance(inbox, dict) else inbox
    assert any(n["kind"] == "group_join" for n in items)


def test_reactions_are_presets_one_per_person_and_switchable(client):
    ana = person(client, "ana@example.com", "anaruns")
    ben = person(client, "ben@example.com", "benlifts")
    cy = person(client, "cy@example.com", "cyrides")
    for fan in (ben, cy):
        client.post("/v1/people/anaruns/follow", headers=bearer(fan))
    log_session(client, ana)
    event = next(
        e
        for e in client.get("/v1/feed", headers=bearer(ben)).json()["events"]
        if e["kind"] == "workout"
    )
    url = f"/v1/events/{event['id']}/kudos"
    first = client.post(url, json={"reaction": "fire"}, headers=bearer(ben)).json()
    assert (first["kudos"], first["my_reaction"], first["reactions"]) == (1, "fire", {"fire": 1})
    # Switching replaces it: still one kudos from ben, and no second notice.
    switched = client.post(url, json={"reaction": "strong"}, headers=bearer(ben)).json()
    assert (switched["kudos"], switched["reactions"]) == (1, {"strong": 1})
    client.post(url, headers=bearer(cy))  # no body: plain kudos
    seen = client.get(f"/v1/events/{event['id']}", headers=bearer(ana)).json()
    assert seen["reactions"] == {"strong": 1, "kudos": 1}
    assert seen["my_reaction"] is None
    notices = client.get("/v1/notifications", headers=bearer(ana)).json()
    items = notices["items"] if isinstance(notices, dict) else notices
    assert sum(1 for n in items if n["kind"] == "kudos") == 2
    # Only the presets: free text is refused.
    assert client.post(url, json={"reaction": "lol nice"}, headers=bearer(cy)).status_code == 422
    gone = client.delete(url, headers=bearer(cy)).json()
    assert (gone["kudos"], gone["reactions"], gone["my_reaction"]) == (1, {"strong": 1}, None)
