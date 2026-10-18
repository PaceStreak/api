/**
 * The account export (Python `build_export`, EXPORT_VERSION 3; spec/account.md §2 "Export document") and the CSV
 * sheets. Every section is read in one D1 batch (no per-habit query); building the document is pure.
 */
import { CUSTOM_PREFIX, EXERCISE_BY_ID } from "../../catalog/exercises.ts";
import type { Stmt } from "../../db/batch.ts";
import { toWire } from "../../db/batch.ts";
import type { Db } from "../../db/client.ts";
import { type CsvCell, csvRow } from "../../heavy/csv.ts";
import { pyStr } from "../../lib/format.ts";
import type { ProfileRow } from "../profile/service.ts";
import { profileOut } from "../profile/service.ts";
import { METRIC_FIELDS } from "./importer.ts";
import * as repo from "./repo.ts";

export const EXPORT_VERSION = 3;

/** Every read the JSON export needs, in one batch. The profile row comes first (the caller may ensure it). */
export const exportReads = (db: Db, u: string) =>
  [
    repo.account(db, u),
    repo.profileRow(db, u),
    repo.chains(db, u),
    repo.repairs(db, u),
    repo.pauses(db, u),
    repo.customs(db, u),
    repo.liveWorkouts(db, u),
    repo.liveSets(db, u),
    repo.monthly(db, u),
    repo.rest(db, u),
    repo.gearRows(db, u),
    repo.gymRows(db, u),
    repo.notes(db, u),
    repo.weightGoal(db, u),
    repo.habitRows(db, u),
    repo.habitLogRows(db, u),
    repo.blocksRows(db, u),
    repo.readinessRows(db, u),
    repo.reflections(db, u),
    repo.wagers(db, u),
    repo.plans(db, u),
    repo.routineRows(db, u),
    repo.metrics(db, u),
    repo.photos(db, u),
    repo.weighInRows(db, u),
    repo.meals(db, u),
    repo.foodRows(db, u),
    repo.recipeRows(db, u),
    repo.journal(db, u),
    repo.habitRoutineRows(db, u),
    repo.nutritionTarget(db, u),
    repo.achievements(db, u),
    repo.records(db, u),
    repo.following(db, u),
    repo.followers(db, u),
    repo.blockedCount(db, u),
    repo.buddiesAsA(db, u),
    repo.buddiesAsB(db, u),
    repo.authoredComments(db, u),
    repo.memberships(db, u),
    repo.challengeRows(db, u),
    repo.prefs(db, u),
  ] as const;

type Reads = ReturnType<typeof exportReads>;
export type ExportRows = { -readonly [K in keyof Reads]: Awaited<Reads[K]> };

export const exportStatements = (db: Db, u: string): Stmt[] => [...exportReads(db, u)];

const date = (d: string | null) => d;
const km = (m: number | null) => (m ? m / 1000 : null);

/** Groups rows by a key, keeping their order. */
function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list === undefined) out.set(k, [r]);
    else list.push(r);
  }
  return out;
}

/** The export document, keys in Python's order. `null` when the account no longer exists. */
export function buildExport(now: number, r: ExportRows): Record<string, unknown> | null {
  const [
    acct,
    profileRows,
    chains,
    repairs,
    pauses,
    customs,
    workouts,
    sets,
    monthly,
    rest,
    gear,
    gyms,
    notes,
    goal,
    habits,
    logs,
    blocks,
    ready,
    reflections,
    wagers,
    plans,
    routines,
    metrics,
    photos,
    weighIns,
    meals,
    foods,
    recipes,
    journal,
    habitRoutines,
    target,
    achievements,
    records,
    following,
    followers,
    blocked,
    buddiesA,
    buddiesB,
    comments,
    memberships,
    challengeRows,
    prefs,
  ] = r;
  const a = acct[0];
  if (a === undefined) return null;
  const p = profileRows[0] as ProfileRow | undefined;
  const setsBy = groupBy(sets, (s) => s.workoutId);
  const daysBy = groupBy(logs, (l) => l.habitId);
  const buddies = [...buddiesA, ...buddiesB].sort((x, y) => x.createdAt - y.createdAt);
  return {
    format: "pacestreak-export",
    version: EXPORT_VERSION,
    exported_at: toWire(now),
    account: {
      email: a.email,
      created_at: toWire(a.createdAt),
      email_verified: a.isVerified,
      two_factor: a.totpEnabled,
    },
    profile: p === undefined ? null : { ...profileOut(p), accepted_terms_at: toWire(p.acceptedTermsAt) },
    chains: chains.map((c) => ({
      id: c.id,
      name: c.name,
      disciplines: c.disciplines,
      target_history: c.targetHistory,
      requirements_history: c.requirementsHistory,
    })),
    repairs: repairs.map((x) => ({ chain_id: x.chainId, week_start: x.weekStart, month: x.month })),
    pauses: pauses.map((x) => ({ starts_on: x.startsOn, ends_on: x.endsOn, reason: x.reason, note: x.note })),
    custom_exercises: customs.map((c) => ({
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
    })),
    workouts: workouts.map((w) => ({
      id: w.id,
      discipline: w.discipline,
      title: w.title,
      notes: w.notes,
      started_at: toWire(w.startedAt),
      local_date: w.localDate,
      duration_sec: w.durationSec,
      distance_m: w.distanceM,
      elevation_m: w.elevationM,
      effort: w.effort,
      feel: w.feel,
      routine_id: w.routineId,
      tags: w.tags,
      splits: w.splits,
      gear_id: w.gearId,
      gym_id: w.gymId,
      soreness: w.soreness,
      pump: w.pump,
      avg_hr: w.avgHr,
      max_hr: w.maxHr,
      hr_zones: w.hrZones,
      source: w.source,
      sets: (setsBy.get(w.id) ?? []).map((s) => ({
        exercise_id: s.exerciseId,
        position: s.position,
        set_index: s.setIndex,
        superset: s.superset,
        kind: s.kind,
        weight_kg: s.weightKg,
        reps: s.reps,
        rpe: s.rpe,
        duration_sec: s.durationSec,
        distance_m: s.distanceM,
        completed: s.completed,
      })),
    })),
    monthly_goals: monthly.map((g) => ({ month: g.month, days: g.days })),
    rest_days: rest.map((x) => ({ day: x.day, kind: x.kind, note: x.note })),
    gear: gear.map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      default_for: g.defaultFor,
      limit_km: km(g.limitM),
      initial_km: g.initialM / 1000,
      retired_at: toWire(g.retiredAt),
      note: g.note,
    })),
    gyms: gyms.map((g) => ({
      id: g.id,
      name: g.name,
      equipment: g.equipment,
      plates_kg: g.platesKg,
      bar_kg: g.barKg,
      is_default: g.isDefault,
    })),
    exercise_notes: notes.map((n) => ({ exercise_id: n.exerciseId, note: n.note })),
    weight_goal:
      goal[0] === undefined
        ? null
        : {
            target_kg: goal[0].targetKg,
            start_kg: goal[0].startKg,
            milestone_kg: goal[0].milestoneKg,
            set_on: goal[0].setOn,
          },
    habits: habits.map((h) => ({
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
      paused_from: date(h.pausedFrom),
      paused_until: date(h.pausedUntil),
      template_id: h.templateId,
      started_on: h.startedOn,
      archived_at: toWire(h.archivedAt),
      days: (daysBy.get(h.id) ?? []).map((l) => ({ date: l.day, amount: l.amount, note: l.note })),
    })),
    training_blocks: blocks.map((b) => ({
      name: b.name,
      starts_on: b.startsOn,
      weeks: b.weeks,
      rir_start: b.rirStart,
      rir_end: b.rirEnd,
      ended_at: toWire(b.endedAt),
    })),
    readiness: ready.map((x) => ({ date: x.day, sleep: x.sleep, energy: x.energy, soreness: x.soreness })),
    reflections: reflections.map((x) => ({
      week_start: x.weekStart,
      went_well: x.wentWell,
      change: x.change,
    })),
    streak_wagers: wagers.map((x) => ({ week_start: x.weekStart, days: x.days })),
    plans: plans.map((x) => ({
      name: x.name,
      description: x.description,
      template_id: x.templateId,
      weeks: x.weeks,
      started_on: x.startedOn,
      finished_at: toWire(x.finishedAt),
    })),
    routines: routines.map((x) => ({
      id: x.id,
      name: x.name,
      discipline: x.discipline,
      notes: x.notes,
      items: x.items,
    })),
    body_metrics: metrics.map((m) => ({
      date: m.measuredOn,
      body_fat_pct: m.bodyFatPct,
      resting_hr: m.restingHr,
      sleep_hours: m.sleepHours,
      waist_cm: m.waistCm,
      neck_cm: m.neckCm,
      shoulders_cm: m.shouldersCm,
      chest_cm: m.chestCm,
      arm_cm: m.armCm,
      forearm_cm: m.forearmCm,
      hips_cm: m.hipsCm,
      thigh_cm: m.thighCm,
      calf_cm: m.calfCm,
      note: m.note,
    })),
    // Backed-up photos are listed here; the images themselves are in the CSV export's photos/ folder.
    body_photos: photos.map((x) => ({ id: x.id, date: x.takenOn, pose: x.pose, size: x.size })),
    weigh_ins: weighIns.map((w) => ({
      id: w.id,
      weighed_at: toWire(w.weighedAt),
      date: w.localDate,
      moment: w.moment,
      weight_kg: w.weightKg,
      note: w.note,
    })),
    meals: meals.map((m) => ({
      id: m.id,
      date: m.day,
      meal: m.meal,
      name: m.name,
      servings: m.servings,
      kcal: m.kcal,
      protein_g: m.proteinG,
      carbs_g: m.carbsG,
      fat_g: m.fatG,
    })),
    foods: foods.map((f) => ({
      id: f.id,
      name: f.name,
      brand: f.brand,
      barcode: f.barcode,
      serving_label: f.servingLabel,
      kcal: f.kcal,
      protein_g: f.proteinG,
      carbs_g: f.carbsG,
      fat_g: f.fatG,
    })),
    recipes: recipes.map((x) => ({
      id: x.id,
      name: x.name,
      serves: x.serves,
      items: x.items,
      kcal: x.kcal,
      protein_g: x.proteinG,
      carbs_g: x.carbsG,
      fat_g: x.fatG,
    })),
    journal: journal.map((j) => ({ date: j.day, mood: j.mood, note: j.note })),
    habit_routines: habitRoutines.map((x) => ({
      id: x.id,
      name: x.name,
      emoji: x.emoji,
      time_of_day: x.timeOfDay,
      habit_ids: x.habitIds,
    })),
    nutrition_target:
      target[0] === undefined
        ? null
        : {
            kcal: target[0].kcal,
            protein_g: target[0].proteinG,
            carbs_g: target[0].carbsG,
            fat_g: target[0].fatG,
          },
    achievements: achievements.map((x) => ({ id: x.achievementId, tier: x.tier, unlocked_on: x.unlockedOn })),
    personal_records: records.map((x) => ({
      key: x.key,
      value: x.value,
      previous: x.previous,
      date: x.achievedOn,
      current: x.isCurrent,
    })),
    social: {
      following: following.map((f) => f.handle),
      followers: followers.map((f) => f.handle),
      blocked: blocked[0]?.n ?? 0,
      buddies: buddies.map((b) => ({
        handle: b.handle,
        status: b.status,
        started_at: toWire(b.startedAt),
        ended_at: toWire(b.endedAt),
      })),
      comments: comments.map((c) => ({
        id: c.id,
        event_id: c.eventId,
        body: c.body,
        created_at: toWire(c.createdAt),
      })),
      groups: memberships.map((m) => ({
        name: m.name,
        role: m.role,
        joined_at: toWire(m.joinedAt),
        shares_with_coach: m.sharesWithCoach,
      })),
      challenges: challengeRows.map((c) => ({
        title: c.title,
        starts_on: c.startsOn,
        ends_on: c.endsOn,
        final_score: c.finalScore,
        final_rank: c.finalRank,
      })),
    },
    notification_preferences: prefs[0]?.channels ?? {},
  };
}

// ---- CSV sheets ---------------------------------------------------------------------------------------------

export const csvReads = (db: Db, u: string) =>
  [
    repo.customs(db, u),
    repo.liveWorkouts(db, u),
    repo.liveSets(db, u),
    repo.metrics(db, u),
    repo.weighInRows(db, u),
    repo.meals(db, u),
    repo.journal(db, u),
    repo.habitDaysSheet(db, u),
    repo.photos(db, u),
  ] as const;
type CsvRead = ReturnType<typeof csvReads>;
export type CsvRows = { -readonly [K in keyof CsvRead]: Awaited<CsvRead[K]> };

/** Python `str(float)` for REAL columns (`100.0`), so the sheets read the same as before. */
const real = (x: number | null) => (x === null ? null : pyStr(x));

/** Python `str(datetime)` for an aware UTC datetime: `2026-10-17 09:00:00+00:00` (space, microseconds if any). */
function pyDateTime(ms: number): string {
  const iso = new Date(ms).toISOString();
  const frac = iso.slice(20, 23);
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}${frac === "000" ? "" : `.${frac}000`}+00:00`;
}

const sheet = (header: readonly string[], rows: Iterable<readonly CsvCell[]>) => {
  let out = csvRow(header);
  for (const r of rows) out += csvRow(r);
  return out;
};

export const README =
  "PaceStreak export.\n\nWeights are always kilograms and distances always metres,\n" +
  "whatever units the app displays. The JSON export contains everything,\n" +
  "including social data; these CSVs cover training, and photos/ holds any\n" +
  "progress photos you backed up.\n";

export interface Sheet {
  name: string;
  data: string;
}

/** The CSV sheets in the zip, in Python's order (photos are added by the caller, before README.txt). */
export function csvSheets(r: CsvRows): Sheet[] {
  const [customs, workouts, sets, metrics, weighIns, meals, journal, habitDays] = r;
  const names = new Map<string, string>([...EXERCISE_BY_ID.values()].map((e) => [e.id, e.name]));
  for (const c of customs) names.set(`${CUSTOM_PREFIX}${c.id}`, c.name);
  const dateOf = new Map(workouts.map((w) => [w.id, w.localDate]));
  const setsBy = groupBy(sets, (s) => s.workoutId);
  return [
    {
      name: "workouts.csv",
      data: sheet(
        [
          "id",
          "date",
          "started_at",
          "discipline",
          "title",
          "duration_sec",
          "distance_m",
          "elevation_m",
          "effort",
          "feel",
          "notes",
          "tags",
          "source",
        ],
        workouts.map((w) => [
          w.id,
          w.localDate,
          toWire(w.startedAt),
          w.discipline,
          w.title,
          w.durationSec,
          real(w.distanceM),
          real(w.elevationM),
          w.effort,
          w.feel,
          w.notes,
          w.tags.join(" "),
          w.source,
        ]),
      ),
    },
    {
      name: "sets.csv",
      data: sheet(
        [
          "workout_id",
          "date",
          "exercise_id",
          "exercise",
          "position",
          "set",
          "kind",
          "weight_kg",
          "reps",
          "rpe",
          "duration_sec",
          "distance_m",
          "completed",
        ],
        workouts.flatMap((w) =>
          (setsBy.get(w.id) ?? []).map((s): CsvCell[] => [
            s.workoutId,
            dateOf.get(s.workoutId) ?? null,
            s.exerciseId,
            names.get(s.exerciseId) ?? s.exerciseId,
            s.position,
            s.setIndex,
            s.kind,
            real(s.weightKg),
            s.reps,
            real(s.rpe),
            s.durationSec,
            real(s.distanceM),
            s.completed,
          ]),
        ),
      ),
    },
    {
      name: "body_metrics.csv",
      data: sheet(
        ["date", ...METRIC_FIELDS],
        metrics.map((m) => [
          m.measuredOn,
          real(m.bodyFatPct),
          m.restingHr,
          real(m.sleepHours),
          real(m.waistCm),
          real(m.neckCm),
          real(m.shouldersCm),
          real(m.chestCm),
          real(m.armCm),
          real(m.forearmCm),
          real(m.hipsCm),
          real(m.thighCm),
          real(m.calfCm),
          m.note,
        ]),
      ),
    },
    {
      name: "weigh_ins.csv",
      data: sheet(
        ["weighed_at", "date", "moment", "weight_kg", "note"],
        weighIns.map((w) => [pyDateTime(w.weighedAt), w.localDate, w.moment, real(w.weightKg), w.note]),
      ),
    },
    {
      name: "meals.csv",
      data: sheet(
        ["date", "meal", "name", "servings", "kcal", "protein_g", "carbs_g", "fat_g"],
        meals.map((m) => [
          m.day,
          m.meal,
          m.name,
          real(m.servings),
          real(m.kcal),
          real(m.proteinG),
          real(m.carbsG),
          real(m.fatG),
        ]),
      ),
    },
    {
      name: "journal.csv",
      data: sheet(
        ["date", "mood", "note"],
        journal.map((j) => [j.day, j.mood, j.note]),
      ),
    },
    {
      name: "habit_days.csv",
      data: sheet(
        ["habit", "kind", "unit", "date", "amount", "note"],
        habitDays.map((h) => [h.name, h.kind, h.unit, h.day, real(h.amount), h.note]),
      ),
    },
  ];
}

export const photoName = (p: { takenOn: string; pose: string; id: string; contentType: string }) =>
  `photos/${p.takenOn}_${p.pose}_${p.id}.${p.contentType === "image/png" ? "png" : p.contentType === "image/webp" ? "webp" : "jpg"}`;
