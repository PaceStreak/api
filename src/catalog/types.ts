/**
 * Shapes of the static catalogues. Keys are snake_case because these objects are served as-is on the wire
 * (`GET /v1/library`, `GET /v1/habits/catalog`, plan templates), matching the Python payloads.
 */

export interface Discipline {
  id: string;
  name: string;
  emoji: string;
  metrics: string[];
  verb: string;
}

export type LoadType = "weight" | "bodyweight" | "weighted_bw" | "time";

export interface Exercise {
  id: string;
  name: string;
  pattern: string;
  equipment: string;
  primary: string[];
  secondary: string[];
  load_type: string;
  rest_sec: number;
  cue: string;
  unilateral: boolean;
  aliases: string[];
}

export interface RoutineTemplateItem {
  exercise_id: string;
  sets: number;
  reps_min: number;
  reps_max: number;
  rest_sec: number;
  target_rpe: number;
  note: null;
}

export interface RoutineTemplate {
  id: string;
  name: string;
  discipline: string;
  summary: string;
  items: RoutineTemplateItem[];
}

/** A session in a plan template. `day` is an offset from the person's week start (0 = first day). */
export interface PlanTemplateSession {
  day: number;
  discipline: string;
  title: string;
  minutes: number;
  note?: string;
  routine_template?: string;
}

export interface PlanTemplate {
  id: string;
  name: string;
  summary: string;
  weeks: PlanTemplateSession[][];
}

/** The `GET /v1/plans/templates` row (Python `plans.templates()`). */
export interface PlanTemplateSummary {
  id: string;
  name: string;
  summary: string;
  weeks_count: number;
  per_week: number;
  disciplines: string[];
  equipment: string[];
}

export type HabitKind = "check" | "duration" | "count" | "quit";

export interface HabitTemplate {
  id: string;
  name: string;
  emoji: string;
  category: string;
  kind: string;
  blurb: string;
  unit: string | null;
  daily_goal: number | null;
  weekly_target: number;
  time_of_day: string;
  cue: string | null;
  total_goal: number | null;
}
