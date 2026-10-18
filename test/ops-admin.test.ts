/** Health, crash reports and the admin routes (spec/core.md §1, spec/misc.md §3), through the real Worker. */
import { SELF } from "cloudflare:test";
import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  activityEvents,
  auditLog,
  authFailures,
  clientErrors,
  comments,
  notifications,
  profiles,
  reports,
  securityEvents,
  users,
  workerHeartbeats,
} from "../src/db/schema/index.ts";
import { STALE_AFTER_SECONDS } from "../src/jobs/heartbeat.ts";
import { checkHandle, isReserved, mentionsBrand } from "../src/lib/handles.ts";
import { uuid7 } from "../src/lib/uuid7.ts";
import { fingerprint, MAX_GROUPS, urlPath } from "../src/modules/ops/service.ts";
import { makeRole, signupAs } from "./fixtures/admin.ts";
import { signup } from "./fixtures/auth.ts";
import { testDb } from "./fixtures/db.ts";
import { api, expectRoundTrips, jsonOf } from "./fixtures/http.ts";

const { db } = testDb();

async function addProfile(userId: string, extra: Partial<typeof profiles.$inferInsert> = {}) {
  const now = Date.now();
  const handle = extra.handle ?? `p_${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(profiles).values({
    userId,
    createdAt: now,
    updatedAt: now,
    handle,
    handleFold: handle,
    onboardedAt: now,
    ...extra,
  });
  return handle;
}

describe("health", () => {
  it("health_returns_healthy without the version header", async () => {
    const res = await SELF.fetch("https://api.test/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "healthy" });
    expect(res.headers.get("PaceStreak-Version")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=5");
  });

  it("ready runs SELECT 1 and reports the database", async () => {
    const res = await SELF.fetch("https://api.test/health/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", checks: { database: "ok" } });
  });

  it("worker reports never_ran, ok and stale without exposing jobs", async () => {
    await db.delete(workerHeartbeats);
    const never = await SELF.fetch("https://api.test/health/worker");
    expect([never.status, await never.json()]).toEqual([503, { status: "never_ran", age_seconds: null }]);

    const now = Date.now();
    await db.insert(workerHeartbeats).values({
      id: uuid7(now),
      createdAt: now,
      updatedAt: now,
      name: "scheduler",
      lastTickAt: now - 10_000,
      durationMs: 12,
      jobs: { reminders: { result: 1 } },
    });
    const ok = await SELF.fetch("https://api.test/health/worker");
    const body = await jsonOf<Record<string, unknown>>(ok);
    expect(ok.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body).not.toHaveProperty("jobs");

    await db
      .update(workerHeartbeats)
      .set({ lastTickAt: now - (STALE_AFTER_SECONDS + 60) * 1000 })
      .where(eq(workerHeartbeats.name, "scheduler"));
    const stale = await SELF.fetch("https://api.test/health/worker");
    expect(stale.status).toBe(503);
    expect((await jsonOf<{ status: string }>(stale)).status).toBe("stale");
  });
});

describe("client errors", () => {
  it("url paths drop scheme, host, query and fragment verbatim", () => {
    expect(urlPath("https://app.pacestreak.com/reset?token=secret#x")).toBe("/reset");
    expect(urlPath("/today?x=1")).toBe("/today");
    expect(urlPath("//host/a%20b")).toBe("/a%20b");
    expect(urlPath("not a url#frag")).toBe("not a url");
  });

  it("fingerprints the message with the stack's second line", async () => {
    const a = await fingerprint("boom", "Error: boom\n  at f (app.js:1:2)\n  at g (app.js:3:4)");
    const b = await fingerprint("boom", "  Error: boom\r\n  at f (app.js:1:2)\n  elsewhere");
    expect(a).toBe(b);
    expect(await fingerprint("boom", null)).not.toBe(a);
  });

  it("groups repeats, keeps paths only, and lists and resolves for admins", async () => {
    const message = `TypeError ${crypto.randomUUID()}`;
    const report = {
      message,
      stack: "TypeError\n  at x (a.js:1:1)",
      url: "https://app.pacestreak.com/x?token=t",
      release: "r1",
    };
    const first = await api("/v1/client-errors", { json: report, headers: { "User-Agent": "UA/1" } });
    expect([first.status, await first.json()]).toEqual([202, { received: true }]);
    expectRoundTrips(first, 1);
    await api("/v1/client-errors", { json: { ...report, url: "/y", release: "r2" } });

    const admin = await signupAs("admin");
    const list = await api("/v1/admin/client-errors", { token: admin.token });
    expect(list.status).toBe(200);
    expectRoundTrips(list, 1);
    const rows = await jsonOf<Record<string, unknown>[]>(list);
    const row = rows.find((r) => r.message === message);
    expect(row).toMatchObject({ count: 2, path: "/y", release: "r2", user_agent: null });
    expect(row).not.toHaveProperty("alerted_at");

    const gone = await api(`/v1/admin/client-errors/${String(row?.id)}`, {
      method: "DELETE",
      token: admin.token,
    });
    expect(gone.status).toBe(204);
    const again = await api(`/v1/admin/client-errors/${String(row?.id)}`, {
      method: "DELETE",
      token: admin.token,
    });
    expect([again.status, await again.json()]).toEqual([404, { detail: "Not found" }]);
    const malformed = await api("/v1/admin/client-errors/not-a-uuid", {
      method: "DELETE",
      token: admin.token,
    });
    expect(malformed.status).toBe(404);
  });

  it("validates like pydantic", async () => {
    const res = await api("/v1/client-errors", { json: { message: "" } });
    expect(res.status).toBe(422);
  });

  it("stops taking new groups at MAX_GROUPS but still counts known ones", async () => {
    await db.delete(clientErrors);
    const now = Date.now();
    const known = await fingerprint("known", null);
    const rows = Array.from({ length: MAX_GROUPS }, (_, i) => ({
      id: uuid7(now),
      createdAt: now,
      updatedAt: now,
      fingerprint: i === 0 ? known : `fp-${i}`,
      message: i === 0 ? "known" : `m${i}`,
      firstSeen: now,
      lastSeen: now,
    }));
    for (let i = 0; i < rows.length; i += 10) await db.insert(clientErrors).values(rows.slice(i, i + 10));
    const fresh = await api("/v1/client-errors", { json: { message: "brand new" } });
    expect([fresh.status, await fresh.json()]).toEqual([202, { received: false }]);
    const repeat = await api("/v1/client-errors", { json: { message: "known" } });
    expect(await repeat.json()).toEqual({ received: true });
    const [k] = await db.select().from(clientErrors).where(eq(clientErrors.fingerprint, known));
    expect(k?.count).toBe(2);
    expect((await db.select({ n: count() }).from(clientErrors))[0]?.n).toBe(MAX_GROUPS);
    await db.delete(clientErrors);
  });
});

describe("admin gate", () => {
  it("hides every admin route behind 404 for users, and admin-only routes from moderators", async () => {
    const user = await signup();
    const mod = await signupAs("moderator");
    for (const path of ["/v1/admin/reports", "/v1/admin/users", "/v1/admin/audit", "/v1/admin/metrics"]) {
      const res = await api(path, { token: user.token });
      expect([path, res.status, await res.json()]).toEqual([path, 404, { detail: "Not found" }]);
      expect((await api(path, { token: mod.token })).status).toBe(200);
    }
    for (const path of ["/v1/admin/client-errors", "/v1/admin/abuse"]) {
      expect((await api(path, { token: mod.token })).status).toBe(404);
    }
    expect((await api("/v1/admin/users")).status).toBe(401);
  });

  it("a role lost after the read cannot write", async () => {
    const mod = await signupAs("moderator");
    const target = await signup();
    await addProfile(target.userId);
    await makeRole(mod.userId, "user");
    const res = await api(`/v1/admin/users/${target.userId}`, {
      method: "PATCH",
      json: { social_suspended: true },
      token: mod.token,
    });
    expect(res.status).toBe(404);
  });
});

describe("admin users", () => {
  it("lists and searches users with report counts", async () => {
    const mod = await signupAs("moderator");
    const target = await signup();
    const handle = await addProfile(target.userId, { isOfficial: true });
    const now = Date.now();
    await db.insert(reports).values({
      id: uuid7(now),
      createdAt: now,
      updatedAt: now,
      reporterId: mod.userId,
      reportedUserId: target.userId,
      targetType: "user",
      targetId: target.userId,
      reason: "spam",
    });
    const res = await api(`/v1/admin/users?q=${encodeURIComponent(handle.toUpperCase())}`, {
      token: mod.token,
    });
    expect(res.status).toBe(200);
    expectRoundTrips(res, 1);
    expect(await res.json()).toEqual([
      expect.objectContaining({
        id: target.userId,
        email: target.email,
        handle,
        role: "user",
        official: true,
        social_suspended: false,
        deletion_scheduled_at: null,
        reports: 1,
      }),
    ]);
    // Wildcards are literal.
    expect(await jsonOf(await api("/v1/admin/users?q=%25%25%25", { token: mod.token }))).toEqual([]);
  });

  it("patch: role and is_active are admin only, never on yourself, and deactivation ends sessions", async () => {
    const mod = await signupAs("moderator");
    const admin = await signupAs("admin");
    const target = await signup();
    await addProfile(target.userId, { leaderboardOptIn: true });
    const denied = await api(`/v1/admin/users/${target.userId}`, {
      method: "PATCH",
      json: { role: "moderator" },
      token: mod.token,
    });
    expect([denied.status, await denied.json()]).toEqual([403, { detail: "Admins only" }]);
    const self = await api(`/v1/admin/users/${admin.userId}`, {
      method: "PATCH",
      json: { is_active: false },
      token: admin.token,
    });
    expect([self.status, await self.json()]).toEqual([409, { detail: "Not on your own account" }]);
    const missing = await api(`/v1/admin/users/${crypto.randomUUID()}`, {
      method: "PATCH",
      json: {},
      token: admin.token,
    });
    expect(missing.status).toBe(404);

    const suspend = await api(`/v1/admin/users/${target.userId}`, {
      method: "PATCH",
      json: { social_suspended: true },
      token: mod.token,
    });
    expect(await suspend.json()).toEqual({ ok: true, social_suspended: true });
    expectRoundTrips(suspend, 2);
    const [p] = await db.select().from(profiles).where(eq(profiles.userId, target.userId));
    expect(p?.socialSuspendedAt).not.toBeNull();
    expect(p?.leaderboardOptIn).toBe(false);

    const off = await api(`/v1/admin/users/${target.userId}`, {
      method: "PATCH",
      json: { is_active: false, role: "moderator" },
      token: admin.token,
    });
    expect(await off.json()).toEqual({ ok: true, role: "moderator", is_active: false });
    expect((await api("/v1/auth/me", { token: target.token })).status).toBe(401);
    const entries = await db.select().from(auditLog).where(eq(auditLog.targetId, target.userId));
    expect(entries.map((e) => e.action)).toEqual(["user.update", "user.update"]);
  });

  it("official: reserved handles only for official accounts, and revoking needs an ordinary one", async () => {
    const admin = await signupAs("admin");
    const target = await signup();
    const notOnboarded = await api(`/v1/admin/users/${target.userId}/official`, {
      json: { official: true },
      token: admin.token,
    });
    expect(notOnboarded.status).toBe(404);
    await addProfile(target.userId, { displayName: "PaceStreak Team" });
    const brand = `pacestreak_${crypto.randomUUID().slice(0, 6)}`;

    const bad = await api(`/v1/admin/users/${target.userId}/official`, {
      json: { official: true, handle: "x" },
      token: admin.token,
    });
    expect(bad.status).toBe(422);
    const reservedForOthers = await api(`/v1/admin/users/${target.userId}/official`, {
      json: { official: false, handle: brand },
      token: admin.token,
    });
    expect([reservedForOthers.status, await reservedForOthers.json()]).toEqual([
      409,
      { detail: "That handle is reserved" },
    ]);

    const grant = await api(`/v1/admin/users/${target.userId}/official`, {
      json: { official: true, handle: `@${brand.toUpperCase()}` },
      token: admin.token,
    });
    expect([grant.status, await grant.json()]).toEqual([200, { official: true, handle: brand }]);

    const other = await signup();
    await addProfile(other.userId);
    const taken = await api(`/v1/admin/users/${other.userId}/official`, {
      json: { official: true, handle: brand },
      token: admin.token,
    });
    expect([taken.status, await taken.json()]).toEqual([409, { detail: "That handle is taken" }]);

    const stuck = await api(`/v1/admin/users/${target.userId}/official`, {
      json: { official: false },
      token: admin.token,
    });
    expect([stuck.status, await stuck.json()]).toEqual([
      409,
      { detail: "This account holds a reserved handle; give it an ordinary one to revoke" },
    ]);
    const ordinary = `runner_${crypto.randomUUID().slice(0, 6)}`;
    const revoke = await api(`/v1/admin/users/${target.userId}/official`, {
      json: { official: false, handle: ordinary },
      token: admin.token,
    });
    expect(await revoke.json()).toEqual({ official: false, handle: ordinary });
    const [p] = await db.select().from(profiles).where(eq(profiles.userId, target.userId));
    expect([p?.displayName, p?.handleFold, p?.isOfficial]).toEqual([null, ordinary, false]);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "user.official"));
    expect(entry?.detail).toEqual({
      before: { official: false, handle: expect.any(String) },
      after: expect.any(Object),
    });
  });

  it("handle rules match Python reserved.py", () => {
    for (const h of [
      "admin",
      "_adm1n_2",
      "admin_user",
      "the_admin",
      "run_mod_42",
      "pace5treak",
      "officia1",
    ]) {
      expect([h, isReserved(h)]).toEqual([h, true]);
    }
    for (const h of ["badminton", "padmini", "model", "modern", "runner"]) {
      expect([h, isReserved(h)]).toEqual([h, false]);
    }
    expect(mentionsBrand("Pace Streak")).toBe(true);
    expect(mentionsBrand("Jo")).toBe(false);
    expect(checkHandle(" @@Runner_1 ")).toBe("runner_1");
  });
});

describe("admin reports", () => {
  it("resolve hides the target, suspends, groups siblings, notifies and audits", async () => {
    const mod = await signupAs("moderator");
    const author = await signup();
    const reporterA = await signup();
    const reporterB = await signup();
    await addProfile(author.userId, { leaderboardOptIn: true });
    const handleA = await addProfile(reporterA.userId);
    const now = Date.now();
    const eventId = uuid7(now);
    const commentId = uuid7(now);
    await db.insert(activityEvents).values({
      id: eventId,
      createdAt: now,
      updatedAt: now,
      userId: author.userId,
      kind: "workout",
      refKey: eventId,
      occurredOn: "2026-10-14",
    });
    await db.insert(comments).values({
      id: commentId,
      createdAt: now,
      updatedAt: now,
      eventId,
      authorId: author.userId,
      body: "rude",
    });
    const reportRow = (reporterId: string, at: number) => ({
      id: uuid7(at),
      createdAt: at,
      updatedAt: at,
      reporterId,
      reportedUserId: author.userId,
      targetType: "comment" as const,
      targetId: commentId,
      reason: "abuse",
    });
    const first = reportRow(reporterA.userId, now);
    const second = reportRow(reporterB.userId, now + 1);
    await db.insert(reports).values([first, second]);

    const list = await api("/v1/admin/reports", { token: mod.token });
    expectRoundTrips(list, 1);
    const open = await jsonOf<Record<string, unknown>[]>(list);
    const mine = open.find((r) => r.id === first.id);
    expect(mine).toMatchObject({
      target_type: "comment",
      status: "open",
      reporter: { id: reporterA.userId, handle: handleA, email: null, suspended: false },
      reported: { id: author.userId, suspended: false },
      prior_actioned: 0,
    });
    expect(open.find((r) => r.id === second.id)?.reporter).toBeNull();
    expect((await api("/v1/admin/reports?status=bogus", { token: mod.token })).status).toBe(422);

    const res = await api(`/v1/admin/reports/${first.id}/resolve`, {
      json: { action: "hide_and_suspend", note: "rude comment" },
      token: mod.token,
    });
    expect([res.status, await res.json()]).toEqual([200, { status: "actioned", grouped: 1 }]);
    expectRoundTrips(res, 2);

    const [c] = await db.select().from(comments).where(eq(comments.id, commentId));
    expect(c?.hiddenAt).not.toBeNull();
    const [p] = await db.select().from(profiles).where(eq(profiles.userId, author.userId));
    expect([p?.socialSuspendedAt !== null, p?.leaderboardOptIn]).toEqual([true, false]);
    const rs = await db.select().from(reports).where(eq(reports.targetId, commentId));
    expect(rs.map((r) => [r.status, r.resolution]).sort()).toEqual(
      [
        ["actioned", "rude comment"],
        ["actioned", `grouped with ${first.id}`],
      ].sort(),
    );
    const [n] = await db.select().from(notifications).where(eq(notifications.userId, author.userId));
    expect(n?.title).toBe("Some of your content was removed");
    const [a] = await db.select().from(auditLog).where(eq(auditLog.action, "report.hide_and_suspend"));
    expect(a?.detail).toEqual({ report: first.id, note: "rude comment", grouped: 1 });

    const after = await jsonOf<Record<string, unknown>[]>(
      await api("/v1/admin/reports?status=actioned", { token: mod.token }),
    );
    expect(after.find((r) => r.id === first.id)?.prior_actioned).toBe(2);
    expect(
      (
        await api(`/v1/admin/reports/${crypto.randomUUID()}/resolve`, {
          json: { action: "dismiss" },
          token: mod.token,
        })
      ).status,
    ).toBe(404);
  });

  it("dismiss changes nothing but the report", async () => {
    const mod = await signupAs("moderator");
    const reporter = await signup();
    const now = Date.now();
    const id = uuid7(now);
    await db.insert(reports).values({
      id,
      createdAt: now,
      updatedAt: now,
      reporterId: reporter.userId,
      targetType: "user",
      targetId: reporter.userId,
      reason: "x",
    });
    const res = await api(`/v1/admin/reports/${id}/resolve`, {
      json: { action: "dismiss" },
      token: mod.token,
    });
    expect(await res.json()).toEqual({ status: "dismissed", grouped: 0 });
    const [r] = await db.select().from(reports).where(eq(reports.id, id));
    expect([r?.status, r?.resolution, r?.resolvedBy]).toEqual(["dismissed", "dismiss", mod.userId]);
  });
});

describe("admin views", () => {
  it("audit lists the newest entries with the actor's handle", async () => {
    const mod = await signupAs("moderator");
    const handle = await addProfile(mod.userId);
    const target = await signup();
    await addProfile(target.userId);
    await api(`/v1/admin/users/${target.userId}`, {
      method: "PATCH",
      json: { social_suspended: false },
      token: mod.token,
    });
    const res = await api("/v1/admin/audit", { token: mod.token });
    expectRoundTrips(res, 1);
    const rows = await jsonOf<Record<string, unknown>[]>(res);
    expect(rows.find((r) => r.target_id === target.userId)).toMatchObject({
      action: "user.update",
      target_type: "user",
      actor: handle,
      detail: { social_suspended: false },
    });
  });

  it("metrics count users, weeks and the worker, plus the D1 size", async () => {
    const mod = await signupAs("moderator");
    const res = await api("/v1/admin/metrics", { token: mod.token });
    expect(res.status).toBe(200);
    expectRoundTrips(res, 1);
    const m = await jsonOf<Record<string, unknown>>(res);
    const total = (await db.select({ n: count() }).from(users))[0]?.n;
    expect(m.users).toBe(total);
    expect(m).toHaveProperty("onboarded");
    expect(m).toHaveProperty("active_7d");
    expect(m).toHaveProperty("sessions_7d");
    const weeks = m.signups_by_week as { week: string; count: number }[];
    const monday = new Date(`${weeks.at(-1)?.week}T00:00:00Z`).getUTCDay();
    expect(monday).toBe(1);
    expect(weeks.reduce((s, w) => s + w.count, 0)).toBeGreaterThan(0);
    expect((m.worker as { status: string }).status).toMatch(/never_ran|ok|stale/);
    expect((m.database as { size_bytes: number }).size_bytes).toBeGreaterThan(0);
  });

  it("abuse summarises the last day's failures and signups", async () => {
    const admin = await signupAs("admin");
    const victim = await signup();
    const now = Date.now();
    const ip = `203.0.113.${Math.floor(Math.random() * 200)}`;
    await db.insert(authFailures).values([
      {
        id: uuid7(now),
        createdAt: now,
        updatedAt: now,
        kind: "login",
        ipAddress: ip,
        emailHash: "h1",
        userId: victim.userId,
      },
      { id: uuid7(now), createdAt: now, updatedAt: now, kind: "login", ipAddress: ip, emailHash: "h2" },
      { id: uuid7(now), createdAt: now - 2 * 86_400_000, updatedAt: now, kind: "mfa", ipAddress: ip },
    ]);
    await db.insert(securityEvents).values({
      id: uuid7(now),
      createdAt: now,
      updatedAt: now,
      userId: victim.userId,
      kind: "signup",
      ipAddress: ip,
    });
    const res = await api("/v1/admin/abuse", { token: admin.token });
    expect(res.status).toBe(200);
    expectRoundTrips(res, 1);
    const body = await jsonOf<{
      failures: Record<string, number>;
      by_ip: { ip: string; failures: number; accounts: number }[];
      by_account: { account: string; failures: number; ips: number }[];
      signups_by_ip: { ip: string; signups: number }[];
    }>(res);
    expect(body.failures.login).toBeGreaterThanOrEqual(2);
    expect(body.by_ip.find((r) => r.ip === ip)).toEqual({ ip, failures: 2, accounts: 2 });
    expect(body.by_account.find((r) => r.account === victim.email)).toEqual({
      account: victim.email,
      failures: 1,
      ips: 1,
    });
    expect(body.signups_by_ip.find((r) => r.ip === ip)).toEqual({ ip, signups: 1 });
  });
});
