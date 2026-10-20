/**
 * EMAIL_ENABLED=0 (production on the Workers Free plan): the same Worker, the same routes, with outgoing email off.
 * The suite's bindings have it on (vitest.config.ts); here every request runs against a copy of `env` with it
 * off, so both states are tested in one run. The email-on side of each rule is at the end of the file.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createCtx } from "../src/ctx.ts";
import { writeBatch } from "../src/db/batch.ts";
import { loadConfig } from "../src/env.ts";
import { totpAt } from "../src/lib/crypto/totp.ts";
import { EMAIL_OFF } from "../src/lib/errors.ts";
import * as notif from "../src/modules/notifications/service.ts";
import { mountRoutes } from "../src/routes.ts";
import { Client, loginToken, PASSWORD, sent, signup as signupOn } from "./fixtures/auth.ts";
import { uniqueEmail } from "./fixtures/db.ts";
import { api, jsonOf, randomIp } from "./fixtures/http.ts";
import { uniqueHandle } from "./fixtures/profile.ts";
import { recordingQueue } from "./jobs/helpers.ts";

const app = createApp(mountRoutes);
const queue = recordingQueue();
// One object for the whole file: config is parsed once per env object.
const offEnv = { ...env, EMAIL_ENABLED: "0", JOBS: queue } as unknown as Env;

interface Opts {
  json?: unknown;
  token?: string;
  method?: string;
}

async function off(path: string, o: Opts = {}): Promise<Response> {
  const headers: Record<string, string> = { "CF-Connecting-IP": randomIp() };
  if (o.json !== undefined) headers["Content-Type"] = "application/json";
  if (o.token !== undefined) headers.Authorization = `Bearer ${o.token}`;
  const exec = createExecutionContext();
  const res = await app.request(
    `https://api.pacestreak.test${path}`,
    {
      method: o.method ?? (o.json === undefined ? "GET" : "POST"),
      headers,
      ...(o.json === undefined ? {} : { body: JSON.stringify(o.json) }),
    },
    offEnv,
    exec,
  );
  await waitOnExecutionContext(exec);
  return res;
}

const mailTo = (email: string) => sent.filter((m) => m.startsWith(`[email:console] to=${email} `));

interface Account {
  email: string;
  token: string;
  userId: string;
  codes: string[];
}

/** Sign up and sign in with email off: no code, no verification step. */
async function account(handle?: string): Promise<Account> {
  const email = uniqueEmail();
  const res = await off("/v1/auth/signup", { json: { email, password: PASSWORD } });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = await jsonOf<{ id: string; is_verified: boolean; recovery_codes: string[] }>(res);
  const login = await off("/v1/auth/login", { json: { email, password: PASSWORD } });
  expect(login.status, await login.clone().text()).toBe(200);
  const { access_token } = await jsonOf<{ access_token: string }>(login);
  if (handle !== undefined) {
    const o = await off("/v1/me/onboarding", {
      token: access_token,
      json: { handle, birth_year: 1990, accept_terms: true, visibility: "public" },
    });
    expect(o.status, await o.clone().text()).toBe(200);
  }
  return { email, token: access_token, userId: body.id, codes: body.recovery_codes };
}

async function refused(res: Response) {
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ detail: EMAIL_OFF });
}

describe("EMAIL_ENABLED=0", () => {
  it("advertises itself before and after sign-in", async () => {
    const pub = await off("/v1/config");
    expect(pub.status).toBe(200);
    expect(await pub.json()).toEqual({ email_enabled: false, push_available: true });
    expect(pub.headers.get("Cache-Control")).toBe("public, max-age=300");
    const a = await account(uniqueHandle("cfg"));
    const me = await jsonOf<{ email_enabled: boolean }>(await off("/v1/me", { token: a.token }));
    expect(me.email_enabled).toBe(false);
  });

  it("signup is usable at once: no code, recovery codes instead, nothing mailed", async () => {
    const a = await account(uniqueHandle("su"));
    expect(a.codes).toHaveLength(10);
    expect(new Set(a.codes).size).toBe(10);
    for (const c of a.codes) expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const me = await jsonOf<{ is_verified: boolean }>(await off("/v1/auth/me", { token: a.token }));
    expect(me.is_verified).toBe(false);
    const status = await jsonOf<{ enabled: boolean; recovery_codes_remaining: number }>(
      await off("/v1/auth/2fa", { token: a.token }),
    );
    expect(status).toMatchObject({ enabled: false, recovery_codes_remaining: 10 });
    expect(mailTo(a.email)).toEqual([]);
  });

  it("does not gate follows or groups behind a confirmed address", async () => {
    const hb = uniqueHandle("fb");
    const a = await account(uniqueHandle("fa"));
    await account(hb);
    const follow = await off(`/v1/people/${hb}/follow`, { token: a.token, json: {} });
    expect(follow.status, await follow.clone().text()).toBeLessThan(300);
    const group = await off("/v1/groups", { token: a.token, json: { name: "Morning crew" } });
    expect(group.status, await group.clone().text()).toBe(201);
  });

  it("refuses every email-code route with 404 Email is turned off, before validation", async () => {
    const a = await account();
    const email = a.email;
    for (const [path, body] of [
      ["/v1/auth/verify-email", { email, code: "123456" }],
      ["/v1/auth/resend-verification", { email }],
      ["/v1/auth/forgot-password", { email }],
      ["/v1/auth/reset-password", { email, code: "123456", new_password: "a-new-password-long-enough" }],
      ["/v1/auth/confirm-email-change", { email, code: "123456" }],
      ["/v1/auth/verify-email", {}],
    ] as const) {
      await refused(await off(path, { json: body }));
    }
    expect(mailTo(email)).toEqual([]);
  });

  it("recovers a non-2FA account with a signup code, once", async () => {
    const a = await account();
    const code = a.codes[0] ?? "";
    const next = "a-brand-new-password-here";
    const ok = await off("/v1/auth/recover", {
      json: { email: a.email, recovery_code: code.toLowerCase(), new_password: next },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const again = await off("/v1/auth/recover", {
      json: { email: a.email, recovery_code: code, new_password: "yet-another-password-here" },
    });
    expect(again.status).toBe(401);
    expect((await off("/v1/auth/login", { json: { email: a.email, password: PASSWORD } })).status).toBe(401);
    const login = await off("/v1/auth/login", { json: { email: a.email, password: next } });
    expect(login.status).toBe(200);
    const wrong = await off("/v1/auth/recover", {
      json: { email: a.email, recovery_code: "AAAAA-AAAAA", new_password: next },
    });
    expect(wrong.status).toBe(401);
    expect(mailTo(a.email)).toEqual([]);
  });

  it("regenerates recovery codes with the password; the old set dies", async () => {
    const a = await account();
    expect(
      (await off("/v1/auth/recovery-codes", { token: a.token, json: { password: "wrong" } })).status,
    ).toBe(401);
    const res = await off("/v1/auth/recovery-codes", { token: a.token, json: { password: PASSWORD } });
    expect(res.status).toBe(200);
    const { recovery_codes } = await jsonOf<{ recovery_codes: string[] }>(res);
    expect(recovery_codes).toHaveLength(10);
    const stale = await off("/v1/auth/recover", {
      json: { email: a.email, recovery_code: a.codes[0], new_password: "a-brand-new-password-here" },
    });
    expect(stale.status).toBe(401);
    const fresh = await off("/v1/auth/recover", {
      json: { email: a.email, recovery_code: recovery_codes[0], new_password: "a-brand-new-password-here" },
    });
    expect(fresh.status).toBe(200);
  });

  it("changes the email directly with the current password, never to a taken address", async () => {
    const a = await account();
    const b = await account();
    const to = uniqueEmail();
    const bad = await off("/v1/auth/change-email", {
      token: a.token,
      json: { password: "nope", new_email: to },
    });
    expect(bad.status).toBe(401);
    const taken = await off("/v1/auth/change-email", {
      token: a.token,
      json: { password: PASSWORD, new_email: b.email },
    });
    expect(taken.status).toBe(409);
    const res = await off("/v1/auth/change-email", {
      token: a.token,
      json: { password: PASSWORD, new_email: to },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ detail: "Your email address is updated.", email: to });
    const me = await jsonOf<{ email: string }>(await off("/v1/auth/me", { token: a.token }));
    expect(me.email).toBe(to);
    // Signs in with the new address; recovery codes still belong to the account.
    expect((await off("/v1/auth/login", { json: { email: to, password: PASSWORD } })).status).toBe(200);
    const inbox = await jsonOf<{ items: { kind: string; category: string }[] }>(
      await off("/v1/notifications", { token: a.token }),
    );
    expect(inbox.items.some((n) => n.kind === "email_changed" && n.category === "security")).toBe(true);
    expect([...mailTo(a.email), ...mailTo(to)]).toEqual([]);
  });

  it("keeps recovery codes when 2FA is turned off; with 2FA on, new codes also need a TOTP code", async () => {
    const a = await account();
    const setup = await jsonOf<{ secret: string }>(
      await off("/v1/auth/2fa/setup", { token: a.token, json: {} }),
    );
    // Three consecutive TOTP steps inside the one-step window: each is fresh for the replay guard.
    const now = Date.now();
    const enable = await off("/v1/auth/2fa/enable", {
      token: a.token,
      json: { password: PASSWORD, code: await totpAt(setup.secret, now - 30_000) },
    });
    expect(enable.status, await enable.clone().text()).toBe(200);
    const noCode = await off("/v1/auth/recovery-codes", { token: a.token, json: { password: PASSWORD } });
    expect(noCode.status).toBe(400);
    const regen = await off("/v1/auth/recovery-codes", {
      token: a.token,
      json: { password: PASSWORD, code: await totpAt(setup.secret, now) },
    });
    expect(regen.status, await regen.clone().text()).toBe(200);
    const disable = await off("/v1/auth/2fa/disable", {
      token: a.token,
      json: { password: PASSWORD, code: await totpAt(setup.secret, now + 30_000) },
    });
    expect(disable.status, await disable.clone().text()).toBe(200);
    const status = await jsonOf<{ enabled: boolean; recovery_codes_remaining: number }>(
      await off("/v1/auth/2fa", { token: a.token }),
    );
    expect(status).toEqual(expect.objectContaining({ enabled: false, recovery_codes_remaining: 10 }));
  });

  it("notification preferences have no email channel, and stored email choices are kept", async () => {
    const a = await account(uniqueHandle("np"));
    const put = await off("/v1/notifications/preferences", {
      token: a.token,
      method: "PUT",
      json: { channels: { digest: { email: true, push: true } } },
    });
    expect(put.status).toBe(200);
    const prefs = await jsonOf<{
      email_available: boolean;
      categories: { id: string; push: boolean; email: boolean }[];
    }>(await off("/v1/notifications/preferences", { token: a.token }));
    expect(prefs.email_available).toBe(false);
    expect(prefs.categories.every((c) => c.email === false)).toBe(true);
    expect(prefs.categories.find((c) => c.id === "digest")?.push).toBe(true);
  });

  it("delivers to the inbox and push but never by email, security notices included", async () => {
    const a = await account(uniqueHandle("dl"));
    const cfg = loadConfig(offEnv);
    if (!cfg.ok) throw new Error(cfg.reasons.join("; "));
    const ctx = createCtx(offEnv, cfg.config, createExecutionContext(), "test");
    const results = await writeBatch(ctx, [
      notif.notify(ctx, { userId: a.userId, kind: "weekly_digest", category: "digest", title: "Your week" }),
      notif.notify(ctx, {
        userId: a.userId,
        kind: "new_sign_in",
        category: "security",
        title: "New sign-in",
      }),
    ]);
    const ids = notif.notifiedIds(...(results as notif.NotifyResult[]));
    expect(ids).toHaveLength(2);
    await notif.deliver(ctx, ids);
    expect(mailTo(a.email)).toEqual([]);
  });

  it("turns the email channel off for every category, locked ones too", () => {
    const stored = { digest: { email: true }, backup: { email: true, push: false } };
    expect(notif.channelsFor(stored, "digest", false)).toEqual({ push: false, email: false });
    expect(notif.channelsFor(stored, "backup", false)).toEqual({ push: false, email: false });
    expect(notif.channelsFor(stored, "security", false)).toEqual({ push: true, email: false });
    expect(notif.channelsFor(stored, "security", true)).toEqual({ push: true, email: true });
    expect(notif.channelsFor(stored, "digest", true)).toEqual({ push: false, email: true });
  });
});

describe("EMAIL_ENABLED=1 is unchanged", () => {
  it("signup mails nothing and returns no recovery codes; /v1/config and /v1/me say so", async () => {
    const email = uniqueEmail();
    const res = await api("/v1/auth/signup", { json: { email, password: PASSWORD } });
    expect(res.status).toBe(201);
    const body = await jsonOf<Record<string, unknown>>(res);
    expect(body).not.toHaveProperty("recovery_codes");
    // The first sign-in's emailed code confirms the address, so signup itself mails nothing.
    expect(mailTo(email)).toEqual([]);
    expect(await (await api("/v1/config")).json()).toEqual({ email_enabled: true, push_available: true });
    const me = await signupOn();
    const prefs = await jsonOf<{ email_available: boolean }>(
      await api("/v1/notifications/preferences", { token: me.token }),
    );
    expect(prefs.email_available).toBe(true);
  });

  it("an unconfirmed address still cannot follow", async () => {
    const hb = uniqueHandle("ob");
    const email = uniqueEmail();
    await api("/v1/auth/signup", { json: { email, password: PASSWORD } });
    const token = await loginToken(new Client(), email);
    // The sign-in's emailed code confirms the address, so the only signed-in unconfirmed account is one whose
    // confirmation lapsed (say, an address that changed while email was off): set that state directly.
    await env.DB.prepare("UPDATE users SET is_verified = 0 WHERE email = ?").bind(email).run();
    await api("/v1/me/onboarding", {
      token,
      json: { handle: uniqueHandle("oa"), birth_year: 1990, accept_terms: true, visibility: "public" },
    });
    const b = await signupOn();
    await api("/v1/me/onboarding", {
      token: b.token,
      json: { handle: hb, birth_year: 1990, accept_terms: true, visibility: "public" },
    });
    const res = await api(`/v1/people/${hb}/follow`, { token, json: {} });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: "Confirm your email address first" });
  });

  it("a non-2FA account without codes cannot recover, and email change still waits for a code", async () => {
    const me = await signupOn();
    const res = await api("/v1/auth/recover", {
      json: { email: me.email, recovery_code: "AAAAA-AAAAA", new_password: "a-brand-new-password-here" },
    });
    expect(res.status).toBe(401);
    const to = uniqueEmail();
    const change = await api("/v1/auth/change-email", {
      token: me.token,
      json: { password: PASSWORD, new_email: to },
    });
    expect(change.status).toBe(200);
    expect(await change.json()).toEqual({
      detail: `If ${to} can be used, a confirmation code is on its way there.`,
    });
    expect(mailTo(to).some((m) => m.includes("Confirm your new"))).toBe(true);
  });
});
