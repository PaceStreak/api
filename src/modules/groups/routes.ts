/** /v1 groups, coaching, challenges and announcements (Python app/groups/router.py). */
import { Hono } from "hono";
import type { AppEnv } from "../../ctx.ts";
import { json, param, query } from "../../lib/validation.ts";
import { auth } from "../auth/service.ts";
import * as s from "./schemas.ts";
import * as service from "./service.ts";

export const groupRoutes = new Hono<AppEnv>()
  .get("/groups", auth(), async (c) => c.json(await service.myGroups(c.var.ctx, c.var.authed)))
  .post("/groups", auth(), json(s.GroupIn), async (c) =>
    c.json(await service.createGroup(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .post("/groups/join", auth(), json(s.JoinIn), async (c) =>
    c.json(await service.joinGroup(c.var.ctx, c.var.authed, c.req.valid("json").code)),
  )
  .get("/groups/:group_id", auth(), param(s.GroupId), async (c) =>
    c.json(await service.getGroup(c.var.ctx, c.var.authed, c.req.valid("param").group_id)),
  )
  .patch("/groups/:group_id", auth(), param(s.GroupId), json(s.GroupPatch), async (c) =>
    c.json(
      await service.updateGroup(c.var.ctx, c.var.authed, c.req.valid("param").group_id, c.req.valid("json")),
    ),
  )
  .delete("/groups/:group_id", auth(), param(s.GroupId), async (c) => {
    await service.deleteGroup(c.var.ctx, c.var.authed, c.req.valid("param").group_id);
    return c.body(null, 204);
  })
  .post("/groups/:group_id/leave", auth(), param(s.GroupId), async (c) => {
    await service.leaveGroup(c.var.ctx, c.var.authed, c.req.valid("param").group_id);
    return c.body(null, 204);
  })
  .post("/groups/:group_id/invite/rotate", auth(), param(s.GroupId), async (c) =>
    c.json(await service.rotateInvite(c.var.ctx, c.var.authed, c.req.valid("param").group_id)),
  )
  .patch(
    "/groups/:group_id/members/:member_id",
    auth(),
    param(s.MemberParams),
    json(s.MemberPatch),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(
        await service.setRole(c.var.ctx, c.var.authed, p.group_id, p.member_id, c.req.valid("json").role),
      );
    },
  )
  .delete("/groups/:group_id/members/:member_id", auth(), param(s.MemberParams), async (c) => {
    const p = c.req.valid("param");
    await service.removeMember(c.var.ctx, c.var.authed, p.group_id, p.member_id);
    return c.body(null, 204);
  })
  .patch("/groups/:group_id/me", auth(), param(s.GroupId), json(s.MembershipPatch), async (c) =>
    c.json(
      await service.patchMe(c.var.ctx, c.var.authed, c.req.valid("param").group_id, c.req.valid("json")),
    ),
  )
  .get("/coaching", auth(), async (c) => c.json(await service.coaching(c.var.ctx, c.var.authed)))
  .get("/groups/:group_id/coach", auth(), param(s.GroupId), async (c) =>
    c.json(await service.coachView(c.var.ctx, c.var.authed, c.req.valid("param").group_id)),
  )
  .get("/groups/:group_id/feed", auth(), param(s.GroupId), query(s.FeedQuery), async (c) =>
    c.json(
      await service.groupFeed(
        c.var.ctx,
        c.var.authed,
        c.req.valid("param").group_id,
        c.req.valid("query").before ?? null,
      ),
    ),
  )
  .get("/challenges", auth(), async (c) => c.json(await service.listChallenges(c.var.ctx, c.var.authed)))
  .post("/challenges", auth(), json(s.ChallengeIn), async (c) =>
    c.json(await service.createChallenge(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .get("/challenges/code/:code", auth(), param(s.CodeParam), async (c) =>
    c.json(await service.previewChallenge(c.var.ctx, c.var.authed, c.req.valid("param").code)),
  )
  .post("/challenges/join", auth(), json(s.JoinIn), async (c) =>
    c.json(await service.joinByCode(c.var.ctx, c.var.authed, c.req.valid("json").code)),
  )
  .get("/challenges/:challenge_id", auth(), param(s.ChallengeId), async (c) =>
    c.json(await service.getChallenge(c.var.ctx, c.var.authed, c.req.valid("param").challenge_id)),
  )
  .post("/challenges/:challenge_id/join", auth(), param(s.ChallengeId), async (c) =>
    c.json(await service.joinChallenge(c.var.ctx, c.var.authed, c.req.valid("param").challenge_id)),
  )
  .post("/challenges/:challenge_id/leave", auth(), param(s.ChallengeId), async (c) => {
    await service.leaveChallenge(c.var.ctx, c.var.authed, c.req.valid("param").challenge_id);
    return c.body(null, 204);
  })
  .delete("/challenges/:challenge_id", auth(), param(s.ChallengeId), async (c) => {
    await service.deleteChallenge(c.var.ctx, c.var.authed, c.req.valid("param").challenge_id);
    return c.body(null, 204);
  })
  .post(
    "/groups/:group_id/members/:member_id/plan",
    auth(),
    param(s.MemberParams),
    json(s.AssignIn),
    async (c) => {
      const p = c.req.valid("param");
      return c.json(
        await service.assignPlan(c.var.ctx, c.var.authed, p.group_id, p.member_id, c.req.valid("json")),
        201,
      );
    },
  )
  .get("/groups/:group_id/announcements", auth(), param(s.GroupId), async (c) =>
    c.json(await service.listAnnouncements(c.var.ctx, c.var.authed, c.req.valid("param").group_id)),
  )
  .post("/groups/:group_id/announcements", auth(), param(s.GroupId), json(s.AnnouncementIn), async (c) =>
    c.json(
      await service.postAnnouncement(
        c.var.ctx,
        c.var.authed,
        c.req.valid("param").group_id,
        c.req.valid("json"),
      ),
      201,
    ),
  )
  .delete(
    "/groups/:group_id/announcements/:announcement_id",
    auth(),
    param(s.AnnouncementParams),
    async (c) => {
      const p = c.req.valid("param");
      await service.deleteAnnouncement(c.var.ctx, c.var.authed, p.group_id, p.announcement_id);
      return c.body(null, 204);
    },
  );
