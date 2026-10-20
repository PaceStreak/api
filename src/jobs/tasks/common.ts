/**
 * Shared plumbing for the worker jobs (spec/misc.md §4, DESIGN.md §9 lane 3).
 *
 * A per-user job is a `SlicedJob`: the cron dispatcher `select`s candidate ids with indexed queries and fans them
 * out as `job-slice` messages; the consumer runs `slice` on each pack of at most 50 ids. `slice` re-reads its rows
 * and re-checks the hour at its own clock, so a late or redelivered message can never nudge outside the hour, and
 * every notification carries the Python dedupe key, so a slice that runs twice inserts nothing new.
 */
import type { Ctx } from "../../ctx.ts";
import { runBatch, type Stmt } from "../../db/batch.ts";
import { formatG } from "../../lib/format.ts";
import { effectiveEnd } from "../../modules/game/service.ts";
import { actionUrl, isDone, scheduled } from "../../modules/habits/service.ts";
import { notify } from "../../modules/notifications/service.ts";
import { chunk } from "../dispatch.ts";
import type { Tick } from "../scheduled.ts";
import { hoursByZone } from "../zones.ts";
import { distinctZones, type HabitRow, IN_CHUNK } from "./repo.ts";

export interface SlicedJob {
  /** Candidate ids for this tick; an empty list enqueues nothing. */
  select(ctx: Ctx, tick: Tick): Promise<string[]>;
  /** Does the work for one pack of ids; returns the notification ids it inserted (the caller delivers them). */
  slice(ctx: Ctx, ids: readonly string[]): Promise<string[]>;
}

const zoneCache = new WeakMap<Tick, Promise<string[]>>();

/** Every zone in use, read once per tick and shared by its jobs. */
export function zonesOf(ctx: Ctx, tick: Tick): Promise<string[]> {
  let z = zoneCache.get(tick);
  if (z === undefined) {
    z = runBatch(ctx.db, [distinctZones(ctx.db)] as const).then(([rows]) => rows.map((r) => r.tz));
    zoneCache.set(tick, z);
    // A failed read must not poison the other jobs of the tick.
    z.catch(() => zoneCache.delete(tick));
  }
  return z;
}

/** Zones grouped by their local hour at `now`, each group chunked for the parameter limit. */
export function zonesByHour(zones: readonly string[], now: number): [number, string[]][] {
  const groups = new Map<number, string[]>();
  for (const [tz, h] of hoursByZone(zones, now)) {
    const list = groups.get(h);
    if (list === undefined) groups.set(h, [tz]);
    else list.push(tz);
  }
  return [...groups].flatMap(([h, zs]) => chunk(zs, IN_CHUNK).map((part): [number, string[]] => [h, part]));
}

/** Zones grouped by an arbitrary key (local date, weekday ...), each group chunked. */
export function zonesBy<K>(zones: readonly string[], keyOf: (tz: string) => K): [K, string[]][] {
  const groups = new Map<K, string[]>();
  for (const tz of zones) {
    const k = keyOf(tz);
    const list = groups.get(k);
    if (list === undefined) groups.set(k, [tz]);
    else list.push(tz);
  }
  return [...groups].flatMap(([k, zs]) => chunk(zs, IN_CHUNK).map((part): [K, string[]] => [k, part]));
}

/** Runs one statement per chunk of `ids` in a single batch and concatenates the rows. */
export async function readChunked<R>(
  ctx: Ctx,
  ids: readonly string[],
  build: (part: string[]) => Stmt,
): Promise<R[]> {
  if (ids.length === 0) return [];
  const parts = chunk([...new Set(ids)], IN_CHUNK);
  const results = (await runBatch(ctx.db, parts.map(build))) as unknown as R[][];
  return results.flat();
}

/** Runs `stmts` (one batch) and concatenates their rows; nothing for an empty list. */
export async function readAll<R>(ctx: Ctx, stmts: readonly Stmt[]): Promise<R[]> {
  if (stmts.length === 0) return [];
  return ((await runBatch(ctx.db, stmts)) as unknown as R[][]).flat();
}

/** Unique ids, order kept. */
export const unique = (ids: Iterable<string>): string[] => [...new Set(ids)];

/** Python `Span.is_active`: started, and not past its (capped) end. */
export function pausedOn(
  pauses: readonly { startsOn: string; endsOn: string | null }[],
  today: string,
): boolean {
  return pauses.some((p) => p.startsOn <= today && today <= effectiveEnd(p));
}

/** Python `_habit_off_today`: not planned for today, or paused on its own. */
export function habitOffToday(h: HabitRow, today: string): boolean {
  if (!scheduled(h.daysMask, today)) return true;
  return h.pausedFrom !== null && h.pausedFrom <= today && (h.pausedUntil === null || today <= h.pausedUntil);
}

/** Python `_done_today`: the day's logged amount counts as done for the habit's kind. */
export function doneToday(h: HabitRow, amount: number | undefined): boolean {
  return amount !== undefined && isDone(h.kind, amount, h.dailyGoal);
}

/**
 * Python `_remind`: the per-habit reminder, with signed Done / In 1 hour buttons for the push. Wrapped in an
 * object because a query builder is thenable: returning it from an async function would run it.
 */
export async function remindStatement(
  ctx: Ctx,
  h: HabitRow,
  today: string,
  dedupeKey: string,
): Promise<{ stmt: Stmt }> {
  const goal =
    (h.kind === "duration" || h.kind === "count") && h.dailyGoal
      ? ` ${formatG(h.dailyGoal)} ${h.unit ?? ""}`.trimEnd()
      : "";
  const [done, snooze] = await Promise.all([
    actionUrl(ctx, h.userId, h.id, "done", today),
    actionUrl(ctx, h.userId, h.id, "snooze", today),
  ]);
  // Title and body show on a lock screen: no name, cue or amount there (root AGENTS.md, habits are never shown to
  // anyone else). The owner reads the specifics in the app, through `detail`.
  const stmt = notify(ctx, {
    userId: h.userId,
    kind: "habit_reminder",
    category: "habits",
    title: "Habit reminder",
    body: "One of your habits is due today. One tap when it's done.",
    detail:
      `${h.emoji} ${h.name}`.trim() +
      ". " +
      (h.cue ? `${h.cue}. ` : "") +
      (goal ? `Today's goal:${goal}.` : "One tap when it's done."),
    url: `/habits/${h.id}`,
    data: {
      actions: [
        { action: "done", title: "Done", url: done },
        { action: "snooze", title: "In 1 hour", url: snooze },
      ],
    },
    dedupeKey,
  });
  return { stmt };
}

/**
 * Runs one write batch; per statement, the ids a `notify()` insert actually inserted (empty for a deduplicated
 * insert and for statements that return no rows).
 */
export async function insertEach(ctx: Ctx, stmts: readonly Stmt[]): Promise<string[][]> {
  if (stmts.length === 0) return [];
  const res = (await runBatch(ctx.db, stmts)) as unknown[];
  return res.map((rows) => (Array.isArray(rows) ? (rows as { id: string }[]).map((r) => r.id) : []));
}
