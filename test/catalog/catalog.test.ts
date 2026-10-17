import { describe, expect, it } from "vitest";
import {
  EXERCISE_FOLD_INDEX,
  EXERCISES,
  emptyAchievementContext,
  HABIT_CATALOG_PAYLOAD,
  HABIT_TEMPLATE_BY_ID,
  LIBRARY_PAYLOAD,
  libraryJsonBody,
  PLAN_TEMPLATES,
  progress,
  QUEST_POOL,
  questsFor,
  RULE_BY_ID,
  RULES,
  reached,
  searchExercises,
} from "../../src/catalog/index.ts";

function rule(id: string) {
  const r = RULE_BY_ID.get(id);
  if (r === undefined) throw new Error(id);
  return r;
}

describe("catalogue sizes match the Python source", () => {
  it("has every exercise, template, rule and quest", () => {
    expect(EXERCISES.length).toBe(283);
    expect(LIBRARY_PAYLOAD.templates.length).toBe(24);
    expect(PLAN_TEMPLATES.length).toBe(22);
    expect(HABIT_CATALOG_PAYLOAD.templates.length).toBe(68);
    expect(RULES.length).toBe(29);
    expect(QUEST_POOL.length).toBe(8);
  });
});

describe("frozen data", () => {
  it("cannot be mutated", () => {
    const e = EXERCISES[0];
    expect(Object.isFrozen(EXERCISES)).toBe(true);
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e?.primary)).toBe(true);
    expect(Object.isFrozen(HABIT_TEMPLATE_BY_ID.get("sleep-7"))).toBe(true);
  });

  it("serves exercises with custom false and caches the JSON body", () => {
    expect(LIBRARY_PAYLOAD.exercises.every((e) => e.custom === false)).toBe(true);
    expect(libraryJsonBody()).toBe(libraryJsonBody());
    expect(JSON.parse(libraryJsonBody()).version).toBe(1);
  });
});

describe("fold index", () => {
  it("is built once with folded names and aliases", () => {
    expect(EXERCISE_FOLD_INDEX.length).toBe(EXERCISES.length);
    const ohs = EXERCISE_FOLD_INDEX.find((x) => x.exercise.id === "overhead-squat");
    expect(ohs?.aliases).toEqual(["ohs"]);
  });

  it("searches case- and accent-insensitively over names and aliases", () => {
    expect(searchExercises("BÄCK SQUAT").map((e) => e.id)).toContain("back-squat");
    expect(searchExercises("ssb").map((e) => e.id)).toEqual(["safety-bar-squat"]);
    expect(searchExercises("  ")).toEqual([]);
  });
});

describe("achievement rules", () => {
  it("match Python reached() and progress()", () => {
    const c = {
      ...emptyAchievementContext(),
      tonnage_kg: 30000.25,
      push_sets: 30,
      pull_sets: 25,
      distance_km: 42.25,
    };
    expect(reached(rule("tonnage"), c)).toEqual(["bronze"]);
    expect(progress(rule("tonnage"), c)).toEqual({ value: 30000.2, next: 100000, max: 500000 });
    expect(reached(rule("balanced"), c)).toEqual([null]);
    expect(progress(rule("balanced"), c)).toEqual({ value: 83.3, next: null, max: 75 });
    expect(progress(rule("distance"), c)).toEqual({ value: 42.2, next: 500, max: 2000 });
    expect(reached(rule("first_session"), c)).toEqual([]);
  });
});

describe("quest pick", () => {
  it("matches Python quests_for", () => {
    const ids = (w: string, weighs: boolean, habits: boolean) =>
      questsFor(w, weighs, habits).map((x) => x.id);
    expect(ids("2026-10-12", false, false)).toEqual(["early_week", "rest_day", "new_exercise"]);
    expect(ids("2026-10-19", true, false)).toEqual(["morning_weigh", "new_exercise", "rpe"]);
    expect(ids("2026-10-26", true, true)).toEqual(["new_exercise", "balanced", "morning_weigh"]);
    expect(ids("2024-01-01", false, true)).toEqual(["rest_day", "short_counts", "balanced"]);
  });
});
