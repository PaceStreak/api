/**
 * /v1/notifications, 11 routes (spec/misc.md §2). The public key and both email-unsubscribe routes are
 * unauthenticated on purpose: the first is read before sign-in, the others are opened from a mail client.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../ctx.ts";
import { json, query } from "../../lib/validation.ts";
import { auth } from "../auth/service.ts";
import * as s from "./schemas.ts";
import * as service from "./service.ts";

export const notificationRoutes = new Hono<AppEnv>()
  .get("/", auth(), query(s.InboxQuery), async (c) =>
    c.json(await service.list(c.var.ctx, c.var.authed, c.req.valid("query"))),
  )
  .get("/unread-count", auth(), async (c) => c.json(await service.unreadCount(c.var.ctx, c.var.authed)))
  .post("/read", auth(), json(s.ReadIn), async (c) =>
    c.json(await service.markRead(c.var.ctx, c.var.authed, c.req.valid("json").ids)),
  )
  .get("/preferences", auth(), async (c) => c.json(await service.getPreferences(c.var.ctx, c.var.authed)))
  .put("/preferences", auth(), json(s.PreferencesIn), async (c) =>
    c.json(await service.putPreferences(c.var.ctx, c.var.authed, c.req.valid("json"))),
  )
  .get("/push/public-key", (c) => c.json(service.publicKey(c.var.ctx)))
  .post("/push/subscribe", auth(), json(s.SubscriptionIn), async (c) =>
    c.json(
      await service.subscribe(c.var.ctx, c.var.authed, c.req.valid("json"), c.req.header("User-Agent")),
      201,
    ),
  )
  .post("/push/unsubscribe", auth(), json(s.PushUnsubscribeIn), async (c) =>
    c.json(await service.unsubscribePush(c.var.ctx, c.var.authed, c.req.valid("json").endpoint)),
  )
  .post("/push/test", auth(), async (c) => c.json(await service.pushTest(c.var.ctx, c.var.authed)))
  // RFC 8058: the mail client POSTs `List-Unsubscribe=One-Click` with the parameters in the URL. The body
  // carries nothing we need, so it is not read.
  .post("/unsubscribe/one-click", query(s.EmailUnsubscribeIn), async (c) =>
    c.json(await service.emailUnsubscribe(c.var.ctx, c.req.valid("query"))),
  )
  .post("/unsubscribe", json(s.EmailUnsubscribeIn), async (c) =>
    c.json(await service.emailUnsubscribe(c.var.ctx, c.req.valid("json"))),
  );
