/** /v1/search and /v1/day/{day} (Python app/search/router.py): the owner's own log only. */
import { Hono } from "hono";
import type { AppEnv } from "../../ctx.ts";
import { param, query } from "../../lib/validation.ts";
import { auth } from "../auth/service.ts";
import { DayParam, SearchQuery } from "./schemas.ts";
import * as service from "./service.ts";

export const searchRoutes = new Hono<AppEnv>()
  .get("/search", auth(), query(SearchQuery), async (c) =>
    c.json(await service.search(c.var.ctx, c.var.authed, c.req.valid("query").q)),
  )
  .get("/day/:day", auth(), param(DayParam), async (c) =>
    c.json(await service.day(c.var.ctx, c.var.authed, c.req.valid("param").day)),
  );
