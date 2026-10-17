import { describe, expect, it } from "vitest";
import {
  EQUIPMENT,
  EXERCISE_BY_ID,
  EXERCISES,
  LOAD_TYPES,
  MUSCLES,
  PATTERNS,
  PLAN_TEMPLATE_SUMMARIES,
  PLAN_TEMPLATES,
  ROUTINE_TEMPLATE_BY_ID,
  ROUTINE_TEMPLATES,
} from "../../src/catalog/index.ts";

// The two route-level pytest cases (POST /v1/plans, POST /v1/routines/from-template) also need the training
// routes; here they check the catalogue data those routes rely on. The training unit adds the HTTP round-trip.

describe("test_exercise_catalog", () => {
  it("ids_and_names_are_unique", () => {
    const ids = EXERCISES.map((e) => e.id);
    const names = EXERCISES.map((e) => e.name.toLowerCase());
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every_exercise_uses_known_keys", () => {
    for (const e of EXERCISES) {
      expect(e.pattern in PATTERNS, e.id).toBe(true);
      expect(e.equipment in EQUIPMENT, e.id).toBe(true);
      expect(LOAD_TYPES.includes(e.load_type), e.id).toBe(true);
      expect(e.primary.length, e.id).toBeGreaterThan(0);
      for (const m of [...e.primary, ...e.secondary]) expect(m in MUSCLES, `${e.id} ${m}`).toBe(true);
      expect(
        e.primary.filter((m) => e.secondary.includes(m)),
        e.id,
      ).toEqual([]);
      expect(e.cue, e.id).not.toBe("");
      expect(e.rest_sec, e.id).toBeGreaterThanOrEqual(30);
      expect(e.rest_sec, e.id).toBeLessThanOrEqual(300);
    }
  });

  it("every_plan_template_starts_and_links_its_routines", () => {
    const byId = new Map(PLAN_TEMPLATE_SUMMARIES.map((t) => [t.id, t]));
    expect(byId.get("plan-run-from-zero")?.equipment).toEqual([]);
    expect(byId.get("plan-five-by-five")?.equipment).toEqual(["barbell"]);
    expect(new Set(byId.keys())).toEqual(new Set(PLAN_TEMPLATES.map((t) => t.id)));
    for (const t of PLAN_TEMPLATES) {
      for (const s of t.weeks.flat()) {
        if (s.routine_template !== undefined) {
          expect(ROUTINE_TEMPLATE_BY_ID.has(s.routine_template), `${t.id} ${s.routine_template}`).toBe(true);
        }
      }
    }
  });

  it("every_starter_routine_can_be_added", () => {
    for (const t of ROUTINE_TEMPLATES) {
      expect(t.items.length, t.id).toBeGreaterThan(0);
      for (const item of t.items)
        expect(EXERCISE_BY_ID.has(item.exercise_id), `${t.id} ${item.exercise_id}`).toBe(true);
    }
  });
});
