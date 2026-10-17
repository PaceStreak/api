/** Built-in training plan templates (Python `app/training/plan_templates.py`), frozen and summarised once. */
import { EXERCISE_BY_ID, ROUTINE_TEMPLATE_BY_ID } from "./exercises.ts";
import { type DeepReadonly, deepFreeze } from "./freeze.ts";
import { PLAN_TEMPLATES_DATA } from "./plan-templates.data.ts";
import type { PlanTemplate, PlanTemplateSummary } from "./types.ts";

export type CatalogPlanTemplate = DeepReadonly<PlanTemplate>;

export const PLAN_TEMPLATES = deepFreeze(PLAN_TEMPLATES_DATA);
export const PLAN_TEMPLATE_BY_ID: ReadonlyMap<string, CatalogPlanTemplate> = new Map(
  PLAN_TEMPLATES.map((t) => [t.id, t]),
);

/** Python `_template_equipment`: every equipment kind the plan's routines use, minus bodyweight, sorted. */
function templateEquipment(t: CatalogPlanTemplate): string[] {
  const kinds = new Set<string>();
  for (const week of t.weeks) {
    for (const s of week) {
      const routine =
        s.routine_template === undefined ? undefined : ROUTINE_TEMPLATE_BY_ID.get(s.routine_template);
      if (routine === undefined) continue;
      for (const item of routine.items) {
        const ex = EXERCISE_BY_ID.get(item.exercise_id);
        if (ex !== undefined) kinds.add(ex.equipment);
      }
    }
  }
  kinds.delete("bodyweight");
  return [...kinds].sort();
}

/** `GET /v1/plans/templates` body (Python `plans.templates()`), computed once per isolate. */
export const PLAN_TEMPLATE_SUMMARIES: readonly DeepReadonly<PlanTemplateSummary>[] = deepFreeze(
  PLAN_TEMPLATES.map(
    (t): PlanTemplateSummary => ({
      id: t.id,
      name: t.name,
      summary: t.summary,
      weeks_count: t.weeks.length,
      per_week: Math.max(...t.weeks.map((w) => w.length)),
      disciplines: [...new Set(t.weeks.flatMap((w) => w.map((s) => s.discipline)))].sort(),
      equipment: templateEquipment(t),
    }),
  ),
);
