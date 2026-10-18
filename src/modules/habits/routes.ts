/**
 * /v1/habits (19 routes) and /v1/habit-routines (4), spec/habits.md §1.1-§1.2. Static paths (`/catalog`,
 * `/import`, `/order`) are registered before `/:id`. The catalogue and the reminder action are unauthenticated:
 * the first is public data, the second carries its own signature.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../ctx.ts";
import { collectMultipart } from "../../heavy/multipart.ts";
import { HttpError } from "../../lib/errors.ts";
import { ipRateLimit } from "../../lib/ratelimit.ts";
import { json, param, query } from "../../lib/validation.ts";
import { auth } from "../auth/service.ts";
import { MAX_BYTES } from "./importer.ts";
import * as s from "./schemas.ts";
import * as service from "./service.ts";

const missingFile = () =>
  new HttpError(422, [{ type: "missing", loc: ["body", "file"], msg: "Field required", input: null }]);

export const habitRoutes = new Hono<AppEnv>()
  .get("/catalog", (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    return c.json(service.catalog());
  })
  .get("/", auth(), query(s.ListQuery), async (c) =>
    c.json(await service.list(c.var.ctx, c.var.authed, c.req.valid("query").archived)),
  )
  .post("/", auth(), json(s.HabitIn), async (c) =>
    c.json(await service.create(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .post("/import", auth(), async (c) => {
    // Python read the file up to 5 MB + 1 byte and refused the rest in the parser, with this 422.
    const form = await collectMultipart(c.req.raw.body, c.req.header("Content-Type"), {
      maxFileBytes: MAX_BYTES,
      tooLarge: () => new HttpError(422, "That file is over 5 MB"),
    });
    const file = form.files.get("file");
    if (file === undefined) throw missingFile();
    const raw = form.fields.get("dry_run");
    const dryRun = raw === undefined ? false : s.parseLaxBool(raw);
    if (dryRun === null)
      throw new HttpError(422, [
        {
          type: "bool_parsing",
          loc: ["body", "dry_run"],
          msg: "Input should be a valid boolean, unable to interpret input",
          input: raw,
        },
      ]);
    return c.json(
      await service.importHabits(
        c.var.ctx,
        c.var.authed,
        { filename: file.filename, bytes: file.bytes },
        dryRun,
      ),
    );
  })
  .put("/order", auth(), json(s.OrderIn), async (c) => {
    await service.reorder(c.var.ctx, c.var.authed, c.req.valid("json").ids);
    return c.body(null, 204);
  })
  .get("/:id/stats", auth(), param(s.HabitId), query(s.StatsQuery), async (c) =>
    c.json(await service.stats(c.var.ctx, c.var.authed, c.req.valid("param").id, c.req.valid("query").weeks)),
  )
  .get("/:id", auth(), param(s.HabitId), query(s.DetailQuery), async (c) =>
    c.json(await service.get(c.var.ctx, c.var.authed, c.req.valid("param").id, c.req.valid("query").days)),
  )
  .patch("/:id", auth(), param(s.HabitId), json(s.HabitIn), async (c) =>
    c.json(await service.update(c.var.ctx, c.var.authed, c.req.valid("param").id, c.req.valid("json"))),
  )
  .post("/:id/archive", auth(), param(s.HabitId), async (c) =>
    c.json(await service.setArchived(c.var.ctx, c.var.authed, c.req.valid("param").id, true)),
  )
  .post("/:id/pause", auth(), param(s.HabitId), json(s.PauseIn), async (c) =>
    c.json(await service.pause(c.var.ctx, c.var.authed, c.req.valid("param").id, c.req.valid("json"))),
  )
  .post("/:id/resume", auth(), param(s.HabitId), async (c) =>
    c.json(await service.resume(c.var.ctx, c.var.authed, c.req.valid("param").id)),
  )
  .post("/:id/unarchive", auth(), param(s.HabitId), async (c) =>
    c.json(await service.setArchived(c.var.ctx, c.var.authed, c.req.valid("param").id, false)),
  )
  .delete("/:id", auth(), param(s.HabitId), async (c) =>
    c.json(await service.remove(c.var.ctx, c.var.authed, c.req.valid("param").id)),
  )
  .put("/:id/days/:day", auth(), param(s.HabitDay), json(s.DayIn), async (c) => {
    const p = c.req.valid("param");
    return c.json(await service.setDay(c.var.ctx, c.var.authed, p.id, p.day, c.req.valid("json")));
  })
  .post("/:id/days/:day/add", auth(), param(s.HabitDay), json(s.AddIn), async (c) => {
    const p = c.req.valid("param");
    return c.json(await service.addToDay(c.var.ctx, c.var.authed, p.id, p.day, c.req.valid("json").amount));
  })
  .put("/:id/days", auth(), param(s.HabitId), json(s.BulkIn), async (c) =>
    c.json(await service.setDays(c.var.ctx, c.var.authed, c.req.valid("param").id, c.req.valid("json").days)),
  )
  .post("/:id/snooze", auth(), param(s.HabitId), json(s.SnoozeIn), async (c) =>
    c.json(
      await service.snooze(c.var.ctx, c.var.authed, c.req.valid("param").id, c.req.valid("json").minutes),
    ),
  )
  .delete("/:id/snooze", auth(), param(s.HabitId), async (c) => {
    await service.unsnooze(c.var.ctx, c.var.authed, c.req.valid("param").id);
    return c.body(null, 204);
  })
  .post(
    "/:id/action",
    ipRateLimit("RL_30", "habit_action"),
    param(s.HabitId),
    query(s.ActionQuery),
    async (c) => c.json(await service.action(c.var.ctx, c.req.valid("param").id, c.req.valid("query"))),
  );

export const habitRoutineRoutes = new Hono<AppEnv>()
  .get("/", auth(), async (c) => c.json(await service.listRoutines(c.var.ctx, c.var.authed)))
  .post("/", auth(), json(s.RoutineIn), async (c) =>
    c.json(await service.createRoutine(c.var.ctx, c.var.authed, c.req.valid("json")), 201),
  )
  .put("/:id", auth(), param(s.HabitId), json(s.RoutineIn), async (c) =>
    c.json(
      await service.updateRoutine(c.var.ctx, c.var.authed, c.req.valid("param").id, c.req.valid("json")),
    ),
  )
  .delete("/:id", auth(), param(s.HabitId), async (c) =>
    c.json(await service.deleteRoutine(c.var.ctx, c.var.authed, c.req.valid("param").id)),
  );
