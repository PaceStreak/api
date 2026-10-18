/**
 * Job 1, `refresh_stale_stats` (hourly): recompute projections whose local date rolled over. This is how a streak
 * ends when someone simply stops logging: nothing writes, so something has to notice.
 *
 * Python took the 500 oldest-computed rows with `computed_for <= UTC today` and skipped the fresh ones in Python,
 * so 500 fresh rows at the head could starve stale ones. Here the staleness test runs in SQL per local date (zones
 * grouped by their local date at `now`), so all 500 are stale.
 */
import type { Ctx } from "../../ctx.ts";
import { localDate } from "../../lib/time.ts";
import { recompute } from "../../modules/game/service.ts";
import { readAll, type SlicedJob, zonesBy, zonesOf } from "./common.ts";
import { STATS_LIMIT, staleStats } from "./repo.ts";

/** Recomputes run this many at a time inside one slice. */
const PARALLEL = 5;

export const stats: SlicedJob = {
  async select(ctx, tick) {
    const zones = await zonesOf(ctx, tick);
    const stmts = zonesBy(zones, (tz) => localDate(tick.now, tz)).map(([today, zs]) =>
      staleStats(ctx.db, zs, today),
    );
    const rows = await readAll<{ userId: string; computedAt: number }>(ctx, stmts);
    rows.sort((a, b) => a.computedAt - b.computedAt);
    return rows.slice(0, STATS_LIMIT).map((r) => r.userId);
  },

  async slice(ctx: Ctx, ids) {
    for (let i = 0; i < ids.length; i += PARALLEL) {
      await Promise.all(ids.slice(i, i + PARALLEL).map((id) => recompute(ctx, id, { notify: false })));
    }
    return [];
  },
};
