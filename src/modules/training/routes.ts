/**
 * Training routes (spec/training-a.md, training-b.md), mounted in the Python router order (spec/core.md §0):
 * `trainingRoutes`, `gearRoutes` (/gear), `personalRoutes`, `photoRoutes` (/body-photos), `meRoutes` (/me
 * monthly goal and rest days), `planRoutes` (/plans). Literal paths come before their parameterised siblings.
 */
import { Hono } from "hono";
import { libraryJsonBody } from "../../catalog/exercises.ts";
import { PLAN_TEMPLATE_SUMMARIES } from "../../catalog/plan-templates.ts";
import type { AppEnv } from "../../ctx.ts";
import { etagMatches } from "../../lib/etag.ts";
import { json, param, query } from "../../lib/validation.ts";
import { auth } from "../auth/service.ts";
import * as body from "./body.ts";
import * as chains from "./chains.ts";
import * as ex from "./exercises.ts";
import * as imports from "./imports.ts";
import * as personal from "./personal.ts";
import * as plans from "./plans.ts";
import * as s from "./schemas.ts";
import * as w from "./workouts.ts";

const noContent = (c: { body: (b: null, s: 204) => Response }) => c.body(null, 204);

export const trainingRoutes = new Hono<AppEnv>()
  .get("/library", (c) =>
    c.body(libraryJsonBody(), 200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    }),
  )
  // ---- workouts
  .get("/workouts", auth(), query(s.ListQuery), async (c) =>
    c.json(await w.list(c.var.ctx, c.var.authed, c.req.valid("query"))),
  )
  .get("/workouts/changes", auth(), query(s.ChangesQuery), async (c) => {
    const q = c.req.valid("query");
    const r = await w.changes(c.var.ctx, c.var.authed, q.since, q.limit);
    c.header("ETag", r.etag);
    c.header("Cache-Control", "private, no-cache");
    if (etagMatches(c.req.header("If-None-Match"), r.etag)) return c.body(null, 304);
    return c.json(r.body());
  })
  .post("/workouts/batch", auth(), json(s.BatchIn), async (c) =>
    c.json(await w.batch(c.var.ctx, c.var.authed, c.req.valid("json"))),
  )
  .post("/workouts/import", auth(), async (c) =>
    c.json(await imports.importFile(c.var.ctx, c.var.authed, c.req.raw)),
  )
  .get("/workouts/:workout_id", auth(), param(s.WorkoutId), async (c) =>
    c.json(await w.getOne(c.var.ctx, c.var.authed, c.req.valid("param").workout_id)),
  )
  .put("/workouts/:workout_id", auth(), param(s.WorkoutId), json(s.WorkoutIn), async (c) =>
    c.json(await w.putWorkout(c.var.ctx, c.var.authed, c.req.valid("param").workout_id, c.req.valid("json"))),
  )
  .delete("/workouts/:workout_id", auth(), param(s.WorkoutId), query(s.DeleteQuery), async (c) =>
    c.json(
      await w.deleteWorkout(
        c.var.ctx,
        c.var.authed,
        c.req.valid("param").workout_id,
        c.req.valid("query").client_updated_at,
      ),
    ),
  )
  // ---- exercises
  .get("/exercises/last", auth(), query(s.LastQuery), async (c) =>
    c.json(await w.last(c.var.ctx, c.var.authed, c.req.valid("query").ids)),
  )
  .get("/exercises/custom", auth(), async (c) => c.json(await ex.listCustom(c.var.ctx, c.var.authed)))
  .post("/exercises/custom", auth(), json(s.CustomExerciseIn), async (c) =>
    c.json(await ex.createCustom(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .put(
    "/exercises/custom/:exercise_id",
    auth(),
    param(s.ExerciseIdParam),
    json(s.CustomExerciseIn),
    async (c) =>
      c.json(
        await ex.updateCustom(c.var.ctx, c.var.authed, c.req.valid("param").exercise_id, c.req.valid("json")),
      ),
  )
  .delete("/exercises/custom/:exercise_id", auth(), param(s.ExerciseIdParam), async (c) => {
    await ex.deleteCustom(c.var.ctx, c.var.authed, c.req.valid("param").exercise_id);
    return noContent(c);
  })
  .get(
    "/exercises/:exercise_id/history",
    auth(),
    param(s.ExerciseIdParam),
    query(s.HistoryQuery),
    async (c) =>
      c.json(
        await w.history(
          c.var.ctx,
          c.var.authed,
          c.req.valid("param").exercise_id,
          c.req.valid("query").limit,
        ),
      ),
  )
  // ---- routines
  .get("/routines", auth(), async (c) => c.json(await ex.listRoutines(c.var.ctx, c.var.authed)))
  .post("/routines", auth(), json(s.RoutineIn), async (c) =>
    c.json(await ex.createRoutine(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .post("/routines/from-template/:template_id", auth(), param(s.TemplateId), async (c) =>
    c.json(await ex.routineFromTemplate(c.var.ctx, c.var.authed, c.req.valid("param").template_id), 201),
  )
  .put("/routines/:routine_id", auth(), param(s.RoutineId), json(s.RoutineIn), async (c) =>
    c.json(
      await ex.updateRoutine(c.var.ctx, c.var.authed, c.req.valid("param").routine_id, c.req.valid("json")),
    ),
  )
  .delete("/routines/:routine_id", auth(), param(s.RoutineId), async (c) => {
    await ex.deleteRoutine(c.var.ctx, c.var.authed, c.req.valid("param").routine_id);
    return noContent(c);
  })
  // ---- body metrics and weigh-ins
  .get("/body-metrics", auth(), query(s.DaysQuery), async (c) =>
    c.json(await body.listMetrics(c.var.ctx, c.var.authed, c.req.valid("query").days)),
  )
  .put("/body-metrics/:day", auth(), param(s.DayParam), json(s.BodyMetricIn), async (c) =>
    c.json(await body.putMetric(c.var.ctx, c.var.authed, c.req.valid("param").day, c.req.valid("json"))),
  )
  .delete("/body-metrics/:day", auth(), param(s.DayParam), async (c) => {
    await body.deleteMetric(c.var.ctx, c.var.authed, c.req.valid("param").day);
    return noContent(c);
  })
  .get("/weigh-ins", auth(), query(s.DaysQuery), async (c) =>
    c.json(await body.listWeighIns(c.var.ctx, c.var.authed, c.req.valid("query").days)),
  )
  .put("/weigh-ins/:weigh_in_id", auth(), param(s.WeighInId), json(s.WeighInIn), async (c) =>
    c.json(
      await body.putWeighIn(c.var.ctx, c.var.authed, c.req.valid("param").weigh_in_id, c.req.valid("json")),
    ),
  )
  .delete("/weigh-ins/:weigh_in_id", auth(), param(s.WeighInId), async (c) => {
    await body.deleteWeighIn(c.var.ctx, c.var.authed, c.req.valid("param").weigh_in_id);
    return noContent(c);
  })
  // ---- chains
  .get("/chains", auth(), async (c) => c.json(await chains.listChains(c.var.ctx, c.var.authed)))
  .post("/chains", auth(), json(s.ChainIn), async (c) =>
    c.json(await chains.createChain(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .patch("/chains/:chain_id", auth(), param(s.ChainId), json(s.ChainPatch), async (c) =>
    c.json(
      await chains.updateChain(c.var.ctx, c.var.authed, c.req.valid("param").chain_id, c.req.valid("json")),
    ),
  )
  .delete("/chains/:chain_id", auth(), param(s.ChainId), async (c) => {
    await chains.archiveChain(c.var.ctx, c.var.authed, c.req.valid("param").chain_id);
    return noContent(c);
  })
  .post("/chains/:chain_id/repair", auth(), param(s.ChainId), json(s.RepairIn), async (c) =>
    c.json(
      await chains.repairWeek(
        c.var.ctx,
        c.var.authed,
        c.req.valid("param").chain_id,
        c.req.valid("json").week_start,
      ),
    ),
  )
  // ---- pauses
  .get("/pauses", auth(), async (c) => c.json(await chains.listPauses(c.var.ctx, c.var.authed)))
  .post("/pauses", auth(), json(s.PauseIn), async (c) =>
    c.json(await chains.createPause(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .post("/pauses/:pause_id/end", auth(), param(s.PauseId), async (c) =>
    c.json(await chains.endPause(c.var.ctx, c.var.authed, c.req.valid("param").pause_id)),
  )
  .delete("/pauses/:pause_id", auth(), param(s.PauseId), async (c) => {
    await chains.deletePause(c.var.ctx, c.var.authed, c.req.valid("param").pause_id);
    return noContent(c);
  });

export const gearRoutes = new Hono<AppEnv>()
  .get("/", auth(), async (c) => c.json(await personal.listGear(c.var.ctx, c.var.authed)))
  .post("/", auth(), json(s.GearIn), async (c) =>
    c.json(await personal.createGear(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .patch("/:gear_id", auth(), param(s.GearId), json(s.GearPatch), async (c) =>
    c.json(
      await personal.updateGear(c.var.ctx, c.var.authed, c.req.valid("param").gear_id, c.req.valid("json")),
    ),
  )
  .delete("/:gear_id", auth(), param(s.GearId), async (c) => {
    await personal.deleteGear(c.var.ctx, c.var.authed, c.req.valid("param").gear_id);
    return noContent(c);
  });

export const personalRoutes = new Hono<AppEnv>()
  .get("/gyms", auth(), async (c) => c.json(await personal.listGyms(c.var.ctx, c.var.authed)))
  .post("/gyms", auth(), json(s.GymIn), async (c) =>
    c.json(await personal.createGym(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .put("/gyms/:gym_id", auth(), param(s.GymId), json(s.GymIn), async (c) =>
    c.json(
      await personal.updateGym(c.var.ctx, c.var.authed, c.req.valid("param").gym_id, c.req.valid("json")),
    ),
  )
  .delete("/gyms/:gym_id", auth(), param(s.GymId), async (c) => {
    await personal.deleteGym(c.var.ctx, c.var.authed, c.req.valid("param").gym_id);
    return noContent(c);
  })
  .get("/exercise-notes", auth(), async (c) => c.json(await personal.listNotes(c.var.ctx, c.var.authed)))
  .put("/exercise-notes/:exercise_id", auth(), param(s.ExerciseIdParam), json(s.ExerciseNoteIn), async (c) =>
    c.json(
      await personal.putNote(
        c.var.ctx,
        c.var.authed,
        c.req.valid("param").exercise_id,
        c.req.valid("json").note,
      ),
    ),
  )
  .get("/weight-goal", auth(), async (c) => c.json(await personal.getGoal(c.var.ctx, c.var.authed)))
  .put("/weight-goal", auth(), json(s.WeightGoalIn), async (c) => {
    const b = c.req.valid("json");
    return c.json(await personal.putGoal(c.var.ctx, c.var.authed, b.target_kg, b.milestone_kg));
  })
  .delete("/weight-goal", auth(), async (c) => {
    await personal.deleteGoal(c.var.ctx, c.var.authed);
    return noContent(c);
  })
  .get("/blocks/active", auth(), async (c) => c.json(await personal.activeBlock(c.var.ctx, c.var.authed)))
  .post("/blocks", auth(), json(s.BlockIn), async (c) =>
    c.json(await personal.startBlock(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .post("/blocks/:block_id/end", auth(), param(s.BlockId), async (c) => {
    await personal.endBlock(c.var.ctx, c.var.authed, c.req.valid("param").block_id);
    return noContent(c);
  })
  .get("/readiness", auth(), query(s.ReadinessQuery), async (c) =>
    c.json(await personal.listReadiness(c.var.ctx, c.var.authed, c.req.valid("query").days)),
  )
  .put("/readiness/:day", auth(), param(s.DayParam), json(s.ReadinessIn), async (c) =>
    c.json(
      await personal.putReadiness(c.var.ctx, c.var.authed, c.req.valid("param").day, c.req.valid("json")),
    ),
  )
  .get("/reflections", auth(), async (c) => c.json(await personal.listReflections(c.var.ctx, c.var.authed)))
  .put("/reflections/:week", auth(), param(s.WeekParam), json(s.ReflectionIn), async (c) =>
    c.json(
      await personal.putReflection(c.var.ctx, c.var.authed, c.req.valid("param").week, c.req.valid("json")),
    ),
  );

export const photoRoutes = new Hono<AppEnv>()
  .get("/", auth(), async (c) => c.json(await body.listPhotos(c.var.ctx, c.var.authed)))
  .delete("/", auth(), async (c) => {
    await body.deleteAllPhotos(c.var.ctx, c.var.authed);
    return noContent(c);
  })
  .get("/:photo_id", auth(), param(s.PhotoId), (c) =>
    body.getPhoto(c.var.ctx, c.var.authed, c.req.valid("param").photo_id),
  )
  .put("/:photo_id", auth(), param(s.PhotoId), query(s.PhotoIn), async (c) =>
    c.json(
      await body.uploadPhoto(c.var.ctx, c.var.authed, c.req.valid("param").photo_id, c.req.valid("query"), {
        contentType: c.req.header("Content-Type"),
        contentLength: c.req.header("Content-Length"),
        stream: c.req.raw.body,
      }),
    ),
  )
  .delete("/:photo_id", auth(), param(s.PhotoId), async (c) => {
    await body.deletePhoto(c.var.ctx, c.var.authed, c.req.valid("param").photo_id);
    return noContent(c);
  });

export const meRoutes = new Hono<AppEnv>()
  .get("/monthly-goal", auth(), query(s.MonthGoalQuery), async (c) =>
    c.json(await personal.getMonthGoal(c.var.ctx, c.var.authed, c.req.valid("query").month)),
  )
  .put("/monthly-goal", auth(), json(s.GoalIn), async (c) => {
    const b = c.req.valid("json");
    return c.json(await personal.setMonthGoal(c.var.ctx, c.var.authed, b.month, b.days));
  })
  .delete("/monthly-goal/:month", auth(), param(s.MonthParam), async (c) => {
    await personal.clearMonthGoal(c.var.ctx, c.var.authed, c.req.valid("param").month);
    return noContent(c);
  })
  .get("/rest-days", auth(), query(s.RestQuery), async (c) =>
    c.json(await personal.listRestDays(c.var.ctx, c.var.authed, c.req.valid("query").from)),
  )
  .put("/rest-days/:day", auth(), param(s.DayParam), json(s.RestIn), async (c) => {
    const b = c.req.valid("json");
    return c.json(
      await personal.putRestDay(c.var.ctx, c.var.authed, c.req.valid("param").day, b.kind, b.note),
    );
  })
  .delete("/rest-days/:day", auth(), param(s.DayParam), async (c) => {
    await personal.deleteRestDay(c.var.ctx, c.var.authed, c.req.valid("param").day);
    return noContent(c);
  });

export const planRoutes = new Hono<AppEnv>()
  .get("/templates", (c) => c.json(PLAN_TEMPLATE_SUMMARIES))
  .get("/", auth(), async (c) => c.json(await plans.listPlans(c.var.ctx, c.var.authed)))
  .get("/active", auth(), async (c) => c.json(await plans.activePlan(c.var.ctx, c.var.authed)))
  .post("/", auth(), json(s.PlanCreate), async (c) =>
    c.json(await plans.createPlan(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .post("/race", auth(), json(s.RaceIn), async (c) =>
    c.json(await plans.racePlan(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .post("/import", auth(), json(s.SharedPlan), async (c) =>
    c.json(await plans.importPlan(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .get("/:plan_id/export", auth(), param(s.PlanId), async (c) =>
    c.json(await plans.exportPlan(c.var.ctx, c.var.authed, c.req.valid("param").plan_id)),
  )
  .get("/:plan_id", auth(), param(s.PlanId), async (c) =>
    c.json(await plans.getPlan(c.var.ctx, c.var.authed, c.req.valid("param").plan_id)),
  )
  .put("/:plan_id", auth(), param(s.PlanId), json(s.PlanIn), async (c) =>
    c.json(
      await plans.updatePlan(c.var.ctx, c.var.authed, c.req.valid("param").plan_id, c.req.valid("json")),
    ),
  )
  .post("/:plan_id/start", auth(), param(s.PlanId), json(s.StartIn), async (c) =>
    c.json(
      await plans.startPlan(c.var.ctx, c.var.authed, c.req.valid("param").plan_id, c.req.valid("json").when),
    ),
  )
  .post("/:plan_id/stop", auth(), param(s.PlanId), async (c) =>
    c.json(await plans.stopPlan(c.var.ctx, c.var.authed, c.req.valid("param").plan_id)),
  )
  .delete("/:plan_id", auth(), param(s.PlanId), async (c) => {
    await plans.deletePlan(c.var.ctx, c.var.authed, c.req.valid("param").plan_id);
    return noContent(c);
  });
