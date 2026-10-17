/** Port of tests/test_auth.py, plus the rewrite's own auth checks (round trips, cookies, persisted attempts). */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { totpAt } from "../../src/lib/crypto/totp.ts";
import { Client, loginToken, otpCode, PASSWORD, register, sent, signup } from "../fixtures/auth.ts";
import { useFixedClock } from "../fixtures/clock.ts";
import { uniqueEmail } from "../fixtures/db.ts";
import { expectRoundTrips, jsonOf } from "../fixtures/http.ts";

const bearer = (token: string) => ({ token });

async function enable2fa(client: Client, token: string, password = PASSWORD) {
  const setup = await jsonOf<{ secret: string; provisioning_uri: string }>(
    await client.call("/v1/auth/2fa/setup", { method: "POST", ...bearer(token) }),
  );
  const code = await totpAt(setup.secret, Date.now());
  const enable = await client.call("/v1/auth/2fa/enable", { json: { password, code }, ...bearer(token) });
  expect(enable.status).toBe(200);
  return {
    secret: setup.secret,
    code,
    codes: (await jsonOf<{ recovery_codes: string[] }>(enable)).recovery_codes,
  };
}

describe("test_auth", () => {
  it("signup_does_not_log_in", async () => {
    const client = new Client();
    const res = await client.call("/v1/auth/signup", { json: { email: uniqueEmail(), password: PASSWORD } });
    expect(res.status).toBe(201);
    expect((await jsonOf<{ is_verified: boolean }>(res)).is_verified).toBe(false);
    expect(client.cookies.has("refresh_token")).toBe(false);
  });

  it("signup_rejects_duplicate_email", async () => {
    const client = new Client();
    const email = await register(client);
    const res = await client.call("/v1/auth/signup", {
      json: { email: email.toUpperCase(), password: PASSWORD },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: "Email already registered" });
  });

  it("signup_rejects_short_password", async () => {
    const res = await new Client().call("/v1/auth/signup", {
      json: { email: uniqueEmail(), password: "too-short" },
    });
    expect(res.status).toBe(422);
  });

  it("verify_email_confirms_the_account", async () => {
    const client = new Client();
    const email = uniqueEmail();
    await client.call("/v1/auth/signup", { json: { email, password: PASSWORD } });
    const code = otpCode("verify-email", email);
    expect((await client.call("/v1/auth/verify-email", { json: { email, code } })).status).toBe(200);
    const token = await loginToken(client, email);
    const me = await jsonOf<{ is_verified: boolean }>(await client.call("/v1/auth/me", bearer(token)));
    expect(me.is_verified).toBe(true);
  });

  it("verify_email_code_is_single_use", async () => {
    const client = new Client();
    const email = await register(client);
    const code = otpCode("verify-email", email);
    const again = await client.call("/v1/auth/verify-email", { json: { email, code } });
    expect(again.status).toBe(400);
  });

  it("login_rejects_wrong_password", async () => {
    const client = new Client();
    const email = await register(client);
    const res = await client.call("/v1/auth/login", { json: { email, password: "wrong-wrong-wrong!" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: "Incorrect email or password" });
  });

  it("login_sets_refresh_and_csrf_cookies", async () => {
    const client = new Client();
    const email = await register(client);
    const res = await client.call("/v1/auth/login", { json: { email, password: PASSWORD } });
    expect(res.status).toBe(200);
    expectRoundTrips(res, 2);
    const body = await jsonOf<Record<string, unknown>>(res);
    expect(body).toMatchObject({ token_type: "bearer", expires_in: 900 });
    expect(body.csrf_token).toBe(client.cookies.get("csrf_token"));
    expect(client.cookies.get("refresh_token")).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const [refresh, csrf] = res.headers.getSetCookie();
    expect(refresh).toMatch(
      /^refresh_token=[\w-]{86}; expires=\w{3}, \d\d \w{3} \d{4} \d\d:\d\d:\d\d GMT; HttpOnly; Max-Age=604800; Path=\/v1\/auth; SameSite=lax$/,
    );
    expect(csrf).toMatch(
      /^csrf_token=[\w-]{43}; expires=.+ GMT; Max-Age=604800; Path=\/v1\/auth; SameSite=lax$/,
    );
  });

  it("me_requires_a_bearer_token", async () => {
    const res = await new Client().call("/v1/auth/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: "Invalid authentication credentials" });
  });

  it("refresh_requires_csrf_header", async () => {
    const { client } = await signup();
    const res = await client.call("/v1/auth/refresh", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: "Invalid CSRF token" });
  });

  it("refresh_rotates_the_token", async () => {
    const { client } = await signup();
    const old = client.cookies.get("refresh_token");
    const first = await client.call("/v1/auth/refresh", { method: "POST", headers: client.csrf() });
    expect(first.status).toBe(200);
    expectRoundTrips(first, 2);
    expect(client.cookies.get("refresh_token")).not.toBe(old);
    const token = (await jsonOf<{ access_token: string }>(first)).access_token;
    expect((await client.call("/v1/auth/me", bearer(token))).status).toBe(200);
  });

  it("refresh_reuse_of_a_rotated_token_burns_the_session", async () => {
    const clock = useFixedClock(Date.now());
    const { client, token } = await signup();
    const staleRefresh = client.cookies.get("refresh_token") ?? "";
    const staleCsrf = client.cookies.get("csrf_token") ?? "";
    expect((await client.call("/v1/auth/refresh", { method: "POST", headers: client.csrf() })).status).toBe(
      200,
    );
    clock.advance(31_000); // past the reload-race grace window
    client.cookies.set("refresh_token", staleRefresh);
    client.cookies.set("csrf_token", staleCsrf);
    const replay = await client.call("/v1/auth/refresh", {
      method: "POST",
      headers: { "X-CSRF-Token": staleCsrf },
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({
      detail: "Refresh token has been revoked due to suspicious activity.",
    });
    const again = await client.call("/v1/auth/refresh", {
      method: "POST",
      headers: { "X-CSRF-Token": staleCsrf },
    });
    expect(again.status).toBe(401);
    // Burning the session also kills its access tokens at once.
    expect((await client.call("/v1/auth/me", bearer(token))).status).toBe(401);
  });

  it("a_reload_race_reusing_the_previous_token_keeps_the_session", async () => {
    const { client } = await signup();
    const staleRefresh = client.cookies.get("refresh_token") ?? "";
    const staleCsrf = client.cookies.get("csrf_token") ?? "";
    expect((await client.call("/v1/auth/refresh", { method: "POST", headers: client.csrf() })).status).toBe(
      200,
    );
    const currentRefresh = client.cookies.get("refresh_token") ?? "";
    const currentCsrf = client.cookies.get("csrf_token") ?? "";
    for (let i = 0; i < 2; i++) {
      client.cookies.set("refresh_token", staleRefresh);
      client.cookies.set("csrf_token", staleCsrf);
      const raced = await client.call("/v1/auth/refresh", {
        method: "POST",
        headers: { "X-CSRF-Token": staleCsrf },
      });
      expect(raced.status, await raced.clone().text()).toBe(200);
      const token = (await jsonOf<{ access_token: string }>(raced)).access_token;
      expect((await client.call("/v1/auth/me", bearer(token))).status).toBe(200);
    }
    client.cookies.set("refresh_token", currentRefresh);
    client.cookies.set("csrf_token", currentCsrf);
    const last = await client.call("/v1/auth/refresh", {
      method: "POST",
      headers: { "X-CSRF-Token": currentCsrf },
    });
    expect(last.status).toBe(200);
  });

  it("logout_ends_the_session", async () => {
    const { client, token } = await signup();
    const logout = await client.call("/v1/auth/logout", { method: "POST", headers: client.csrf() });
    expect(logout.status).toBe(204);
    expect(client.cookies.size).toBe(0);
    const refresh = await client.call("/v1/auth/refresh", {
      method: "POST",
      headers: { "X-CSRF-Token": "anything" },
    });
    expect(refresh.status).toBe(403);
    expect((await client.call("/v1/auth/me", bearer(token))).status).toBe(401);
  });

  it("logout_all_revokes_other_sessions_access_tokens", async () => {
    const { client, token: a, email } = await signup();
    const b = await loginToken(new Client(), email);
    expect((await client.call("/v1/auth/logout-all", { method: "POST", ...bearer(a) })).status).toBe(204);
    expect((await client.call("/v1/auth/me", bearer(a))).status).toBe(401);
    expect((await client.call("/v1/auth/me", bearer(b))).status).toBe(401);
  });

  it("sessions_lists_active_sessions_with_current_flagged", async () => {
    const { client, token } = await signup();
    const res = await client.call("/v1/auth/sessions", bearer(token));
    expect(res.status).toBe(200);
    expectRoundTrips(res, 1);
    const sessions = await jsonOf<{ current: boolean; created_at: string }[]>(res);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.current).toBe(true);
  });

  it("forgot_password_always_reports_success", async () => {
    const before = sent.length;
    const res = await new Client().call("/v1/auth/forgot-password", {
      json: { email: uniqueEmail("nobody") },
    });
    expect(res.status).toBe(200);
    expect(sent.length).toBe(before);
  });

  it("reset_password_signs_out_everywhere", async () => {
    const { client, email, token } = await signup();
    await client.call("/v1/auth/forgot-password", { json: { email } });
    const code = otpCode("reset-password", email);
    expect(code).toBeTruthy();
    const newPassword = "a-brand-new-long-password";
    const reset = await client.call("/v1/auth/reset-password", {
      json: { email, code, new_password: newPassword },
    });
    expect(reset.status).toBe(200);
    expect((await client.call("/v1/auth/me", bearer(token))).status).toBe(401);
    expect((await client.call("/v1/auth/login", { json: { email, password: PASSWORD } })).status).toBe(401);
    expect((await client.call("/v1/auth/login", { json: { email, password: newPassword } })).status).toBe(
      200,
    );
  });

  it("change_password_requires_current_password", async () => {
    const { client, token } = await signup();
    const res = await client.call("/v1/auth/change-password", {
      json: { current_password: "not-the-real-password!!", new_password: "another-long-one" },
      ...bearer(token),
    });
    expect(res.status).toBe(401);
  });

  it("two_factor_setup_enable_and_login_challenge", async () => {
    const { client, token, email } = await signup();
    const { code, codes } = await enable2fa(client, token);
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    const challenge = await client.call("/v1/auth/login", { json: { email, password: PASSWORD } });
    expect(challenge.status).toBe(200);
    const body = await jsonOf<{ mfa_required: boolean; mfa_token: string; expires_in: number }>(challenge);
    expect(body.mfa_required).toBe(true);
    expect(body.expires_in).toBe(300);
    const replay = await client.call("/v1/auth/2fa/verify", { json: { mfa_token: body.mfa_token, code } });
    expect(replay.status).toBe(401);
    // A recovery code works once.
    const ok = await client.call("/v1/auth/2fa/verify", {
      json: { mfa_token: body.mfa_token, code: codes[0] },
    });
    expect(ok.status).toBe(200);
    const twice = await client.call("/v1/auth/2fa/verify", {
      json: { mfa_token: body.mfa_token, code: codes[0] },
    });
    expect(twice.status).toBe(401);
  });

  it("two_factor_disable_requires_password_and_code", async () => {
    const { client, token } = await signup();
    const { secret } = await enable2fa(client, token);
    const wrong = await client.call("/v1/auth/2fa/disable", {
      json: { password: "not-it-at-all!!", code: await totpAt(secret, Date.now()) },
      ...bearer(token),
    });
    expect(wrong.status).toBe(401);
  });
});

describe("auth (rewrite)", () => {
  it("changed: email code attempts are saved, so the fifth miss locks the code (test_verify_email_code_is_single_use)", async () => {
    const client = new Client();
    const email = uniqueEmail();
    await client.call("/v1/auth/signup", { json: { email, password: PASSWORD } });
    const code = otpCode("verify-email", email) ?? "";
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      expect((await client.call("/v1/auth/verify-email", { json: { email, code: wrong } })).status).toBe(400);
    }
    expect((await client.call("/v1/auth/verify-email", { json: { email, code } })).status).toBe(400);
  });

  it("logout clears both cookies with Secure-compatible attributes", async () => {
    const { client } = await signup();
    const res = await client.call("/v1/auth/logout", { method: "POST", headers: client.csrf() });
    expect(res.headers.getSetCookie()).toEqual([
      'refresh_token=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Max-Age=0; Path=/v1/auth; SameSite=lax',
      'csrf_token=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/v1/auth; SameSite=lax',
    ]);
  });

  it("change-password signs other sessions out and keeps this one", async () => {
    const { client, token, email } = await signup();
    const other = await loginToken(new Client(), email);
    const res = await client.call("/v1/auth/change-password", {
      json: { current_password: PASSWORD, new_password: "another-long-password" },
      ...bearer(token),
    });
    expect(res.status).toBe(200);
    expectRoundTrips(res, 2);
    const fresh = (await jsonOf<{ access_token: string }>(res)).access_token;
    expect((await client.call("/v1/auth/me", bearer(fresh))).status).toBe(200);
    expect((await client.call("/v1/auth/me", bearer(other))).status).toBe(401);
    expect((await client.call("/v1/auth/me", bearer(token))).status).toBe(401);
  });

  it("revoking a session by id ends it; someone else's is 404", async () => {
    const a = await signup();
    const b = await signup();
    const list = await jsonOf<{ id: string }[]>(await a.client.call("/v1/auth/sessions", bearer(a.token)));
    const id = list[0]?.id ?? "";
    expect(
      (await b.client.call(`/v1/auth/sessions/${id}`, { method: "DELETE", ...bearer(b.token) })).status,
    ).toBe(404);
    const own = await a.client.call(`/v1/auth/sessions/${id}`, { method: "DELETE", ...bearer(a.token) });
    expect(own.status).toBe(204);
    expect((await a.client.call("/v1/auth/me", bearer(a.token))).status).toBe(401);
    expect(
      (await a.client.call("/v1/auth/sessions/not-a-uuid", { method: "DELETE", ...bearer(b.token) })).status,
    ).toBe(422);
  });

  it("email change: code goes to the new address and confirms it", async () => {
    const { client, token, email } = await signup();
    const next = uniqueEmail("moved");
    const same = await client.call("/v1/auth/change-email", {
      json: { password: PASSWORD, new_email: email },
      ...bearer(token),
    });
    expect(same.status).toBe(422);
    expect(await same.json()).toEqual({ detail: "That's already your address" });
    const req = await client.call("/v1/auth/change-email", {
      json: { password: PASSWORD, new_email: next },
      ...bearer(token),
    });
    expect(await req.json()).toEqual({
      detail: `If ${next} can be used, a confirmation code is on its way there.`,
    });
    const code = otpCode("confirm-email", next);
    const ok = await client.call("/v1/auth/confirm-email-change", { json: { email: next, code } });
    expect(ok.status).toBe(200);
    const me = await jsonOf<{ email: string }>(await client.call("/v1/auth/me", bearer(token)));
    expect(me.email).toBe(next);
  });

  it("2fa status, recovery-code regeneration and disable", async () => {
    const { client, token } = await signup();
    const clock = useFixedClock(Date.now());
    const { secret } = await enable2fa(client, token);
    clock.advance(30_000);
    const regen = await client.call("/v1/auth/2fa/recovery-codes", {
      json: { code: await totpAt(secret, clock.now()) },
      ...bearer(token),
    });
    expect(regen.status).toBe(200);
    const status = await jsonOf<{ enabled: boolean; recovery_codes_remaining: number }>(
      await client.call("/v1/auth/2fa", bearer(token)),
    );
    expect(status).toMatchObject({ enabled: true, recovery_codes_remaining: 10 });
    clock.advance(30_000);
    const off = await client.call("/v1/auth/2fa/disable", {
      json: { password: PASSWORD, code: await totpAt(secret, clock.now()) },
      ...bearer(token),
    });
    expect(await off.json()).toEqual({ detail: "Two-factor authentication disabled" });
  });

  it("recover with a recovery code resets the password", async () => {
    const { client, token, email } = await signup();
    const { codes } = await enable2fa(client, token);
    const bad = await client.call("/v1/auth/recover", {
      json: { email, recovery_code: "AAAAA-AAAAA", new_password: "recovered-long-password" },
    });
    expect(bad.status).toBe(401);
    const ok = await client.call("/v1/auth/recover", {
      json: { email, recovery_code: codes[1], new_password: "recovered-long-password" },
    });
    expect(ok.status).toBe(200);
    expect((await client.call("/v1/auth/me", bearer(token))).status).toBe(401);
    const failures = await env.DB.prepare(
      "SELECT count(*) AS n FROM auth_failures WHERE kind = 'recover'",
    ).first<{ n: number }>();
    expect(failures?.n).toBeGreaterThan(0);
  });

  it("per-IP limit on login answers slowapi's 429", async () => {
    const client = new Client();
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await client.call("/v1/auth/login", { json: { email: uniqueEmail(), password: PASSWORD } });
    }
    expect(last?.status).toBe(429);
    expect(await last?.json()).toEqual({ error: "Rate limit exceeded: 10 per 1 minute" });
  });
});
