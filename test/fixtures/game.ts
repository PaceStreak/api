/**
 * Game fixtures: a signed-in, onboarded person (conftest `person`) and a workout write that does what the training
 * unit's write path does (rows, then `statRefresh` in the same batch, then `recompute`). Until TRAINING lands, the
 * ported tests put workouts through this instead of `PUT /v1/workouts/{id}`.
 */
import { eq } from "drizzle-orm";
import { runBatch, type Stmt } from "../../src/db/batch.ts";
import { profiles, workoutSets, workouts } from "../../src/db/schema/index.ts";
import { localParts } from "../../src/lib/time.ts";
import { uuid7 } from "../../src/lib/uuid7.ts";
import { recompute, statRefresh } from "../../src/modules/game/service.ts";
import { jobCtx } from "../jobs/helpers.ts";
import { type SignedIn, signup } from "./auth.ts";
import { testDb, uniqueEmail } from "./db.ts";

export interface Person extends SignedIn {
  handle: string;
}

let n = 0;

/** Sign up over HTTP, then onboard by writing the profile (PROFILE-ACCOUNT owns the real onboarding route). */
export async function person(
  opts: { handle?: string; timezone?: string; birthYear?: number } = {},
): Promise<Person> {
  const me = await signup(uniqueEmail("game"));
  const handle = opts.handle ?? `p${Date.now().toString(36)}${n++}`;
  const { db } = testDb();
  const now = Date.now();
  await db
    .insert(profiles)
    .values({
      userId: me.userId,
      handle,
      handleFold: handle,
      timezone: opts.timezone ?? "UTC",
      birthYear: opts.birthYear ?? 1990,
      onboardedAt: now,
      acceptedTermsAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  return { ...me, handle };
}

export async function setProfile(
  userId: string,
  values: Partial<typeof profiles.$inferInsert>,
): Promise<void> {
  await testDb().db.update(profiles).set(values).where(eq(profiles.userId, userId));
}

export interface SetIn {
  exercise_id: string;
  weight_kg?: number | null;
  reps?: number | null;
  rpe?: number | null;
  duration_sec?: number | null;
  kind?: "work" | "warmup" | "drop" | "failure";
  completed?: boolean;
}

export interface WorkoutIn {
  id?: string;
  discipline?: string;
  startedAt?: number;
  localDate?: string;
  localHour?: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
  effort?: number | null;
  feel?: number | null;
  source?: "app" | "import";
  sets?: SetIn[];
}

/** test_training.py `workout()`: a strength session an hour ago with two sets of back squats. */
export const defaultSets = (): SetIn[] => [
  { exercise_id: "back-squat", weight_kg: 100, reps: 5, rpe: 8 },
  { exercise_id: "back-squat", weight_kg: 100, reps: 5 },
];

/** Inserts the workout and its sets, refreshes the aggregates in the same batch, then recomputes. */
export async function putWorkout(userId: string, w: WorkoutIn = {}, tz = "UTC") {
  const ctx = jobCtx();
  const now = ctx.clock.now();
  const startedAt = w.startedAt ?? now - 3_600_000;
  const local = localParts(startedAt, tz);
  const id = w.id ?? uuid7(now);
  const sets = w.sets ?? defaultSets();
  const discipline = w.discipline ?? "strength";
  const localDate = w.localDate ?? local.date;
  const stmts: Stmt[] = [
    ctx.db.insert(workouts).values({
      id,
      userId,
      discipline,
      startedAt,
      localDate,
      localHour: w.localHour === undefined ? local.hour : w.localHour,
      durationSec: w.durationSec === undefined ? 3600 : w.durationSec,
      distanceM: w.distanceM ?? null,
      effort: w.effort ?? null,
      feel: w.feel ?? null,
      source: w.source ?? "app",
      clientUpdatedAt: now,
      seq: 0,
      createdAt: now,
      updatedAt: now,
    }),
  ];
  if (sets.length > 0)
    stmts.push(
      ctx.db.insert(workoutSets).values(
        sets.map((s, i) => ({
          id: uuid7(now),
          workoutId: id,
          userId,
          exerciseId: s.exercise_id,
          position: 0,
          setIndex: i,
          kind: s.kind ?? "work",
          weightKg: s.weight_kg ?? null,
          reps: s.reps ?? null,
          rpe: s.rpe ?? null,
          durationSec: s.duration_sec ?? null,
          completed: s.completed ?? true,
          createdAt: now,
          updatedAt: now,
        })),
      ),
    );
  const exercises = [...new Set(sets.map((s) => s.exercise_id))];
  stmts.push(...statRefresh(ctx, userId, { dates: [localDate], exercises }));
  await runBatch(ctx.db, stmts);
  const outcome = await recompute(ctx, userId, {
    workoutId: id,
    scope: { exercises, disciplines: [discipline] },
  });
  return { id, localDate, outcome };
}

/** Soft-deletes a workout the way the training unit will: row change, refresh, recompute. */
export async function deleteWorkout(
  userId: string,
  id: string,
  localDate: string,
  exercises: string[],
  discipline: string,
) {
  const ctx = jobCtx();
  const now = ctx.clock.now();
  await runBatch(ctx.db, [
    ctx.db.update(workouts).set({ deletedAt: now, updatedAt: now }).where(eq(workouts.id, id)),
    ...statRefresh(ctx, userId, { dates: [localDate], exercises }),
  ]);
  return recompute(ctx, userId, { scope: { exercises, disciplines: [discipline] } });
}
