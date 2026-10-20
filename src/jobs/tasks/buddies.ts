/**
 * Job 9, `buddy_nudges`: at 17:00 local for the helper, if their buddy is still short this week with at most two
 * days left and it is still reachable, suggest some encouragement. Never about a paused buddy, never twice in one
 * of the buddy's weeks, and it says nothing about why they're short. A pair id is the unit of work.
 */
import { addDays, daysBetween, localDate, localHour, weekStart } from "../../lib/time.ts";
import type { NotifyInput } from "../../modules/notifications/service.ts";
import { chunk } from "../dispatch.ts";
import { zonesAtHour } from "../zones.ts";
import { insertNotes, readAll, readChunked, type SlicedJob, unique, zonesOf } from "./common.ts";
import { activePairs, buddyCandidates, buddyProfiles, buddyStats, IN_CHUNK } from "./repo.ts";

export const BUDDY_NUDGE_HOUR = 17;

type Profile = {
  userId: string;
  handle: string | null;
  timezone: string;
  weekStartsOn: number;
  live: number;
};
type Stats = { userId: string; recentWeeks: string[]; thisWeekDays: number; thisWeekTarget: number };

/** Test seam (Python's tests monkeypatched `BUDDY_NUDGE_HOUR` and `week_start`). */
export const buddyClock = {
  hour: BUDDY_NUDGE_HOUR,
  weekStart: (day: string, weekStartsOn: number) => weekStart(day, weekStartsOn),
};

export const buddyNudges: SlicedJob = {
  async select(ctx, tick) {
    const zones = zonesAtHour(await zonesOf(ctx, tick), buddyClock.hour, tick.now);
    const stmts = chunk(zones, IN_CHUNK).flatMap((zs) => [
      buddyCandidates(ctx.db, zs, "a"),
      buddyCandidates(ctx.db, zs, "b"),
    ]);
    return unique((await readAll<{ id: string }>(ctx, stmts)).map((r) => r.id));
  },

  async slice(ctx, ids) {
    const now = ctx.clock.now();
    const pairs = await readChunked<{ id: string; userA: string; userB: string }>(ctx, ids, (part) =>
      activePairs(ctx.db, part),
    );
    if (pairs.length === 0) return [];
    const people = unique(pairs.flatMap((p) => [p.userA, p.userB]));
    const parts = chunk(people, IN_CHUNK);
    const res = await readAll<Profile | Stats>(ctx, [
      ...parts.map((part) => buddyProfiles(ctx.db, part)),
      ...parts.map((part) => buddyStats(ctx.db, part)),
    ]);
    const profiles = new Map<string, Profile>();
    const stats = new Map<string, Stats>();
    for (const row of res) {
      if ("handle" in row) profiles.set(row.userId, row);
      else stats.set(row.userId, row);
    }
    const notes: NotifyInput[] = [];
    for (const pair of pairs) {
      for (const [helper, buddy] of [
        [pair.userA, pair.userB],
        [pair.userB, pair.userA],
      ] as const) {
        const hp = profiles.get(helper);
        const bp = profiles.get(buddy);
        const bs = stats.get(buddy);
        if (hp === undefined || bp === undefined || bs === undefined || bs.recentWeeks.length === 0) continue;
        // Python nudged regardless; nobody inactive or leaving hears about, or is talked about to, a buddy.
        if (hp.live !== 1 || bp.live !== 1) continue;
        if (localHour(now, hp.timezone) !== buddyClock.hour) continue;
        if (bs.recentWeeks.at(-1) !== "open") continue; // kept already, or paused: nothing to say
        const today = localDate(now, bp.timezone);
        const week = buddyClock.weekStart(today, bp.weekStartsOn);
        const daysLeft = daysBetween(today, addDays(week, 6)) + 1;
        const needed = bs.thisWeekTarget - bs.thisWeekDays;
        if (!(needed > 0 && needed <= daysLeft && daysLeft <= 2)) continue;
        notes.push({
          userId: helper,
          kind: "buddy_at_risk",
          category: "social",
          title: `@${bp.handle} needs ${needed} more this week`,
          body: "Your buddy streak rides on it. A quick word of encouragement goes a long way.",
          url: "/buddies",
          actorId: buddy,
          dedupeKey: `buddy-risk:${pair.id}:${buddy}:${week}`,
        });
      }
    }
    return insertNotes(ctx, notes);
  },
};
