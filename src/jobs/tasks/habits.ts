/**
 * Jobs 3-5: habit reminders at the hour someone chose, snoozed reminders whose hour is up, and the one evening
 * summary that replaces per-habit reminders (spec/misc.md §4). Never for habits being broken ("don't smoke" at
 * 6pm is a prompt, not a help), never during a pause, never for a habit already done today. The summary is a
 * count, never names: it shows on a lock screen.
 *
 * Each slice is two round trips: one read batch (rows, pauses, today's logs), one write batch.
 */
import type { Ctx } from "../../ctx.ts";
import { runBatch, type Stmt } from "../../db/batch.ts";
import { localDate, toWire } from "../../lib/time.ts";
import { notify } from "../../modules/notifications/service.ts";
import { chunk } from "../dispatch.ts";
import { atLocalHour } from "../zones.ts";
import {
  doneToday,
  habitOffToday,
  insertEach,
  pausedOn,
  readAll,
  remindStatement,
  type SlicedJob,
  unique,
  zonesByHour,
  zonesOf,
} from "./common.ts";
import {
  clearSnooze,
  dueSnoozes,
  type HabitRow,
  IN_CHUNK,
  logsOn,
  openHabits,
  pausesOf,
  reminderCandidates,
  reminderRows,
  snoozeRows,
  summaryCandidates,
  summaryRows,
  userLogsOn,
} from "./repo.ts";

type Pause = { userId: string; startsOn: string; endsOn: string | null };
type Log = { habitId: string; day: string; amount: number };

function pausesByUser(rows: readonly Pause[]): Map<string, Pause[]> {
  const out = new Map<string, Pause[]>();
  for (const p of rows) {
    const list = out.get(p.userId);
    if (list === undefined) out.set(p.userId, [p]);
    else list.push(p);
  }
  return out;
}

const logKey = (habitId: string, day: string) => `${habitId}|${day}`;

/** For each habit row: its pauses and today's logged amount, in one read batch. */
async function habitContext(ctx: Ctx, rows: readonly HabitRow[], todayOf: (h: HabitRow) => string) {
  const userIds = unique(rows.map((r) => r.userId));
  const habitIds = unique(rows.map((r) => r.id));
  const days = unique(rows.map(todayOf));
  // Leave room for the day list inside the 100-parameter limit (at most three local dates exist at once).
  const stmts: Stmt[] = [
    ...chunk(userIds, IN_CHUNK).map((part) => pausesOf(ctx.db, part)),
    ...chunk(habitIds, IN_CHUNK - days.length).map((part) => logsOn(ctx.db, part, days)),
  ];
  const results = (await ctxBatch(ctx, stmts)) as unknown[][];
  const nPauses = Math.ceil(userIds.length / IN_CHUNK);
  const pauses = pausesByUser(results.slice(0, nPauses).flat() as Pause[]);
  const logs = new Map(
    (results.slice(nPauses).flat() as Log[]).map((l) => [logKey(l.habitId, l.day), l.amount]),
  );
  return { pauses, logs };
}

async function ctxBatch(ctx: Ctx, stmts: readonly Stmt[]): Promise<unknown[]> {
  return stmts.length === 0 ? [] : ((await runBatch(ctx.db, stmts)) as unknown[]);
}

const todayIn = (now: number) => (h: { timezone: string }) => localDate(now, h.timezone);

/** Job 3, `habit_reminders`. */
export const habitReminders: SlicedJob = {
  async select(ctx, tick) {
    const zones = await zonesOf(ctx, tick);
    const stmts = zonesByHour(zones, tick.now).map(([h, zs]) => reminderCandidates(ctx.db, zs, h));
    return unique((await readAll<{ id: string }>(ctx, stmts)).map((r) => r.id));
  },

  async slice(ctx, ids) {
    const now = ctx.clock.now();
    const read = await readAll<HabitRow>(
      ctx,
      chunk(unique(ids), IN_CHUNK).map((part) => reminderRows(ctx.db, part)),
    );
    const rows = atLocalHour(
      read,
      (r) => r.timezone,
      (r) => r.remindHour,
      now,
    );
    if (rows.length === 0) return [];
    const today = todayIn(now);
    const { pauses, logs } = await habitContext(ctx, rows, today);
    const due = rows.filter((h) => {
      const day = today(h);
      return (
        !habitOffToday(h, day) &&
        !pausedOn(pauses.get(h.userId) ?? [], day) &&
        !doneToday(h, logs.get(logKey(h.id, day)))
      );
    });
    const built = await Promise.all(
      due.map((h) => remindStatement(ctx, h, today(h), `habit:${h.id}:${today(h)}`)),
    );
    return (
      await insertEach(
        ctx,
        built.map((b) => b.stmt),
      )
    ).flat();
  },
};

/** Job 4, `snoozed_reminders`: a snooze that ran out reminds again if still not done, and is cleared either way. */
export const habitSnoozes: SlicedJob = {
  async select(ctx, tick) {
    return unique((await readAll<{ id: string }>(ctx, [dueSnoozes(ctx.db, tick.now)])).map((r) => r.id));
  },

  async slice(ctx, ids) {
    const now = ctx.clock.now();
    const rows = await readAll<HabitRow & { remindable: number }>(
      ctx,
      chunk(unique(ids), IN_CHUNK).map((part) => snoozeRows(ctx.db, part, now)),
    );
    if (rows.length === 0) return [];
    const today = todayIn(now);
    const live = rows.filter((h) => h.remindable === 1 && h.archivedAt === null && h.kind !== "quit");
    const { pauses, logs } = await habitContext(ctx, live, today);
    // Each clear is predicated on the snooze that fired, so a newer snooze set meanwhile survives.
    const stmts: Stmt[] = rows.map((h) => clearSnooze(ctx.db, h.id, h.snoozedUntil ?? 0, now));
    const due = live.filter((h) => {
      const day = today(h);
      return (
        !habitOffToday(h, day) &&
        !pausedOn(pauses.get(h.userId) ?? [], day) &&
        !doneToday(h, logs.get(logKey(h.id, day)))
      );
    });
    const built = await Promise.all(
      due.map((h) =>
        remindStatement(ctx, h, today(h), `habit-snooze:${h.id}:${toWire(h.snoozedUntil ?? 0)}`),
      ),
    );
    const res = await insertEach(ctx, [...stmts, ...built.map((b) => b.stmt)]);
    return res.slice(stmts.length).flat();
  },
};

type SummaryRow = { userId: string; timezone: string; hour: number | null };

/** Job 5, `habit_summary`: one note at the chosen hour with how many habits are still open today. */
export const habitSummary: SlicedJob = {
  async select(ctx, tick) {
    const zones = await zonesOf(ctx, tick);
    const stmts = zonesByHour(zones, tick.now).map(([h, zs]) => summaryCandidates(ctx.db, zs, h));
    return unique((await readAll<{ userId: string }>(ctx, stmts)).map((r) => r.userId));
  },

  async slice(ctx, ids) {
    const now = ctx.clock.now();
    const read = await readAll<SummaryRow>(
      ctx,
      chunk(unique(ids), IN_CHUNK).map((part) => summaryRows(ctx.db, part)),
    );
    const people = atLocalHour(
      read,
      (r) => r.timezone,
      (r) => r.hour,
      now,
    );
    if (people.length === 0) return [];
    const today = todayIn(now);
    const userIds = people.map((p) => p.userId);
    const days = unique(people.map(today));
    const results = (await ctxBatch(ctx, [
      ...chunk(userIds, IN_CHUNK).map((part) => openHabits(ctx.db, part)),
      ...chunk(userIds, IN_CHUNK).map((part) => pausesOf(ctx.db, part)),
      ...chunk(userIds, IN_CHUNK - days.length).map((part) => userLogsOn(ctx.db, part, days)),
    ])) as unknown[][];
    const n = Math.ceil(userIds.length / IN_CHUNK);
    const n2 = Math.ceil(userIds.length / (IN_CHUNK - days.length));
    const habits = results.slice(0, n).flat() as HabitRow[];
    const pauses = pausesByUser(results.slice(n, 2 * n).flat() as Pause[]);
    const logs = new Map(
      (results.slice(2 * n, 2 * n + n2).flat() as Log[]).map((l) => [logKey(l.habitId, l.day), l.amount]),
    );
    const byUser = new Map<string, HabitRow[]>();
    for (const h of habits) {
      const list = byUser.get(h.userId);
      if (list === undefined) byUser.set(h.userId, [h]);
      else list.push(h);
    }
    const stmts: Stmt[] = [];
    for (const p of people) {
      const day = today(p);
      if (pausedOn(pauses.get(p.userId) ?? [], day)) continue;
      const open = (byUser.get(p.userId) ?? []).filter(
        (h) => h.startedOn <= day && !habitOffToday(h, day) && !doneToday(h, logs.get(logKey(h.id, day))),
      ).length;
      if (open === 0) continue;
      stmts.push(
        notify(ctx, {
          userId: p.userId,
          kind: "habit_summary",
          category: "habits",
          title: `${open} habit${open === 1 ? "" : "s"} still open today`,
          body: "A few minutes now keeps the week on track.",
          url: "/habits",
          dedupeKey: `habit-summary:${day}`,
        }),
      );
    }
    return (await insertEach(ctx, stmts)).flat();
  },
};
