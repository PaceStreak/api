/** Port of tests/test_prelaunch.py: terms versions, recovery, changing the address, crash reports, the abuse view. */
import { count } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clientErrors } from "../../src/db/schema/index.ts";
import { SETTINGS } from "../../src/env.ts";
import { totpAt } from "../../src/lib/crypto/totp.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import { MAX_GROUPS } from "../../src/modules/ops/service.ts";
import { signupAs } from "../fixtures/admin.ts";
import { Client, loginToken, otpCode, PASSWORD, register, sent } from "../fixtures/auth.ts";
import { testDb, uniqueEmail } from "../fixtures/db.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { person } from "../fixtures/profile.ts";

const settings = SETTINGS as { termsVersion: string };

async function with2fa(email: string) {
  const client = new Client();
  await register(client, email);
  const token = await loginToken(client, email);
  const setup = await jsonOf<{ secret: string }>(
    await client.call("/v1/auth/2fa/setup", { method: "POST", token }),
  );
  const enable = await client.call("/v1/auth/2fa/enable", {
    json: { password: PASSWORD, code: await totpAt(setup.secret, Date.now()) },
    token,
  });
  return { client, token, codes: (await jsonOf<{ recovery_codes: string[] }>(enable)).recovery_codes };
}

describe("test_prelaunch", () => {
  it("new_accounts_accept_the_current_terms", async () => {
    const { token } = await person();
    const me = await jsonOf<{ needs_terms: boolean; terms_version: string }>(await api("/v1/me", { token }));
    expect(me.needs_terms).toBe(false);
    expect(me.terms_version).toBe(SETTINGS.termsVersion);
  });

  it("a_new_terms_version_must_be_accepted", async () => {
    const { token } = await person();
    const original = settings.termsVersion;
    settings.termsVersion = "2099-01-01";
    try {
      const me = await jsonOf<{ needs_terms: boolean }>(await api("/v1/me", { token }));
      expect(me.needs_terms).toBe(true);
      const stale = await api("/v1/me/terms", { token, json: { version: "2026-09-25" } });
      expect(stale.status).toBe(409);
      const ok = await api("/v1/me/terms", { token, json: { version: "2099-01-01" } });
      expect(ok.status).toBe(200);
      expect((await jsonOf<{ needs_terms: boolean }>(await api("/v1/me", { token }))).needs_terms).toBe(
        false,
      );
    } finally {
      settings.termsVersion = original;
    }
  });

  it("recover_with_a_recovery_code", async () => {
    const email = uniqueEmail("recover");
    const { client, token, codes } = await with2fa(email);
    const newPassword = "a completely new passphrase";
    const recover = (code: string | undefined) =>
      client.call("/v1/auth/recover", { json: { email, recovery_code: code, new_password: newPassword } });
    expect((await recover("nope-nope")).status).toBe(401);
    const ok = await recover(codes[0]);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await client.call("/v1/auth/me", { token })).status).toBe(401);
    expect((await recover(codes[0])).status).toBe(401);
    const login = await client.call("/v1/auth/login", { json: { email, password: newPassword } });
    expect(login.status).toBe(200);
  });

  it("recover_without_two_factor_reveals_nothing", async () => {
    const email = uniqueEmail("no2fa");
    await register(new Client(), email);
    const body = (e: string) => ({ email: e, recovery_code: "abcd-efgh", new_password: "x".repeat(20) });
    const r = await api("/v1/auth/recover", { json: body(email) });
    const ghost = await api("/v1/auth/recover", { json: body(uniqueEmail("ghost")) });
    expect(r.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(await r.json()).toEqual(await ghost.json());
  });

  it("change_email_waits_for_the_new_address", async () => {
    const client = new Client();
    const old = uniqueEmail("old");
    const next = uniqueEmail("new");
    await register(client, old);
    const token = await loginToken(client, old);
    const bad = await client.call("/v1/auth/change-email", {
      json: { password: "wrong-wrong-wrong!", new_email: next },
      token,
    });
    expect(bad.status).toBe(401);
    const started = await client.call("/v1/auth/change-email", {
      json: { password: PASSWORD, new_email: next },
      token,
    });
    expect(started.status).toBe(200);
    const me = await jsonOf<{ email: string }>(await client.call("/v1/auth/me", { token }));
    expect(me.email).toBe(old);
    const confirmed = await client.call("/v1/auth/confirm-email-change", {
      json: { email: next, code: otpCode("confirm-email", next) },
    });
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect((await client.call("/v1/auth/login", { json: { email: next, password: PASSWORD } })).status).toBe(
      200,
    );
    expect(sent.some((m) => m.includes(old) && m.includes("was changed"))).toBe(true);
  });

  it("change_email_to_a_taken_address_looks_the_same", async () => {
    const taken = uniqueEmail("taken");
    await register(new Client(), taken);
    const client = new Client();
    const mover = uniqueEmail("mover");
    await register(client, mover);
    const token = await loginToken(client, mover);
    const a = await client.call("/v1/auth/change-email", {
      json: { password: PASSWORD, new_email: taken },
      token,
    });
    const b = await client.call("/v1/auth/change-email", {
      json: { password: PASSWORD, new_email: uniqueEmail("free") },
      token,
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it("client_errors_group_and_strip_queries", async () => {
    await testDb().db.delete(clientErrors);
    const body = {
      message: "TypeError: x is undefined",
      stack: "TypeError: x is undefined\n    at render (index-abc.js:1:200)",
      url: "https://app.pacestreak.com/reset-password?token=SECRET",
      release: "0.1.0",
    };
    for (let i = 0; i < 3; i++) expect((await api("/v1/client-errors", { json: body })).status).toBe(202);
    const admin = await signupAs("admin");
    const errors = await jsonOf<{ id: string; count: number; path: string }[]>(
      await api("/v1/admin/client-errors", { token: admin.token }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.count).toBe(3);
    expect(errors[0]?.path).toBe("/reset-password"); // never the token
    const del = await api(`/v1/admin/client-errors/${errors[0]?.id}`, {
      token: admin.token,
      method: "DELETE",
    });
    expect(del.status).toBe(204);
  });

  it("abuse_view_counts_failures_and_names_only_real_accounts", async () => {
    const victim = uniqueEmail("victim");
    await register(new Client(), victim);
    const attacker = new Client();
    for (let i = 0; i < 3; i++)
      await attacker.call("/v1/auth/login", { json: { email: victim, password: "wrong-wrong-wrong!" } });
    await attacker.call("/v1/auth/login", {
      json: { email: uniqueEmail("nobody"), password: "wrong-wrong-wrong!" },
    });
    const admin = await signupAs("admin");
    const view = await jsonOf<{
      failures: Record<string, number>;
      by_account: unknown[];
      by_ip: { failures: number }[];
      signups_by_ip: { signups: number }[];
    }>(await api("/v1/admin/abuse", { token: admin.token }));
    expect(view.failures.login).toBeGreaterThanOrEqual(4);
    // The file's database is shared with the recover tests above, so only this test's rows are pinned down.
    expect(view.by_account).toContainEqual({ account: victim, failures: 3, ips: 1 });
    expect(view.by_ip.some((x) => x.failures === 4)).toBe(true);
    expect(view.signups_by_ip.reduce((n, s) => n + s.signups, 0)).toBeGreaterThanOrEqual(2);
    // Moderators can't see it (admin-only routes answer 404, not 403).
    const mod = await signupAs("moderator");
    expect((await api("/v1/admin/abuse", { token: mod.token })).status).toBe(404);
  });

  it("crash_reports_are_bounded", async () => {
    // Python lowered MAX_GROUPS to 2; here the table is filled to two short of the cap instead.
    const { db } = testDb();
    await db.delete(clientErrors);
    const now = Date.now();
    const rows = Array.from({ length: MAX_GROUPS - 2 }, (_, i) => ({
      id: uuid7(now),
      createdAt: now,
      updatedAt: now,
      fingerprint: `filler-${i}`,
      message: `filler ${i}`,
      firstSeen: now,
      lastSeen: now,
    }));
    for (let i = 0; i < rows.length; i += 10) await db.insert(clientErrors).values(rows.slice(i, i + 10));
    let last: Response | null = null;
    for (let i = 0; i < 3; i++) {
      last = await api("/v1/client-errors", { json: { message: `Error ${i}` } });
      expect(last.status).toBe(202);
    }
    expect(await last?.json()).toEqual({ received: false }); // a third distinct group is refused
    // ...but a known one still counts.
    expect(await jsonOf(await api("/v1/client-errors", { json: { message: "Error 0" } }))).toEqual({
      received: true,
    });
    expect((await db.select({ n: count() }).from(clientErrors))[0]?.n).toBe(MAX_GROUPS);
    await db.delete(clientErrors);
  });

  it("two_accounts_asking_for_the_same_new_address", async () => {
    // pending_email isn't unique; a second pending claim used to 500 the confirm.
    const wanted = uniqueEmail("wanted");
    for (const who of ["first", "second"]) {
      const client = new Client();
      const email = uniqueEmail(who);
      await register(client, email);
      const token = await loginToken(client, email);
      const r = await client.call("/v1/auth/change-email", {
        json: { password: PASSWORD, new_email: wanted },
        token,
      });
      expect(r.status).toBe(200);
    }
    const confirmed = await api("/v1/auth/confirm-email-change", {
      json: { email: wanted, code: otpCode("confirm-email", wanted) },
    });
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect((await api("/v1/auth/login", { json: { email: wanted, password: PASSWORD } })).status).toBe(200);
  });
});
