/**
 * Account routes (Python app/account/router.py and calendar.py, spec/account.md §1 routes 6-14): `/v1/me/*`
 * (mounted after game's) and the public feed `/v1/calendar/{token}.ics`.
 */
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../ctx.ts";
import { notFound } from "../../lib/errors.ts";
import { json, query } from "../../lib/validation.ts";
import { auth } from "../auth/service.ts";
import { requestMeta as metaOf } from "../profile/service.ts";
import * as service from "./service.ts";

const ExportQuery = z.object({
  format: z
    .string()
    .regex(/^(json|csv|ics)$/)
    .default("json"),
});
const requestMeta = (c: Context) => metaOf(c.req);
const DeleteIn = z.object({ password: z.string().min(1).max(256) });

export const accountRoutes = new Hono<AppEnv>()
  .get("/export", auth(), query(ExportQuery), async (c) => {
    const format = c.req.valid("query").format as "json" | "csv" | "ics";
    const out = await service.exportData(c.var.ctx, c.var.authed, format, requestMeta(c));
    return c.body(out.body as string, 200, {
      "Content-Type": out.contentType,
      "Content-Disposition": `attachment; filename="${out.filename}"`,
      "Cache-Control": "private, no-store",
    });
  })
  .post("/import", auth(), async (c) =>
    c.json(await service.importData(c.var.ctx, c.var.authed, c.req.raw.body, c.req.header("Content-Type"))),
  )
  .post("/delete", auth(), json(DeleteIn), async (c) =>
    c.json(
      await service.scheduleDeletion(c.var.ctx, c.var.authed, c.req.valid("json").password, requestMeta(c)),
    ),
  )
  .post("/delete/cancel", auth(), async (c) =>
    c.json(await service.cancelDeletion(c.var.ctx, c.var.authed, requestMeta(c))),
  )
  .get("/security-events", auth(), async (c) => c.json(await service.securityEvents(c.var.ctx, c.var.authed)))
  .get("/calendar", auth(), async (c) => c.json(await service.calendarStatus(c.var.ctx, c.var.authed)))
  .post("/calendar", auth(), async (c) =>
    c.json(await service.createFeed(c.var.ctx, c.var.authed, requestMeta(c)), 201),
  )
  .delete("/calendar", auth(), async (c) => {
    await service.revokeFeed(c.var.ctx, c.var.authed, requestMeta(c));
    return c.body(null, 204);
  });

export const calendarFeedRoutes = new Hono<AppEnv>().get("/:file", async (c) => {
  const file = c.req.param("file");
  if (!file.endsWith(".ics")) throw notFound();
  return service.feed(c.var.ctx, file.slice(0, -4));
});
