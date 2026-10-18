/**
 * Gear, gyms, exercise notes, the weight goal, training blocks, readiness, reflections, monthly goals and rest
 * days (spec/training-a.md §1.10, training-b.md §1c-§1d). All private to their owner.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { CUSTOM_PREFIX, EXERCISE_BY_ID } from "../../catalog/exercises.ts";
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, abortUnless, isCondAbort, type Stmt } from "../../db/batch.ts";
import {
  exerciseNotes,
  gear,
  gyms,
  monthlyGoals,
  readiness,
  restDays,
  trainingBlocks,
  weekReflections,
  weightGoals,
} from "../../db/schema/index.ts";
import { conflict, HttpError, notFound } from "../../lib/errors.ts";
import { pyRound } from "../../lib/format.ts";
import { addDays, daysBetween, localDate, toWire, weekStart } from "../../lib/time.ts";
import { UUID_RE, uuid7 } from "../../lib/uuid7.ts";
import * as repo from "./repo.ts";
import type { BlockInput, GearInput, GearPatchInput, GymInput } from "./schemas.ts";
import { profileOf } from "./workouts.ts";

const today = (ctx: Ctx, prof: Parameters<typeof profileOf>[0]) => {
  const p = profileOf(prof);
  return { p, today: localDate(ctx.clock.now(), p.timezone) };
};

// ---- gear -----------------------------------------------------------------------------------------------------

export const MAX_GEAR = 30;
type GearRow = typeof gear.$inferSelect;
type Usage = { dist: number; n: number; last: string | null };

export function gearOut(g: GearRow, usage: Usage | undefined) {
  const logged = usage?.dist ?? 0;
  const total = g.initialM + logged;
  return {
    id: g.id,
    name: g.name,
    kind: g.kind,
    default_for: g.defaultFor,
    limit_km: g.limitM ? pyRound(g.limitM / 1000, 1) : null,
    initial_km: pyRound(g.initialM / 1000, 1),
    distance_m: pyRound(total, 1),
    sessions: usage?.n ?? 0,
    last_used: usage?.last ?? null,
    worn: g.limitM ? pyRound(total / g.limitM, 3) : null,
    retired: g.retiredAt !== null,
    retired_at: toWire(g.retiredAt),
    note: g.note,
  };
}

const usageMap = (rows: readonly { gear_id: string; dist: number; n: number; last: string | null }[]) =>
  new Map(rows.map((r) => [r.gear_id, { dist: r.dist, n: r.n, last: r.last }]));

export async function listGear(ctx: Ctx, authed: AuthedBatch) {
  const [, rows, usage] = await authed.read(
    repo.listGear(ctx.db, authed.userId),
    repo.gearUsage(ctx.db, authed.userId),
  );
  const u = usageMap(usage);
  return rows.map((g) => gearOut(g, u.get(g.id)));
}

/** One default per discipline: the gear just saved takes it from every other item. */
function claimDefaults(db: Ctx["db"], others: readonly GearRow[], mine: GearRow, now: number): Stmt[] {
  if (mine.defaultFor.length === 0) return [];
  const out: Stmt[] = [];
  for (const o of others) {
    if (o.id === mine.id) continue;
    const kept = o.defaultFor.filter((d) => !mine.defaultFor.includes(d));
    if (kept.length !== o.defaultFor.length)
      out.push(db.update(gear).set({ defaultFor: kept, updatedAt: now }).where(eq(gear.id, o.id)));
  }
  return out;
}

export async function createGear(ctx: Ctx, authed: AuthedBatch, body: GearInput) {
  const [, rows] = await authed.read(repo.listGear(ctx.db, authed.userId));
  if (rows.length >= MAX_GEAR) throw conflict(`${MAX_GEAR} items is the limit. Delete a retired one first.`);
  const now = ctx.clock.now();
  const g: GearRow = {
    id: uuid7(now),
    createdAt: now,
    updatedAt: now,
    userId: authed.userId,
    name: body.name.trim(),
    kind: body.kind,
    defaultFor: body.default_for,
    limitM: body.limit_km ? body.limit_km * 1000 : null,
    initialM: body.initial_km * 1000,
    retiredAt: null,
    note: (body.note ?? "").trim() || null,
  };
  await authed.write(ctx.db.insert(gear).values(g), ...claimDefaults(ctx.db, rows, g, now));
  return gearOut(g, undefined);
}

export async function updateGear(ctx: Ctx, authed: AuthedBatch, id: string, body: GearPatchInput) {
  const [, rows, usage] = await authed.read(
    repo.listGear(ctx.db, authed.userId),
    repo.gearUsage(ctx.db, authed.userId),
  );
  const cur = rows.find((r) => r.id === id);
  if (cur === undefined) throw notFound("Not found");
  const now = ctx.clock.now();
  const g: GearRow = { ...cur, updatedAt: now };
  if (body.name != null) g.name = body.name.trim();
  if (body.kind != null) g.kind = body.kind;
  if (body.limit_km !== undefined) g.limitM = body.limit_km ? body.limit_km * 1000 : null;
  if (body.initial_km != null) g.initialM = body.initial_km * 1000;
  if (body.note !== undefined) g.note = (body.note ?? "").trim() || null;
  if (body.retired != null) g.retiredAt = body.retired ? now : null;
  if (body.default_for != null) g.defaultFor = body.default_for;
  // Retired gear is never picked for a new session.
  if (g.retiredAt !== null) g.defaultFor = [];
  await authed.write(
    ctx.db
      .update(gear)
      .set({
        name: g.name,
        kind: g.kind,
        limitM: g.limitM,
        initialM: g.initialM,
        note: g.note,
        retiredAt: g.retiredAt,
        defaultFor: g.defaultFor,
        updatedAt: now,
      })
      .where(and(eq(gear.id, id), eq(gear.userId, authed.userId))),
    ...claimDefaults(ctx.db, rows, g, now),
  );
  return gearOut(g, usageMap(usage).get(id));
}

/** Sessions that used it keep everything but the link (FK `ON DELETE SET NULL`). */
export async function deleteGear(ctx: Ctx, authed: AuthedBatch, id: string) {
  const [rows] = await authed.write(
    ctx.db
      .delete(gear)
      .where(and(eq(gear.id, id), eq(gear.userId, authed.userId)))
      .returning({ id: gear.id }),
  );
  if (rows.length === 0) throw notFound("Not found");
}

// ---- gyms -----------------------------------------------------------------------------------------------------

export const MAX_GYMS = 10;
type GymRow = typeof gyms.$inferSelect;

export const gymOut = (g: GymRow) => ({
  id: g.id,
  name: g.name,
  equipment: g.equipment,
  plates_kg: g.platesKg,
  bar_kg: g.barKg,
  is_default: g.isDefault,
});

export async function listGyms(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.listGyms(ctx.db, authed.userId));
  return rows.map(gymOut);
}

const gymValues = (b: GymInput) => ({
  name: b.name.trim(),
  equipment: b.equipment,
  platesKg: b.plates_kg,
  barKg: b.bar_kg,
  isDefault: b.is_default,
});

export async function createGym(ctx: Ctx, authed: AuthedBatch, body: GymInput) {
  const [, rows] = await authed.read(repo.listGyms(ctx.db, authed.userId));
  if (rows.length >= MAX_GYMS) throw conflict(`${MAX_GYMS} gyms is the limit`);
  const now = ctx.clock.now();
  // The first gym is the default one; nobody should have to say so.
  const g: GymRow = {
    id: uuid7(now),
    createdAt: now,
    updatedAt: now,
    userId: authed.userId,
    ...gymValues(body),
    isDefault: body.is_default || rows.length === 0,
  };
  const stmts: [Stmt, ...Stmt[]] = [ctx.db.insert(gyms).values(g)];
  if (g.isDefault) stmts.push(repo.clearOtherDefaults(ctx.db, authed.userId, g.id, now));
  await authed.write(...stmts);
  return gymOut(g);
}

export async function updateGym(ctx: Ctx, authed: AuthedBatch, id: string, body: GymInput) {
  const now = ctx.clock.now();
  const stmts: [Stmt, ...Stmt[]] = [
    ctx.db
      .update(gyms)
      .set({ ...gymValues(body), updatedAt: now })
      .where(and(eq(gyms.id, id), eq(gyms.userId, authed.userId)))
      .returning(),
  ];
  if (body.is_default)
    stmts.push(
      ctx.db
        .update(gyms)
        .set({ isDefault: false, updatedAt: now })
        .where(
          and(
            eq(gyms.userId, authed.userId),
            ne(gyms.id, id),
            sql`EXISTS (SELECT 1 FROM gyms g WHERE g.id = ${id} AND g.user_id = ${authed.userId})`,
          ),
        ),
    );
  const [rows] = (await authed.write(...stmts)) as [GymRow[]];
  const g = rows[0];
  if (g === undefined) throw notFound("Not found");
  return gymOut(g);
}

export async function deleteGym(ctx: Ctx, authed: AuthedBatch, id: string) {
  const [rows] = await authed.write(
    ctx.db
      .delete(gyms)
      .where(and(eq(gyms.id, id), eq(gyms.userId, authed.userId)))
      .returning({ id: gyms.id }),
  );
  if (rows.length === 0) throw notFound("Not found");
}

// ---- exercise notes -------------------------------------------------------------------------------------------

export async function listNotes(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.notes(ctx.db, authed.userId));
  return Object.fromEntries(rows.map((n) => [n.exerciseId, n.note]));
}

/** Set the note that stays with an exercise; empty removes it. One round trip (custom ids guard their owner). */
export async function putNote(ctx: Ctx, authed: AuthedBatch, exerciseId: string, note: string) {
  const uid = authed.userId;
  const stmts: Stmt[] = [];
  if (!EXERCISE_BY_ID.has(exerciseId)) {
    const raw = exerciseId.startsWith(CUSTOM_PREFIX)
      ? exerciseId.slice(CUSTOM_PREFIX.length).toLowerCase()
      : "";
    if (!UUID_RE.test(raw)) throw notFound("No such exercise");
    stmts.push(
      abortUnless(
        ctx.db,
        sql`EXISTS (SELECT 1 FROM custom_exercises WHERE id = ${raw} AND user_id = ${uid})`,
      ),
    );
  }
  const text = note.trim();
  const now = ctx.clock.now();
  const mine = and(eq(exerciseNotes.userId, uid), eq(exerciseNotes.exerciseId, exerciseId));
  stmts.push(
    text === ""
      ? ctx.db.delete(exerciseNotes).where(mine)
      : ctx.db
          .insert(exerciseNotes)
          .values({ id: uuid7(now), userId: uid, exerciseId, note: text, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: [exerciseNotes.userId, exerciseNotes.exerciseId],
            set: { note: text, updatedAt: now },
          }),
  );
  try {
    await authed.write(...(stmts as [Stmt, ...Stmt[]]));
  } catch (err) {
    if (isCondAbort(err)) throw notFound("No such exercise");
    throw err;
  }
  return { exercise_id: exerciseId, note: text === "" ? null : text };
}

// ---- weight goal ----------------------------------------------------------------------------------------------

type GoalRow = typeof weightGoals.$inferSelect;
const goalOut = (g: GoalRow) => ({
  target_kg: g.targetKg,
  start_kg: g.startKg,
  milestone_kg: g.milestoneKg,
  set_on: g.setOn,
});

export async function getGoal(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.goal(ctx.db, authed.userId));
  return rows[0] === undefined ? null : goalOut(rows[0]);
}

/** Starts from the last week's average weigh-in, so progress is measured from the trend. */
export async function putGoal(ctx: Ctx, authed: AuthedBatch, targetKg: number, milestoneKg: number) {
  const now = ctx.clock.now();
  // A local date is within a day of UTC: read a day wider, then keep the local week.
  const utc = new Date(now).toISOString().slice(0, 10);
  const [, prof, rows] = await authed.read(
    repo.profile(ctx.db, authed.userId),
    repo.weighInsSince(ctx.db, authed.userId, addDays(utc, -8)),
  );
  const { today: day } = today(ctx, prof);
  const week = rows.filter((w) => w.localDate > addDays(day, -7));
  if (week.length === 0) throw conflict("Weigh in first, so the goal has somewhere to start");
  const avg = week.reduce((n, w) => n + w.weightKg, 0) / week.length;
  const values = { targetKg: pyRound(targetKg, 2), milestoneKg, startKg: pyRound(avg, 2), setOn: day };
  const [saved] = await authed.write(
    ctx.db
      .insert(weightGoals)
      .values({ id: uuid7(now), userId: authed.userId, createdAt: now, updatedAt: now, ...values })
      .onConflictDoUpdate({ target: weightGoals.userId, set: { ...values, updatedAt: now } })
      .returning(),
  );
  return goalOut(saved[0] as GoalRow);
}

export async function deleteGoal(ctx: Ctx, authed: AuthedBatch) {
  await authed.write(ctx.db.delete(weightGoals).where(eq(weightGoals.userId, authed.userId)));
}

// ---- training blocks ------------------------------------------------------------------------------------------

type BlockRow = typeof trainingBlocks.$inferSelect;
type BlockLike = Pick<BlockRow, "startsOn" | "weeks" | "rirStart" | "rirEnd" | "endedAt">;

/** Where today falls in a block, or null before it or after it (Python `block_week`). */
export function blockWeek(b: BlockLike, day: string) {
  const index = Math.floor(daysBetween(b.startsOn, day) / 7);
  if (index < 0 || index >= b.weeks || b.endedAt !== null) return null;
  const working = b.weeks - 1;
  const deload = index === working;
  let rir: number;
  if (deload) rir = Math.max(b.rirStart + 1, 4);
  else if (working === 1) rir = b.rirStart;
  else rir = pyRound(b.rirStart - ((b.rirStart - b.rirEnd) / (working - 1)) * index);
  return { week: index + 1, weeks: b.weeks, deload, rir };
}

export function blockOut(b: BlockRow, day: string) {
  return {
    id: b.id,
    name: b.name,
    starts_on: b.startsOn,
    weeks: b.weeks,
    rir_start: b.rirStart,
    rir_end: b.rirEnd,
    ended: b.endedAt !== null || daysBetween(b.startsOn, day) >= b.weeks * 7,
    now: blockWeek(b, day),
  };
}

export async function activeBlock(ctx: Ctx, authed: AuthedBatch) {
  const [, prof, rows] = await authed.read(
    repo.profile(ctx.db, authed.userId),
    repo.liveBlocks(ctx.db, authed.userId),
  );
  const { today: day } = today(ctx, prof);
  for (const b of rows) {
    const out = blockOut(b, day);
    if (!out.ended) return out;
  }
  return null;
}

export async function startBlock(ctx: Ctx, authed: AuthedBatch, body: BlockInput) {
  if (body.rir_end > body.rir_start) throw new HttpError(422, "Reps in reserve should fall, not rise");
  const [, prof] = await authed.read(repo.profile(ctx.db, authed.userId));
  const { p, today: day } = today(ctx, prof);
  const now = ctx.clock.now();
  const b: BlockRow = {
    id: uuid7(now),
    createdAt: now,
    updatedAt: now,
    userId: authed.userId,
    name: body.name.trim(),
    startsOn: addDays(weekStart(day, p.weekStartsOn), body.when === "next" ? 7 : 0),
    weeks: body.weeks,
    rirStart: body.rir_start,
    rirEnd: body.rir_end,
    endedAt: null,
  };
  // One block at a time: starting one ends the last.
  await authed.write(
    ctx.db
      .update(trainingBlocks)
      .set({ endedAt: now, updatedAt: now })
      .where(and(eq(trainingBlocks.userId, authed.userId), sql`${trainingBlocks.endedAt} IS NULL`)),
    ctx.db.insert(trainingBlocks).values(b),
  );
  return blockOut(b, day);
}

export async function endBlock(ctx: Ctx, authed: AuthedBatch, id: string) {
  const now = ctx.clock.now();
  const [rows] = await authed.write(
    ctx.db
      .update(trainingBlocks)
      .set({ endedAt: sql`coalesce(${trainingBlocks.endedAt}, ${now})`, updatedAt: now })
      .where(and(eq(trainingBlocks.id, id), eq(trainingBlocks.userId, authed.userId)))
      .returning({ id: trainingBlocks.id }),
  );
  if (rows.length === 0) throw notFound("Not found");
}

// ---- readiness ------------------------------------------------------------------------------------------------

type ReadinessRow = typeof readiness.$inferSelect;
const readinessOut = (r: ReadinessRow) => ({
  date: r.day,
  sleep: r.sleep,
  energy: r.energy,
  soreness: r.soreness,
});

export async function listReadiness(ctx: Ctx, authed: AuthedBatch, days: number) {
  const n = Math.max(1, Math.min(days, 365));
  const utc = new Date(ctx.clock.now()).toISOString().slice(0, 10);
  const [, prof, rows] = await authed.read(
    repo.profile(ctx.db, authed.userId),
    repo.readinessSince(ctx.db, authed.userId, addDays(utc, -n - 1)),
  );
  const since = addDays(today(ctx, prof).today, -n);
  return rows.filter((r) => r.day >= since).map(readinessOut);
}

export async function putReadiness(
  ctx: Ctx,
  authed: AuthedBatch,
  day: string,
  body: { sleep: number; energy: number; soreness: number },
) {
  const [, prof] = await authed.read(repo.profile(ctx.db, authed.userId));
  const { today: t } = today(ctx, prof);
  if (day < addDays(t, -2) || day > t)
    throw new HttpError(422, "Check-ins are for today or the last two days");
  const now = ctx.clock.now();
  const [rows] = await authed.write(
    ctx.db
      .insert(readiness)
      .values({ id: uuid7(now), userId: authed.userId, day, ...body, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [readiness.userId, readiness.day], set: { ...body, updatedAt: now } })
      .returning(),
  );
  return readinessOut(rows[0] as ReadinessRow);
}

// ---- reflections ----------------------------------------------------------------------------------------------

type ReflectionRow = typeof weekReflections.$inferSelect;
const reflectionOut = (r: ReflectionRow) => ({
  week_start: r.weekStart,
  went_well: r.wentWell,
  change: r.change,
});

export async function listReflections(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.reflections(ctx.db, authed.userId));
  return rows.map(reflectionOut);
}

/** One per week; both fields empty removes it. */
export async function putReflection(
  ctx: Ctx,
  authed: AuthedBatch,
  week: string,
  body: { went_well: string | null; change: string | null },
) {
  const [, prof] = await authed.read(repo.profile(ctx.db, authed.userId));
  const { p, today: t } = today(ctx, prof);
  const start = weekStart(week, p.weekStartsOn);
  if (start > t) throw new HttpError(422, "That week hasn't started");
  const wentWell = (body.went_well ?? "").trim() || null;
  const change = (body.change ?? "").trim() || null;
  const mine = and(eq(weekReflections.userId, authed.userId), eq(weekReflections.weekStart, start));
  if (wentWell === null && change === null) {
    await authed.write(ctx.db.delete(weekReflections).where(mine));
    return null;
  }
  const now = ctx.clock.now();
  const [rows] = await authed.write(
    ctx.db
      .insert(weekReflections)
      .values({
        id: uuid7(now),
        userId: authed.userId,
        weekStart: start,
        wentWell,
        change,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [weekReflections.userId, weekReflections.weekStart],
        set: { wentWell, change, updatedAt: now },
      })
      .returning(),
  );
  return reflectionOut(rows[0] as ReflectionRow);
}

// ---- monthly goal and rest days (Python training/habits.py) ---------------------------------------------------

function bounds(month: string): [string, string] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = `${month}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return [first, addDays(next, -1)];
}

async function goalView(ctx: Ctx, authed: AuthedBatch, month: string | undefined) {
  // Without a month the local date decides it; read the month on both sides of UTC and pick after.
  const utc = new Date(ctx.clock.now()).toISOString().slice(0, 10);
  const candidates =
    month === undefined
      ? [...new Set([addDays(utc, -1), utc, addDays(utc, 1)].map((d) => d.slice(0, 7)))]
      : [month];
  const reads = candidates.flatMap((m) => {
    const [first, last] = bounds(m);
    return [
      repo.monthGoal(ctx.db, authed.userId, m),
      repo.activeDays(ctx.db, authed.userId, first, last),
    ] as const;
  });
  const [, prof, ...rest] = await authed.read(repo.profile(ctx.db, authed.userId), ...reads);
  const t = today(ctx, prof).today;
  const m = month ?? t.slice(0, 7);
  const i = candidates.indexOf(m);
  const [first, last] = bounds(m);
  const goal = (rest[2 * i] as { days: number }[])[0]?.days ?? null;
  // Days after today never count (Python capped the range at today); recount only when the month is current.
  let done = (rest[2 * i + 1] as { n: number }[])[0]?.n ?? 0;
  if (t < last && t >= first) {
    const [, capped] = await authed.read(repo.activeDays(ctx.db, authed.userId, first, t));
    done = capped[0]?.n ?? 0;
  } else if (t < first) done = 0;
  const daysLeft = t > last ? 0 : daysBetween(t > first ? t : first, last) + 1;
  return {
    month: m,
    goal,
    done,
    days_in_month: Number(last.slice(8, 10)),
    days_left: daysLeft,
    reachable: goal === null || done + daysLeft >= goal,
  };
}

export const getMonthGoal = goalView;

export async function setMonthGoal(ctx: Ctx, authed: AuthedBatch, month: string, days: number) {
  const [, last] = bounds(month);
  const n = Number(last.slice(8, 10));
  if (days > n) throw new HttpError(422, `${month} has ${n} days`);
  const [, prof] = await authed.read(repo.profile(ctx.db, authed.userId));
  const t = today(ctx, prof).today;
  if (last < `${t.slice(0, 7)}-01`) throw new HttpError(422, "That month is over");
  const now = ctx.clock.now();
  await authed.write(
    ctx.db
      .insert(monthlyGoals)
      .values({ id: uuid7(now), userId: authed.userId, month, days, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [monthlyGoals.userId, monthlyGoals.month],
        set: { days, updatedAt: now },
      }),
  );
  return goalView(ctx, authed, month);
}

export async function clearMonthGoal(ctx: Ctx, authed: AuthedBatch, month: string) {
  await authed.write(
    ctx.db
      .delete(monthlyGoals)
      .where(and(eq(monthlyGoals.userId, authed.userId), eq(monthlyGoals.month, month))),
  );
}

export const REST_BACK_DAYS = 365;
export const REST_AHEAD_DAYS = 7;

export async function listRestDays(ctx: Ctx, authed: AuthedBatch, from: string | undefined) {
  const utc = new Date(ctx.clock.now()).toISOString().slice(0, 10);
  const [, prof, rows] = await authed.read(
    repo.profile(ctx.db, authed.userId),
    repo.restDaysSince(ctx.db, authed.userId, from ?? addDays(utc, -REST_BACK_DAYS - 1)),
  );
  const start = from ?? addDays(today(ctx, prof).today, -REST_BACK_DAYS);
  return rows.filter((r) => r.day >= start);
}

export async function putRestDay(
  ctx: Ctx,
  authed: AuthedBatch,
  day: string,
  kind: string,
  note: string | null,
) {
  const [, prof] = await authed.read(repo.profile(ctx.db, authed.userId));
  const t = today(ctx, prof).today;
  if (day > addDays(t, REST_AHEAD_DAYS) || day < addDays(t, -REST_BACK_DAYS))
    throw new HttpError(422, `Rest days can be logged up to ${REST_AHEAD_DAYS} days ahead and a year back`);
  const now = ctx.clock.now();
  const k = kind as (typeof restDays.$inferInsert)["kind"] & string;
  const [rows] = await authed.write(
    ctx.db
      .insert(restDays)
      .values({ id: uuid7(now), userId: authed.userId, day, kind: k, note, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [restDays.userId, restDays.day], set: { kind: k, note, updatedAt: now } })
      .returning({ day: restDays.day, kind: restDays.kind, note: restDays.note }),
  );
  return rows[0];
}

export async function deleteRestDay(ctx: Ctx, authed: AuthedBatch, day: string) {
  await authed.write(
    ctx.db.delete(restDays).where(and(eq(restDays.userId, authed.userId), eq(restDays.day, day))),
  );
}
