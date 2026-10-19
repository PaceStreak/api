/**
 * Job 6, `weekly_digest`: 09:00 local on the first day of each person's week, last week summed up. Job 8,
 * `monthly_backup`: 09:00 local on the 1st (or the first day of the week, for people who chose weekly), a
 * reminder to download a copy of everything, only for people who opted in.
 */
import type { Ctx } from "../../ctx.ts";
import type { Stmt } from "../../db/batch.ts";
import { isoWeekKey } from "../../lib/isoweek.ts";
import { addDays, localParts, weekStart } from "../../lib/time.ts";
import { buildRecap, digestLines, snapshotsFor } from "../../modules/game/service.ts";
import { channelsFor, notify } from "../../modules/notifications/service.ts";
import { chunk } from "../dispatch.ts";
import { insertEach, readAll, type SlicedJob, unique, zonesBy, zonesOf } from "./common.ts";
import { backupCandidates, backupRows, digestCandidates, IN_CHUNK, localRows } from "./repo.ts";

export const MORNING_HOUR = 9;

/** Zones where it is 09:00 now, grouped by their local weekday and whether it is the 1st. */
function morningZones(zones: readonly string[], now: number) {
  const parts = new Map(zones.map((tz) => [tz, localParts(now, tz)]));
  const at9 = zones.filter((tz) => parts.get(tz)?.hour === MORNING_HOUR);
  return zonesBy(at9, (tz) => {
    const p = parts.get(tz);
    return `${p?.weekday ?? 0}|${p?.date.slice(8) === "01" ? 1 : 0}`;
  }).map(([key, zs]) => ({ weekday: Number(key.split("|")[0]), first: key.endsWith("|1"), zones: zs }));
}

export const weeklyDigest: SlicedJob = {
  async select(ctx, tick) {
    const groups = morningZones(await zonesOf(ctx, tick), tick.now);
    const stmts = groups.map((g) => digestCandidates(ctx.db, g.zones, g.weekday));
    return unique((await readAll<{ userId: string }>(ctx, stmts)).map((r) => r.userId));
  },

  async slice(ctx: Ctx, ids) {
    const now = ctx.clock.now();
    const rows = await readAll<{ userId: string; timezone: string; weekStartsOn: number }>(
      ctx,
      chunk(unique(ids), IN_CHUNK).map((part) => localRows(ctx.db, part)),
    );
    const due = rows.filter((r) => {
      const p = localParts(now, r.timezone);
      return p.hour === MORNING_HOUR && p.weekday === r.weekStartsOn;
    });
    if (due.length === 0) return [];
    const snaps = await snapshotsFor(
      ctx,
      due.map((r) => r.userId),
    );
    const stmts: Stmt[] = [];
    for (const r of due) {
      const s = snaps.get(r.userId);
      if (s === undefined) continue;
      const lastWeek = addDays(weekStart(localParts(now, r.timezone).date, r.weekStartsOn), -7);
      const recap = buildRecap(s.snapshot, s.held, lastWeek);
      if (recap === null) continue;
      const [title, body] = digestLines(recap);
      stmts.push(
        notify(ctx, {
          userId: r.userId,
          kind: "weekly_digest",
          category: "digest",
          title,
          body,
          url: `/recap?week=${lastWeek}`,
          dedupeKey: `digest:${lastWeek}`,
        }),
      );
    }
    return (await insertEach(ctx, stmts)).flat();
  },
};

type BackupRow = {
  userId: string;
  timezone: string;
  weekStartsOn: number;
  channels: Record<string, { push?: boolean; email?: boolean }>;
  attach: boolean;
  frequency: "monthly" | "weekly";
};

export const monthlyBackup: SlicedJob = {
  async select(ctx, tick) {
    const groups = morningZones(await zonesOf(ctx, tick), tick.now);
    const stmts = groups.map((g) => backupCandidates(ctx.db, g.zones, g.weekday, g.first));
    return unique((await readAll<{ userId: string }>(ctx, stmts)).map((r) => r.userId));
  },

  async slice(ctx, ids) {
    const now = ctx.clock.now();
    const rows = await readAll<BackupRow>(
      ctx,
      chunk(unique(ids), IN_CHUNK).map((part) => backupRows(ctx.db, part)),
    );
    const stmts: Stmt[] = [];
    for (const r of rows) {
      const wanted = channelsFor(r.channels, "backup", ctx.cfg.emailEnabled);
      if (!(wanted.email || wanted.push)) continue;
      const local = localParts(now, r.timezone);
      if (local.hour !== MORNING_HOUR) continue;
      const weekly = r.frequency === "weekly";
      // week_starts_on uses date.weekday()'s numbering (Monday = 0).
      if (weekly && local.weekday !== r.weekStartsOn) continue;
      if (!weekly && local.date.slice(8) !== "01") continue;
      const period = weekly ? isoWeekKey(local.date) : local.date.slice(0, 7);
      const unit = weekly ? "week" : "month";
      const attached = r.attach && wanted.email;
      stmts.push(
        notify(ctx, {
          userId: r.userId,
          kind: "monthly_backup",
          category: "backup",
          title: `Your ${weekly ? "weekly" : "monthly"} PaceStreak backup`,
          body: attached
            ? `A new ${unit}, and a copy of everything you've logged.`
            : `A new ${unit}. Download a copy of everything you've logged - one tap, and it's yours to keep.`,
          url: "/settings/data?backup=1",
          data: attached ? { export_attachment: true } : null,
          dedupeKey: `backup:${period}`,
        }),
      );
    }
    return (await insertEach(ctx, stmts)).flat();
  },
};
