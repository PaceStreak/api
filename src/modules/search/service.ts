/**
 * GET /v1/search and GET /v1/day/{day} (spec/social.md §5): private to the owner, never social. One round trip
 * each: every block's statement goes out in the caller's read batch.
 */
import type { Ctx } from "../../ctx.ts";
import type { AuthedBatch } from "../../db/batch.ts";
import { pyRound } from "../../lib/format.ts";
import { isDone } from "../habits/service.ts";
import * as repo from "./repo.ts";

const WIDTH = 90;

/** Python `str.title()`: upper-case after every non-letter ("open_water" becomes "Open_Water"). */
function pyTitle(s: string): string {
  let prev = false;
  let out = "";
  for (const ch of s) {
    const letter = /\p{L}/u.test(ch);
    out += letter ? (prev ? ch.toLowerCase() : ch.toUpperCase()) : ch;
    prev = letter;
  }
  return out;
}

/** Python `_snippet`: up to 90 characters around the first match, with ellipses where it was cut. */
export function snippet(text: string | null, q: string): string | null {
  if (!text) return null;
  const chars = Array.from(text);
  const lower = text.toLowerCase();
  const at = lower.indexOf(q.toLowerCase());
  // Python indexes code points; count them up to the match.
  const atChars = at < 0 ? -1 : Array.from(lower.slice(0, at)).length;
  if (atChars < 0 || chars.length <= WIDTH) return chars.slice(0, WIDTH).join("");
  const start = Math.max(0, atChars - Math.floor(WIDTH / 3));
  return (
    (start ? "…" : "") +
    chars.slice(start, start + WIDTH).join("") +
    (start + WIDTH < chars.length ? "…" : "")
  );
}

export async function search(ctx: Ctx, authed: AuthedBatch, raw: string) {
  const q = raw.trim();
  const uid = authed.userId;
  const db = ctx.db;
  const [, habits, notes, workouts, journal, foods, recipes] = await authed.read(
    repo.habits(db, uid, q),
    repo.habitNotes(db, uid, q),
    repo.workouts(db, uid, q),
    repo.journal(db, uid, q),
    repo.foods(db, uid, q),
    repo.recipes(db, uid, q),
  );
  const results: Record<string, unknown>[] = [];
  for (const h of habits)
    results.push({
      kind: "habit",
      id: h.id,
      title: `${h.emoji} ${h.name}`,
      detail: h.archived_at !== null ? "Archived" : snippet(h.cue || h.why, q),
      url: `/habits/${h.id}`,
    });
  for (const l of notes)
    results.push({
      kind: "habit_note",
      id: l.id,
      title: `${l.emoji} ${l.name}`,
      detail: snippet(l.note, q),
      date: l.day,
      url: `/habits/${l.habit_id}`,
    });
  for (const w of workouts)
    results.push({
      kind: "workout",
      id: w.id,
      title: w.title || pyTitle(w.discipline),
      detail: snippet(w.notes, q),
      date: w.local_date,
      url: `/workouts/${w.id}`,
    });
  for (const j of journal)
    results.push({
      kind: "journal",
      id: j.id,
      title: "Journal",
      detail: snippet(j.note, q),
      date: j.day,
      url: `/day/${j.day}`,
    });
  for (const f of foods)
    results.push({
      kind: "food",
      id: f.id,
      title: f.name,
      detail: `${f.brand ? `${f.brand} · ` : ""}${pyRound(f.kcal)} kcal`,
      url: "/food",
    });
  for (const r of recipes)
    results.push({
      kind: "recipe",
      id: r.id,
      title: r.name,
      detail: `Recipe · ${pyRound(r.kcal)} kcal a serving`,
      url: "/food",
    });
  return { q, results };
}

/** Everything logged on one date: training, habits, food, mood, body. */
export async function day(ctx: Ctx, authed: AuthedBatch, date: string) {
  const uid = authed.userId;
  const db = ctx.db;
  const [, workouts, habits, meals, journal, readiness, rest, weighIns] = await authed.read(
    repo.dayWorkouts(db, uid, date),
    repo.dayHabits(db, uid, date),
    repo.dayMeals(db, uid, date),
    repo.dayJournal(db, uid, date),
    repo.dayReadiness(db, uid, date),
    repo.dayRest(db, uid, date),
    repo.dayWeighIns(db, uid, date),
  );
  const kcal = meals.reduce((n, m) => n + (m.kcal ?? 0), 0);
  const protein = meals.reduce((n, m) => n + (m.protein_g ?? 0), 0);
  const j = journal[0];
  const r = readiness[0];
  const rd = rest[0];
  return {
    date,
    workouts: workouts.map((w) => ({ ...w })),
    habits: habits.map((h) => ({
      id: h.id,
      name: h.name,
      emoji: h.emoji,
      kind: h.kind,
      unit: h.unit,
      amount: h.amount ?? 0,
      note: h.note,
      done: isDone(h.kind, h.amount ?? 0, h.daily_goal),
    })),
    food: {
      meals: meals.map((m) => ({
        meal: m.meal,
        count: m.n,
        kcal: pyRound(m.kcal ?? 0, 1),
        protein_g: pyRound(m.protein_g ?? 0, 1),
      })),
      kcal: pyRound(kcal, 1),
      protein_g: pyRound(protein, 1),
    },
    journal: j === undefined ? null : { mood: j.mood, note: j.note },
    readiness: r === undefined ? null : { sleep: r.sleep, energy: r.energy, soreness: r.soreness },
    rest: rd === undefined ? null : { kind: rd.kind, note: rd.note },
    weigh_ins: weighIns.map((w) => ({ weight_kg: w.weight_kg, moment: w.moment })),
  };
}
