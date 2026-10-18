/** Port of tests/test_worker.py: the scheduler's jobs, the heartbeat and the health endpoints. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { notifications, profiles } from "../../src/db/schema/index.ts";
import { createJobRegistry, type JobRegistry, runTick } from "../../src/jobs/scheduled.ts";
import { registerJobs } from "../../src/jobs/tasks/index.ts";
import { errorAlerts } from "../../src/jobs/tasks/maintenance.ts";
import { isQuietDay } from "../../src/modules/notifications/service.ts";
import { signupAs } from "../fixtures/admin.ts";
import { sent } from "../fixtures/auth.ts";
import { useFixedClock, useSystemClock } from "../fixtures/clock.ts";
import { testDb } from "../fixtures/db.ts";
import { api, jsonOf } from "../fixtures/http.ts";
import { person } from "../fixtures/profile.ts";
import { type Json, logSession } from "../fixtures/training.ts";
import { jobCtx, recordingQueue, runFor } from "../jobs/helpers.ts";

const hourNow = () => new Date().getUTCHours();
const patchProfile = (token: string, json: unknown) =>
  api("/v1/me/profile", { token, method: "PATCH", json });
const inbox = async (token: string): Promise<Json[]> =>
  (await jsonOf<Json>(await api("/v1/notifications", { token }))).items;

/** A tick at minute 2 of the current hour (the hourly jobs run), on its own registry. */
function tick(trigger: "quarter" | "daily", registry: JobRegistry) {
  const now = Date.now();
  const at2 = now - (now % 3_600_000) + 120_000;
  return runTick(jobCtx(), trigger, at2, { registry, queue: recordingQueue() });
}

class RuntimeError extends Error {
  override name = "RuntimeError";
}

describe("test_worker", () => {
  // First in the file: before any tick the worker has never run.
  it("health_endpoints", async () => {
    expect(await jsonOf(await api("/health"))).toEqual({ status: "healthy" });
    const ready = await api("/health/ready");
    expect(ready.status).toBe(200);
    expect((await jsonOf<Json>(ready)).checks.database).toBe("ok");

    // No tick yet: the status page should say so, loudly.
    expect((await api("/health/worker")).status).toBe(503);

    const reg = createJobRegistry();
    registerJobs(reg);
    await tick("quarter", reg);
    const worker = await api("/health/worker");
    expect(worker.status).toBe(200);
    const body = await jsonOf<Json>(worker);
    expect(body.status).toBe("ok");
    // Job names and errors are admin-only, never on the public endpoint.
    expect(body).not.toHaveProperty("jobs");
  });

  it("a_failing_job_is_reported_and_counted", async () => {
    const reg = createJobRegistry();
    registerJobs({
      register: (name, handler) => {
        if (name !== "housekeeping") reg.register(name, handler);
      },
      get: reg.get,
    });
    reg.register("housekeeping", async () => {
      throw new RuntimeError("boom");
    });
    await tick("quarter", reg);
    // Each trigger releases its lease when done, so the second daily tick runs too.
    await tick("daily", reg);
    await tick("daily", reg);

    const admin = await signupAs("admin");
    const metrics = await api("/v1/admin/metrics", { token: admin.token });
    expect(metrics.status, await metrics.clone().text()).toBe(200);
    const state = (await jsonOf<Json>(metrics)).worker;
    expect(state.jobs.housekeeping).toEqual({ error: "RuntimeError" });
    expect(state.jobs.stats).toEqual({ result: 0 });
    expect(state.failing_ticks).toBe(2);
  });

  it("streak_at_risk_nudge_fires_once_at_the_reminder_hour", async () => {
    const me = await person("risky", { weekly_target: 7 });
    await patchProfile(me.token, { reminder_hour: hourNow() });
    await logSession(me.token);

    const first = await runFor("nudges", me.userId);
    const second = await runFor("nudges", me.userId);
    expect(first.length).toBe(1);
    expect(second).toEqual([]); // de-duplicated

    const risk = (await inbox(me.token)).filter((n) => n.kind === "streak_risk");
    expect(risk.length).toBe(1);
    // The nudge always carries the off-ramp.
    expect(risk[0].body.includes("repair") || risk[0].body.includes("freeze")).toBe(true);
  });

  it("no_nudge_outside_the_reminder_hour", async () => {
    const me = await person("calm", { weekly_target: 7 });
    await patchProfile(me.token, { reminder_hour: (hourNow() + 5) % 24 });
    await logSession(me.token);
    expect(await runFor("nudges", me.userId)).toEqual([]);
  });

  it("digest_is_quiet_without_history", async () => {
    const me = await person("digester");
    expect(await runFor("digest", me.userId)).toEqual([]);
  });

  it("monthly_backup_reminder_is_opt_in_and_monthly", async () => {
    const opted = await person("backer");
    const other = await person("nobacker");
    await api("/v1/notifications/preferences", {
      token: opted.token,
      method: "PUT",
      json: { channels: { backup: { email: true } } },
    });
    // Pin "now" to 09:05 UTC on the 1st, whatever the real clock says.
    useFixedClock(Date.UTC(2026, 9, 1, 9, 5));
    const first = await runFor("backup", opted.userId);
    expect(await runFor("backup", other.userId)).toEqual([]); // only the person who opted in
    const again = await runFor("backup", opted.userId);
    expect(first.length).toBe(1);
    expect(again).toEqual([]); // once per month
    useSystemClock();

    const note = (await inbox(opted.token)).find((n) => n.kind === "monthly_backup");
    // A link into the app, never a download token.
    expect(note.url).toBe("/settings/data?backup=1");

    useFixedClock(Date.UTC(2026, 9, 2, 9, 5));
    expect(await runFor("backup", opted.userId)).toEqual([]);
  });

  it("weekly_backup_arrives_on_the_first_day_of_the_week", async () => {
    const me = await person("weeklybacker");
    const prefs = await api("/v1/notifications/preferences", {
      token: me.token,
      method: "PUT",
      json: { channels: { backup: { email: true } }, backup_frequency: "weekly" },
    });
    expect(prefs.status, await prefs.clone().text()).toBe(200);
    expect((await jsonOf<Json>(prefs)).backup_frequency).toBe("weekly");
    // 2026-10-05 is a Monday, the default first day of the week.
    useFixedClock(Date.UTC(2026, 9, 5, 9, 5));
    expect((await runFor("backup", me.userId)).length).toBe(1);
    expect(await runFor("backup", me.userId)).toEqual([]); // once per week
    // Thursday the 1st: a weekly person gets nothing on the 1st.
    useFixedClock(Date.UTC(2026, 9, 1, 9, 5));
    expect(await runFor("backup", me.userId)).toEqual([]);
    // The next Monday is a new week.
    useFixedClock(Date.UTC(2026, 9, 12, 9, 5));
    expect((await runFor("backup", me.userId)).length).toBe(1);
  });

  it("quiet_days_hold_nudges_back_from_push_and_email", () => {
    const now = Date.now();
    const p = (quietDays: number | null) => ({ quietDays, timezone: "UTC", quietStart: 22, quietEnd: 7 });
    const everyDay = p(0b1111111);
    expect(isQuietDay(everyDay, "habits", now)).toBe(true);
    expect(isQuietDay(everyDay, "streak_risk", now)).toBe(true);
    // Not a nudge: security, social and backups are never held.
    expect(isQuietDay(everyDay, "security", now)).toBe(false);
    expect(isQuietDay(everyDay, "social", now)).toBe(false);
    expect(isQuietDay(p(null), "habits", now)).toBe(false);
    expect(isQuietDay(p(0), "habits", now)).toBe(false);
  });

  it("smart_reminders_nudge_at_the_learned_hour", async () => {
    const me = await person("smartnudge", { weekly_target: 7 });
    const hour = hourNow();
    // Fixed hour set away from now, learned hour set to now: only smart mode should nudge this tick.
    await patchProfile(me.token, { reminder_mode: "smart", reminder_hour: (hour + 12) % 24 });
    await logSession(me.token);
    const { db } = testDb();
    await db.update(profiles).set({ learnedReminderHour: hour }).where(eq(profiles.userId, me.userId));
    expect((await runFor("nudges", me.userId)).length).toBe(1);

    await patchProfile(me.token, { reminder_mode: "fixed" });
    await db.delete(notifications).where(eq(notifications.userId, me.userId));
    expect(await runFor("nudges", me.userId)).toEqual([]); // fixed mode: 12 hours away
  });

  it("new_app_errors_email_admins_once", async () => {
    const admin = await signupAs("admin");
    const body = {
      message: "TypeError: plates is undefined",
      stack: "at render (index.js:1:1)",
      url: "https://app.pacestreak.com/workouts/live?x=SECRET",
    };
    for (let i = 0; i < 4; i++) expect((await api("/v1/client-errors", { json: body })).status).toBe(202);

    const before = sent.length;
    expect(await errorAlerts(jobCtx())).toBe(1);
    const mail = sent
      .slice(before)
      .filter((m) => m.includes("new app error") && m.includes(`to=${admin.email} `));
    expect(mail.length).toBe(1);
    expect(mail[0]).toContain("/workouts/live");
    expect(mail[0]).not.toContain("SECRET");
    expect(mail[0]).toContain("4 time(s)");

    // Reported once: a later run, even an hour on, sends nothing.
    expect(await errorAlerts(jobCtx())).toBe(0);
  });
});
