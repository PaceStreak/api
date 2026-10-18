/**
 * /v1/me game reads (11 routes) and /v1/leaderboards/{board} (spec/game.md §1). Literal paths are registered
 * before their prefixes: `/recap/month` before `/recap`, `/records/history` before `/records`.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../ctx.ts";
import { json, param, query } from "../../lib/validation.ts";
import { auth } from "../auth/service.ts";
import * as s from "./schemas.ts";
import * as service from "./service.ts";

export const gameRoutes = new Hono<AppEnv>()
  .get("/stats", auth(), async (c) => c.json(await service.stats(c.var.ctx, c.var.authed)))
  .post("/wager", auth(), json(s.WagerIn), async (c) =>
    c.json(await service.makeWager(c.var.ctx, c.var.authed, c.req.valid("json").week), 201),
  )
  .delete("/wager/:week", auth(), param(s.WagerWeek), async (c) => {
    await service.cancelWager(c.var.ctx, c.var.authed, c.req.valid("param").week);
    return c.body(null, 204);
  })
  .get("/recap/month", auth(), query(s.MonthQuery), async (c) =>
    c.json(await service.monthRecap(c.var.ctx, c.var.authed, c.req.valid("query").month)),
  )
  .get("/recap", auth(), query(s.RecapQuery), async (c) =>
    c.json(await service.recap(c.var.ctx, c.var.authed, c.req.valid("query").week)),
  )
  .get("/review", auth(), query(s.ReviewQuery), async (c) =>
    c.json(await service.review(c.var.ctx, c.var.authed, c.req.valid("query").year)),
  )
  .get("/records/history", auth(), query(s.HistoryQuery), async (c) =>
    c.json(await service.recordHistory(c.var.ctx, c.var.authed, c.req.valid("query").key)),
  )
  .get("/xp", auth(), async (c) => c.json(await service.xp(c.var.ctx, c.var.authed)))
  .get("/records", auth(), async (c) => c.json(await service.records(c.var.ctx, c.var.authed)))
  .get("/achievements", auth(), async (c) => c.json(await service.achievements(c.var.ctx, c.var.authed)))
  .get("/progress", auth(), query(s.ProgressQuery), async (c) =>
    c.json(await service.progress(c.var.ctx, c.var.authed, c.req.valid("query").weeks)),
  );

export const leaderboardRoutes = new Hono<AppEnv>().get(
  "/:board",
  auth(),
  param(s.BoardParam),
  query(s.BoardQuery),
  async (c) => {
    const q = c.req.valid("query");
    return c.json(
      await service.leaderboard(
        c.var.ctx,
        c.var.authed,
        c.req.valid("param").board,
        q.scope as "global" | "following" | "group" | "similar",
        q.group_id ?? null,
      ),
    );
  },
);
