/**
 * The signed-in person (Python app/profile/router.py, spec/account.md §1 routes 1-5): `/v1/me` bootstrap,
 * onboarding, terms and settings, mounted before game's `/v1/me` routes; `/v1/handles/{handle}` separately.
 */
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../ctx.ts";
import { json, param } from "../../lib/validation.ts";
import { auth } from "../auth/service.ts";
import * as s from "./schemas.ts";
import * as service from "./service.ts";

const requestMeta = (c: Context) => service.requestMeta(c.req);

export const profileRoutes = new Hono<AppEnv>()
  .get("/", auth(), async (c) => c.json(await service.me(c.var.ctx, c.var.authed)))
  .post("/onboarding", auth(), json(s.OnboardingIn), async (c) =>
    c.json(await service.onboarding(c.var.ctx, c.var.authed, c.req.valid("json"))),
  )
  .post("/terms", auth(), json(s.TermsIn), async (c) =>
    c.json(await service.acceptTerms(c.var.ctx, c.var.authed, c.req.valid("json").version, requestMeta(c))),
  )
  .patch("/profile", auth(), json(s.ProfilePatch), async (c) =>
    c.json(await service.patchProfile(c.var.ctx, c.var.authed, c.req.valid("json"))),
  );

export const handleRoutes = new Hono<AppEnv>().get("/:handle", auth(), param(s.HandleParam), async (c) =>
  c.json(await service.handleAvailable(c.var.ctx, c.var.authed, c.req.valid("param").handle)),
);
