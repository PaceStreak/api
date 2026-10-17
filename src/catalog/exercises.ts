/**
 * The built-in exercise library (spec/training-a.md §1.1): disciplines, muscles, patterns, equipment, exercises
 * and starter routines. Everything is frozen and indexed once per isolate, at module load.
 */
import { fold } from "../lib/fold.ts";
import {
  DISCIPLINES_DATA,
  ENDURANCE_DATA,
  EQUIPMENT_DATA,
  EXERCISES_DATA,
  LOAD_TYPES_DATA,
  MUSCLES_DATA,
  PATTERNS_DATA,
  ROUTINE_TEMPLATES_DATA,
} from "./exercises.data.ts";
import { type DeepReadonly, deepFreeze } from "./freeze.ts";
import type { Discipline, Exercise, RoutineTemplate } from "./types.ts";

export type CatalogExercise = DeepReadonly<Exercise>;
export type CatalogRoutineTemplate = DeepReadonly<RoutineTemplate>;
export type CatalogDiscipline = DeepReadonly<Discipline>;

export const DISCIPLINES = deepFreeze(DISCIPLINES_DATA);
export const DISCIPLINE_BY_ID: ReadonlyMap<string, CatalogDiscipline> = new Map(
  DISCIPLINES.map((d) => [d.id, d]),
);
export const DISCIPLINE_IDS: ReadonlySet<string> = new Set(DISCIPLINES.map((d) => d.id));
export const ENDURANCE: ReadonlySet<string> = new Set(ENDURANCE_DATA);

export const MUSCLES = deepFreeze(MUSCLES_DATA);
export const PATTERNS = deepFreeze(PATTERNS_DATA);
export const PUSH_PATTERNS: ReadonlySet<string> = new Set(["push_h", "push_v"]);
export const PULL_PATTERNS: ReadonlySet<string> = new Set(["pull_h", "pull_v"]);
export const EQUIPMENT = deepFreeze(EQUIPMENT_DATA);
export const LOAD_TYPES = deepFreeze(LOAD_TYPES_DATA);

export const EXERCISES = deepFreeze(EXERCISES_DATA);
export const EXERCISE_BY_ID: ReadonlyMap<string, CatalogExercise> = new Map(EXERCISES.map((e) => [e.id, e]));
/** Custom exercises are addressed as `custom-<uuid>`; library ids never start with it. */
export const CUSTOM_PREFIX = "custom-";

export const ROUTINE_TEMPLATES = deepFreeze(ROUTINE_TEMPLATES_DATA);
export const ROUTINE_TEMPLATE_BY_ID: ReadonlyMap<string, CatalogRoutineTemplate> = new Map(
  ROUTINE_TEMPLATES.map((t) => [t.id, t]),
);

export interface ExerciseFoldEntry {
  readonly exercise: CatalogExercise;
  /** `fold(name)`. */
  readonly name: string;
  /** `fold(alias)` for each alias, in order. */
  readonly aliases: readonly string[];
}

/** Folded name and aliases per exercise, in library order: search never re-folds the library per request. */
export const EXERCISE_FOLD_INDEX: readonly ExerciseFoldEntry[] = Object.freeze(
  EXERCISES.map((e) =>
    Object.freeze({ exercise: e, name: fold(e.name), aliases: Object.freeze(e.aliases.map(fold)) }),
  ),
);

/**
 * Library exercises whose folded name or any alias contains the folded term, in library order. An empty term
 * matches nothing.
 */
export function searchExercises(term: string): CatalogExercise[] {
  const q = fold(term.trim());
  if (q === "") return [];
  const out: CatalogExercise[] = [];
  for (const entry of EXERCISE_FOLD_INDEX) {
    if (entry.name.includes(q) || entry.aliases.some((a) => a.includes(q))) out.push(entry.exercise);
  }
  return out;
}

/** The `to_dict()` shape of a library exercise: the stored fields plus `custom: false`. */
export function exerciseOut(e: CatalogExercise): CatalogExercise & { readonly custom: false } {
  return { ...e, custom: false };
}

/**
 * `GET /v1/library` body (Python `library_payload()`), built once per isolate. Serve it with
 * `Cache-Control: public, max-age=3600`.
 */
export const LIBRARY_PAYLOAD = deepFreeze({
  version: 1,
  disciplines: DISCIPLINES,
  muscles: MUSCLES,
  patterns: PATTERNS,
  equipment: EQUIPMENT,
  exercises: EXERCISES.map(exerciseOut),
  templates: ROUTINE_TEMPLATES,
});

let libraryJson: string | undefined;
/** `JSON.stringify(LIBRARY_PAYLOAD)`, serialised on first use and then reused for the isolate's life. */
export function libraryJsonBody(): string {
  libraryJson ??= JSON.stringify(LIBRARY_PAYLOAD);
  return libraryJson;
}
