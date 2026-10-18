/**
 * /v1/admin (spec/misc.md §3). Moderator and admin routes both answer 404 "Not found" to anyone else, so the
 * admin surface stays hidden. The role gate runs on each handler's first D1 read.
 */
import { Hono } from "hono";
import type { AuthedEnv } from "../../ctx.ts";
import { json, param, query } from "../../lib/validation.ts";
import { admin, moderator } from "../auth/service.ts";
import * as s from "./schemas.ts";
import * as service from "./service.ts";

export const adminRoutes = new Hono<AuthedEnv>()
  .get("/reports", moderator(), query(s.ReportsQuery), async (c) =>
    c.json(await service.listReports(c.var.ctx, c.var.authed, c.req.valid("query").status)),
  )
  .post("/reports/:report_id/resolve", moderator(), param(s.ReportId), json(s.ResolveIn), async (c) =>
    c.json(
      await service.resolveReport(
        c.var.ctx,
        c.var.authed,
        c.req.valid("param").report_id,
        c.req.valid("json"),
      ),
    ),
  )
  .get("/users", moderator(), query(s.UsersQuery), async (c) =>
    c.json(await service.listUsers(c.var.ctx, c.var.authed, c.req.valid("query").q)),
  )
  .patch("/users/:user_id", moderator(), param(s.UserId), json(s.UserPatch), async (c) =>
    c.json(
      await service.updateUser(c.var.ctx, c.var.authed, c.req.valid("param").user_id, c.req.valid("json")),
    ),
  )
  .post("/users/:user_id/official", admin(), param(s.UserId), json(s.OfficialIn), async (c) =>
    c.json(
      await service.setOfficial(c.var.ctx, c.var.authed, c.req.valid("param").user_id, c.req.valid("json")),
    ),
  )
  .post("/users/:user_id/merge", admin(), param(s.UserId), json(s.MergeIn), async (c) =>
    c.json(await service.merge(c.var.ctx, c.var.authed, c.req.valid("param").user_id, c.req.valid("json"))),
  )
  .get("/audit", moderator(), async (c) => c.json(await service.listAudit(c.var.ctx, c.var.authed)))
  .get("/metrics", moderator(), async (c) => c.json(await service.metrics(c.var.ctx, c.var.authed)));
