/** /v1/journal and /v1/insights (spec/habits.md §1.3). Mounted at /v1. */
import { Hono } from "hono";
import type { AppEnv } from "../../ctx.ts";
import { json, param, query } from "../../lib/validation.ts";
import { auth } from "../auth/service.ts";
import * as s from "./schemas.ts";
import * as service from "./service.ts";

export const insightRoutes = new Hono<AppEnv>()
  .get("/journal", auth(), query(s.JournalQuery), async (c) => {
    const q = c.req.valid("query");
    return c.json(await service.listJournal(c.var.ctx, c.var.authed, q.days, q.q));
  })
  .put("/journal/:day", auth(), param(s.JournalDay), json(s.JournalIn), async (c) =>
    c.json(await service.putJournal(c.var.ctx, c.var.authed, c.req.valid("param").day, c.req.valid("json"))),
  )
  .delete("/journal/:day", auth(), param(s.JournalDay), async (c) =>
    c.json(await service.deleteJournal(c.var.ctx, c.var.authed, c.req.valid("param").day)),
  )
  .get("/insights", auth(), async (c) => c.json(await service.insights(c.var.ctx, c.var.authed)));
