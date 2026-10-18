/** /v1/nutrition (spec/misc.md §1) and /v1/coach (spec/habits.md §1.4). */
import { Hono } from "hono";
import type { AppEnv } from "../../ctx.ts";
import { ipRateLimit } from "../../lib/ratelimit.ts";
import { json, param, query } from "../../lib/validation.ts";
import { auth } from "../auth/service.ts";
import * as coach from "./coach.ts";
import * as s from "./schemas.ts";
import * as service from "./service.ts";

export const nutritionRoutes = new Hono<AppEnv>()
  .get("/days/:day", auth(), param(s.DayParam), async (c) =>
    c.json(await service.getDay(c.var.ctx, c.var.authed, c.req.valid("param").day)),
  )
  .get("/history", auth(), query(s.HistoryQuery), async (c) =>
    c.json(await service.history(c.var.ctx, c.var.authed, c.req.valid("query").days)),
  )
  .put("/entries/:entry_id", auth(), param(s.EntryId), json(s.EntryIn), async (c) =>
    c.json(
      await service.putEntry(c.var.ctx, c.var.authed, c.req.valid("param").entry_id, c.req.valid("json")),
    ),
  )
  .delete("/entries/:entry_id", auth(), param(s.EntryId), async (c) =>
    c.json(await service.deleteEntry(c.var.ctx, c.var.authed, c.req.valid("param").entry_id)),
  )
  .post("/copy", auth(), json(s.CopyIn), async (c) =>
    c.json(await service.copy(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .get("/foods", auth(), query(s.FoodsQuery), async (c) =>
    c.json(await service.listFoods(c.var.ctx, c.var.authed, c.req.valid("query").q)),
  )
  .get("/recent", auth(), async (c) => c.json(await service.recent(c.var.ctx, c.var.authed)))
  .post("/foods", auth(), json(s.FoodIn), async (c) =>
    c.json(await service.createFood(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .put("/foods/:food_id", auth(), param(s.FoodId), json(s.FoodIn), async (c) =>
    c.json(
      await service.updateFood(c.var.ctx, c.var.authed, c.req.valid("param").food_id, c.req.valid("json")),
    ),
  )
  .delete("/foods/:food_id", auth(), param(s.FoodId), async (c) =>
    c.json(await service.deleteFood(c.var.ctx, c.var.authed, c.req.valid("param").food_id)),
  )
  // slowapi ran after the dependencies, so only signed-in calls count toward the 30 a minute.
  .get("/barcode/:code", auth(), ipRateLimit("RL_30", "barcode"), async (c) =>
    c.json(await service.barcode(c.var.ctx, c.var.authed, c.req.param("code"))),
  )
  .get("/target", auth(), async (c) => c.json(await service.getTarget(c.var.ctx, c.var.authed)))
  .put("/target", auth(), json(s.TargetIn), async (c) =>
    c.json(await service.putTarget(c.var.ctx, c.var.authed, c.req.valid("json"))),
  )
  .get("/recipes", auth(), async (c) => c.json(await service.listRecipes(c.var.ctx, c.var.authed)))
  .post("/recipes", auth(), json(s.RecipeIn), async (c) =>
    c.json(await service.createRecipe(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .put("/recipes/:recipe_id", auth(), param(s.RecipeId), json(s.RecipeIn), async (c) =>
    c.json(
      await service.updateRecipe(
        c.var.ctx,
        c.var.authed,
        c.req.valid("param").recipe_id,
        c.req.valid("json"),
      ),
    ),
  )
  .delete("/recipes/:recipe_id", auth(), param(s.RecipeId), async (c) =>
    c.json(await service.deleteRecipe(c.var.ctx, c.var.authed, c.req.valid("param").recipe_id)),
  )
  .get("/expenditure", auth(), async (c) => c.json(await service.expenditure(c.var.ctx, c.var.authed)));

export const coachRoutes = new Hono<AppEnv>().get("/today", auth(), async (c) =>
  c.json(await coach.today(c.var.ctx, c.var.authed)),
);
