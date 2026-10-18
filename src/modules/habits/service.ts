/**
 * Habits and habit routines (spec/habits.md §1.1-§1.2). Private to their owner: a habit's name, amounts and slips
 * never reach a feed, profile, group or leaderboard. The game snapshot only ever sees the generic `HabitView`.
 *
 * Cost model:
 * - Reads (list, one habit, stats) are one round trip: profile, pauses, habits and logs in one batch.
 * - Every write that moves a streak rides in the game `recompute`: its read batch already holds the user's habits
 *   and logs (this module's `HabitSource`), the change is applied to those rows in memory and its statements go
 *   first in recompute's write batch. One read and one write, and the projection can never lag the logs.
 * - Snooze, unsnooze and reorder are one write.
 */
import { HABIT_CATALOG_PAYLOAD, HABIT_TEMPLATE_BY_ID } from "../../catalog/habit-templates.ts";
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, runBatch, type Stmt } from "../../db/batch.ts";
import type { Db } from "../../db/client.ts";
import { conflict, HttpError, notFound } from "../../lib/errors.ts";
import { pyRound } from "../../lib/format.ts";
import { assertUnderLimit, BUCKETS, perUser } from "../../lib/ratelimit.ts";
import { addDays, daysBetween, localDate, toWire, zone } from "../../lib/time.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import {
  type HabitView as GameHabitView,
  type Loaded,
  pausedDays,
  recompute,
  setHabitSource,
  weeksPayload,
} from "../game/service.ts";
import { type HabitAction, verify } from "./actions.ts";
import { fitSchedule, type HabitView, isDone, pauseDays, scheduled, viewHabit } from "./engine.ts";
import { casefold, HabitImportError, type ImportedHabit, parse } from "./importer.ts";
import type { HabitRow, LogRow } from "./repo.ts";
import * as repo from "./repo.ts";
import {
  BACKFILL_DAYS,
  type DayInput,
  type HabitInput,
  MAX_HABITS,
  MAX_ROUTINES,
  type RoutineInput,
} from "./schemas.ts";

export { ACTIONS, actionUrl, LIFETIME_SECONDS, sign } from "./actions.ts";
export { isDone, scheduled } from "./engine.ts";

// ---- state ----------------------------------------------------------------------------------------------------

/** A user's habits and logs, plus what judging them needs. Mutated in place by the write paths. */
interface State {
  userId: string;
  habits: HabitRow[];
  logs: LogRow[];
  today: string;
  weekStartsOn: number;
  sheltered: ReadonlySet<string>;
}

function logsByHabit(logs: readonly LogRow[]): Map<string, LogRow[]> {
  const out = new Map<string, LogRow[]>();
  for (const l of logs) {
    const list = out.get(l.habitId);
    if (list === undefined) out.set(l.habitId, [l]);
    else list.push(l);
  }
  return out;
}

function viewOf(
  h: HabitRow,
  logs: readonly LogRow[],
  today: string,
  wso: number,
  sheltered: ReadonlySet<string>,
) {
  const own = pauseDays(h.pausedFrom, h.pausedUntil, today);
  let paused: ReadonlySet<string> = sheltered;
  if (own.size > 0) paused = new Set([...sheltered, ...own]);
  return viewHabit({
    kind: h.kind,
    dailyGoal: h.dailyGoal,
    weeklyTarget: h.weeklyTarget,
    startedOn: h.startedOn,
    logs,
    today,
    weekStartsOn: wso,
    pausedDays: paused,
    daysMask: h.daysMask,
  });
}

/** Python `habit_summary`. */
function summary(h: HabitRow, v: HabitView, today: string, logs: readonly LogRow[]) {
  const r = v.chain;
  const byDay = new Map<string, LogRow>();
  for (const l of logs) byDay.set(l.day, l);
  const recent = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i);
    const l = byDay.get(d);
    recent.push({ date: d, amount: l?.amount ?? 0, note: l?.note || null });
  }
  return {
    id: h.id,
    name: h.name,
    emoji: h.emoji,
    category: h.category,
    kind: h.kind,
    unit: h.unit,
    daily_goal: h.dailyGoal,
    weekly_target: h.weeklyTarget,
    time_of_day: h.timeOfDay,
    cue: h.cue,
    why: h.why,
    total_goal: h.totalGoal,
    remind_hour: h.remindHour,
    days_mask: h.daysMask,
    scheduled_today: scheduled(h.daysMask, today),
    paused_from: h.pausedFrom,
    paused_until: h.pausedUntil,
    paused:
      h.pausedFrom !== null && h.pausedFrom <= today && (h.pausedUntil === null || today <= h.pausedUntil),
    snoozed_until: toWire(h.snoozedUntil),
    template_id: h.templateId,
    started_on: h.startedOn,
    archived: h.archivedAt !== null,
    position: h.position,
    today: { amount: v.todayAmount, done: v.doneDays.has(today) },
    streak: {
      current: r.current,
      longest: r.longest,
      this_week_days: r.thisWeekDays,
      this_week_target: r.thisWeekTarget,
      needed: r.needed,
      days_left: r.daysLeft,
      at_risk: r.atRisk,
      freezes_available: r.freezesAvailable,
      consistency: r.consistency,
    },
    strength: v.strength,
    total: v.total,
    clean_run: v.cleanRun,
    best_clean_run: v.bestCleanRun,
    last_slip: v.lastSlip,
    recent,
  };
}

function summaryOf(st: State, h: HabitRow) {
  const logs = st.logs.filter((l) => l.habitId === h.id);
  return summary(h, viewOf(h, logs, st.today, st.weekStartsOn, st.sheltered), st.today, logs);
}

// ---- the game's habit source ----------------------------------------------------------------------------------

setHabitSource({
  reads: (db: Db, userId: string) => [repo.habitRows(db, userId), repo.logRows(db, userId)],
  views(results, today, weekStartsOn, sheltered): GameHabitView[] {
    const habits = (results[0] ?? []) as HabitRow[];
    const byHabit = logsByHabit((results[1] ?? []) as LogRow[]);
    const out: GameHabitView[] = [];
    for (const h of habits) {
      if (h.archivedAt !== null) continue;
      const v = viewOf(h, byHabit.get(h.id) ?? [], today, weekStartsOn, sheltered);
      out.push({
        kind: h.kind,
        category: h.category,
        weeklyTarget: h.weeklyTarget,
        startedOn: h.startedOn,
        doneDays: [...v.doneDays].sort(),
        chain: v.chain,
        bestCleanRun: v.bestCleanRun,
      });
    }
    return out;
  },
});

/** The state recompute read, sharing its arrays so in-memory changes reach the snapshot it builds. */
function stateOf(l: Loaded, userId: string): State {
  const habits = (l.habitResults[0] ?? []) as HabitRow[];
  const logs = (l.habitResults[1] ?? []) as LogRow[];
  l.habitResults[0] = habits;
  l.habitResults[1] = logs;
  return {
    userId,
    habits,
    logs,
    today: l.inputs.today,
    weekStartsOn: l.inputs.profile.weekStartsOn,
    sheltered: pausedDays(l.inputs.pauses.map((p) => ({ startsOn: p.startsOn, endsOn: p.endsOn }))),
  };
}

/**
 * Applies `change` to the user's habits inside a game recompute: one read, one write. `change` mutates the state
 * and returns the statements that persist it; it runs again on a fresh read if a concurrent recompute won.
 */
async function mutate<T>(
  ctx: Ctx,
  userId: string,
  authed: AuthedBatch | undefined,
  notify: boolean,
  change: (st: State) => { stmts: Stmt[]; result: T },
): Promise<T> {
  let out: { result: T } | null = null;
  await recompute(
    ctx,
    userId,
    { notify },
    {
      ...(authed === undefined ? {} : { authed }),
      apply: (l) => {
        const st = stateOf(l, userId);
        const r = change(st);
        out = { result: r.result };
        return r.stmts;
      },
    },
  );
  if (out === null) throw new Error("recompute did not apply the habit change");
  return (out as { result: T }).result;
}

function own(st: State, habitId: string): HabitRow {
  const h = st.habits.find((x) => x.id === habitId);
  if (h === undefined) throw notFound("Not found");
  return h;
}

/** Profile, pauses, habits and logs in one round trip; `habitId` narrows to one habit. */
async function readState(ctx: Ctx, authed: AuthedBatch, habitId?: string): Promise<State> {
  const db = ctx.db;
  const userId = authed.userId;
  const [, profile, pauses, habits, logs] = await authed.read(
    repo.profileOf(db, userId),
    repo.pausesOf(db, userId),
    habitId === undefined ? repo.habitRows(db, userId) : repo.oneHabit(db, userId, habitId),
    habitId === undefined ? repo.logRows(db, userId) : repo.logsOfHabit(db, userId, habitId),
  );
  const p = profile[0];
  return {
    userId,
    habits,
    logs,
    today: localDate(ctx.clock.now(), zone(p?.timezone)),
    weekStartsOn: p?.weekStartsOn ?? 0,
    sheltered: pausedDays(pauses),
  };
}

// ---- reads ----------------------------------------------------------------------------------------------------

export const catalog = () => HABIT_CATALOG_PAYLOAD;

export async function list(ctx: Ctx, authed: AuthedBatch, archived: boolean) {
  const st = await readState(ctx, authed);
  const byHabit = logsByHabit(st.logs);
  return st.habits
    .filter((h) => archived || h.archivedAt === null)
    .map((h) => {
      const logs = byHabit.get(h.id) ?? [];
      return summary(h, viewOf(h, logs, st.today, st.weekStartsOn, st.sheltered), st.today, logs);
    });
}

export async function get(ctx: Ctx, authed: AuthedBatch, habitId: string, days: number) {
  const st = await readState(ctx, authed, habitId);
  const h = own(st, habitId);
  const v = viewOf(h, st.logs, st.today, st.weekStartsOn, st.sheltered);
  const since = addDays(st.today, -days);
  return {
    ...summary(h, v, st.today, st.logs),
    days: st.logs
      .filter((l) => l.day >= since)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
      .map((l) => ({ date: l.day, amount: l.amount, note: l.note })),
    weeks: weeksPayload(v.chain, 26),
  };
}

export async function stats(ctx: Ctx, authed: AuthedBatch, habitId: string, weeks: number) {
  const st = await readState(ctx, authed, habitId);
  const h = own(st, habitId);
  const cells = weeksPayload(viewOf(h, st.logs, st.today, st.weekStartsOn, st.sheltered).chain, weeks);
  const counted = cells.filter((c) => c.status !== "open" && c.status !== "paused");
  const kept = counted.filter((c) => c.status === "kept" || c.status === "frozen" || c.status === "repaired");
  return {
    weeks: cells,
    weeks_counted: counted.length,
    weeks_kept: kept.length,
    keep_rate: counted.length > 0 ? pyRound((100 * kept.length) / counted.length) : 0,
  };
}

// ---- create and edit ------------------------------------------------------------------------------------------

type Fields = Omit<HabitInput, "template_id">;

const strip = (s: string | null | undefined) => (s ?? "").trim() || null;

export async function create(ctx: Ctx, authed: AuthedBatch, body: HabitInput) {
  const now = ctx.clock.now();
  return run(ctx, authed.userId, authed, false, (st) => {
    const live = st.habits.filter((h) => h.archivedAt === null).length;
    if (live >= MAX_HABITS)
      throw conflict(`${MAX_HABITS} habits at once is the limit. Fewer, kept, beats more, dropped.`);
    let base: Fields = {};
    if (body.template_id) {
      const t = HABIT_TEMPLATE_BY_ID.get(body.template_id);
      if (t === undefined) throw notFound("No such template");
      base = {
        name: t.name,
        emoji: t.emoji,
        category: t.category,
        kind: t.kind as HabitRow["kind"],
        unit: t.unit,
        daily_goal: t.daily_goal,
        weekly_target: t.weekly_target,
        time_of_day: t.time_of_day as Fields["time_of_day"],
        cue: t.cue,
        total_goal: t.total_goal,
      };
    }
    const { template_id: _, ...fields } = body;
    const data: Fields = { ...base, ...fields };
    // Python saved a whitespace-only name as ""; it is refused like a missing one.
    const name = strip(data.name);
    if (name === null) throw new HttpError(422, "Give the habit a name");
    const kind = data.kind || "check";
    const counted = kind === "duration" || kind === "count";
    const dailyGoal = counted ? data.daily_goal || 1 : null;
    const row: HabitRow = {
      id: uuid7(now),
      userId: st.userId,
      name,
      nameFold: "",
      emoji: data.emoji || "✨",
      category: data.category || (kind === "quit" ? "break" : "other"),
      kind,
      unit: kind === "duration" ? data.unit || "minutes" : (data.unit ?? null),
      dailyGoal,
      weeklyTarget: data.weekly_target || 7,
      timeOfDay: data.time_of_day || "anytime",
      cue: strip(data.cue),
      why: strip(data.why),
      totalGoal: counted ? (data.total_goal ?? null) : null,
      remindHour: data.remind_hour ?? null,
      templateId: body.template_id ?? null,
      startedOn: st.today,
      position: live,
      archivedAt: null,
      snoozedUntil: null,
      daysMask: kind !== "quit" ? (data.days_mask ?? null) : null,
      pausedFrom: null,
      pausedUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    // `data` includes the template's fields, so a template always counts as an explicit target (Python).
    fitSchedule(row, "weekly_target" in data);
    st.habits.push(row);
    const { nameFold: _f, ...values } = row;
    return { stmts: [repo.insertHabit(ctx.db, values)], result: row };
  });
}

export async function update(ctx: Ctx, authed: AuthedBatch, habitId: string, body: HabitInput) {
  const now = ctx.clock.now();
  return run(ctx, authed.userId, authed, false, (st) => {
    const h = own(st, habitId);
    const { template_id: _, ...data } = body;
    if ("kind" in data && data.kind !== h.kind)
      throw new HttpError(
        422,
        "A habit's kind can't change, since its history means something different. Start a new one instead.",
      );
    const patch: repo.HabitPatch = {};
    const set = <K extends keyof repo.HabitPatch & keyof HabitRow>(k: K, v: HabitRow[K]) => {
      (h as HabitRow)[k] = v;
      (patch as Record<string, unknown>)[k] = v;
    };
    // Explicit null on a column that cannot be empty is ignored (Python failed it with a misleading 409).
    if ("name" in data) {
      const n = strip(data.name);
      if (n !== null) set("name", n);
    }
    if ("emoji" in data && strip(data.emoji) !== null) set("emoji", strip(data.emoji) as string);
    if ("category" in data && data.category != null) set("category", data.category);
    if ("weekly_target" in data && data.weekly_target != null) set("weeklyTarget", data.weekly_target);
    if ("time_of_day" in data && data.time_of_day != null) set("timeOfDay", data.time_of_day);
    if ("unit" in data) set("unit", strip(data.unit));
    if ("cue" in data) set("cue", strip(data.cue));
    if ("why" in data) set("why", strip(data.why));
    if ("daily_goal" in data) set("dailyGoal", data.daily_goal ?? null);
    if ("total_goal" in data) set("totalGoal", data.total_goal ?? null);
    if ("remind_hour" in data) set("remindHour", data.remind_hour ?? null);
    if ("days_mask" in data) set("daysMask", data.days_mask ?? null);
    if ("days_mask" in data || "weekly_target" in data) {
      const before = { mask: h.daysMask, target: h.weeklyTarget };
      fitSchedule(h, "days_mask" in data ? "weekly_target" in data : true);
      if (h.daysMask !== before.mask) set("daysMask", h.daysMask);
      if (h.weeklyTarget !== before.target) set("weeklyTarget", h.weeklyTarget);
    }
    h.updatedAt = now;
    return { stmts: [repo.updateHabit(ctx.db, st.userId, h.id, patch, now)], result: h };
  });
}

/** `mutate`, then the summary of the habit the change returned, from the state it produced. */
async function run(
  ctx: Ctx,
  userId: string,
  authed: AuthedBatch | undefined,
  notify: boolean,
  change: (st: State) => { stmts: Stmt[]; result: HabitRow },
) {
  let final: State | null = null;
  const h = await mutate(ctx, userId, authed, notify, (st) => {
    final = st;
    return change(st);
  });
  if (final === null) throw new Error("no state");
  return summaryOf(final, h);
}

export async function setArchived(ctx: Ctx, authed: AuthedBatch, habitId: string, archived: boolean) {
  const now = ctx.clock.now();
  return run(ctx, authed.userId, authed, false, (st) => {
    const h = own(st, habitId);
    h.archivedAt = archived ? (h.archivedAt ?? now) : null;
    return {
      stmts: [repo.updateHabit(ctx.db, st.userId, h.id, { archivedAt: h.archivedAt }, now)],
      result: h,
    };
  });
}

export async function pause(
  ctx: Ctx,
  authed: AuthedBatch,
  habitId: string,
  body: { start?: string | null | undefined; until?: string | null | undefined },
) {
  const now = ctx.clock.now();
  return run(ctx, authed.userId, authed, false, (st) => {
    const h = own(st, habitId);
    const start = body.start ?? st.today;
    if (start < addDays(st.today, -14) || start > addDays(st.today, 60))
      throw new HttpError(422, "A pause can start up to 14 days back or 60 ahead.");
    const until = body.until ?? null;
    if (until !== null && until < start) throw new HttpError(422, "It ends before it starts");
    if (until !== null && daysBetween(start, until) > 180)
      throw new HttpError(422, "Pause for six months at most; archive a habit you're done with.");
    h.pausedFrom = start > h.startedOn ? start : h.startedOn;
    h.pausedUntil = until;
    return {
      stmts: [
        repo.updateHabit(ctx.db, st.userId, h.id, { pausedFrom: h.pausedFrom, pausedUntil: until }, now),
      ],
      result: h,
    };
  });
}

export async function resume(ctx: Ctx, authed: AuthedBatch, habitId: string) {
  const now = ctx.clock.now();
  return run(ctx, authed.userId, authed, false, (st) => {
    const h = own(st, habitId);
    if (h.pausedFrom !== null) {
      if (h.pausedFrom >= st.today) {
        h.pausedFrom = null;
        h.pausedUntil = null;
      } else h.pausedUntil = addDays(st.today, -1);
    }
    return {
      stmts: [
        repo.updateHabit(
          ctx.db,
          st.userId,
          h.id,
          { pausedFrom: h.pausedFrom, pausedUntil: h.pausedUntil },
          now,
        ),
      ],
      result: h,
    };
  });
}

export async function remove(ctx: Ctx, authed: AuthedBatch, habitId: string) {
  const now = ctx.clock.now();
  return mutate(ctx, authed.userId, authed, false, (st) => {
    const h = own(st, habitId);
    const logs = st.logs.filter((l) => l.habitId === h.id);
    const trashId = uuid7(now);
    const { nameFold: _, ...row } = h;
    st.habits.splice(st.habits.indexOf(h), 1);
    for (let i = st.logs.length - 1; i >= 0; i--) if (st.logs[i]?.habitId === h.id) st.logs.splice(i, 1);
    return {
      stmts: [
        repo.insertTrash(
          ctx.db,
          { id: trashId, userId: st.userId, kind: "habit", itemId: h.id, label: `${h.emoji} ${h.name}` },
          { row, children: { habit_logs: logs.map((l) => ({ ...l, userId: st.userId })) } },
          now,
        ),
        // Logs go with it (ON DELETE CASCADE).
        repo.deleteHabit(ctx.db, st.userId, h.id),
      ],
      result: { trash_id: trashId },
    };
  });
}

// ---- days -----------------------------------------------------------------------------------------------------

function checkDay(day: string, today: string): void {
  if (day > today) throw new HttpError(422, "That day hasn't happened yet");
  if (day < addDays(today, -BACKFILL_DAYS))
    throw new HttpError(422, `Days can be filled in up to ${BACKFILL_DAYS} days back`);
}

/** Moves the start back when a day before it is filled in. */
function startNoLaterThan(ctx: Ctx, h: HabitRow, day: string, now: number): Stmt[] {
  if (day >= h.startedOn) return [];
  h.startedOn = day;
  return [repo.startNoLaterThan(ctx.db, h.id, day, now)];
}

function findLog(st: State, habitId: string, day: string): LogRow | undefined {
  return st.logs.find((l) => l.habitId === habitId && l.day === day);
}

function dropLog(st: State, row: LogRow): void {
  st.logs.splice(st.logs.indexOf(row), 1);
}

/** PUT a day: the amount outright (zero clears it), and the note only when the key was sent. Idempotent. */
export async function setDay(ctx: Ctx, authed: AuthedBatch, habitId: string, day: string, body: DayInput) {
  const now = ctx.clock.now();
  return run(ctx, authed.userId, authed, true, (st) => {
    const h = own(st, habitId);
    checkDay(day, st.today);
    const row = findLog(st, h.id, day);
    // A note left out keeps the one already there, so a plain tick never wipes it; an empty string clears it.
    const noteSet = "note" in body;
    const note = noteSet ? strip(body.note) : null;
    const keepNote = !noteSet && row !== undefined && Boolean(row.note);
    const stmts: Stmt[] = [];
    if (body.amount <= 0 && note === null && !keepNote) {
      if (row !== undefined) {
        dropLog(st, row);
        stmts.push(repo.deleteLog(ctx.db, h.id, day));
      }
    } else {
      const target = row ?? { id: uuid7(now), habitId: h.id, day, amount: body.amount, note: null };
      if (row === undefined) st.logs.push(target);
      target.amount = body.amount;
      if (noteSet) target.note = note;
      stmts.push(
        repo.putLog(
          ctx.db,
          { id: target.id, habitId: h.id, userId: st.userId, day, amount: body.amount, note: target.note },
          noteSet,
          now,
        ),
      );
      if (body.amount > 0) stmts.push(...startNoLaterThan(ctx, h, day, now));
    }
    return { stmts, result: h };
  });
}

/** POST add: another glass, ten more minutes. Not idempotent. */
export async function addToDay(ctx: Ctx, authed: AuthedBatch, habitId: string, day: string, amount: number) {
  const now = ctx.clock.now();
  return run(ctx, authed.userId, authed, true, (st) => {
    const h = own(st, habitId);
    checkDay(day, st.today);
    let row = findLog(st, h.id, day);
    if (row === undefined) {
      row = { id: uuid7(now), habitId: h.id, day, amount: 0, note: null };
      st.logs.push(row);
    }
    row.amount = Math.min(100_000, row.amount + amount);
    return {
      stmts: [
        repo.addToLog(ctx.db, { id: row.id, habitId: h.id, userId: st.userId, day }, amount, now),
        ...startNoLaterThan(ctx, h, day, now),
      ],
      result: h,
    };
  });
}

/** PUT several days at once with one recompute. Zero clears a day but keeps its note. */
export async function setDays(
  ctx: Ctx,
  authed: AuthedBatch,
  habitId: string,
  days: readonly { date: string; amount: number }[],
) {
  const now = ctx.clock.now();
  return run(ctx, authed.userId, authed, true, (st) => {
    const h = own(st, habitId);
    const seen = new Set<string>();
    for (const d of days) {
      if (seen.has(d.date)) throw new HttpError(422, `${d.date} appears twice`);
      seen.add(d.date);
      checkDay(d.date, st.today);
    }
    const stmts: Stmt[] = [];
    for (const d of days) {
      const row = findLog(st, h.id, d.date);
      if (d.amount <= 0) {
        if (row !== undefined && !row.note) {
          dropLog(st, row);
          stmts.push(repo.deleteLog(ctx.db, h.id, d.date));
        } else if (row !== undefined) {
          row.amount = 0;
          stmts.push(repo.putLog(ctx.db, { ...row, userId: st.userId, amount: 0 }, false, now));
        }
        continue;
      }
      const target = row ?? { id: uuid7(now), habitId: h.id, day: d.date, amount: d.amount, note: null };
      if (row === undefined) st.logs.push(target);
      target.amount = d.amount;
      stmts.push(repo.putLog(ctx.db, { ...target, userId: st.userId }, false, now));
      stmts.push(...startNoLaterThan(ctx, h, d.date, now));
    }
    return { stmts, result: h };
  });
}

// ---- snooze, order --------------------------------------------------------------------------------------------

export async function snooze(ctx: Ctx, authed: AuthedBatch, habitId: string, minutes: number) {
  const now = ctx.clock.now();
  const [rows] = await authed.write(
    repo.setSnooze(ctx.db, authed.userId, habitId, now + minutes * 60_000, now),
  );
  const until = rows[0]?.snoozedUntil;
  if (until == null) throw notFound("Not found");
  return { snoozed_until: toWire(until) };
}

export async function unsnooze(ctx: Ctx, authed: AuthedBatch, habitId: string): Promise<void> {
  const now = ctx.clock.now();
  const [rows] = await authed.write(repo.setSnooze(ctx.db, authed.userId, habitId, null, now));
  if (rows.length === 0) throw notFound("Not found");
}

/** Unknown or foreign ids are skipped silently, as in Python. One write for the whole list. */
export async function reorder(ctx: Ctx, authed: AuthedBatch, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = ctx.clock.now();
  const [first, ...rest]: Stmt[] = ids.map((id, i) => repo.setPosition(ctx.db, authed.userId, id, i, now));
  if (first !== undefined) await authed.write(first, ...rest);
}

// ---- reminder push actions (no session: the signed link is the authorisation) --------------------------------

export async function action(
  ctx: Ctx,
  habitId: string,
  q: { a: string; u: string; d: string; e: number; s: string },
): Promise<{ snoozed_until: string } | { done: true }> {
  if (!(await verify(ctx, q.u, habitId, q.a, q.d, q.e, q.s)))
    throw new HttpError(403, "This link has expired");
  const now = ctx.clock.now();
  if ((q.a as HabitAction) === "snooze") {
    const [rows] = await runBatch(ctx.db, [
      repo.setSnooze(ctx.db, q.u, habitId, now + 60 * 60_000, now, true),
    ]);
    const until = rows?.[0]?.snoozedUntil;
    if (until == null) throw notFound("Not found");
    return { snoozed_until: toWire(until) };
  }
  await mutate(ctx, q.u, undefined, true, (st) => {
    const h = own(st, habitId);
    if (h.archivedAt !== null) throw notFound("Not found");
    const goal = h.kind === "check" ? 1 : h.dailyGoal || 1;
    const row = findLog(st, h.id, q.d);
    const stmts: Stmt[] = [];
    if (row === undefined) {
      const created = { id: uuid7(now), habitId: h.id, day: q.d, amount: goal, note: null };
      st.logs.push(created);
      stmts.push(repo.putLog(ctx.db, { ...created, userId: st.userId }, false, now));
    } else if (!isDone(h.kind, row.amount, h.dailyGoal)) {
      row.amount = goal;
      stmts.push(repo.putLog(ctx.db, { ...row, userId: st.userId }, false, now));
    }
    h.snoozedUntil = null;
    stmts.push(repo.updateHabit(ctx.db, st.userId, h.id, { snoozedUntil: null }, now));
    return { stmts, result: null };
  });
  return { done: true };
}

// ---- import ---------------------------------------------------------------------------------------------------

interface Preview {
  name: string;
  days: number;
  first: string | null;
  last: string | null;
  merge: boolean;
}

function importPlan(st: State, parsed: readonly ImportedHabit[]) {
  const live = st.habits.filter((h) => h.archivedAt === null);
  const byName = new Map(live.map((h) => [casefold(h.name), h]));
  const fresh = parsed.filter((p) => !byName.has(casefold(p.name)));
  if (live.length + fresh.length > MAX_HABITS)
    throw conflict(`That would make more than ${MAX_HABITS} habits. Archive some first.`);
  const preview: Preview[] = parsed.map((p) => {
    const days = [...p.days.keys()].filter((d) => d <= st.today).sort();
    return {
      name: p.name,
      days: days.length,
      first: days[0] ?? null,
      last: days[days.length - 1] ?? null,
      merge: byName.has(casefold(p.name)),
    };
  });
  return { live, byName, preview };
}

/** About 200 KB of JSON per statement keeps each well inside D1's statement and parameter limits. */
const JSON_CHUNK = 200_000;

export async function importHabits(
  ctx: Ctx,
  authed: AuthedBatch,
  file: { filename: string; bytes: Uint8Array },
  dryRun: boolean,
) {
  const now = ctx.clock.now();
  const limit = perUser(ctx.db, BUCKETS.importHabits, authed.userId, now);
  const [counted] = await authed.write(limit.counter);
  assertUnderLimit(counted, BUCKETS.importHabits.limit);
  let parsed: ImportedHabit[];
  try {
    parsed = parse(file.filename, file.bytes);
  } catch (err) {
    if (err instanceof HabitImportError) throw new HttpError(422, err.message);
    throw err;
  }
  if (dryRun) {
    const { preview } = importPlan(await readState(ctx, authed), parsed);
    return { habits: preview, imported_days: 0 };
  }
  return mutate(ctx, authed.userId, authed, false, (st) => {
    const { live, byName, preview } = importPlan(st, parsed);
    const stmts: Stmt[] = [];
    const known = new Set(st.logs.map((l) => `${l.habitId}|${l.day}`));
    const fresh: [string, string, string, number][] = [];
    let position = live.length;
    for (const p of parsed) {
      const days = [...p.days].filter(([d]) => d <= st.today);
      if (days.length === 0) continue;
      const sorted = days.map(([d]) => d).sort();
      const first = sorted[0] as string;
      let h = byName.get(casefold(p.name));
      if (h === undefined) {
        const last = sorted[sorted.length - 1] as string;
        const weeks = Math.max(1, (daysBetween(first, last) + 1) / 7);
        h = {
          id: uuid7(now),
          userId: st.userId,
          name: p.name,
          nameFold: "",
          emoji: "✨",
          category: "other",
          kind: p.binary ? "check" : "count",
          unit: null,
          dailyGoal: p.binary ? null : 1,
          // How often it was really done, so the streak starts honest.
          weeklyTarget: Math.min(7, Math.max(1, pyRound(days.length / weeks))),
          timeOfDay: "anytime",
          cue: null,
          why: null,
          totalGoal: null,
          remindHour: null,
          templateId: null,
          startedOn: first,
          position: position++,
          archivedAt: null,
          snoozedUntil: null,
          daysMask: null,
          pausedFrom: null,
          pausedUntil: null,
          createdAt: now,
          updatedAt: now,
        };
        st.habits.push(h);
        const { nameFold: _, ...values } = h;
        stmts.push(repo.insertHabit(ctx.db, values));
      } else {
        stmts.push(...startNoLaterThan(ctx, h, first, now));
      }
      for (const [day, amount] of days) {
        if (known.has(`${h.id}|${day}`)) continue;
        known.add(`${h.id}|${day}`);
        const row = { id: uuid7(now), habitId: h.id, day, amount, note: null };
        st.logs.push(row);
        fresh.push([row.id, h.id, day, amount]);
      }
    }
    let chunk: typeof fresh = [];
    let size = 0;
    const flush = () => {
      if (chunk.length === 0) return;
      stmts.push(ctx.db.run(repo.insertLogsJson(st.userId, JSON.stringify(chunk), now)));
      chunk = [];
      size = 0;
    };
    for (const r of fresh) {
      chunk.push(r);
      size += 80;
      if (size >= JSON_CHUNK) flush();
    }
    flush();
    return { stmts, result: { habits: preview, imported_days: fresh.length } };
  });
}

// ---- routines -------------------------------------------------------------------------------------------------

function routineOut(r: repo.RoutineRow, live: ReadonlySet<string>) {
  return {
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    time_of_day: r.timeOfDay,
    // Archived or deleted habits drop out of the run without editing it.
    habit_ids: r.habitIds.filter((h) => live.has(h)),
  };
}

/** Python `_fill`: de-duplicated ids, every one a live habit of the caller. */
function fill(body: RoutineInput, live: ReadonlySet<string>) {
  const ids = [...new Set(body.habit_ids)];
  if (ids.some((i) => !live.has(i))) throw notFound("A habit in this routine doesn't exist");
  return { name: body.name.trim(), emoji: body.emoji, timeOfDay: body.time_of_day, habitIds: ids };
}

export async function listRoutines(ctx: Ctx, authed: AuthedBatch) {
  const [, rows, ids] = await authed.read(
    repo.routinesOf(ctx.db, authed.userId),
    repo.liveHabitIds(ctx.db, authed.userId),
  );
  const live = new Set(ids.map((r) => r.id));
  return rows.map((r) => routineOut(r, live));
}

export async function createRoutine(ctx: Ctx, authed: AuthedBatch, body: RoutineInput) {
  const now = ctx.clock.now();
  const [, n, ids] = await authed.read(
    repo.routineCount(ctx.db, authed.userId),
    repo.liveHabitIds(ctx.db, authed.userId),
  );
  if ((n[0]?.n ?? 0) >= MAX_ROUTINES) throw conflict(`${MAX_ROUTINES} routines is the limit`);
  const live = new Set(ids.map((r) => r.id));
  const row = { id: uuid7(now), userId: authed.userId, ...fill(body, live), createdAt: now, updatedAt: now };
  await authed.write(repo.insertRoutine(ctx.db, row));
  return routineOut(row, live);
}

export async function updateRoutine(ctx: Ctx, authed: AuthedBatch, routineId: string, body: RoutineInput) {
  const now = ctx.clock.now();
  const [, rows, ids] = await authed.read(
    repo.oneRoutine(ctx.db, authed.userId, routineId),
    repo.liveHabitIds(ctx.db, authed.userId),
  );
  const r = rows[0];
  if (r === undefined) throw notFound("Not found");
  const live = new Set(ids.map((x) => x.id));
  const v = fill(body, live);
  await authed.write(repo.updateRoutine(ctx.db, authed.userId, routineId, v, now));
  return routineOut({ ...r, ...v }, live);
}

export async function deleteRoutine(ctx: Ctx, authed: AuthedBatch, routineId: string) {
  const now = ctx.clock.now();
  const [, rows] = await authed.read(repo.oneRoutine(ctx.db, authed.userId, routineId));
  const r = rows[0];
  if (r === undefined) throw notFound("Not found");
  const trashId = uuid7(now);
  await authed.write(
    repo.insertTrash(
      ctx.db,
      {
        id: trashId,
        userId: authed.userId,
        kind: "habit_routine",
        itemId: r.id,
        label: `${r.emoji} ${r.name}`,
      },
      { row: r },
      now,
    ),
    repo.deleteRoutine(ctx.db, authed.userId, r.id),
  );
  return { trash_id: trashId };
}
