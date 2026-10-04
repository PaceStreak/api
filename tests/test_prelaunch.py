"""Terms versions, account recovery, changing the address, crash reports and
the abuse view."""

import pyotp

from app.config import get_settings
from tests.conftest import PASSWORD, bearer, login, otp_code, person, register
from tests.test_social import make_role

settings = get_settings()


def test_new_accounts_accept_the_current_terms(client):
    token = person(client, "terms@example.com", "termsy")
    me = client.get("/v1/me", headers=bearer(token)).json()
    assert me["needs_terms"] is False
    assert me["terms_version"] == settings.terms_version


def test_a_new_terms_version_must_be_accepted(client, monkeypatch):
    token = person(client, "terms2@example.com", "termsy2")
    monkeypatch.setattr(settings, "terms_version", "2099-01-01")
    assert client.get("/v1/me", headers=bearer(token)).json()["needs_terms"] is True
    stale = client.post("/v1/me/terms", json={"version": "2026-09-25"}, headers=bearer(token))
    assert stale.status_code == 409
    ok = client.post("/v1/me/terms", json={"version": "2099-01-01"}, headers=bearer(token))
    assert ok.status_code == 200
    assert client.get("/v1/me", headers=bearer(token)).json()["needs_terms"] is False


def _with_2fa(client, email):
    register(client, email)
    token = login(client, email)
    secret = client.post("/v1/auth/2fa/setup", headers=bearer(token)).json()["secret"]
    codes = client.post(
        "/v1/auth/2fa/enable",
        json={"password": PASSWORD, "code": pyotp.TOTP(secret).now()},
        headers=bearer(token),
    ).json()["recovery_codes"]
    return token, codes


def test_recover_with_a_recovery_code(client):
    token, codes = _with_2fa(client, "recover@example.com")
    new_password = "a completely new passphrase"
    wrong = client.post(
        "/v1/auth/recover",
        json={
            "email": "recover@example.com",
            "recovery_code": "nope-nope",
            "new_password": new_password,
        },
    )
    assert wrong.status_code == 401
    ok = client.post(
        "/v1/auth/recover",
        json={
            "email": "recover@example.com",
            "recovery_code": codes[0],
            "new_password": new_password,
        },
    )
    assert ok.status_code == 200, ok.text
    # Every old session is gone, and the code is spent.
    assert client.get("/v1/auth/me", headers=bearer(token)).status_code == 401
    again = client.post(
        "/v1/auth/recover",
        json={
            "email": "recover@example.com",
            "recovery_code": codes[0],
            "new_password": new_password,
        },
    )
    assert again.status_code == 401
    response = client.post(
        "/v1/auth/login", json={"email": "recover@example.com", "password": new_password}
    )
    assert response.status_code == 200


def test_recover_without_two_factor_reveals_nothing(client):
    register(client, "no2fa@example.com")
    r = client.post(
        "/v1/auth/recover",
        json={"email": "no2fa@example.com", "recovery_code": "abcd-efgh", "new_password": "x" * 20},
    )
    ghost = client.post(
        "/v1/auth/recover",
        json={"email": "ghost@example.com", "recovery_code": "abcd-efgh", "new_password": "x" * 20},
    )
    assert r.status_code == ghost.status_code == 401
    assert r.json() == ghost.json()


def test_change_email_waits_for_the_new_address(client, sent):
    email, _ = register(client, "old@example.com")
    token = login(client, email)
    bad = client.post(
        "/v1/auth/change-email",
        json={"password": "wrong-wrong-wrong!", "new_email": "new@example.com"},
        headers=bearer(token),
    )
    assert bad.status_code == 401
    started = client.post(
        "/v1/auth/change-email",
        json={"password": PASSWORD, "new_email": "new@example.com"},
        headers=bearer(token),
    )
    assert started.status_code == 200
    # Still the old address until the code is confirmed.
    assert client.get("/v1/auth/me", headers=bearer(token)).json()["email"] == "old@example.com"
    confirmed = client.post(
        "/v1/auth/confirm-email-change",
        json={"email": "new@example.com", "code": otp_code("confirm-email")},
    )
    assert confirmed.status_code == 200, confirmed.text
    assert (
        client.post(
            "/v1/auth/login", json={"email": "new@example.com", "password": PASSWORD}
        ).status_code
        == 200
    )
    assert any("old@example.com" in m and "was changed" in m for m in sent)


def test_change_email_to_a_taken_address_looks_the_same(client):
    register(client, "taken@example.com")
    email, _ = register(client, "mover@example.com")
    token = login(client, email)
    taken = client.post(
        "/v1/auth/change-email",
        json={"password": PASSWORD, "new_email": "taken@example.com"},
        headers=bearer(token),
    )
    free = client.post(
        "/v1/auth/change-email",
        json={"password": PASSWORD, "new_email": "free@example.com"},
        headers=bearer(token),
    )
    assert taken.status_code == free.status_code == 200


def test_client_errors_group_and_strip_queries(client):
    body = {
        "message": "TypeError: x is undefined",
        "stack": "TypeError: x is undefined\n    at render (index-abc.js:1:200)",
        "url": "https://app.pacestreak.com/reset-password?token=SECRET",
        "release": "0.1.0",
    }
    for _ in range(3):
        assert client.post("/v1/client-errors", json=body).status_code == 202
    register(client, "ops-admin@example.com")
    make_role("ops-admin@example.com", "admin")
    token = login(client, "ops-admin@example.com")
    errors = client.get("/v1/admin/client-errors", headers=bearer(token)).json()
    assert len(errors) == 1 and errors[0]["count"] == 3
    assert errors[0]["path"] == "/reset-password"  # never the token
    assert (
        client.delete(
            f"/v1/admin/client-errors/{errors[0]['id']}", headers=bearer(token)
        ).status_code
        == 204
    )


def test_abuse_view_counts_failures_and_names_only_real_accounts(client):
    register(client, "victim@example.com")
    for _ in range(3):
        client.post(
            "/v1/auth/login", json={"email": "victim@example.com", "password": "wrong-wrong-wrong!"}
        )
    client.post(
        "/v1/auth/login", json={"email": "nobody@example.com", "password": "wrong-wrong-wrong!"}
    )
    register(client, "abuse-admin@example.com")
    make_role("abuse-admin@example.com", "admin")
    token = login(client, "abuse-admin@example.com")
    view = client.get("/v1/admin/abuse", headers=bearer(token)).json()
    assert view["failures"]["login"] == 4
    assert view["by_account"] == [{"account": "victim@example.com", "failures": 3, "ips": 1}]
    assert view["by_ip"][0]["failures"] == 4
    assert sum(s["signups"] for s in view["signups_by_ip"]) >= 2
    # Moderators can't see it (admin-only routes answer 404, not 403).
    register(client, "abuse-mod@example.com")
    make_role("abuse-mod@example.com", "moderator")
    mod = login(client, "abuse-mod@example.com")
    assert client.get("/v1/admin/abuse", headers=bearer(mod)).status_code == 404


def test_crash_reports_are_bounded(client, monkeypatch):
    import app.ops.router as ops

    monkeypatch.setattr(ops, "MAX_GROUPS", 2)
    for i in range(3):
        r = client.post("/v1/client-errors", json={"message": f"Error {i}"})
        assert r.status_code == 202
    assert r.json() == {"received": False}  # a third distinct group is refused
    # ...but a known one still counts.
    assert client.post("/v1/client-errors", json={"message": "Error 0"}).json() == {
        "received": True
    }


def test_two_accounts_asking_for_the_same_new_address(client, sent):
    # pending_email isn't unique; a second pending claim used to 500 the confirm.
    for who in ("first", "second"):
        email, _ = register(client, f"{who}@example.com")
        r = client.post(
            "/v1/auth/change-email",
            json={"password": PASSWORD, "new_email": "wanted@example.com"},
            headers=bearer(login(client, email)),
        )
        assert r.status_code == 200
    confirmed = client.post(
        "/v1/auth/confirm-email-change",
        json={"email": "wanted@example.com", "code": otp_code("confirm-email")},
    )
    assert confirmed.status_code == 200, confirmed.text
    me = client.post("/v1/auth/login", json={"email": "wanted@example.com", "password": PASSWORD})
    assert me.status_code == 200
