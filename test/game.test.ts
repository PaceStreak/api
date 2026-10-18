/**
 * The game module beyond the ported pytest cases: round-trip budgets (on the heavy user), every route's shape,
 * the queue consumers, optimistic concurrency and records against their own history.
 */
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessions, statDays, userStats, workouts } from "../src/db/schema/index.ts";
import { createConsumerRegistry, handleQueue } from "../src/jobs/consumer.ts";
import { addDays } from "../src/lib/time.ts";
import { uuid7 } from "../src/lib/uuid7.ts";
import * as game from "../src/modules/game/service.ts";
import { authedBatch, testDb } from "./fixtures/db.ts";
import { deleteWorkout, person, putWorkout, setProfile } from "./fixtures/game.ts";
import { seedHeavyUser } from "./fixtures/heavy-user.ts";
import { api, expectRoundTrips, jsonOf } from "./fixtures/http.ts";
import { jobCtx } from "./jobs/helpers.ts";

async function heavyPrincipal(userId: string) {
  const { db } = testDb();
  const sessionId = uuid7();
  const now = Date.now();
  await db.insert(sessions).values({ id: sessionId, userId, createdAt: now, expiresAt: now + 86_400_000 });
  return { userId, sessionId, tokenVersion: 0 };
}

describe("game budgets on the heavy user", () => {
  it("rebuilds, recomputes in one read and one write, and snapshots in one round trip", async () => {
    const data = await seedHeavyUser();
    const userId = data.users[0]?.id as string;
    const ctx = jobCtx();
    await game.rebuild(ctx, userId);
    const days = await testDb().db.select().from(statDays).where(eq(statDays.userId, userId));
    expect(days.length).toBeGreaterThan(1000);

    const p = await heavyPrincipal(userId);
    const read = jobCtx();
    const t0 = performance.now();
    const snap = await game.snapshot(read, authedBatch(read.db, p));
    const ms = performance.now() - t0;
    expect(read.stats.roundTrips).toBe(1);
    expect(snap.sessions).toBe(3000);
    // Five positions of four sets; the fifth only ever holds a warm-up, which never counts.
    expect(snap.context.distinct_exercises).toBe(4);
    console.info(`heavy snapshot: ${ms.toFixed(1)} ms wall, ${snap.days.length} days`);

    const rc = jobCtx();
    await game.recompute(rc, userId, { scope: { exercises: ["bench_press"], disciplines: ["run"] } });
    expect(rc.stats.roundTrips).toBe(2);
  }, 120_000);
});

describe("game routes", () => {
  it("serve every /me read in one round trip", async () => {
    const me = await person();
    await putWorkout(me.userId);
    for (const path of [
      "/v1/me/stats",
      "/v1/me/xp",
      "/v1/me/records",
      "/v1/me/achievements",
      "/v1/me/review",
      "/v1/me/progress?weeks=8",
      `/v1/me/recap?week=${new Date().toISOString().slice(0, 10)}`,
      `/v1/me/recap/month?month=${new Date().toISOString().slice(0, 7)}`,
      "/v1/leaderboards/streak",
    ]) {
      const res = await api(path, { token: me.token });
      expect(res.status, path).toBe(200);
      expectRoundTrips(res, 1);
    }
  });

  it("creates the profile and the default chain on first use", async () => {
    const me = await person();
    const { db } = testDb();
    await db.delete(userStats).where(eq(userStats.userId, me.userId));
    const res = await api("/v1/me/stats", { token: me.token });
    const body = await jsonOf<{ chains: { name: string; target: number }[]; level: { level: number } }>(res);
    expect(body.chains.map((c) => [c.name, c.target])).toEqual([["Everything", 3]]);
    expect(body.level.level).toBe(1);
    // The second read finds both and stays at one round trip.
    expectRoundTrips(await api("/v1/me/stats", { token: me.token }), 1);
  });

  it("reports records, their history and the outcome of the session that set them", async () => {
    const me = await person();
    const now = Date.now();
    await putWorkout(me.userId, { startedAt: now - 10 * 86_400_000 });
    const second = await putWorkout(me.userId, {
      sets: [{ exercise_id: "back-squat", weight_kg: 105, reps: 5 }],
    });
    expect(second.outcome.new_records.map((r) => r.key)).toEqual(["e1rm:back-squat"]);
    expect(second.outcome.new_records[0]?.label).toBe("Back squat · estimated 1RM");
    const records = await jsonOf<{ current: { key: string; value: number }[]; recent: unknown[] }>(
      await api("/v1/me/records", { token: me.token }),
    );
    expect(records.current).toEqual([expect.objectContaining({ key: "e1rm:back-squat", value: 122.5 })]);
    expect(records.recent).toHaveLength(1);
    const hist = await jsonOf<{ points: { kind: string }[] }>(
      await api("/v1/me/records/history?key=e1rm:back-squat", { token: me.token }),
    );
    expect(hist.points.map((p) => p.kind)).toEqual(["first", "record"]);
    expect((await api("/v1/me/records/history?key=nope", { token: me.token })).status).toBe(404);

    // Deleting the record session moves the record back, silently.
    await deleteWorkout(me.userId, second.id, second.localDate, ["back-squat"], "strength");
    const after = await jsonOf<{ current: { value: number }[] }>(
      await api("/v1/me/records", { token: me.token }),
    );
    expect(after.current.map((r) => r.value)).toEqual([116.67]);
  });

  it("validates queries like FastAPI", async () => {
    const me = await person();
    expect((await api("/v1/me/progress?weeks=3", { token: me.token })).status).toBe(422);
    expect((await api("/v1/me/review?year=1999", { token: me.token })).status).toBe(422);
    expect((await api("/v1/me/recap?week=nope", { token: me.token })).status).toBe(422);
    const future = await api(`/v1/me/recap?week=${addDays(new Date().toISOString().slice(0, 10), 9)}`, {
      token: me.token,
    });
    expect(future.status).toBe(422);
    expect((await api("/v1/me/wager", { token: me.token, json: { week: "later" } })).status).toBe(422);
    expect((await api("/v1/me/wager/not-a-date", { token: me.token, method: "DELETE" })).status).toBe(422);
    expect((await api("/v1/leaderboards/bodyweight", { token: me.token })).status).toBe(404);
    expect((await api("/v1/leaderboards/streak?scope=everyone", { token: me.token })).status).toBe(422);
    expect((await api("/v1/leaderboards/streak?scope=group", { token: me.token })).status).toBe(422);
    expect((await api("/v1/me/stats")).status).toBe(401);
  });

  it("keeps leaderboards to adults and ranks attendance only", async () => {
    const kid = await person({ birthYear: new Date().getUTCFullYear() - 14 });
    expect((await api("/v1/leaderboards/streak", { token: kid.token })).status).toBe(403);
    const me = await person();
    await setProfile(me.userId, { leaderboardOptIn: true });
    await putWorkout(me.userId, { sets: [] });
    const body = await jsonOf<{
      rows: Record<string, unknown>[];
      me: Record<string, unknown> | null;
      opted_in: boolean;
    }>(await api("/v1/leaderboards/streak", { token: me.token }));
    expect(body.opted_in).toBe(true);
    expect(body.me).toEqual(expect.objectContaining({ handle: me.handle, me: true }));
    expect(Object.keys(body.me ?? {}).sort()).toEqual([
      "avatar_hue",
      "current_streak",
      "display_name",
      "handle",
      "id",
      "level",
      "me",
      "official",
      "rank",
      "value",
      "visibility",
    ]);
  });

  it("reviews the year and recaps the week in attendance only", async () => {
    const me = await person();
    await putWorkout(me.userId, { discipline: "run", distanceM: 5000, durationSec: 1500, sets: [] });
    const today = new Date().toISOString().slice(0, 10);
    const recap = await jsonOf<{ disciplines: { id: string; name: string }[]; sessions: number }>(
      await api(`/v1/me/recap?week=${today}`, { token: me.token }),
    );
    expect(recap.sessions).toBe(1);
    expect(recap.disciplines).toEqual([{ id: "run", name: "Run", sessions: 1 }]);
    const review = await jsonOf<{ days_trained: number; months: unknown[] }>(
      await api("/v1/me/review", { token: me.token }),
    );
    expect(review.days_trained).toBe(1);
    expect(review.months).toHaveLength(12);
    const empty = await person();
    expect((await api("/v1/me/review", { token: empty.token })).status).toBe(404);
  });
});

describe("game consumers and concurrency", () => {
  it("a full recompute message rebuilds the aggregates", async () => {
    const me = await person();
    await putWorkout(me.userId);
    const { db } = testDb();
    await db.delete(statDays).where(eq(statDays.userId, me.userId));
    const reg = createConsumerRegistry();
    game.registerConsumers(reg);
    const batch = createMessageBatch("pacestreak-jobs", [
      {
        id: "m0",
        timestamp: new Date(),
        attempts: 1,
        body: { type: "recompute", userId: me.userId, full: true },
      },
    ]);
    const exec = createExecutionContext();
    await handleQueue(batch, env, exec, reg);
    const res = await getQueueResult(batch, exec);
    expect(res.explicitAcks).toEqual(["m0"]);
    expect(await db.select().from(statDays).where(eq(statDays.userId, me.userId))).toHaveLength(1);
  });

  it("concurrent recomputes each land exactly once on one stats row", async () => {
    const me = await person();
    await putWorkout(me.userId);
    const { db } = testDb();
    const [before] = await db
      .select({ rev: userStats.rev })
      .from(userStats)
      .where(eq(userStats.userId, me.userId));
    await Promise.all([1, 2, 3, 4].map(() => game.recompute(jobCtx(), me.userId, { notify: false })));
    const rows = await db
      .select({ rev: userStats.rev })
      .from(userStats)
      .where(eq(userStats.userId, me.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rev).toBe((before?.rev ?? 0) + 4);
  });

  it("a level-up notifies once, with a stable dedupe key", async () => {
    const me = await person();
    const now = Date.now();
    for (let i = 0; i < 6; i++) await putWorkout(me.userId, { startedAt: now - i * 86_400_000 - 3_600_000 });
    const { db } = testDb();
    const rows = await db.select({ id: workouts.id }).from(workouts).where(eq(workouts.userId, me.userId));
    expect(rows).toHaveLength(6);
    const inbox = await jsonOf<{ items?: { title: string }[] } | { title: string }[]>(
      await api("/v1/notifications", { token: me.token }),
    );
    const titles = (Array.isArray(inbox) ? inbox : (inbox.items ?? [])).map((n) => n.title);
    expect(titles.filter((t) => t.startsWith("Level 2"))).toHaveLength(1);
    expect(titles).toContain("Unlocked: First log");
  });
});
