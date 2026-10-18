/** /v1/trash (spec/account.md §15-18). */
import { Hono } from "hono";
import type { AppEnv } from "../../ctx.ts";
import { param } from "../../lib/validation.ts";
import { auth } from "../auth/service.ts";
import { TrashId } from "./schemas.ts";
import * as service from "./service.ts";

export const trashRoutes = new Hono<AppEnv>()
  .get("/", auth(), async (c) => c.json(await service.list(c.var.ctx, c.var.authed)))
  .post("/:trash_id/restore", auth(), param(TrashId), async (c) =>
    c.json(await service.restore(c.var.ctx, c.var.authed, c.req.valid("param").trash_id)),
  )
  .delete("/:trash_id", auth(), param(TrashId), async (c) => {
    await service.forget(c.var.ctx, c.var.authed, c.req.valid("param").trash_id);
    return c.body(null, 204);
  })
  .delete("/", auth(), async (c) => {
    await service.empty(c.var.ctx, c.var.authed);
    return c.body(null, 204);
  });
