/**
 * Email codes at sign-in (on by default): the challenge, the code step, resends, recovery codes, trusted devices,
 * TOTP precedence, EMAIL_ENABLED=0 and a mailer that fails. Requests go through the real Worker (`SELF`), except
 * the EMAIL_ENABLED=0 and failing-mailer cases, which run the same app against a copy of `env`.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { emailLoginChallenges, notifications, trustedDevices, users } from "../src/db/schema/index.ts";
import { totpAt } from "../src/lib/crypto/totp.ts";
import { BREVO_URL } from "../src/lib/mailer/brevo.ts";
import { CODE_NOT_SENT } from "../src/modules/auth/service.ts";
import { mountRoutes } from "../src/routes.ts";
import { type Challenge, Client, otpCode, PASSWORD, register, sent } from "./fixtures/auth.ts";
import { useFixedClock } from "./fixtures/clock.ts";
import { testDb, uniqueEmail } from "./fixtures/db.ts";
import { mockFetch } from "./fixtures/fetch.ts";
import { expectRoundTrips, jsonOf, randomIp } from "./fixtures/http.ts";

const { db } = testDb();
const MIN = 60_000;

interface Tokens {
  access_token: string;
  csrf_token: string;
}

const mailsTo = (email: string) =>
  sent.filter((m) => m.startsWith(`[email:console] to=${email} `) && m.includes("sign-in code")).length;

async function password(client: Client, email: string): Promise<Response> {
  return client.call("/v1/auth/login", { json: { email, password: PASSWORD } });
}

async function challenge(client: Client, email: string): Promise<Challenge> {
  const res = await password(client, email);
  expect(res.status, await res.clone().text()).toBe(200);
  const body = await jsonOf<Challenge>(res);
  expect(body.mfa_required).toBe(true);
  return body;
}

const verify = (client: Client, mfa_token: string, code: string | null, trust_device?: boolean) =>
  client.call("/v1/auth/2fa/verify", {
    json: { mfa_token, code, ...(trust_device === undefined ? {} : { trust_device }) },
  });

/** Signs in through the code step and returns the tokens. */
async function signIn(client: Client, email: string, trust = false): Promise<Tokens> {
  const ch = await challenge(client, email);
  const res = await verify(client, ch.mfa_token, otpCode("sign-in", email), trust);
  expect(res.status, await res.clone().text()).toBe(200);
  return jsonOf<Tokens>(res);
}

async function account(): Promise<{ client: Client; email: string }> {
  const client = new Client();
  const email = await register(client);
  return { client, email };
}

const trustedRows = async (email: string) => {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return db
    .select()
    .from(trustedDevices)
    .where(eq(trustedDevices.userId, u?.id ?? ""));
};

describe("email codes at sign-in: the challenge", () => {
  it("a correct password gets a challenge, no cookies, and one code by email", async () => {
    const { client, email } = await account();
    const before = mailsTo(email);
    const res = await password(client, email);
    expect(res.status).toBe(200);
    expectRoundTrips(res, 2);
    expect(res.headers.getSetCookie()).toEqual([]);
    const body = await jsonOf<Record<string, unknown>>(res);
    expect(body).toEqual({
      mfa_required: true,
      mfa_token: expect.any(String),
      expires_in: 1800,
      method: "email",
      resend_in: 60,
    });
    expect(mailsTo(email)).toBe(before + 1);
    expect(client.cookies.has("refresh_token")).toBe(false);
  });

  it("the subject is generic and the code is only in the body", async () => {
    const { client, email } = await account();
    await challenge(client, email);
    const mail = sent.findLast((m) => m.startsWith(`[email:console] to=${email} `)) ?? "";
    const [head = "", ...body] = mail.split("\n");
    const code = otpCode("sign-in", email) ?? "";
    expect(head).toBe(`[email:console] to=${email} subject=Your PaceStreak sign-in code`);
    expect(head).not.toContain(code);
    expect(body.join("\n")).toContain(code);
  });

  it("the right code signs in; it is single use", async () => {
    const { client, email } = await account();
    const ch = await challenge(client, email);
    const code = otpCode("sign-in", email);
    const ok = await verify(client, ch.mfa_token, code);
    expect(ok.status).toBe(200);
    expectRoundTrips(ok, 2);
    const t = await jsonOf<Tokens>(ok);
    expect((await client.call("/v1/auth/me", { token: t.access_token })).status).toBe(200);
    expect(client.cookies.get("refresh_token")).toMatch(/^[\w-]{86}$/);
    // No trust asked for: no trusted-device cookie.
    expect(client.cookies.has("trusted_device")).toBe(false);
    const again = await verify(client, ch.mfa_token, code);
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ detail: "Invalid or expired challenge" });
  });

  it("a wrong code is refused and the attempt is saved", async () => {
    const { client, email } = await account();
    const ch = await challenge(client, email);
    const right = otpCode("sign-in", email);
    const wrong = right === "000000" ? "111111" : "000000";
    const res = await verify(client, ch.mfa_token, wrong);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: "Invalid code" });
    const [row] = await db
      .select()
      .from(emailLoginChallenges)
      .where(eq(emailLoginChallenges.userId, (await trustedOwner(email)) ?? ""));
    expect(row?.attempts).toBe(1);
    expect(row?.usedAt).toBeNull();
    expect((await verify(client, ch.mfa_token, right)).status).toBe(200);
  });

  it("five wrong codes spend the code: the right one no longer works", async () => {
    const { client, email } = await account();
    const ch = await challenge(client, email);
    const right = otpCode("sign-in", email);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await verify(client, ch.mfa_token, wrong)).status).toBe(401);
    const res = await verify(client, ch.mfa_token, right);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: "Too many wrong codes. Ask for a new one, or use a recovery code.",
    });
  });

  it("a code expires after ten minutes", async () => {
    const clock = useFixedClock();
    const { client, email } = await account();
    const ch = await challenge(client, email);
    const code = otpCode("sign-in", email);
    clock.advance(10 * MIN + 1000);
    const res = await verify(client, ch.mfa_token, code);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      detail: "That code has expired. Ask for a new one, or use a recovery code.",
    });
  });

  it("a code only completes the sign-in it was sent for", async () => {
    const { client, email } = await account();
    const first = await challenge(client, email);
    const firstCode = otpCode("sign-in", email) ?? "";
    const second = await challenge(client, email);
    const secondCode = otpCode("sign-in", email) ?? "";
    if (firstCode !== secondCode) {
      expect((await verify(client, second.mfa_token, firstCode)).status).toBe(401);
    }
    expect((await verify(client, first.mfa_token, firstCode)).status).toBe(200);
  });

  it("the mailed code also confirms an unconfirmed address", async () => {
    const client = new Client();
    const email = uniqueEmail();
    expect((await client.call("/v1/auth/signup", { json: { email, password: PASSWORD } })).status).toBe(201);
    const ch = await challenge(client, email);
    expect((await verify(client, ch.mfa_token, otpCode("sign-in", email))).status).toBe(200);
    const [u] = await db.select().from(users).where(eq(users.email, email));
    expect(u?.isVerified).toBe(true);
    expect(u?.verifiedAt).not.toBeNull();
  });

  it("a wrong password still sends nothing", async () => {
    const { client, email } = await account();
    const before = mailsTo(email);
    const res = await client.call("/v1/auth/login", { json: { email, password: "wrong-wrong-wrong!" } });
    expect(res.status).toBe(401);
    expect(mailsTo(email)).toBe(before);
  });
});

async function trustedOwner(email: string): Promise<string | undefined> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return u?.id;
}

describe("email codes at sign-in: resend", () => {
  it("one per minute, with the wait in the answer", async () => {
    const clock = useFixedClock();
    const { client, email } = await account();
    const ch = await challenge(client, email);
    const first = otpCode("sign-in", email);
    const soon = await client.call("/v1/auth/2fa/resend", { json: { mfa_token: ch.mfa_token } });
    expect(soon.status).toBe(429);
    expect(soon.headers.get("Retry-After")).toBe("60");
    expect(await soon.json()).toEqual({ detail: "Wait 60 s before asking for another code.", resend_in: 60 });
    clock.advance(61_000);
    const before = mailsTo(email);
    const ok = await client.call("/v1/auth/2fa/resend", { json: { mfa_token: ch.mfa_token } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toEqual({ detail: "A new code is on its way.", expires_in: 600, resend_in: 60 });
    expect(mailsTo(email)).toBe(before + 1);
    const next = otpCode("sign-in", email);
    if (first !== next) expect((await verify(client, ch.mfa_token, first)).status).toBe(401);
    expect((await verify(client, ch.mfa_token, next)).status).toBe(200);
  });

  it("five per hour per account", async () => {
    const clock = useFixedClock();
    const { client, email } = await account();
    const ch = await challenge(client, email);
    for (let i = 0; i < 5; i++) {
      clock.advance(61_000);
      const r = await client.call("/v1/auth/2fa/resend", { json: { mfa_token: ch.mfa_token } });
      expect(r.status, await r.clone().text()).toBe(200);
    }
    clock.advance(61_000);
    const before = mailsTo(email);
    const sixth = await client.call("/v1/auth/2fa/resend", { json: { mfa_token: ch.mfa_token } });
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ detail: "Slow down - try again in a little while." });
    expect(mailsTo(email)).toBe(before);
    // The last code that did go out still works.
    expect((await verify(client, ch.mfa_token, otpCode("sign-in", email))).status).toBe(200);
  });

  it("a fresh code resets the attempts", async () => {
    const clock = useFixedClock();
    const { client, email } = await account();
    const ch = await challenge(client, email);
    const wrong = otpCode("sign-in", email) === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await verify(client, ch.mfa_token, wrong);
    clock.advance(61_000);
    expect((await client.call("/v1/auth/2fa/resend", { json: { mfa_token: ch.mfa_token } })).status).toBe(
      200,
    );
    expect((await verify(client, ch.mfa_token, otpCode("sign-in", email))).status).toBe(200);
  });

  it("refuses a used or foreign token", async () => {
    const { client, email } = await account();
    const ch = await challenge(client, email);
    await verify(client, ch.mfa_token, otpCode("sign-in", email));
    const used = await client.call("/v1/auth/2fa/resend", { json: { mfa_token: ch.mfa_token } });
    expect(used.status).toBe(401);
    const junk = await client.call("/v1/auth/2fa/resend", { json: { mfa_token: "not-a-token" } });
    expect(junk.status).toBe(401);
  });
});

/** New recovery codes for a signed-in account (password only, no TOTP). */
async function recoveryCodes(client: Client, token: string): Promise<string[]> {
  const res = await client.call("/v1/auth/recovery-codes", { token, json: { password: PASSWORD } });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await jsonOf<{ recovery_codes: string[] }>(res)).recovery_codes;
}

describe("email codes at sign-in: recovery codes", () => {
  it("a recovery code works in place of the email code, once", async () => {
    const { client, email } = await account();
    const t = await signIn(client, email);
    const codes = await recoveryCodes(client, t.access_token);
    const ch = await challenge(new Client(), email);
    const fresh = new Client();
    const ok = await verify(fresh, ch.mfa_token, codes[0] ?? "");
    expect(ok.status, await ok.clone().text()).toBe(200);
    const again = await challenge(fresh, email);
    const twice = await verify(fresh, again.mfa_token, codes[0] ?? "");
    expect(twice.status).toBe(401);
    expect(await twice.json()).toEqual({ detail: "Invalid code" });
  });

  it("still works after the email code ran out of attempts", async () => {
    const { client, email } = await account();
    const t = await signIn(client, email);
    const codes = await recoveryCodes(client, t.access_token);
    const ch = await challenge(client, email);
    const wrong = otpCode("sign-in", email) === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await verify(client, ch.mfa_token, wrong);
    expect((await verify(client, ch.mfa_token, codes[1] ?? "")).status).toBe(200);
  });
});

describe("email codes at sign-in: trusted devices", () => {
  it("trusting the device skips the code on the next sign-in, and no email goes out", async () => {
    const { client, email } = await account();
    await signIn(client, email, true);
    const cookie = client.cookies.get("trusted_device");
    expect(cookie).toMatch(/^[\w-]{43}$/);
    const rows = await trustedRows(email);
    expect(rows).toHaveLength(1);
    // Only a keyed hash is stored, never the token.
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.tokenHash).not.toContain(cookie);
    const before = mailsTo(email);
    const res = await password(client, email);
    expect(res.status).toBe(200);
    expectRoundTrips(res, 2);
    const body = await jsonOf<Record<string, unknown>>(res);
    expect(body.access_token).toEqual(expect.any(String));
    expect(body).not.toHaveProperty("mfa_required");
    expect(mailsTo(email)).toBe(before);
  });

  it("the cookie is HttpOnly, SameSite=Lax, on /v1/auth, for 30 days", async () => {
    const { client, email } = await account();
    const ch = await challenge(client, email);
    const res = await verify(client, ch.mfa_token, otpCode("sign-in", email), true);
    const line = res.headers.getSetCookie().find((c) => c.startsWith("trusted_device="));
    expect(line).toMatch(
      /^trusted_device=[\w-]{43}; expires=.+ GMT; HttpOnly; Max-Age=2592000; Path=\/v1\/auth; SameSite=lax$/,
    );
  });

  it("the cookie is bound to its account", async () => {
    const a = await account();
    await signIn(a.client, a.email, true);
    const b = await account();
    // Same browser, someone else's account: the code is still asked for.
    const other = new Client();
    other.cookies.set("trusted_device", a.client.cookies.get("trusted_device") ?? "");
    const ch = await challenge(other, b.email);
    expect(ch.method).toBe("email");
  });

  it("a forged cookie counts for nothing", async () => {
    const { email } = await account();
    const c = new Client();
    c.cookies.set("trusted_device", "A".repeat(43));
    expect((await challenge(c, email)).method).toBe("email");
  });

  it("expires after 30 days", async () => {
    const clock = useFixedClock();
    const { client, email } = await account();
    await signIn(client, email, true);
    clock.advance(30 * 24 * 60 * MIN + 1000);
    expect((await challenge(client, email)).method).toBe("email");
  });

  it("a password change revokes it", async () => {
    const { client, email } = await account();
    const t = await signIn(client, email, true);
    const res = await client.call("/v1/auth/change-password", {
      token: t.access_token,
      json: { current_password: PASSWORD, new_password: `${PASSWORD}-2` },
    });
    expect(res.status).toBe(200);
    const again = await client.call("/v1/auth/login", { json: { email, password: `${PASSWORD}-2` } });
    expect((await jsonOf<Challenge>(again)).method).toBe("email");
  });

  it("signing out everywhere revokes it", async () => {
    const { client, email } = await account();
    const t = await signIn(client, email, true);
    expect((await client.call("/v1/auth/logout-all", { method: "POST", token: t.access_token })).status).toBe(
      204,
    );
    expect((await challenge(client, email)).method).toBe("email");
  });

  it("a plain sign-out keeps it", async () => {
    const { client, email } = await account();
    const t = await signIn(client, email, true);
    const out = await client.call("/v1/auth/logout", {
      method: "POST",
      headers: { "X-CSRF-Token": t.csrf_token },
    });
    expect(out.status).toBe(204);
    const res = await password(client, email);
    expect(await jsonOf<Record<string, unknown>>(res)).toHaveProperty("access_token");
  });

  it("turning email codes off and on revokes it", async () => {
    const { client, email } = await account();
    const t = await signIn(client, email, true);
    const offRes = await client.call("/v1/auth/2fa/email", {
      token: t.access_token,
      json: { password: PASSWORD, enabled: false },
    });
    expect(offRes.status).toBe(200);
    expect(await trustedRows(email)).toEqual([]);
    expect(
      offRes.headers.getSetCookie().some((c) => c.startsWith("trusted_device=") && c.includes("Max-Age=0")),
    ).toBe(true);
  });

  it("lists and revokes trusted devices", async () => {
    const { client, email } = await account();
    const t = await signIn(client, email, true);
    const other = new Client();
    await signIn(other, email, true);
    const list = await jsonOf<{ id: string; current: boolean; device: string }[]>(
      await client.call("/v1/auth/trusted-devices", { token: t.access_token }),
    );
    expect(list).toHaveLength(2);
    expect(list.filter((d) => d.current)).toHaveLength(1);
    const theirs = list.find((d) => !d.current);
    const gone = await client.call(`/v1/auth/trusted-devices/${theirs?.id}`, {
      method: "DELETE",
      token: t.access_token,
    });
    expect(gone.status).toBe(204);
    expect((await challenge(other, email)).method).toBe("email");
    const missing = await client.call(`/v1/auth/trusted-devices/${theirs?.id}`, {
      method: "DELETE",
      token: t.access_token,
    });
    expect(missing.status).toBe(404);
    const all = await client.call("/v1/auth/trusted-devices", { method: "DELETE", token: t.access_token });
    expect(all.status).toBe(204);
    expect(await trustedRows(email)).toEqual([]);
  });
});

describe("email codes at sign-in: the setting", () => {
  it("is on for new accounts and reported by GET /2fa", async () => {
    const { client, email } = await account();
    const t = await signIn(client, email);
    const status = await jsonOf<Record<string, unknown>>(
      await client.call("/v1/auth/2fa", { token: t.access_token }),
    );
    expect(status).toMatchObject({
      enabled: false,
      email_codes: true,
      email_codes_active: true,
      email_available: true,
    });
  });

  it("turning it off needs the password, then sign-in needs no code", async () => {
    const { client, email } = await account();
    const t = await signIn(client, email);
    const wrong = await client.call("/v1/auth/2fa/email", {
      token: t.access_token,
      json: { password: "not-my-password-at-all", enabled: false },
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ detail: "Password is incorrect" });
    const none = await client.call("/v1/auth/2fa/email", { token: t.access_token, json: { enabled: false } });
    expect(none.status).toBe(422);
    const off = await client.call("/v1/auth/2fa/email", {
      token: t.access_token,
      json: { password: PASSWORD, enabled: false },
    });
    expect(await off.json()).toEqual({ email_enabled: false });
    const before = mailsTo(email);
    const res = await password(new Client(), email);
    expect(await jsonOf<Record<string, unknown>>(res)).toHaveProperty("access_token");
    expect(mailsTo(email)).toBe(before);
    const on = await client.call("/v1/auth/2fa/email", {
      token: t.access_token,
      json: { password: PASSWORD, enabled: true },
    });
    expect(on.status).toBe(200);
    expect((await challenge(new Client(), email)).method).toBe("email");
  });

  it("the new-sign-in notice after a mailed code stays off email", async () => {
    const { client, email } = await account();
    await signIn(client, email);
    const other = new Client();
    const ch = await challenge(other, email);
    const res = await other.call("/v1/auth/2fa/verify", {
      json: { mfa_token: ch.mfa_token, code: otpCode("sign-in", email) },
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0" },
    });
    expect(res.status).toBe(200);
    const uid = (await trustedOwner(email)) ?? "";
    const notes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, uid), eq(notifications.kind, "new_sign_in")));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.data).toEqual({ no_email: true });
  });
});

describe("email codes at sign-in: TOTP wins", () => {
  it("with TOTP on, sign-in asks for TOTP and mails nothing; trust is ignored", async () => {
    const { client, email } = await account();
    const t = await signIn(client, email, true);
    const setup = await jsonOf<{ secret: string }>(
      await client.call("/v1/auth/2fa/setup", { method: "POST", token: t.access_token }),
    );
    const enable = await client.call("/v1/auth/2fa/enable", {
      token: t.access_token,
      json: { password: PASSWORD, code: await totpAt(setup.secret, Date.now()) },
    });
    expect(enable.status).toBe(200);
    // Turning TOTP on ends trust granted under the email rule.
    expect(await trustedRows(email)).toEqual([]);
    const before = mailsTo(email);
    const ch = await challenge(client, email);
    expect(ch.method).toBe("totp");
    expect(ch).not.toHaveProperty("resend_in");
    expect(mailsTo(email)).toBe(before);
    const resend = await client.call("/v1/auth/2fa/resend", { json: { mfa_token: ch.mfa_token } });
    expect(resend.status).toBe(401);
    // An emailed-style six digits that is not the TOTP code fails like any wrong code.
    const wrong = await verify(client, ch.mfa_token, "000000", true);
    expect(wrong.status).toBe(401);
    const status = await jsonOf<Record<string, unknown>>(
      await client.call("/v1/auth/2fa", { token: t.access_token }),
    );
    expect(status).toMatchObject({ enabled: true, email_codes: true, email_codes_active: false });
  });
});

// ---- the same app with other bindings -----------------------------------------------------------------------

const app = createApp(mountRoutes);

class EnvClient {
  readonly cookies = new Map<string, string>();
  readonly ip = randomIp();
  constructor(private readonly bindings: Env) {}

  async call(path: string, json?: unknown, token?: string): Promise<Response> {
    const headers: Record<string, string> = { "CF-Connecting-IP": this.ip };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    if (this.cookies.size > 0) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const exec = createExecutionContext();
    const res = await app.request(
      `https://api.pacestreak.test${path}`,
      {
        method: json === undefined ? "GET" : "POST",
        headers,
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      },
      this.bindings,
      exec,
    );
    await waitOnExecutionContext(exec);
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split("; ");
      const i = pair.indexOf("=");
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  }
}

const offEnv = { ...env, EMAIL_ENABLED: "0" } as unknown as Env;
const failingEnv = { ...env, MAILER: "brevo", BREVO_API_KEY: "xkeysib-not-a-real-key" } as unknown as Env;

describe("email codes at sign-in: EMAIL_ENABLED=0", () => {
  it("nobody is asked for an email code, the setting is ignored and its route is gone", async () => {
    const c = new EnvClient(offEnv);
    const email = uniqueEmail();
    expect((await c.call("/v1/auth/signup", { email, password: PASSWORD })).status).toBe(201);
    const res = await c.call("/v1/auth/login", { email, password: PASSWORD });
    expect(res.status).toBe(200);
    const body = await jsonOf<Record<string, unknown>>(res);
    expect(body).toHaveProperty("access_token");
    expect(body).not.toHaveProperty("mfa_required");
    // The stored choice stays on, for when email comes back.
    const [u] = await db.select().from(users).where(eq(users.email, email));
    expect(u?.email2faEnabled).toBe(true);
    const token = body.access_token as string;
    const status = await jsonOf<Record<string, unknown>>(await c.call("/v1/auth/2fa", undefined, token));
    expect(status).toMatchObject({ email_codes: true, email_codes_active: false, email_available: false });
    const toggle = await c.call("/v1/auth/2fa/email", { password: PASSWORD, enabled: false }, token);
    expect(toggle.status).toBe(404);
    expect(await toggle.json()).toEqual({ detail: "Email is turned off" });
    const resend = await c.call("/v1/auth/2fa/resend", { mfa_token: "x" });
    expect(resend.status).toBe(404);
  });

  it("a challenge started with email on cannot be finished with email off", async () => {
    const { client, email } = await account();
    const ch = await challenge(client, email);
    const c = new EnvClient(offEnv);
    const res = await c.call("/v1/auth/2fa/verify", {
      mfa_token: ch.mfa_token,
      code: otpCode("sign-in", email),
    });
    expect(res.status).toBe(401);
  });
});

describe("email codes at sign-in: the mailer fails", () => {
  it("503 with the challenge, nobody gets in without a code, and a recovery code still works", async () => {
    const { client, email } = await account();
    const t = await signIn(client, email);
    const codes = await recoveryCodes(client, t.access_token);
    const brevo = mockFetch(BREVO_URL, () => new Response("down", { status: 500 }));
    const c = new EnvClient(failingEnv);
    const res = await c.call("/v1/auth/login", { email, password: PASSWORD });
    expect(res.status).toBe(503);
    expect(brevo.calls.length).toBeGreaterThan(0);
    expect(res.headers.getSetCookie()).toEqual([]);
    const body = await jsonOf<Record<string, unknown>>(res);
    expect(body).toMatchObject({
      detail: CODE_NOT_SENT,
      mfa_required: true,
      method: "email",
      email_sent: false,
    });
    expect(body).not.toHaveProperty("access_token");
    expect(CODE_NOT_SENT).toBe("We couldn't send your code. Try again, or use a recovery code.");
    // A guess is still refused, and the resend fails the same way.
    expect((await c.call("/v1/auth/2fa/verify", { mfa_token: body.mfa_token, code: "123456" })).status).toBe(
      401,
    );
    const ok = await c.call("/v1/auth/2fa/verify", { mfa_token: body.mfa_token, code: codes[0] });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await jsonOf<Record<string, unknown>>(ok)).toHaveProperty("access_token");
  });

  it("a failed resend is a 503 too", async () => {
    const clock = useFixedClock();
    const { client, email } = await account();
    const ch = await challenge(client, email);
    mockFetch(BREVO_URL, () => new Response("down", { status: 500 }));
    clock.advance(61_000);
    const c = new EnvClient(failingEnv);
    const res = await c.call("/v1/auth/2fa/resend", { mfa_token: ch.mfa_token });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: CODE_NOT_SENT });
  });
});
