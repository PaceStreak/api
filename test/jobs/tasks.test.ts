/** The twelve jobs beyond the pytest ports: registration, fan-out, purge, housekeeping and the Python fixes. */
import { env } from "cloudflare:test";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  bodyPhotos,
  clientErrors,
  habits,
  importJobs,
  notifications,
  profiles,
  rateCounters,
  sessions,
  trashItems,
  userStats,
  users,
} from "../../src/db/schema/index.ts";
import { createConsumerRegistry } from "../../src/jobs/consumer.ts";
import { createJobRegistry, JOB_NAMES, runTick } from "../../src/jobs/scheduled.ts";
import { registerConsumers, registerJobs, SLICED } from "../../src/jobs/tasks/index.ts";
import { errorAlerts, housekeeping, purgeAccounts } from "../../src/jobs/tasks/maintenance.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import { useFixedClock } from "../fixtures/clock.ts";
import { seedUser, testDb } from "../fixtures/db.ts";
import { person, putWorkout, setProfile } from "../fixtures/game.ts";
import { jobCtx, recordingQueue, runFor } from "./helpers.ts";

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);

describe("registration", () => {
  it("every job name has a handler and every sliced job a consumer", () => {
    const jobs = createJobRegistry();
    registerJobs(jobs);
    for (const name of JOB_NAMES) expect(jobs.get(name), name).toBeDefined();
    const consumers = createConsumerRegistry();
    registerConsumers(consumers);
    expect(consumers.get("job-slice")).toBeDefined();
    expect(consumers.get("purge")).toBeDefined();
    expect(Object.keys(SLICED).sort()).toEqual(
      ["backup", "buddies", "digest", "habit_snoozes", "habit_summary", "habits", "nudges", "stats"].sort(),
    );
  });

  it("a sliced job's cron handler fans its ids out as job-slice messages and reports their count", async () => {
    const { db } = testDb();
    const u = await seedUser(db);
    const now = Date.now();
    await db.insert(habits).values({
      id: uuid7(now),
      userId: u.userId,
      name: "Walk",
      nameFold: "walk",
      startedOn: today(),
      snoozedUntil: now - 60_000,
      createdAt: now,
      updatedAt: now,
    });
    const reg = createJobRegistry();
    registerJobs(reg);
    const q = recordingQueue();
    const report = await runTick(jobCtx(), "frequent", now, { registry: reg, queue: q });
    const slices = q.messages.filter((m) => m.type === "job-slice");
    expect(slices.length).toBeGreaterThan(0);
    expect(slices.every((m) => m.type === "job-slice" && m.job === "habit_snoozes")).toBe(true);
    expect(report?.habit_snoozes).toEqual({
      result: slices.flatMap((m) => (m.type === "job-slice" ? m.ids : [])).length,
    });
  });
});

describe("stats", () => {
  it("selects projections whose local date rolled over, not fresh ones", async () => {
    const { db } = testDb();
    const stale = await seedUser(db);
    const fresh = await seedUser(db);
    const now = Date.now();
    const row = (userId: string, computedFor: string) => ({
      id: uuid7(now),
      userId,
      computedAt: now - DAY,
      computedFor,
      seasonId: "2026-Q4",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(userStats).values([row(stale.userId, "2020-01-01"), row(fresh.userId, today())]);
    const ctx = jobCtx();
    const selected = await SLICED.stats?.select(ctx, {
      trigger: "quarter",
      cron: "",
      scheduledTime: now,
      now,
      queue: recordingQueue(),
    });
    expect(selected).toContain(stale.userId);
    expect(selected).not.toContain(fresh.userId);
  });
});

describe("nudges", () => {
  it("parity: once the risk warning is deduplicated, a later tick in the same hour sends the training reminder", async () => {
    // Saturday 18:00 UTC: two days left, one of three sessions done (Tuesday): two needed, at risk.
    const me = await person();
    useFixedClock(Date.UTC(2026, 9, 13, 10));
    await putWorkout(me.userId);
    useFixedClock(Date.UTC(2026, 9, 17, 18, 2));
    await setProfile(me.userId, { reminderHour: 18 });
    const kinds = async () => {
      const ids = await runFor("nudges", me.userId);
      if (ids.length === 0) return [];
      const rows = await testDb()
        .db.select({ kind: notifications.kind, dedupe: notifications.dedupeKey })
        .from(notifications)
        .where(inArray(notifications.id, ids));
      return rows.map((r) => `${r.kind}:${r.dedupe?.split(":")[0]}`);
    };
    expect(await kinds()).toEqual(["streak_risk:risk"]);
    expect(await kinds()).toEqual(["reminder:reminder"]);
    expect(await kinds()).toEqual([]);
  });
});

describe("snoozes", () => {
  it("changed: a deactivated owner's due snooze is cleared without a reminder (Python re-read it every tick)", async () => {
    const { db } = testDb();
    const u = await seedUser(db, { isActive: false });
    const now = Date.now();
    const id = uuid7(now);
    await db.insert(habits).values({
      id,
      userId: u.userId,
      name: "Walk",
      nameFold: "walk",
      startedOn: today(),
      snoozedUntil: now - 60_000,
      createdAt: now,
      updatedAt: now,
    });
    expect(await runFor("habit_snoozes", u.userId)).toEqual([]);
    const [h] = await db.select({ s: habits.snoozedUntil }).from(habits).where(eq(habits.id, id));
    expect(h?.s).toBeNull();
  });
});

describe("purge", () => {
  it("deletes due accounts with their R2 objects, and spares a cancelled deletion", async () => {
    const { db } = testDb();
    const due = await seedUser(db);
    const cancelled = await seedUser(db);
    const now = Date.now();
    await db
      .update(profiles)
      .set({ deletionScheduledAt: now - DAY })
      .where(eq(profiles.userId, due.userId));
    const photoKey = `photos/${due.userId}/a.jpg`;
    const stagedKey = `imports/${uuid7(now)}`;
    await env.PHOTOS.put(photoKey, "x");
    await env.STAGING.put(stagedKey, "y");
    await db.insert(bodyPhotos).values({
      id: uuid7(now),
      userId: due.userId,
      takenOn: today(),
      pose: "front",
      contentType: "image/jpeg",
      objectKey: photoKey,
      size: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(importJobs).values({
      id: uuid7(now),
      userId: due.userId,
      kind: "account",
      objectKey: stagedKey,
      size: 1,
      createdAt: now,
      updatedAt: now,
    });

    expect(await purgeAccounts(jobCtx(), [due.userId, cancelled.userId])).toBe(1);
    const left = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, [due.userId, cancelled.userId]));
    expect(left.map((r) => r.id)).toEqual([cancelled.userId]);
    expect(await env.PHOTOS.head(photoKey)).toBeNull();
    expect(await env.STAGING.head(stagedKey)).toBeNull();
    // Idempotent: a redelivered message finds nothing left to do.
    expect(await purgeAccounts(jobCtx(), [due.userId])).toBe(0);
  });
});

describe("housekeeping", () => {
  it("applies every retention rule and keeps what is still live", async () => {
    const { db } = testDb();
    const u = await seedUser(db);
    const now = Date.now();
    const note = (createdAt: number) => ({
      id: uuid7(createdAt),
      userId: u.userId,
      kind: "x",
      category: "social",
      title: "t",
      createdAt,
      updatedAt: createdAt,
    });
    const oldNote = note(now - 181 * DAY);
    const newNote = note(now - DAY);
    await db.insert(notifications).values([oldNote, newNote]);
    const trash = (purgeAfter: number) => ({
      id: uuid7(now),
      userId: u.userId,
      kind: "workout" as const,
      itemId: uuid7(now),
      label: "l",
      payload: {} as never,
      deletedAt: now,
      purgeAfter,
      createdAt: now,
      updatedAt: now,
    });
    const expired = trash(now - 1);
    const kept = trash(now + DAY);
    await db.insert(trashItems).values([expired, kept]);
    const counter = `job-test:${uuid7(now)}`;
    await db.insert(rateCounters).values({ key: counter, windowStart: now - 3 * DAY, count: 1 });
    const deadSession = uuid7(now);
    await db
      .insert(sessions)
      .values({ id: deadSession, userId: u.userId, createdAt: now - 9 * DAY, expiresAt: now - DAY });
    const oldJob = uuid7(now);
    const stagedKey = `imports/${oldJob}`;
    await env.STAGING.put(stagedKey, "z");
    await db.insert(importJobs).values({
      id: oldJob,
      userId: u.userId,
      kind: "account",
      objectKey: stagedKey,
      size: 1,
      createdAt: now - 8 * DAY,
      updatedAt: now - 8 * DAY,
    });

    await housekeeping(jobCtx());

    const notes = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(inArray(notifications.id, [oldNote.id, newNote.id]));
    expect(notes.map((n) => n.id)).toEqual([newNote.id]);
    const items = await db
      .select({ id: trashItems.id })
      .from(trashItems)
      .where(inArray(trashItems.id, [expired.id, kept.id]));
    expect(items.map((t) => t.id)).toEqual([kept.id]);
    expect(await db.select().from(rateCounters).where(eq(rateCounters.key, counter))).toEqual([]);
    expect(await db.select().from(sessions).where(eq(sessions.id, deadSession))).toEqual([]);
    // The seeded user's live session survives.
    expect(await db.select().from(sessions).where(eq(sessions.id, u.sessionId))).toHaveLength(1);
    expect(await db.select().from(importJobs).where(eq(importJobs.id, oldJob))).toEqual([]);
    expect(await env.STAGING.head(stagedKey)).toBeNull();
  });
});

describe("error alerts", () => {
  it("leaves crash groups first seen over a day ago alone", async () => {
    const { db } = testDb();
    const now = Date.now();
    const id = uuid7(now);
    await db.insert(clientErrors).values({
      id,
      fingerprint: `old-${id}`,
      message: "old",
      firstSeen: now - 2 * DAY,
      lastSeen: now,
      createdAt: now,
      updatedAt: now,
    });
    await errorAlerts(jobCtx());
    const [row] = await db
      .select({ a: clientErrors.alertedAt })
      .from(clientErrors)
      .where(eq(clientErrors.id, id));
    expect(row?.a).toBeNull();
  });
});
