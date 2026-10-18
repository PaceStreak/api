/**
 * The daily journal (mood and a note) and the insights built from everything a person logs (Python
 * `app/insights/router.py`, spec/habits.md §1.3, §2.4). All private to their owner.
 */
import type { Ctx } from "../../ctx.ts";
import type { AuthedBatch } from "../../db/batch.ts";
import { HttpError } from "../../lib/errors.ts";
import { addDays, localDate, zone } from "../../lib/time.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import { isDone } from "../habits/service.ts";
import { find, type SeriesMap } from "./engine.ts";
import * as repo from "./repo.ts";

export const WINDOW_DAYS = 90;
export const BACKFILL_DAYS = 60;

const utcToday = (ctx: Ctx) => new Date(ctx.clock.now()).toISOString().slice(0, 10);
const localToday = (ctx: Ctx, rows: readonly { timezone: string }[]) =>
  localDate(ctx.clock.now(), zone(rows[0]?.timezone));

const out = (j: { day: string; mood: number | null; note: string | null }) => ({
  date: j.day,
  mood: j.mood,
  note: j.note,
});

// ---- journal --------------------------------------------------------------------------------------------------

/** One round trip: the rows are read from a UTC-safe lower bound and trimmed to the local window. */
export async function listJournal(ctx: Ctx, authed: AuthedBatch, days: number, q: string | undefined) {
  // Python stripped `%` and `_` from the term rather than escaping them.
  const term = q ? q.replace(/[%_]/g, "") : null;
  const [, tz, rows] = await authed.read(
    repo.timezoneOf(ctx.db, authed.userId),
    repo.journalSince(ctx.db, authed.userId, addDays(utcToday(ctx), -days), term),
  );
  const since = addDays(localToday(ctx, tz), -(days - 1));
  return rows.filter((r) => r.day >= since).map(out);
}

/** Both empty removes the day (200 with `null`). Idempotent, so an offline retry is safe. */
export async function putJournal(
  ctx: Ctx,
  authed: AuthedBatch,
  day: string,
  body: { mood?: number | null | undefined; note?: string | null | undefined },
) {
  const [, tz] = await authed.read(repo.timezoneOf(ctx.db, authed.userId));
  const today = localToday(ctx, tz);
  if (day < addDays(today, -BACKFILL_DAYS) || day > today)
    throw new HttpError(422, `Journal days are for today or the last ${BACKFILL_DAYS} days`);
  const note = (body.note ?? "").trim() || null;
  const mood = body.mood ?? null;
  if (mood === null && note === null) {
    await authed.write(repo.deleteJournal(ctx.db, authed.userId, day));
    return null;
  }
  const now = ctx.clock.now();
  const [rows] = await authed.write(
    repo.upsertJournal(ctx.db, { id: uuid7(now), userId: authed.userId, day, mood, note }, now),
  );
  const row = rows[0];
  if (row === undefined) throw new Error("journal upsert returned nothing");
  return out(row);
}

/** Idempotent; the app queues it offline. No date-range check, as in Python. */
export async function deleteJournal(ctx: Ctx, authed: AuthedBatch, day: string) {
  const [, rows] = await authed.read(repo.journalDay(ctx.db, authed.userId, day));
  const row = rows[0];
  if (row === undefined) return { trash_id: null };
  const now = ctx.clock.now();
  const trashId = uuid7(now);
  await authed.write(
    repo.insertTrash(
      ctx.db,
      { id: trashId, userId: authed.userId, itemId: row.id, label: `Journal, ${day}` },
      { row: { ...row, userId: authed.userId } },
      now,
    ),
    repo.deleteJournal(ctx.db, authed.userId, day),
  );
  return { trash_id: trashId };
}

// ---- insights -------------------------------------------------------------------------------------------------

/**
 * Every daily series over the window before today (today is left out: it isn't over). One round trip. A series
 * key exists only once a value was set, as Python's defaultdict did, so `coverage` lists what is logged.
 */
export async function insights(ctx: Ctx, authed: AuthedBatch) {
  const db = ctx.db;
  const u = authed.userId;
  const utc = utcToday(ctx);
  const lo = addDays(utc, -WINDOW_DAYS - 2);
  const hi = utc;
  const [, tz, ready, sleepHours, moods, first, trainedDays, habits, logs, meals] = await authed.read(
    repo.timezoneOf(db, u),
    repo.readinessIn(db, u, lo, hi),
    repo.sleepHoursIn(db, u, lo, hi),
    repo.moodIn(db, u, lo, hi),
    repo.firstWorkoutDay(db, u),
    repo.workoutDaysIn(db, u, lo, hi),
    repo.liveNonQuitHabits(db, u),
    repo.habitLogsIn(db, u, lo, hi),
    repo.mealTotalsIn(db, u, lo, hi),
  );
  const today = localToday(ctx, tz);
  const start = addDays(today, -WINDOW_DAYS);
  const end = addDays(today, -1);
  const inWindow = (d: string) => start <= d && d <= end;
  const series: SeriesMap = new Map();
  const put = (key: string, day: string, v: number) => {
    let m = series.get(key);
    if (m === undefined) {
      m = new Map();
      series.set(key, m);
    }
    m.set(day, v);
  };

  for (const r of ready) {
    if (!inWindow(r.day)) continue;
    put("sleep", r.day, r.sleep);
    put("energy", r.day, r.energy);
  }
  for (const m of sleepHours) if (inWindow(m.day) && m.hours !== null) put("sleep_hours", m.day, m.hours);
  for (const j of moods) if (inWindow(j.day) && j.mood !== null) put("mood", j.day, j.mood);

  // Training is known for every day once someone has started: no session means a rest day, not an unknown one.
  const firstDay = first[0]?.first ?? null;
  if (firstDay !== null) {
    const trained = new Set(trainedDays.map((r) => r.day));
    for (let d = firstDay > start ? firstDay : start; d <= end; d = addDays(d, 1))
      put("trained", d, trained.has(d) ? 1 : 0);
  }

  // Habits: the share of live, non-quit habits done that day.
  if (habits.length > 0) {
    const byId = new Map(habits.map((h) => [h.id, h]));
    const done = new Map<string, number>();
    for (const l of logs) {
      const h = byId.get(l.habitId);
      if (h === undefined || !inWindow(l.day)) continue;
      if (isDone(h.kind, l.amount, h.dailyGoal)) done.set(l.day, (done.get(l.day) ?? 0) + 1);
    }
    for (let d = start; d <= end; d = addDays(d, 1)) {
      let live = 0;
      for (const h of habits) if (h.startedOn <= d) live++;
      if (live > 0) put("habits", d, (done.get(d) ?? 0) / live);
    }
  }

  for (const m of meals) {
    if (!inWindow(m.day)) continue;
    put("kcal", m.day, m.kcal);
    put("protein_g", m.day, m.protein);
  }

  return {
    window_days: WINDOW_DAYS,
    insights: find(series),
    coverage: Object.fromEntries([...series].map(([k, v]) => [k, v.size])),
  };
}
