"""Buddy streaks, group streaks and encouragement."""

from app.game.joint import joint_streak
from tests.conftest import bearer, person
from tests.test_social import log_session

# --- the pure engine ----------------------------------------------------------------


def test_a_pair_keeps_a_week_only_when_both_do():
    r = joint_streak([["kept", "kept", "missed", "open"], ["kept", "kept", "kept", "open"]], 1.0)
    assert [w.status for w in r.weeks] == ["kept", "kept", "missed", "open"]
    assert r.current == 0 and r.longest == 2


def test_freezes_and_repairs_carry_over():
    r = joint_streak([["frozen", "kept"], ["kept", "repaired"]], 1.0)
    assert r.current == 2


def test_a_paused_member_sits_the_week_out():
    # B is injured in week 2: A alone decides it. Both paused in week 3: the
    # week is neutral, and the run carries on through it.
    r = joint_streak(
        [["kept", "kept", "paused", "kept"], ["kept", "paused", "paused", "kept"]], 1.0
    )
    assert [w.status for w in r.weeks] == ["kept", "kept", "paused", "kept"]
    assert r.current == 3


def test_group_threshold():
    members = [["kept", "open"], ["kept", "open"], ["kept", "open"], ["missed", "open"]]
    assert joint_streak(members, 0.75).weeks[0].status == "kept"
    assert joint_streak(members, 1.0).weeks[0].status == "missed"


def test_the_current_week_never_breaks_and_counts_once_kept():
    assert joint_streak([["kept", "open"], ["kept", "open"]], 1.0).current == 1
    assert joint_streak([["kept", "kept"], ["kept", "kept"]], 1.0).current == 2


def test_max_weeks_starts_the_pair_fresh():
    r = joint_streak([["kept"] * 5, ["kept"] * 5], 1.0, max_weeks=2)
    assert len(r.weeks) == 2 and r.current == 2


def test_members_with_shorter_history_are_left_out_of_old_weeks():
    # B only has this week (just joined): the older weeks are A's alone, and
    # this week is still open for B.
    r = joint_streak([["kept", "kept", "kept"], ["open"]], 1.0)
    assert [w.status for w in r.weeks] == ["kept", "kept", "open"]
    assert r.current == 2


# --- the API ------------------------------------------------------------------------


def _follow(client, token, handle):
    r = client.post(f"/v1/people/{handle}/follow", headers=bearer(token))
    assert r.status_code in (200, 201), r.text


def test_buddy_invite_accept_and_progress(client):
    a = person(client, "bud-a@example.com", "buda", visibility="public")
    b = person(client, "bud-b@example.com", "budb", visibility="public")

    # Strangers can't invite each other.
    assert client.post("/v1/buddies", json={"handle": "budb"}, headers=bearer(a)).status_code == 403

    _follow(client, a, "budb")
    invite = client.post("/v1/buddies", json={"handle": "budb"}, headers=bearer(a))
    assert invite.status_code == 201, invite.text
    pair_id = invite.json()["id"]
    assert client.post("/v1/buddies", json={"handle": "budb"}, headers=bearer(a)).status_code == 409
    # Only the invitee can accept.
    assert client.post(f"/v1/buddies/{pair_id}/accept", headers=bearer(a)).status_code == 409

    incoming = client.get("/v1/buddies", headers=bearer(b)).json()
    assert incoming[0]["incoming"] is True
    accepted = client.post(f"/v1/buddies/{pair_id}/accept", headers=bearer(b))
    assert accepted.status_code == 200, accepted.text

    log_session(client, b)
    view = client.get("/v1/buddies", headers=bearer(a)).json()[0]
    assert view["status"] == "active"
    assert view["them"]["days"] == 1
    # Progress only: nothing about sessions, notes or pause reasons.
    assert set(view["them"]) == {"days", "target", "paused"}


def test_blocking_ends_a_pair(client):
    a = person(client, "bud-c@example.com", "budc", visibility="public")
    b = person(client, "bud-d@example.com", "budd", visibility="public")
    _follow(client, b, "budc")
    pair = client.post("/v1/buddies", json={"handle": "budd"}, headers=bearer(a)).json()
    client.post(f"/v1/buddies/{pair['id']}/accept", headers=bearer(b))
    client.post("/v1/people/budc/block", headers=bearer(b))
    assert client.get("/v1/buddies", headers=bearer(a)).json() == []


def test_encouragement_is_preset_and_once_a_day(client):
    a = person(client, "enc-a@example.com", "enca", visibility="public")
    b = person(client, "enc-b@example.com", "encb", visibility="public")
    presets = client.get("/v1/encouragement/presets", headers=bearer(a)).json()
    assert presets and all("text" in p for p in presets)

    # b doesn't follow a yet: a can't message b.
    body = {"preset": presets[0]["id"]}
    assert client.post("/v1/people/encb/encourage", json=body, headers=bearer(a)).status_code == 403
    _follow(client, b, "enca")
    first = client.post("/v1/people/encb/encourage", json=body, headers=bearer(a))
    assert first.status_code == 202 and first.json()["sent"] is True
    again = client.post("/v1/people/encb/encourage", json=body, headers=bearer(a))
    assert again.json()["sent"] is False
    free_text = client.post(
        "/v1/people/encb/encourage", json={"preset": "anything I like"}, headers=bearer(a)
    )
    assert free_text.status_code == 422

    inbox = client.get("/v1/notifications", headers=bearer(b)).json()
    items = inbox["items"] if isinstance(inbox, dict) else inbox
    assert sum(1 for n in items if n["kind"] == "encouragement") == 1


def test_group_streak_is_reported(client):
    a = person(client, "grp-a@example.com", "grpa")
    group = client.post("/v1/groups", json={"name": "Crew"}, headers=bearer(a)).json()
    log_session(client, a)
    detail = client.get(f"/v1/groups/{group['id']}", headers=bearer(a)).json()
    assert detail["streak"]["threshold"] == 75
    assert detail["streak"]["this_week"] == {"kept": 0, "counted": 1}
    bad = client.patch(
        f"/v1/groups/{group['id']}", json={"streak_threshold": 20}, headers=bearer(a)
    )
    assert bad.status_code == 422
    ok = client.patch(
        f"/v1/groups/{group['id']}", json={"streak_threshold": 100}, headers=bearer(a)
    )
    assert ok.status_code == 200
