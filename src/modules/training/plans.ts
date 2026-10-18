/**
 * Training plans (spec/training-b.md §1b, §2a-§2j): a schedule of suggested sessions that reads the log to say
 * what is done. Every route is one or two round trips: the read, then the write together with the logged-session
 * read the view needs.
 */
import { and, eq } from "drizzle-orm";
import { DISCIPLINE_IDS, EXERCISE_BY_ID, ROUTINE_TEMPLATE_BY_ID } from "../../catalog/exercises.ts";
import { type CatalogPlanTemplate, PLAN_TEMPLATE_BY_ID } from "../../catalog/plan-templates.ts";
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, type Stmt, withFold } from "../../db/batch.ts";
import { type PlanSession, routines, trainingPlans } from "../../db/schema/index.ts";
import { conflict, HttpError, notFound } from "../../lib/errors.ts";
import { addDays, daysBetween, localDate, toWire, weekStart } from "../../lib/time.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import { buildRacePlan, RacePlanError } from "./race.ts";
import * as repo from "./repo.ts";
import {
  MAX_PER_WEEK,
  type PlanInput,
  PlanSession as PlanSessionSchema,
  type SharedPlanInput,
} from "./schemas.ts";
import { type ProfileRow, profileOf } from "./workouts.ts";

export const MAX_PLANS = 20;
export const PLAN_FORMAT = "pacestreak-plan";
const LIMIT = `${MAX_PLANS} plans is the limit. Delete an old one first.`;

export type PlanRow = typeof trainingPlans.$inferSelect;
type Session = Record<string, unknown> & { day: number; discipline: string };

// ---- the pure part --------------------------------------------------------------------------------------------

/** Statuses for one week (Python `match_week`): exact day first, then a same-kind session moved within the week. */
export function matchWeek(
  sessions: readonly Session[],
  ws: string,
  done: readonly (readonly [string, string])[],
  today: string,
): Record<string, unknown>[] {
  const remaining = [...done];
  const out = sessions.map((s) => ({ ...s }) as Record<string, unknown> & Session);
  for (const s of out) {
    const when = addDays(ws, s.day);
    s.date = when;
    const i = remaining.findIndex(([d, disc]) => d === when && disc === s.discipline);
    if (i >= 0) {
      remaining.splice(i, 1);
      s.status = "done";
      s.moved = false;
    }
  }
  for (const s of out) {
    if ("status" in s) continue;
    const i = remaining.findIndex(([, disc]) => disc === s.discipline);
    if (i >= 0) {
      remaining.splice(i, 1);
      s.status = "done";
      s.moved = true;
      continue;
    }
    const when = s.date as string;
    s.moved = false;
    s.status = when === today ? "today" : when > today ? "upcoming" : "skipped";
  }
  return out;
}

const floorDiv = (a: number, b: number) => Math.floor(a / b);

export function planPosition(plan: Pick<PlanRow, "startedOn">, today: string, wso: number): number | null {
  if (plan.startedOn === null) return null;
  return floorDiv(daysBetween(plan.startedOn, weekStart(today, wso)), 7);
}

function cycleStart(plan: PlanRow, index: number | null): string {
  const started = plan.startedOn as string;
  const length = plan.weeks.length || 1;
  if (!plan.repeat || index === null || index < length) return started;
  return addDays(started, 7 * (index - (((index % length) + length) % length)));
}

export function summary(plan: PlanRow) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    template_id: plan.templateId,
    weeks_count: plan.weeks.length,
    sessions_count: plan.weeks.reduce((n, w) => n + w.length, 0),
    started_on: plan.startedOn,
    finished_at: toWire(plan.finishedAt),
    active: plan.startedOn !== null && plan.finishedAt === null,
    repeat: plan.repeat,
  };
}

/** The range of logged sessions a started plan's view needs, or null when not started. */
export function viewRange(plan: PlanRow, today: string, wso: number): [string, string] | null {
  if (plan.startedOn === null) return null;
  const base = cycleStart(plan, planPosition(plan, today, wso));
  const end = addDays(base, 7 * plan.weeks.length - 1);
  return [base, end < today ? end : today];
}

/** The whole plan with a status on every session that has come due (Python `plan_view`). */
export function planView(
  plan: PlanRow,
  today: string,
  wso: number,
  logged: readonly { d: string; discipline: string }[],
) {
  const out = {
    ...summary(plan),
    weeks: plan.weeks as unknown[],
    challenge_id: plan.challengeId,
    assigned_by: plan.assignedBy,
  };
  if (plan.startedOn === null) return { ...out, current_week: null, today: [], progress: null };
  const weeks = plan.weeks as Session[][];
  let index = planPosition(plan, today, wso);
  const base = cycleStart(plan, index);
  const byWeek = new Map<string, [string, string][]>();
  for (const r of logged) {
    const ws = addDays(base, 7 * floorDiv(daysBetween(base, r.d), 7));
    const list = byWeek.get(ws) ?? [];
    list.push([r.d, r.discipline]);
    byWeek.set(ws, list);
  }
  const detailed: Record<string, unknown>[][] = [];
  let done = 0;
  let due = 0;
  weeks.forEach((sessions, i) => {
    const ws = addDays(base, 7 * i);
    if (ws > today) {
      detailed.push(
        sessions.map((s) => ({ ...s, date: addDays(ws, s.day), status: "upcoming", moved: false })),
      );
      return;
    }
    const matched = matchWeek(sessions, ws, byWeek.get(ws) ?? [], today);
    detailed.push(matched);
    for (const s of matched) {
      if (s.status !== "upcoming") due++;
      if (s.status === "done") done++;
    }
  });
  const started = plan.startedOn;
  if (index !== null) index -= floorDiv(daysBetween(started, base), 7);
  const current = index !== null && index >= 0 && index < weeks.length ? index : null;
  return {
    ...out,
    weeks: detailed,
    current_week: current,
    today: current === null ? [] : (detailed[current] ?? []).filter((s) => s.date === today),
    progress: { done, due, total: weeks.reduce((n, w) => n + w.length, 0) },
    cycle: weeks.length > 0 ? floorDiv(daysBetween(started, base), 7 * weeks.length) + 1 : 1,
  };
}

/** Python `_finish_if_over`: a run-once plan past its last week is finished (the GETs write this). */
function overNow(plan: PlanRow, today: string, wso: number): boolean {
  if (plan.startedOn === null || plan.finishedAt !== null || plan.repeat) return false;
  const index = planPosition(plan, today, wso);
  return index !== null && index >= plan.weeks.length;
}

const dumpSession = (s: Record<string, unknown>): PlanSession => {
  const v = PlanSessionSchema.parse(s);
  return {
    day: v.day,
    discipline: v.discipline,
    title: v.title,
    minutes: v.minutes,
    distance_km: v.distance_km,
    routine_id: v.routine_id,
    note: v.note,
  };
};

// ---- routine reuse --------------------------------------------------------------------------------------------

type NameRow = { id: string; name: string };

/** Finds the oldest routine with a matching name or plans a new one, in a batch's statements. */
class Routines {
  readonly stmts: Stmt[] = [];
  private made = new Map<string, string>();
  constructor(
    private readonly ctx: Ctx,
    private readonly userId: string,
    private readonly existing: readonly NameRow[],
  ) {}

  id(
    key: string,
    match: (r: NameRow) => boolean,
    create: () => {
      name: string;
      discipline: string;
      notes: string | null;
      items: Record<string, unknown>[];
    },
  ): string {
    const known = this.made.get(key);
    if (known !== undefined) return known;
    let id = this.existing.find(match)?.id;
    if (id === undefined) {
      const now = this.ctx.clock.now();
      id = uuid7(now);
      this.stmts.push(
        this.ctx.db.insert(routines).values(
          withFold(routines, {
            id,
            userId: this.userId,
            createdAt: now,
            updatedAt: now,
            position: 0,
            ...create(),
          }),
        ),
      );
    }
    this.made.set(key, id);
    return id;
  }
}

function fromTemplate(r: Routines, t: CatalogPlanTemplate): PlanSession[][] {
  return t.weeks.map((week) =>
    week.map((s) => {
      const { routine_template: tpl, ...rest } = s;
      const out: Record<string, unknown> = { ...rest };
      const rt = tpl === undefined ? undefined : ROUTINE_TEMPLATE_BY_ID.get(tpl);
      if (rt !== undefined) {
        out.routine_id = r.id(
          `tpl:${rt.id}`,
          (x) => x.name === rt.name,
          () => ({
            name: rt.name,
            discipline: rt.discipline,
            notes: rt.summary,
            items: rt.items.map((i) => ({ ...i })),
          }),
        );
      }
      return dumpSession(out);
    }),
  );
}

/**
 * Python `materialize`: a shareable plan becomes one of `userId`'s, embedded routines reused by name
 * (case-insensitive) or created with library exercises only. Returns the plan row and the statements.
 */
export function materialize(
  ctx: Ctx,
  userId: string,
  shared: SharedPlanInput,
  existingRoutines: readonly NameRow[],
  fields: { challengeId?: string; assignedBy?: string } = {},
): { plan: PlanRow; stmts: Stmt[] } {
  if (shared.weeks.some((w) => w.length > MAX_PER_WEEK))
    throw new HttpError(422, `at most ${MAX_PER_WEEK} sessions a week`);
  const r = new Routines(ctx, userId, existingRoutines);
  const weeks = shared.weeks.map((week) =>
    [...week]
      .sort((a, b) => a.day - b.day)
      .map((s) => {
        const { routine, routine_id: _drop, ...rest } = s;
        const data: PlanSession = { ...rest, routine_id: null };
        if (routine !== null) {
          const key = routine.name.toLowerCase();
          data.routine_id = r.id(
            key,
            (x) => x.name.toLowerCase() === key,
            () => ({
              name: routine.name,
              discipline: DISCIPLINE_IDS.has(routine.discipline) ? routine.discipline : "strength",
              notes: routine.notes,
              items: routine.items.filter((i) => EXERCISE_BY_ID.has(i.exercise_id)),
            }),
          );
        }
        return data;
      }),
  );
  const now = ctx.clock.now();
  const plan: PlanRow = {
    id: uuid7(now),
    createdAt: now,
    updatedAt: now,
    userId,
    name: shared.name.trim(),
    description: (shared.description ?? "").trim() || null,
    templateId: null,
    weeks,
    startedOn: null,
    challengeId: fields.challengeId ?? null,
    assignedBy: fields.assignedBy ?? null,
    finishedAt: null,
    // A challenge scores a fixed run of weeks, so its copy never loops.
    repeat: shared.repeat && fields.challengeId === undefined,
  };
  return { plan, stmts: [...r.stmts, ctx.db.insert(trainingPlans).values(plan)] };
}

/** A built-in template in the shareable format, routine templates embedded by value (Python `template_shared`). */
export function templateShared(t: CatalogPlanTemplate): SharedPlanInput {
  return {
    format: PLAN_FORMAT,
    version: 1,
    name: t.name,
    description: t.summary,
    repeat: false,
    weeks: t.weeks.map((w) =>
      w.map((s) => {
        const rt =
          s.routine_template === undefined ? undefined : ROUTINE_TEMPLATE_BY_ID.get(s.routine_template);
        return {
          day: s.day,
          discipline: s.discipline,
          title: s.title,
          minutes: s.minutes,
          distance_km: null,
          routine_id: null,
          note: s.note ?? null,
          routine:
            rt === undefined
              ? null
              : {
                  name: rt.name,
                  discipline: rt.discipline,
                  notes: rt.summary,
                  items: rt.items.map((i) => ({ ...i, weight_kg: null, increment_kg: null })),
                },
        };
      }),
    ),
  };
}

/** The shareable export: routines by value (library items only), never a routine id. */
export function shareable(plan: PlanRow, owned: readonly (typeof routines.$inferSelect)[]) {
  const byId = new Map(owned.map((r) => [r.id, r]));
  return {
    format: PLAN_FORMAT,
    version: 1,
    name: plan.name,
    description: plan.description,
    weeks: plan.weeks.map((w) =>
      w.map((s) => {
        const out: Record<string, unknown> = {
          day: s.day,
          discipline: s.discipline,
          title: s.title ?? null,
          minutes: s.minutes ?? null,
          distance_km: s.distance_km ?? null,
          note: s.note ?? null,
        };
        const r = s.routine_id ? byId.get(s.routine_id) : undefined;
        if (r !== undefined)
          out.routine = {
            name: r.name,
            discipline: r.discipline,
            notes: r.notes,
            items: r.items.filter((i) => EXERCISE_BY_ID.has(String(i.exercise_id))),
          };
        return out;
      }),
    ),
    repeat: plan.repeat,
  };
}

/** One plan at a time keeps "today" unambiguous (Python `run_only`). */
export function runOnly(ctx: Ctx, plan: PlanRow, starts: string): Stmt[] {
  const now = ctx.clock.now();
  plan.startedOn = starts;
  plan.finishedAt = null;
  return [
    repo.stopOtherPlans(ctx.db, plan.userId, plan.id, now),
    ctx.db
      .update(trainingPlans)
      .set({ startedOn: starts, finishedAt: null, updatedAt: now })
      .where(eq(trainingPlans.id, plan.id)),
  ];
}

// ---- routes ---------------------------------------------------------------------------------------------------

const todayOf = (ctx: Ctx, prof: readonly ProfileRow[]) => {
  const p = profileOf(prof);
  return { wso: p.weekStartsOn, today: localDate(ctx.clock.now(), p.timezone) };
};

/** Writes `stmts` (if any) and reads the logged sessions the view needs, in one round trip. */
async function viewAfter(
  ctx: Ctx,
  authed: AuthedBatch,
  plan: PlanRow,
  today: string,
  wso: number,
  stmts: readonly Stmt[],
  appOnly = false,
) {
  const range = viewRange(plan, today, wso);
  const reads: Stmt[] = range === null ? [] : [repo.logged(ctx.db, plan.userId, range[0], range[1], appOnly)];
  const all = [...stmts, ...reads];
  let rows: { d: string; discipline: string }[] = [];
  if (all.length > 0) {
    const res = (
      stmts.length > 0
        ? await authed.write(...(all as [Stmt, ...Stmt[]]))
        : (await authed.read(...all)).slice(1)
    ) as unknown[];
    if (range !== null) rows = res[res.length - 1] as typeof rows;
  }
  return planView(plan, today, wso, rows);
}

function finishStmt(ctx: Ctx, plan: PlanRow): Stmt {
  const now = ctx.clock.now();
  plan.finishedAt = now;
  return ctx.db
    .update(trainingPlans)
    .set({ finishedAt: now, updatedAt: now })
    .where(eq(trainingPlans.id, plan.id));
}

async function own(ctx: Ctx, authed: AuthedBatch, id: string) {
  const [, rows, prof] = await authed.read(repo.planById(ctx.db, id), repo.profile(ctx.db, authed.userId));
  const plan = rows[0];
  if (plan === undefined || plan.userId !== authed.userId) throw notFound("Not found");
  return { plan, ...todayOf(ctx, prof) };
}

export async function listPlans(ctx: Ctx, authed: AuthedBatch) {
  const [, prof, plans] = await authed.read(
    repo.profile(ctx.db, authed.userId),
    repo.listPlans(ctx.db, authed.userId),
  );
  const { today, wso } = todayOf(ctx, prof);
  const writes = plans.filter((p) => overNow(p, today, wso)).map((p) => finishStmt(ctx, p));
  if (writes.length > 0) await authed.write(...(writes as [Stmt, ...Stmt[]]));
  return plans.map(summary);
}

export async function activePlan(ctx: Ctx, authed: AuthedBatch) {
  const [, prof, rows] = await authed.read(
    repo.profile(ctx.db, authed.userId),
    repo.activePlan(ctx.db, authed.userId),
  );
  const plan = rows[0];
  if (plan === undefined) return null;
  const { today, wso } = todayOf(ctx, prof);
  return viewAfter(ctx, authed, plan, today, wso, overNow(plan, today, wso) ? [finishStmt(ctx, plan)] : []);
}

export async function getPlan(ctx: Ctx, authed: AuthedBatch, id: string) {
  const { plan, today, wso } = await own(ctx, authed, id);
  return viewAfter(ctx, authed, plan, today, wso, overNow(plan, today, wso) ? [finishStmt(ctx, plan)] : []);
}

function newPlan(ctx: Ctx, userId: string, v: Partial<PlanRow> & Pick<PlanRow, "name" | "weeks">): PlanRow {
  const now = ctx.clock.now();
  return {
    id: uuid7(now),
    createdAt: now,
    updatedAt: now,
    userId,
    description: null,
    templateId: null,
    startedOn: null,
    challengeId: null,
    assignedBy: null,
    finishedAt: null,
    repeat: false,
    ...v,
  };
}

function checkRoutines(body: PlanInput, owned: readonly { id: string }[]) {
  const ids = new Set(body.weeks.flat().flatMap((s) => (s.routine_id ? [s.routine_id] : [])));
  const mine = new Set(owned.map((r) => r.id));
  if ([...ids].some((i) => !mine.has(i)))
    throw new HttpError(422, "A session names a routine that isn't yours");
}

const sessionsOf = (body: PlanInput): PlanSession[][] => body.weeks.map((w) => w.map((s) => ({ ...s })));

export async function createPlan(
  ctx: Ctx,
  authed: AuthedBatch,
  body: { template_id: string | null; plan: PlanInput | null },
) {
  const uid = authed.userId;
  const ids =
    body.plan === null ? [] : body.plan.weeks.flat().flatMap((s) => (s.routine_id ? [s.routine_id] : []));
  const [, count, prof, names, owned] = await authed.read(
    repo.countPlans(ctx.db, uid),
    repo.profile(ctx.db, uid),
    repo.routineNames(ctx.db, uid),
    repo.routinesByIds(ctx.db, uid, ids),
  );
  if ((count[0]?.n ?? 0) >= MAX_PLANS) throw conflict(LIMIT);
  let plan: PlanRow;
  let stmts: Stmt[] = [];
  if (body.template_id) {
    const t = PLAN_TEMPLATE_BY_ID.get(body.template_id);
    if (t === undefined) throw notFound("No such template");
    const r = new Routines(ctx, uid, names);
    plan = newPlan(ctx, uid, {
      name: t.name,
      description: t.summary,
      templateId: t.id,
      weeks: fromTemplate(r, t),
    });
    stmts = r.stmts;
  } else if (body.plan !== null) {
    checkRoutines(body.plan, owned);
    plan = newPlan(ctx, uid, {
      name: body.plan.name.trim(),
      description: (body.plan.description ?? "").trim() || null,
      weeks: sessionsOf(body.plan),
      repeat: body.plan.repeat,
    });
  } else {
    throw new HttpError(422, "Choose a template or send a plan");
  }
  stmts.push(ctx.db.insert(trainingPlans).values(plan));
  const { today, wso } = todayOf(ctx, prof);
  return viewAfter(ctx, authed, plan, today, wso, stmts);
}

export async function racePlan(
  ctx: Ctx,
  authed: AuthedBatch,
  body: { race: string; race_date: string; per_week: number },
) {
  const uid = authed.userId;
  const [, count, prof] = await authed.read(repo.countPlans(ctx.db, uid), repo.profile(ctx.db, uid));
  if ((count[0]?.n ?? 0) >= MAX_PLANS) throw conflict(LIMIT);
  const { today, wso } = todayOf(ctx, prof);
  let built: ReturnType<typeof buildRacePlan>;
  try {
    built = buildRacePlan(body.race, body.race_date, today, wso, body.per_week);
  } catch (err) {
    if (err instanceof RacePlanError) throw new HttpError(422, err.message);
    throw err;
  }
  const [first, weeks, name] = built;
  const plan = newPlan(ctx, uid, {
    name: name.slice(0, 60),
    description:
      "Easy running most days, one faster session once the base is built, a taper, then a recovery week. A schedule of suggestions: rest when you need to.",
    templateId: `race-${body.race}`,
    weeks: weeks as unknown as PlanSession[][],
  });
  const stmts: Stmt[] = [ctx.db.insert(trainingPlans).values(plan), ...runOnly(ctx, plan, first)];
  return viewAfter(ctx, authed, plan, today, wso, stmts);
}

export async function exportPlan(ctx: Ctx, authed: AuthedBatch, id: string) {
  const [, rows, owned] = await authed.read(
    repo.planById(ctx.db, id),
    repo.listRoutines(ctx.db, authed.userId),
  );
  const plan = rows[0];
  if (plan === undefined || plan.userId !== authed.userId) throw notFound("Not found");
  return shareable(plan, owned);
}

export async function importPlan(ctx: Ctx, authed: AuthedBatch, body: SharedPlanInput) {
  const uid = authed.userId;
  const [, count, prof, names] = await authed.read(
    repo.countPlans(ctx.db, uid),
    repo.profile(ctx.db, uid),
    repo.routineNames(ctx.db, uid),
  );
  if ((count[0]?.n ?? 0) >= MAX_PLANS) throw conflict(LIMIT);
  const { plan, stmts } = materialize(ctx, uid, body, names);
  const { today, wso } = todayOf(ctx, prof);
  return viewAfter(ctx, authed, plan, today, wso, stmts);
}

export async function updatePlan(ctx: Ctx, authed: AuthedBatch, id: string, body: PlanInput) {
  const uid = authed.userId;
  const ids = body.weeks.flat().flatMap((s) => (s.routine_id ? [s.routine_id] : []));
  const [, rows, prof, owned] = await authed.read(
    repo.planById(ctx.db, id),
    repo.profile(ctx.db, uid),
    repo.routinesByIds(ctx.db, uid, ids),
  );
  const plan = rows[0];
  if (plan === undefined || plan.userId !== uid) throw notFound("Not found");
  checkRoutines(body, owned);
  const now = ctx.clock.now();
  plan.name = body.name.trim();
  plan.description = (body.description ?? "").trim() || null;
  plan.weeks = sessionsOf(body);
  plan.repeat = body.repeat;
  const { today, wso } = todayOf(ctx, prof);
  return viewAfter(ctx, authed, plan, today, wso, [
    ctx.db
      .update(trainingPlans)
      .set({
        name: plan.name,
        description: plan.description,
        weeks: plan.weeks,
        repeat: plan.repeat,
        updatedAt: now,
      })
      .where(and(eq(trainingPlans.id, id), eq(trainingPlans.userId, uid))),
  ]);
}

export async function startPlan(ctx: Ctx, authed: AuthedBatch, id: string, when: string) {
  const { plan, today, wso } = await own(ctx, authed, id);
  const starts = addDays(weekStart(today, wso), when === "next" ? 7 : 0);
  return viewAfter(ctx, authed, plan, today, wso, runOnly(ctx, plan, starts));
}

/** A stopped plan's view needs no log, so this is one round trip. */
export async function stopPlan(ctx: Ctx, authed: AuthedBatch, id: string) {
  const now = ctx.clock.now();
  const [rows] = await authed.write(
    ctx.db
      .update(trainingPlans)
      .set({ startedOn: null, finishedAt: null, updatedAt: now })
      .where(and(eq(trainingPlans.id, id), eq(trainingPlans.userId, authed.userId)))
      .returning(),
  );
  const plan = rows[0];
  if (plan === undefined) throw notFound("Not found");
  return planView(plan, "", 0, []);
}

export async function deletePlan(ctx: Ctx, authed: AuthedBatch, id: string) {
  const [rows] = await authed.write(
    ctx.db
      .delete(trainingPlans)
      .where(and(eq(trainingPlans.id, id), eq(trainingPlans.userId, authed.userId)))
      .returning({ id: trainingPlans.id }),
  );
  if (rows.length === 0) throw notFound("Not found");
}
