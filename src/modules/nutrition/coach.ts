/**
 * The daily coach (Python `app/coach/router.py`, spec/habits.md §2.5): a few lines of feedback built from the
 * person's own data by fixed rules - streak pace, readiness, habits and yesterday's food. No model writes these and
 * nothing leaves the server. Private to the owner; it reads habits, so it only ever counts them, never names them
 * (the card may sit on a screen someone else can see over a shoulder).
 *
 * One D1 round trip: the game snapshot with readiness, meal totals and the target read in the same batch. Those are
 * read for a UTC-safe span of days, because the person's local today is only known once the profile is read.
 */
import type { Ctx } from "../../ctx.ts";
import type { AuthedBatch } from "../../db/batch.ts";
import { formatG } from "../../lib/format.ts";
import { addDays, daysBetween } from "../../lib/time.ts";
import { type ChainResult, type HabitView, snapshotWith } from "../game/service.ts";
import * as repo from "./repo.ts";
import { totals } from "./service.ts";

/** Days without training before the coach says something. */
export const IDLE_DAYS = 5;
export const MAX_NOTES = 4;

export interface Note {
  kind: string;
  tone: "nudge" | "praise" | "rest" | "info";
  title: string;
  body: string;
  /** Lower sorts first: what to do today beats what went well. */
  rank: number;
}

const note = (kind: string, tone: Note["tone"], title: string, body: string, rank = 50): Note => ({
  kind,
  tone,
  title,
  body,
  rank,
});

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function streakNotes(
  chains: readonly { chain: { name: string }; result: ChainResult }[],
  today: string,
  lastActive: string | null,
): Note[] {
  const notes: Note[] = [];
  for (const { chain, result: r } of chains) {
    if (r.pausedNow) continue;
    const name = chain.name || "Your streak";
    if (r.needed <= 0)
      notes.push(
        note(
          "week_kept",
          "praise",
          `${name}: week kept`,
          `${r.thisWeekDays} of ${r.thisWeekTarget} done. Anything more is a bonus.`,
          70,
        ),
      );
    else if (r.atRisk)
      notes.push(
        note(
          "at_risk",
          "nudge",
          `${name} needs you today`,
          `${plural(r.needed, "more session")} with ${plural(r.daysLeft, "day")} left. Today is the day that keeps the week.`,
          10,
        ),
      );
    else
      notes.push(
        note(
          "on_pace",
          "info",
          `${name}: ${r.thisWeekDays} of ${r.thisWeekTarget}`,
          `${r.needed} more to go, ${plural(r.daysLeft, "day")} to do it.`,
          40,
        ),
      );
  }
  if (lastActive !== null) {
    const idle = daysBetween(lastActive, today);
    if (idle >= IDLE_DAYS)
      notes.push(
        note(
          "idle",
          "nudge",
          "It's been a few days",
          `Last session ${idle} days ago. Something short counts: twenty minutes beats a perfect plan you don't start.`,
          20,
        ),
      );
  }
  return notes;
}

export function readinessNotes(r: { sleep: number; energy: number; soreness: number } | undefined): Note[] {
  if (r === undefined) return [];
  if (r.sleep <= 2 || r.energy <= 2 || r.soreness >= 4) {
    const reason = r.sleep <= 2 ? "Short on sleep" : r.energy <= 2 ? "Low on energy" : "Still sore";
    return [
      note(
        "go_easy",
        "rest",
        `${reason}: go easy`,
        "Train lighter or make it mobility today. An easy day still counts; an injury costs weeks.",
        15,
      ),
    ];
  }
  if (r.sleep >= 4 && r.energy >= 4 && r.soreness <= 2)
    return [
      note(
        "go_hard",
        "praise",
        "Good day to push",
        "Slept well, fresh legs. If a hard session is on the plan, today suits it.",
        45,
      ),
    ];
  return [];
}

/** Counts only, never names. */
export function habitNotes(habits: readonly HabitView[]): Note[] {
  const short = habits.filter((v) => v.chain.thisWeekDays < v.chain.thisWeekTarget && !v.chain.pausedNow);
  if (short.length === 0) return [];
  const tight = short.filter((v) => v.chain.atRisk);
  if (tight.length > 0)
    return [
      note(
        "habits_at_risk",
        "nudge",
        `${plural(tight.length, "habit")} at risk this week`,
        "Only just enough days left to keep them. Check Today for which.",
        25,
      ),
    ];
  return [
    note(
      "habits_open",
      "info",
      `${plural(short.length, "habit")} still open this week`,
      "Plenty of time, but a tick today makes the end of the week easier.",
      60,
    ),
  ];
}

/**
 * Yesterday against the target. Gentle by design: under-eating gets the same tone as over-eating, and no target
 * means no judgement.
 */
export function foodNotes(
  eaten: { kcal: number; protein_g: number } | null,
  target: { kcal: number | null; proteinG: number | null } | undefined,
): Note[] {
  if (eaten === null || target === undefined) return [];
  const notes: Note[] = [];
  if (target.proteinG && eaten.protein_g < 0.8 * target.proteinG)
    notes.push(
      note(
        "protein_low",
        "nudge",
        "Protein ran short yesterday",
        `${formatG(eaten.protein_g)} g of ${formatG(target.proteinG)} g. Front-load some at breakfast today.`,
        35,
      ),
    );
  if (target.kcal) {
    const ratio = eaten.kcal / target.kcal;
    const of = `${formatG(eaten.kcal)} of ${formatG(target.kcal)} kcal.`;
    if (ratio < 0.75)
      notes.push(
        note(
          "kcal_low",
          "info",
          "Yesterday was well under target",
          `${of} Training on too little makes recovery harder; if you forgot to log, ignore this.`,
          38,
        ),
      );
    else if (ratio > 1.2)
      notes.push(
        note(
          "kcal_high",
          "info",
          "Yesterday was over target",
          `${of} One day changes nothing; the weekly trend is what counts.`,
          55,
        ),
      );
    else if (notes.length === 0)
      notes.push(
        note(
          "food_on_target",
          "praise",
          "Food on target yesterday",
          `${formatG(eaten.kcal)} kcal, ${formatG(eaten.protein_g)} g protein.`,
          65,
        ),
      );
  }
  return notes;
}

const strip = ({ rank: _, ...n }: Note) => n;

/** GET /v1/coach/today. */
export async function today(ctx: Ctx, authed: AuthedBatch) {
  const db = ctx.db;
  const u = authed.userId;
  const utc = new Date(ctx.clock.now()).toISOString().slice(0, 10);
  const { snapshot: snap, extra } = await snapshotWith(ctx, authed, [
    repo.readinessBetween(db, u, addDays(utc, -1), addDays(utc, 1)),
    repo.dailyTotalsBetween(db, u, addDays(utc, -2), utc),
    repo.targetOf(db, u),
  ] as const);
  const [ready, meals, target] = extra as [
    Awaited<ReturnType<typeof repo.readinessBetween>>,
    Awaited<ReturnType<typeof repo.dailyTotalsBetween>>,
    Awaited<ReturnType<typeof repo.targetOf>>,
  ];
  const day = snap.today;
  if (snap.pausedToday)
    return {
      date: day,
      notes: [
        strip(
          note(
            "paused",
            "rest",
            "Streaks are paused",
            "Nothing is counting down. Rest properly; the grid will be here.",
            0,
          ),
        ),
      ],
    };
  const yesterday = addDays(day, -1);
  const y = meals.find((m) => m.day === yesterday);
  const eaten =
    y === undefined
      ? null
      : totals([{ kcal: y.kcal, proteinG: y.protein_g, carbsG: y.carbs_g, fatG: y.fat_g }]);
  let notes = [
    ...streakNotes(snap.chains, day, snap.lastActive),
    ...readinessNotes(ready.find((r) => r.day === day)),
    ...habitNotes(snap.habits),
    ...foodNotes(eaten, target[0]),
  ]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_NOTES);
  if (notes.length === 0)
    notes = [
      note(
        "start",
        "info",
        "Nothing to flag",
        "Log a session, a meal or a check-in and this fills with feedback.",
      ),
    ];
  return { date: day, notes: notes.map(strip) };
}
