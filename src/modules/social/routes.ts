/** /v1 people, follows, feed, events, comments, reports (Python app/social/router.py) and buddies (buddies.py). */
import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../../ctx.ts";
import { slowDown } from "../../lib/errors.ts";
import { json, param, query } from "../../lib/validation.ts";
import { auth } from "../auth/service.ts";
import * as s from "./schemas.ts";
import * as service from "./service.ts";

/** People search: 60 a minute per user through the RL_SEARCH binding (DESIGN.md §7), no D1 write. */
const searchLimit: MiddlewareHandler<AppEnv & { Variables: { authed: { userId: string } } }> = async (
  c,
  next,
) => {
  const { success } = await c.env.RL_SEARCH.limit({ key: c.var.authed.userId });
  if (!success) throw slowDown();
  await next();
};

/** Kudos takes an optional body: none at all means plain kudos (FastAPI `body: KudosIn | None = None`). */
const kudosBody: MiddlewareHandler<AppEnv> = async (c, next) => {
  const raw = await c.req.text();
  if (raw.trim() === "") {
    c.req.addValidatedData("json", { reaction: "kudos" });
    return next();
  }
  return json<typeof s.KudosIn, AppEnv>(s.KudosIn)(c as never, next);
};

const before = (q: { before?: number | undefined }) => q.before ?? null;

export const socialRoutes = new Hono<AppEnv>()
  .get("/people/search", auth(), searchLimit, query(s.SearchQuery), async (c) =>
    c.json(await service.searchPeople(c.var.ctx, c.var.authed, c.req.valid("query").q)),
  )
  .get("/people/suggested", auth(), async (c) => c.json(await service.suggested(c.var.ctx, c.var.authed)))
  .get("/people/:handle", auth(), param(s.HandleParam), async (c) =>
    c.json(await service.viewPerson(c.var.ctx, c.var.authed, c.req.valid("param").handle)),
  )
  .get("/people/:handle/events", auth(), param(s.HandleParam), query(s.BeforeQuery), async (c) =>
    c.json(
      await service.personEvents(
        c.var.ctx,
        c.var.authed,
        c.req.valid("param").handle,
        before(c.req.valid("query")),
      ),
    ),
  )
  .post("/people/:handle/follow", auth(), param(s.HandleParam), async (c) =>
    c.json(await service.follow(c.var.ctx, c.var.authed, c.req.valid("param").handle)),
  )
  .delete("/people/:handle/follow", auth(), param(s.HandleParam), async (c) => {
    await service.unfollow(c.var.ctx, c.var.authed, c.req.valid("param").handle);
    return c.body(null, 204);
  })
  .delete("/people/:handle/follower", auth(), param(s.HandleParam), async (c) => {
    await service.removeFollower(c.var.ctx, c.var.authed, c.req.valid("param").handle);
    return c.body(null, 204);
  })
  .get("/people/:handle/followers", auth(), param(s.HandleParam), async (c) =>
    c.json(await service.followList(c.var.ctx, c.var.authed, c.req.valid("param").handle, true)),
  )
  .get("/people/:handle/following", auth(), param(s.HandleParam), async (c) =>
    c.json(await service.followList(c.var.ctx, c.var.authed, c.req.valid("param").handle, false)),
  )
  .get("/me/follow-requests", auth(), async (c) =>
    c.json(await service.followRequests(c.var.ctx, c.var.authed)),
  )
  .post("/me/follow-requests/:request_id/:decision", auth(), param(s.RequestParams), async (c) => {
    const p = c.req.valid("param");
    return c.json(await service.answerRequest(c.var.ctx, c.var.authed, p.request_id, p.decision));
  })
  .post("/people/:handle/block", auth(), param(s.HandleParam), async (c) => {
    await service.block(c.var.ctx, c.var.authed, c.req.valid("param").handle);
    return c.body(null, 204);
  })
  .delete("/people/:handle/block", auth(), param(s.HandleParam), async (c) => {
    await service.unblock(c.var.ctx, c.var.authed, c.req.valid("param").handle);
    return c.body(null, 204);
  })
  .get("/me/blocks", auth(), async (c) => c.json(await service.myBlocks(c.var.ctx, c.var.authed)))
  .get("/feed", auth(), query(s.BeforeQuery), async (c) =>
    c.json(await service.feed(c.var.ctx, c.var.authed, before(c.req.valid("query")))),
  )
  .post("/events/:event_id/kudos", auth(), param(s.EventId), kudosBody, async (c) => {
    const body = c.req.valid("json" as never) as { reaction: s.Reaction };
    return c.json(
      await service.giveKudos(c.var.ctx, c.var.authed, c.req.valid("param").event_id, body.reaction),
    );
  })
  .delete("/events/:event_id/kudos", auth(), param(s.EventId), async (c) =>
    c.json(await service.takeKudos(c.var.ctx, c.var.authed, c.req.valid("param").event_id)),
  )
  .get("/events/:event_id", auth(), param(s.EventId), async (c) =>
    c.json(await service.getEvent(c.var.ctx, c.var.authed, c.req.valid("param").event_id)),
  )
  .delete("/events/:event_id", auth(), param(s.EventId), async (c) => {
    await service.deleteEvent(c.var.ctx, c.var.authed, c.req.valid("param").event_id);
    return c.body(null, 204);
  })
  .get("/events/:event_id/comments", auth(), param(s.EventId), async (c) =>
    c.json(await service.listComments(c.var.ctx, c.var.authed, c.req.valid("param").event_id)),
  )
  .post("/events/:event_id/comments", auth(), param(s.EventId), json(s.CommentIn), async (c) =>
    c.json(
      await service.addComment(c.var.ctx, c.var.authed, c.req.valid("param").event_id, c.req.valid("json")),
      201,
    ),
  )
  .delete("/comments/:comment_id", auth(), param(s.CommentId), async (c) => {
    await service.deleteComment(c.var.ctx, c.var.authed, c.req.valid("param").comment_id);
    return c.body(null, 204);
  })
  .post("/reports", auth(), json(s.ReportIn), async (c) =>
    c.json(await service.report(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  );

export const buddyRoutes = new Hono<AppEnv>()
  .get("/buddies", auth(), async (c) => c.json(await service.listBuddies(c.var.ctx, c.var.authed)))
  .post("/buddies", auth(), json(s.InviteIn), async (c) =>
    c.json(await service.invite(c.var.ctx, c.var.authed, c.req.valid("json").handle), 201),
  )
  .post("/buddies/:pair_id/accept", auth(), param(s.PairId), async (c) =>
    c.json(await service.acceptBuddy(c.var.ctx, c.var.authed, c.req.valid("param").pair_id)),
  )
  .post("/buddies/:pair_id/end", auth(), param(s.PairId), async (c) => {
    await service.endBuddy(c.var.ctx, c.var.authed, c.req.valid("param").pair_id);
    return c.body(null, 204);
  })
  .get("/encouragement/presets", (c) => c.json(service.presets()))
  .post("/people/:handle/encourage", auth(), param(s.HandleParam), json(s.EncourageIn), async (c) =>
    c.json(
      await service.encourage(
        c.var.ctx,
        c.var.authed,
        c.req.valid("param").handle,
        c.req.valid("json").preset,
      ),
      202,
    ),
  );
