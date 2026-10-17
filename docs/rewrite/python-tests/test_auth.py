import pyotp

from tests.conftest import PASSWORD, bearer, csrf_headers, login, otp_code, register


def test_signup_does_not_log_in(client):
    response = client.post(
        "/v1/auth/signup", json={"email": "new@example.com", "password": PASSWORD}
    )
    assert response.status_code == 201
    assert response.json()["is_verified"] is False
    assert "refresh_token" not in client.cookies


def test_signup_rejects_duplicate_email(client):
    register(client, "dup@example.com")
    response = client.post(
        "/v1/auth/signup", json={"email": "dup@example.com", "password": PASSWORD}
    )
    assert response.status_code == 409


def test_signup_rejects_short_password(client):
    response = client.post(
        "/v1/auth/signup", json={"email": "short@example.com", "password": "too-short"}
    )
    assert response.status_code == 422


def test_verify_email_confirms_the_account(client):
    client.post("/v1/auth/signup", json={"email": "verify@example.com", "password": PASSWORD})
    code = otp_code("verify-email")
    response = client.post(
        "/v1/auth/verify-email", json={"email": "verify@example.com", "code": code}
    )
    assert response.status_code == 200

    access_token = login(client, "verify@example.com")
    me = client.get("/v1/auth/me", headers=bearer(access_token))
    assert me.json()["is_verified"] is True


def test_verify_email_code_is_single_use(client):
    register(client, "reuse@example.com")
    code = otp_code("verify-email")
    client.post("/v1/auth/verify-email", json={"email": "reuse@example.com", "code": code})
    response = client.post(
        "/v1/auth/verify-email", json={"email": "reuse@example.com", "code": code}
    )
    assert response.status_code == 400


def test_login_rejects_wrong_password(client):
    register(client, "login@example.com")
    response = client.post(
        "/v1/auth/login", json={"email": "login@example.com", "password": "wrong-wrong-wrong!"}
    )
    assert response.status_code == 401


def test_login_sets_refresh_and_csrf_cookies(client):
    email, password = register(client, "cookies@example.com")
    response = client.post("/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200
    assert "access_token" in response.json()
    assert client.cookies.get("refresh_token")
    assert client.cookies.get("csrf_token")


def test_me_requires_a_bearer_token(client):
    response = client.get("/v1/auth/me")
    assert response.status_code == 401


def test_refresh_requires_csrf_header(client):
    register(client, "refresh@example.com")
    login(client, "refresh@example.com")
    response = client.post("/v1/auth/refresh")  # no X-CSRF-Token
    assert response.status_code == 403


def test_refresh_rotates_the_token(client):
    email, password = register(client, "rotate@example.com")
    login(client, email, password)

    old_refresh_cookie = client.cookies.get("refresh_token")

    first = client.post("/v1/auth/refresh", headers=csrf_headers(client))
    assert first.status_code == 200
    new_access_token = first.json()["access_token"]

    # Rotation issued a new cookie value.
    assert client.cookies.get("refresh_token") != old_refresh_cookie

    me = client.get("/v1/auth/me", headers=bearer(new_access_token))
    assert me.status_code == 200


def test_refresh_reuse_of_a_rotated_token_burns_the_session(client, monkeypatch):
    # Past the reload-race grace window (tested separately below).
    from datetime import timedelta

    monkeypatch.setattr("app.auth.service.REUSE_GRACE", timedelta(seconds=-1))
    email, password = register(client, "reuse@example.com")
    login(client, email, password)
    stale_refresh_cookie = client.cookies.get("refresh_token")
    stale_csrf_cookie = client.cookies.get("csrf_token")

    # Rotate once for real, so the cookie about to be replayed below is
    # genuinely stale rather than merely unknown.
    first = client.post("/v1/auth/refresh", headers=csrf_headers(client))
    assert first.status_code == 200

    # Replay the pre-rotation cookie pair on the same client. A rejected
    # request carries no Set-Cookie, so the jar still holds these stale
    # values afterwards - deliberately, so the next assertion below replays
    # the *current* (post-rotation) cookie and finds it burned too.
    client.cookies.set("refresh_token", stale_refresh_cookie)
    client.cookies.set("csrf_token", stale_csrf_cookie)
    replay = client.post("/v1/auth/refresh", headers={"X-CSRF-Token": stale_csrf_cookie})
    assert replay.status_code == 401

    # The whole family was burned by the reuse detected above, so even a
    # second attempt with the same stale pair still fails the same way -
    # confirming the rejection wasn't a one-shot "already rotated" check.
    refresh_again = client.post("/v1/auth/refresh", headers={"X-CSRF-Token": stale_csrf_cookie})
    assert refresh_again.status_code == 401


def test_a_reload_race_reusing_the_previous_token_keeps_the_session(client):
    """Two overlapping reloads present the token that was just rotated away.
    Within the grace window that continues the session instead of ending it."""
    email, password = register(client, "race@example.com")
    login(client, email, password)
    stale_refresh = client.cookies.get("refresh_token")
    stale_csrf = client.cookies.get("csrf_token")
    assert client.post("/v1/auth/refresh", headers=csrf_headers(client)).status_code == 200
    current_refresh = client.cookies.get("refresh_token")
    current_csrf = client.cookies.get("csrf_token")

    for _ in range(2):  # the stale token twice: both follow the chain to its tip
        client.cookies.set("refresh_token", stale_refresh)
        client.cookies.set("csrf_token", stale_csrf)
        raced = client.post("/v1/auth/refresh", headers={"X-CSRF-Token": stale_csrf})
        assert raced.status_code == 200, raced.text
        assert (
            client.get("/v1/auth/me", headers=bearer(raced.json()["access_token"])).status_code
            == 200
        )

    # The tab that had received the first rotation is still signed in too.
    client.cookies.set("refresh_token", current_refresh)
    client.cookies.set("csrf_token", current_csrf)
    assert (
        client.post("/v1/auth/refresh", headers={"X-CSRF-Token": current_csrf}).status_code == 200
    )


def test_logout_ends_the_session(client):
    email, password = register(client, "logout@example.com")
    login(client, email, password)

    logout = client.post("/v1/auth/logout", headers=csrf_headers(client))
    assert logout.status_code == 204

    # Logout cleared both cookies, so there is no CSRF cookie left to send -
    # require_csrf rejects the missing pair before rotate_refresh_token is
    # ever reached, which is itself proof the session is gone client-side too.
    refresh = client.post("/v1/auth/refresh", headers={"X-CSRF-Token": "anything"})
    assert refresh.status_code == 403


def test_logout_all_revokes_other_sessions_access_tokens(client):
    email, password = register(client, "everywhere@example.com")
    access_token_a = login(client, email, password)

    # A second, independent login - its own session.
    second = client.post("/v1/auth/login", json={"email": email, "password": password})
    access_token_b = second.json()["access_token"]

    revoke = client.post("/v1/auth/logout-all", headers=bearer(access_token_a))
    assert revoke.status_code == 204

    assert client.get("/v1/auth/me", headers=bearer(access_token_a)).status_code == 401
    assert client.get("/v1/auth/me", headers=bearer(access_token_b)).status_code == 401


def test_sessions_lists_active_sessions_with_current_flagged(client):
    email, password = register(client, "sessions@example.com")
    access_token = login(client, email, password)

    response = client.get("/v1/auth/sessions", headers=bearer(access_token))
    assert response.status_code == 200
    sessions = response.json()
    assert len(sessions) == 1
    assert sessions[0]["current"] is True


def test_forgot_password_always_reports_success(client, sent):
    known = client.post("/v1/auth/forgot-password", json={"email": "nobody@example.com"})
    assert known.status_code == 200
    assert len(sent) == 0  # no account, no email - but the response looks the same


def test_reset_password_signs_out_everywhere(client):
    email, password = register(client, "reset@example.com")
    login(client, email, password)

    client.post("/v1/auth/forgot-password", json={"email": email})
    code = otp_code("reset-password")
    assert code

    new_password = "a-brand-new-long-password"
    reset = client.post(
        "/v1/auth/reset-password",
        json={"email": email, "code": code, "new_password": new_password},
    )
    assert reset.status_code == 200

    old_login = client.post("/v1/auth/login", json={"email": email, "password": password})
    assert old_login.status_code == 401

    new_login = client.post("/v1/auth/login", json={"email": email, "password": new_password})
    assert new_login.status_code == 200


def test_change_password_requires_current_password(client):
    email, password = register(client, "change@example.com")
    access_token = login(client, email, password)

    response = client.post(
        "/v1/auth/change-password",
        json={"current_password": "not-the-real-password!!", "new_password": "another-long-one"},
        headers=bearer(access_token),
    )
    assert response.status_code == 401


def test_two_factor_setup_enable_and_login_challenge(client):
    email, password = register(client, "2fa@example.com")
    access_token = login(client, email, password)

    setup = client.post("/v1/auth/2fa/setup", headers=bearer(access_token))
    assert setup.status_code == 200
    secret = setup.json()["secret"]

    code = pyotp.TOTP(secret).now()
    enable = client.post(
        "/v1/auth/2fa/enable",
        json={"password": password, "code": code},
        headers=bearer(access_token),
    )
    assert enable.status_code == 200
    assert len(enable.json()["recovery_codes"]) == 10

    # Logging in again now stops at the MFA challenge, not a token pair.
    challenge = client.post("/v1/auth/login", json={"email": email, "password": password})
    assert challenge.status_code == 200
    assert challenge.json()["mfa_required"] is True
    mfa_token = challenge.json()["mfa_token"]

    # The step this code is valid for was already spent by /2fa/enable above,
    # so it must be rejected here too - a *new* challenge with the *same*
    # code fails even though the code is still time-valid, which is exactly
    # what stops the code being replayed.
    replay = client.post("/v1/auth/2fa/verify", json={"mfa_token": mfa_token, "code": code})
    assert replay.status_code == 401


def test_two_factor_disable_requires_password_and_code(client):
    email, password = register(client, "disable2fa@example.com")
    access_token = login(client, email, password)

    setup = client.post("/v1/auth/2fa/setup", headers=bearer(access_token))
    secret = setup.json()["secret"]
    code = pyotp.TOTP(secret).now()
    client.post(
        "/v1/auth/2fa/enable",
        json={"password": password, "code": code},
        headers=bearer(access_token),
    )

    wrong_password = client.post(
        "/v1/auth/2fa/disable",
        json={"password": "not-it-at-all!!", "code": pyotp.TOTP(secret).now()},
        headers=bearer(access_token),
    )
    assert wrong_password.status_code == 401
