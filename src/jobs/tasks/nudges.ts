/**
 * Job 2, `streak_nudges`: at each person's reminder hour (the learned hour in smart mode), warn about a streak at
 * risk; when no warning went out and they plan to train today but haven't, a plain reminder instead.
 *
 * Parity note (DESIGN.md §9): `sent_risk` is true only when a warning was actually inserted, so once the
 * warning has gone out, a later tick in the same hour finds it deduplicated and may send the reminder.
 */
import { pyWeekday, weekStart } from "../../lib/time.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import { snapshotsFor } from "../../modules/game/service.ts";
import type { NotifyInput } from "../../modules/notifications/service.ts";
import { atLocalHour } from "../zones.ts";
import { insertNotes, readAll, readChunked, type SlicedJob, unique, zonesByHour, zonesOf } from "./common.ts";
import { type NudgeRow, nudgeCandidates, nudgeRows } from "./repo.ts";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const targetHour = (p: NudgeRow) =>
  p.reminderMode === "smart" && p.learnedReminderHour !== null ? p.learnedReminderHour : p.reminderHour;

export const nudges: SlicedJob = {
  async select(ctx, tick) {
    const zones = await zonesOf(ctx, tick);
    const stmts = zonesByHour(zones, tick.now).map(([h, zs]) => nudgeCandidates(ctx.db, zs, h));
    return unique((await readAll<NudgeRow>(ctx, stmts)).map((r) => r.userId));
  },

  async slice(ctx, ids) {
    const now = ctx.clock.now();
    const rows = await readChunked<NudgeRow>(ctx, ids, (part) => nudgeRows(ctx.db, part));
    const due = atLocalHour(rows, (r) => r.timezone, targetHour, now).map((r) => r.userId);
    if (due.length === 0) return [];
    const snaps = await snapshotsFor(ctx, due);

    // Phase 1: the risk warnings. Phase 2: reminders for people none of whose warnings was inserted.
    const risk: NotifyInput[] = [];
    const riskOwner = new Map<string, string>();
    for (const userId of due) {
      const snap = snaps.get(userId)?.snapshot;
      // Nobody on a declared injury break gets told to train.
      if (snap === undefined || snap.pausedToday) continue;
      const today = snap.today;
      const end = WEEKDAYS[(pyWeekday(weekStart(today, snap.profile.weekStartsOn)) + 6) % 7];
      for (const view of snap.chains) {
        const r = view.result;
        if (!r.atRisk || (r.current === 0 && r.thisWeekDays === 0)) continue;
        const sessions = r.needed === 1 ? "session" : "sessions";
        const name = view.chain.name;
        // A chain's name is the owner's own words: it stays out of the title and the push body (lock screens).
        const say = (what: string) =>
          r.willFreeze
            ? `${r.needed} more ${sessions} by ${end} keeps ${what} going. If not, a freeze covers this week - rest if you need to.`
            : r.needed > r.daysLeft
              ? `This week is out of reach for ${what}. A repair can save it later this month - no need to train sore to fix it.`
              : `${r.needed} more ${sessions} by ${end} keeps your ${r.current}-week streak. Skip it if you're hurt or wiped - a missed week can be repaired once a month.`;
        const body = say("this streak");
        const detail = say(`'${name}'`);
        const id = uuid7(now);
        riskOwner.set(id, userId);
        risk.push({
          id,
          userId,
          kind: "streak_risk",
          category: "streak_risk",
          title: r.current
            ? `Your ${r.current}-week streak needs ${r.needed} more`
            : `A streak needs ${r.needed} more this week`,
          body,
          detail: detail === body ? null : detail,
          url: "/",
          dedupeKey: `risk:${view.chain.id}:${today}`,
        });
      }
    }
    const riskIds = await insertNotes(ctx, risk);
    const warned = new Set(riskIds.map((id) => riskOwner.get(id)));

    const reminders: NotifyInput[] = [];
    for (const userId of due) {
      const snap = snaps.get(userId)?.snapshot;
      if (snap === undefined || snap.pausedToday || warned.has(userId)) continue;
      const today = snap.today;
      const main = snap.chains[0].result;
      const planned = snap.profile.trainingDays;
      const isPlanned =
        (planned === null && main.needed > 0) ||
        (planned !== null && ((planned >> pyWeekday(today)) & 1) === 1);
      const trainedToday = snap.days.some((d) => d.day === today);
      if (!isPlanned || trainedToday) continue;
      reminders.push({
        userId,
        kind: "reminder",
        category: "reminder",
        title: "Training today?",
        body: `${main.thisWeekDays} of ${main.thisWeekTarget} this week. Ten seconds to log it.`,
        url: "/log",
        dedupeKey: `reminder:${today}`,
      });
    }
    return [...riskIds, ...(await insertNotes(ctx, reminders))];
  },
};
