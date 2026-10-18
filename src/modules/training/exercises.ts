/** Custom exercises and routines (spec/training-a.md §1.4-§1.5). */
import { and, eq, sql } from "drizzle-orm";
import { CUSTOM_PREFIX, EXERCISE_BY_ID, ROUTINE_TEMPLATE_BY_ID } from "../../catalog/exercises.ts";
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, abortUnless, isCondAbort, withFold, withFoldPatch } from "../../db/batch.ts";
import { customExercises, routines } from "../../db/schema/index.ts";
import { conflict, HttpError, notFound } from "../../lib/errors.ts";
import { toWire } from "../../lib/time.ts";
import { UUID_RE, uuid7 } from "../../lib/uuid7.ts";
import * as repo from "./repo.ts";
import type { CustomExerciseInput, RoutineInput } from "./schemas.ts";

export const MAX_CUSTOMS = 300;
export const MAX_ROUTINES = 100;

type CustomRow = typeof customExercises.$inferSelect;
type RoutineRow = typeof routines.$inferSelect;

export function customOut(c: CustomRow) {
  return {
    id: `${CUSTOM_PREFIX}${c.id}`,
    name: c.name,
    pattern: c.pattern,
    equipment: c.equipment,
    primary: c.primary,
    secondary: c.secondary,
    load_type: c.loadType,
    rest_sec: c.restSec,
    unilateral: c.unilateral,
    cue: c.cue,
    archived: c.archived,
    custom: true,
    aliases: [],
  };
}

export function routineOut(r: RoutineRow) {
  return {
    id: r.id,
    name: r.name,
    discipline: r.discipline,
    notes: r.notes,
    items: r.items,
    position: r.position,
    last_used_at: toWire(r.lastUsedAt),
    updated_at: toWire(r.updatedAt),
  };
}

/** `custom-<uuid>` (or a bare uuid, like Python's `removeprefix`) -> uuid, else 404. */
function customId(raw: string): string {
  const id = (raw.startsWith(CUSTOM_PREFIX) ? raw.slice(CUSTOM_PREFIX.length) : raw).toLowerCase();
  if (!UUID_RE.test(id)) throw notFound("Not found");
  return id;
}

const customValues = (b: CustomExerciseInput) => ({
  name: b.name,
  pattern: b.pattern,
  equipment: b.equipment,
  primary: b.primary,
  secondary: b.secondary,
  loadType: b.load_type,
  restSec: b.rest_sec,
  unilateral: b.unilateral,
  cue: b.cue,
});

export async function listCustom(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.listCustoms(ctx.db, authed.userId));
  return rows.map(customOut);
}

/** One round trip: the limit is a guard in the insert's own batch. */
export async function createCustom(ctx: Ctx, authed: AuthedBatch, body: CustomExerciseInput) {
  const now = ctx.clock.now();
  try {
    const [, rows] = await authed.write(
      abortUnless(
        ctx.db,
        sql`(SELECT count(*) FROM custom_exercises WHERE user_id = ${authed.userId}) < ${MAX_CUSTOMS}`,
      ),
      ctx.db
        .insert(customExercises)
        .values(
          withFold(customExercises, {
            id: uuid7(now),
            userId: authed.userId,
            createdAt: now,
            updatedAt: now,
            archived: false,
            ...customValues(body),
          }),
        )
        .returning(),
    );
    return customOut(rows[0] as CustomRow);
  } catch (err) {
    if (isCondAbort(err)) throw conflict("That is a lot of custom exercises");
    throw err;
  }
}

export async function updateCustom(ctx: Ctx, authed: AuthedBatch, raw: string, body: CustomExerciseInput) {
  const id = customId(raw);
  const now = ctx.clock.now();
  const [rows] = await authed.write(
    ctx.db
      .update(customExercises)
      .set(withFoldPatch(customExercises, { ...customValues(body), updatedAt: now }))
      .where(and(eq(customExercises.id, id), eq(customExercises.userId, authed.userId)))
      .returning(),
  );
  const row = rows[0];
  if (row === undefined) throw notFound("Not found");
  return customOut(row);
}

/** History still names it by id: a used exercise is archived, an unused one deleted. One round trip. */
export async function deleteCustom(ctx: Ctx, authed: AuthedBatch, raw: string) {
  const id = customId(raw);
  const uid = authed.userId;
  const used = sql`EXISTS (SELECT 1 FROM workout_sets WHERE user_id = ${uid} AND exercise_id = ${`${CUSTOM_PREFIX}${id}`})`;
  const mine = and(eq(customExercises.id, id), eq(customExercises.userId, uid));
  const [archived, deleted] = await authed.write(
    ctx.db
      .update(customExercises)
      .set({ archived: true, updatedAt: ctx.clock.now() })
      .where(and(mine, used))
      .returning({ id: customExercises.id }),
    ctx.db
      .delete(customExercises)
      .where(and(mine, sql`NOT ${used}`))
      .returning({ id: customExercises.id }),
  );
  if (archived.length === 0 && deleted.length === 0) throw notFound("Not found");
}

// ---- routines -------------------------------------------------------------------------------------------------

/** Library ids, plus `custom-<uuid>` the caller owns; null when no custom id needs a read. */
export function unknownExercise(ids: Iterable<string>, owned: ReadonlySet<string>): string | null {
  const unknown = [...new Set(ids)].filter((e) => !EXERCISE_BY_ID.has(e) && !owned.has(e)).sort();
  return unknown[0] ?? null;
}

export function customIdsIn(ids: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const e of ids) {
    if (!e.startsWith(CUSTOM_PREFIX)) continue;
    const raw = e.slice(CUSTOM_PREFIX.length).toLowerCase();
    if (UUID_RE.test(raw)) out.add(raw);
  }
  return [...out];
}

export async function listRoutines(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.listRoutines(ctx.db, authed.userId));
  return rows.map(routineOut);
}

async function checkItems(ctx: Ctx, authed: AuthedBatch, body: RoutineInput, routineId?: string) {
  const ids = body.items.map((i) => i.exercise_id);
  const customs = customIdsIn(ids);
  if (customs.length === 0 && routineId === undefined) {
    const bad = unknownExercise(ids, new Set());
    if (bad !== null) throw new HttpError(422, `Unknown exercise: ${bad}`);
    return;
  }
  const [, owned, own] = await authed.read(
    repo.customsByIds(ctx.db, authed.userId, customs),
    repo.routineById(ctx.db, authed.userId, routineId ?? ""),
  );
  if (routineId !== undefined && own.length === 0) throw notFound("Not found");
  const bad = unknownExercise(ids, new Set(owned.map((c) => `${CUSTOM_PREFIX}${c.id}`)));
  if (bad !== null) throw new HttpError(422, `Unknown exercise: ${bad}`);
}

const routineValues = (b: RoutineInput) => ({
  name: b.name,
  discipline: b.discipline,
  notes: b.notes,
  items: b.items as Record<string, unknown>[],
  position: b.position,
});

export async function createRoutine(ctx: Ctx, authed: AuthedBatch, body: RoutineInput) {
  await checkItems(ctx, authed, body);
  const now = ctx.clock.now();
  try {
    const [, rows] = await authed.write(
      abortUnless(
        ctx.db,
        sql`(SELECT count(*) FROM routines WHERE user_id = ${authed.userId}) < ${MAX_ROUTINES}`,
      ),
      ctx.db
        .insert(routines)
        .values(
          withFold(routines, {
            id: uuid7(now),
            userId: authed.userId,
            createdAt: now,
            updatedAt: now,
            ...routineValues(body),
          }),
        )
        .returning(),
    );
    return routineOut(rows[0] as RoutineRow);
  } catch (err) {
    if (isCondAbort(err)) throw conflict("Routine limit reached");
    throw err;
  }
}

export async function routineFromTemplate(ctx: Ctx, authed: AuthedBatch, templateId: string) {
  const t = ROUTINE_TEMPLATE_BY_ID.get(templateId);
  if (t === undefined) throw notFound("No such template");
  const now = ctx.clock.now();
  const [rows] = await authed.write(
    ctx.db
      .insert(routines)
      .values(
        withFold(routines, {
          id: uuid7(now),
          userId: authed.userId,
          createdAt: now,
          updatedAt: now,
          name: t.name,
          discipline: t.discipline,
          notes: t.summary,
          items: t.items.map((i) => ({ ...i })),
          position: 0,
        }),
      )
      .returning(),
  );
  return routineOut(rows[0] as RoutineRow);
}

export async function updateRoutine(ctx: Ctx, authed: AuthedBatch, id: string, body: RoutineInput) {
  await checkItems(ctx, authed, body, id);
  const [rows] = await authed.write(
    ctx.db
      .update(routines)
      .set(withFoldPatch(routines, { ...routineValues(body), updatedAt: ctx.clock.now() }))
      .where(and(eq(routines.id, id), eq(routines.userId, authed.userId)))
      .returning(),
  );
  const row = rows[0];
  if (row === undefined) throw notFound("Not found");
  return routineOut(row);
}

export async function deleteRoutine(ctx: Ctx, authed: AuthedBatch, id: string) {
  const [rows] = await authed.write(
    ctx.db
      .delete(routines)
      .where(and(eq(routines.id, id), eq(routines.userId, authed.userId)))
      .returning({ id: routines.id }),
  );
  if (rows.length === 0) throw notFound("Not found");
}
