/**
 * The training module beyond the ported pytest cases: round-trip budgets on the heavy user (5 years, 3,000
 * workouts), the batch's optimistic concurrency, and the import helpers' exact Python formats.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { EXERCISES } from "../src/catalog/exercises.ts";
import { sessions, workouts } from "../src/db/schema/index.ts";
import { uuid7 } from "../src/lib/uuid7.ts";
import * as game from "../src/modules/game/service.ts";
import { pyIsoUtc, uuid5 } from "../src/modules/training/imports.ts";
import { matchExercise } from "../src/modules/training/lifting.ts";
import * as w from "../src/modules/training/workouts.ts";
import { authed } from "./fixtures/auth.ts";
import { authedBatch, testDb } from "./fixtures/db.ts";
import { seedHeavyUser } from "./fixtures/heavy-user.ts";
import { jobCtx } from "./jobs/helpers.ts";

async function heavy() {
  const data = await seedHeavyUser();
  const userId = data.users[0]?.id as string;
  await game.rebuild(jobCtx(), userId);
  const sessionId = uuid7();
  const now = Date.now();
  await testDb()
    .db.insert(sessions)
    .values({ id: sessionId, userId, createdAt: now, expiresAt: now + 86_400_000 });
  return { userId, sessionId, tokenVersion: 0 };
}

const body = (startedAt: number, cua: number) => ({
  discipline: "strength",
  title: null,
  notes: null,
  started_at: startedAt,
  duration_sec: 3600,
  distance_m: null,
  elevation_m: null,
  effort: null,
  feel: null,
  routine_id: null,
  tags: [],
  gear_id: null,
  gym_id: null,
  soreness: null,
  pump: null,
  avg_hr: null,
  max_hr: null,
  hr_zones: [],
  splits: [],
  client_updated_at: cua,
  sets: [
    {
      exercise_id: "bench-press",
      position: 0,
      set_index: 0,
      superset: null,
      kind: "work" as const,
      weight_kg: 60,
      reps: 5,
      rpe: null,
      duration_sec: null,
      distance_m: null,
      completed: true,
    },
  ],
});

describe("training budgets on the heavy user", () => {
  it("reads in one round trip and writes a workout in three", async () => {
    const p = await heavy();
    const read = jobCtx();
    const a = authedBatch(read.db, p);
    const page = await w.changes(read, a, 0, 200);
    expect(read.stats.roundTrips).toBe(1);
    expect(page.body().workouts).toHaveLength(200);
    expect(page.body().more).toBe(true);
    const list = jobCtx();
    expect(await w.list(list, authedBatch(list.db, p), { limit: 100 })).toHaveLength(100);
    expect(list.stats.roundTrips).toBe(1);
    const last = jobCtx();
    await w.last(last, authedBatch(last.db, p), "bench_press,squat");
    expect(last.stats.roundTrips).toBe(1);

    const put = jobCtx();
    const now = put.clock.now();
    const r = await w.putWorkout(
      put,
      authedBatch(put.db, p),
      crypto.randomUUID(),
      body(now - 3_600_000, now),
    );
    expect(r.applied).toBe(true);
    expect(put.stats.roundTrips).toBe(3);

    const batch = jobCtx();
    const ops = Array.from({ length: 50 }, (_, i) => ({
      op: "put" as const,
      id: crypto.randomUUID(),
      workout: body(now - (i + 2) * 3_600_000, now),
      client_updated_at: now,
    }));
    const res = await w.batch(batch, authedBatch(batch.db, p), { ops });
    expect(res.results.every((x) => x.ok && "applied" in x && x.applied)).toBe(true);
    expect(batch.stats.roundTrips).toBe(3);
    // One JSON upsert for all 50 rows, not 50 statements.
    expect(batch.stats.statements).toBeLessThan(80);
  }, 120_000);
});

describe("workout writes", () => {
  it("a write that lost a race re-reads and applies on top of the newer row", async () => {
    const { user: p } = await authed();
    const ctx = jobCtx();
    const id = crypto.randomUUID();
    const now = ctx.clock.now();
    await w.putWorkout(ctx, authedBatch(ctx.db, p), id, body(now - 3_600_000, now - 1000));
    // Another device bumps the row between this request's read and its write: simulate by editing seq.
    const racing = jobCtx();
    const read = authedBatch(racing.db, p);
    const origRead = read.read.bind(read);
    let once = true;
    read.read = (async (...stmts: Parameters<typeof origRead>) => {
      const out = await origRead(...stmts);
      if (once) {
        once = false;
        await testDb().db.update(workouts).set({ seq: 999_999_999 }).where(eq(workouts.id, id));
      }
      return out;
    }) as typeof read.read;
    const r = await w.putWorkout(racing, read, id, { ...body(now - 3_600_000, now), title: "Second" });
    expect(r.applied).toBe(true);
    expect(r.workout.title).toBe("Second");
  });
});

describe("import helpers", () => {
  it("make Python's uuid5 ids from Python's isoformat", async () => {
    expect(pyIsoUtc(Date.UTC(2026, 4, 1, 7))).toBe("2026-05-01T07:00:00+00:00");
    expect(pyIsoUtc(Date.UTC(2026, 4, 1, 7, 0, 0, 120))).toBe("2026-05-01T07:00:00.120000+00:00");
    // python -c "import uuid; print(uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org'))"
    expect(await uuid5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
  });

  it("match library names the way the Python matcher did", () => {
    expect(matchExercise("Bench Press (Barbell)", EXERCISES)).toBe("bench-press");
    expect(matchExercise("Squat (Barbell)", EXERCISES)).toBe("back-squat");
    expect(matchExercise("Cable Thing Nobody Has (Cable)", EXERCISES)).toBeNull();
  });
});
