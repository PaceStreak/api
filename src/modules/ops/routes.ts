/**
 * Health (unversioned, spec/core.md §1.1) and ops under /v1 (§1.2). The two admin views here are served by the
 * Python ops router too; they sit behind `admin()` and its 404.
 */
import { Hono } from "hono";
import type { AppEnv, AuthedEnv } from "../../ctx.ts";
import { ipRateLimit } from "../../lib/ratelimit.ts";
import { json, param } from "../../lib/validation.ts";
import { admin } from "../auth/service.ts";
import { ClientErrorIn, ErrorId } from "./schemas.ts";
import * as service from "./service.ts";

/** Seconds a `/health` answer is served from the colo cache, so a monitor storm never wakes the isolate's work. */
export const HEALTH_CACHE_SECONDS = 5;

export const healthRoutes = new Hono<AppEnv>()
  // Liveness touches nothing, D1 included: a slow database must not make the API look dead.
  .get("/", async (c) => {
    const cache = caches.default;
    const key = new Request(new URL("/health", c.req.url).toString());
    const hit = await cache.match(key);
    if (hit !== undefined) return new Response(hit.body, hit);
    const res = c.json({ status: "healthy" }, 200, {
      "Cache-Control": `public, max-age=${HEALTH_CACHE_SECONDS}`,
    });
    c.var.ctx.defer(cache.put(key, res.clone()));
    return res;
  })
  .get("/ready", async (c) => {
    const r = await service.ready(c.var.ctx);
    return c.json(r.body, r.status);
  })
  .get("/worker", async (c) => {
    const r = await service.worker(c.var.ctx);
    return c.json(r.body, r.status);
  });

export const opsRoutes = new Hono<AuthedEnv>()
  .post("/client-errors", json(ClientErrorIn), ipRateLimit("RL_30", "client-errors"), async (c) =>
    c.json(await service.reportClientError(c.var.ctx, c.req.valid("json"), c.req.header("User-Agent")), 202),
  )
  .get("/admin/client-errors", admin(), async (c) =>
    c.json(await service.listClientErrors(c.var.ctx, c.var.authed)),
  )
  .delete("/admin/client-errors/:error_id", admin(), param(ErrorId), async (c) => {
    await service.deleteClientError(c.var.ctx, c.var.authed, c.req.valid("param").error_id);
    return c.body(null, 204);
  })
  .get("/admin/abuse", admin(), async (c) => c.json(await service.abuse(c.var.ctx, c.var.authed)));
