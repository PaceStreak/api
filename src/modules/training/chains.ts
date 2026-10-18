/**
 * Streak chains and pauses (spec/training-a.md §1.8-§1.9). Writes that change what the engine judges ride in a
 * recompute (`apply`): validated on the snapshot read, applied in memory and in the recompute's own write batch,
 * so each costs two round trips.
 */
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../../ctx.ts";
import type { AuthedBatch, Stmt } from "../../db/batch.ts";
import { rateLimitGuard } from "../../db/batch.ts";
import {
  type RequirementsHistory,
  streakChains,
  streakPauses,
  streakRepairs,
  type TargetHistory,
} from "../../db/schema/index.ts";
import { conflict, HttpError, notFound } from "../../lib/errors.ts";
import { BUCKETS, perUser } from "../../lib/ratelimit.ts";
import { localDate, monthKey, weekStart } from "../../lib/time.ts";
import { uuid7, uuid7Time } from "../../lib/uuid7.ts";
import {
  chainPayload,
  effectiveEnd,
  internal,
  PAUSE_BUDGET_DAYS,
  pauseDaysUsed,
  pauseEndFor,
  pauseError,
  pausePayload,
  publicOutcome,
  recompute,
  snapshot,
} from "../game/service.ts";
import * as repo from "./repo.ts";
import type { ChainInput, ChainPatchInput, PauseInput, Requirement } from "./schemas.ts";
import { profileOf } from "./workouts.ts";

export const MAX_CHAINS = 6;

/** Python `check_requirements`, as the 422 it raised. */
function checkRequirements(reqs: readonly Requirement[], target: number, disciplines: readonly string[]) {
  if (reqs.reduce((n, r) => n + r.days, 0) > target)
    throw new HttpError(
      422,
      "The requirements add up to more days than the weekly target. Raise the target or ask for fewer days.",
    );
  if (disciplines.length > 0) {
    const outside = [...new Set(reqs.flatMap((r) => r.disciplines))]
      .filter((d) => !disciplines.includes(d))
      .sort();
    if (outside.length > 0) throw new HttpError(422, `not counted by this streak: ${outside.join(", ")}`);
  }
}

const targetOf = (h: TargetHistory) => {
  const last = h[h.length - 1];
  return last === undefined ? 3 : Math.trunc(Number(last.target));
};
const requirementsOf = (h: RequirementsHistory) => [...(h[h.length - 1]?.requirements ?? [])];

export async function listChains(ctx: Ctx, authed: AuthedBatch) {
  const snap = await snapshot(ctx, authed);
  return {
    chains: snap.chains.map((v) => chainPayload(v, 52)),
    repair_available: !snap.repairUsedThisMonth,
  };
}

export async function createChain(ctx: Ctx, authed: AuthedBatch, body: ChainInput) {
  const uid = authed.userId;
  const [, chains, prof] = await authed.read(repo.liveChains(ctx.db, uid), repo.profile(ctx.db, uid));
  const now = ctx.clock.now();
  const stmts: Stmt[] = [];
  let positions = chains.map((c) => c.position);
  if (chains.length === 0) {
    // Python `get_chains` creates the default chain on first use.
    stmts.push(
      ctx.db.insert(streakChains).values({
        id: uuid7(now),
        userId: uid,
        name: "Everything",
        disciplines: [],
        targetHistory: [{ from: "2000-01-03", target: 3 }],
        requirementsHistory: [],
        position: 0,
        createdAt: now,
        updatedAt: now,
      }),
    );
    positions = [0];
  }
  if (Math.max(chains.length, 1) >= MAX_CHAINS) throw conflict("Six chains is the limit");
  checkRequirements(body.requirements, body.target, body.disciplines);
  const p = profileOf(prof);
  const thisWeek = weekStart(localDate(now, p.timezone), p.weekStartsOn);
  const id = uuid7(now);
  stmts.push(
    ctx.db.insert(streakChains).values({
      id,
      userId: uid,
      name: body.name,
      disciplines: body.disciplines,
      targetHistory: [{ from: "2000-01-03", target: body.target }],
      requirementsHistory:
        body.requirements.length > 0 ? [{ from: thisWeek, requirements: body.requirements }] : [],
      position: Math.max(...positions) + 1,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await authed.write(...(stmts as [Stmt, ...Stmt[]]));
  return { id };
}

export async function updateChain(ctx: Ctx, authed: AuthedBatch, id: string, body: ChainPatchInput) {
  const now = ctx.clock.now();
  await recompute(
    ctx,
    authed.userId,
    { notify: false, scope: null },
    {
      authed,
      apply: (l) => {
        const chain = l.inputs.chains.find((c) => c.id === id);
        if (chain === undefined) throw notFound("Not found");
        const p = l.inputs.profile;
        const thisWeek = weekStart(l.inputs.today, p.weekStartsOn);
        const disciplines = body.disciplines ?? chain.disciplines;
        const current = targetOf(chain.targetHistory);
        const target = body.target ?? current;
        if (body.requirements !== null || body.target !== null || body.disciplines !== null) {
          checkRequirements(
            body.requirements ?? (requirementsOf(chain.requirementsHistory) as Requirement[]),
            target,
            disciplines,
          );
        }
        let targetHistory = chain.targetHistory;
        if (body.target !== null && body.target !== current) {
          targetHistory = [
            ...targetHistory.filter((h) => h.from < thisWeek),
            { from: thisWeek, target: body.target },
          ];
        }
        let requirementsHistory = chain.requirementsHistory;
        if (
          body.requirements !== null &&
          JSON.stringify(body.requirements) !== JSON.stringify(requirementsOf(requirementsHistory))
        ) {
          requirementsHistory = [
            ...requirementsHistory.filter((h) => h.from < thisWeek),
            { from: thisWeek, requirements: body.requirements },
          ];
        }
        const name = body.name ?? chain.name;
        Object.assign(chain, { name, disciplines, targetHistory, requirementsHistory });
        const set: Partial<typeof streakChains.$inferInsert> = {
          name,
          disciplines,
          targetHistory,
          requirementsHistory,
          updatedAt: now,
        };
        if (body.position !== null) set.position = body.position;
        return [
          ctx.db
            .update(streakChains)
            .set(set)
            .where(and(eq(streakChains.id, id), eq(streakChains.userId, authed.userId))),
        ];
      },
    },
  );
  return { id };
}

export async function archiveChain(ctx: Ctx, authed: AuthedBatch, id: string) {
  const [, chains] = await authed.read(repo.liveChains(ctx.db, authed.userId));
  if (!chains.some((c) => c.id === id)) throw notFound("Not found");
  if (chains.length <= 1) throw conflict("You need at least one streak");
  await authed.write(
    ctx.db
      .update(streakChains)
      .set({ archived: true, updatedAt: ctx.clock.now() })
      .where(and(eq(streakChains.id, id), eq(streakChains.userId, authed.userId))),
  );
}

export async function repairWeek(ctx: Ctx, authed: AuthedBatch, id: string, week: string) {
  const now = ctx.clock.now();
  const res = await recompute(
    ctx,
    authed.userId,
    { notify: false, scope: null },
    {
      authed,
      apply: (l) => {
        if (!l.inputs.chains.some((c) => c.id === id)) throw notFound("Not found");
        // The repairable week is judged on the snapshot this recompute reads.
        const snap = internal.snapshotOf(l);
        const view = snap.chains.find((v) => v.chain.id === id);
        if (view === undefined || view.result.repairableWeek !== week)
          throw conflict(
            "That week cannot be repaired - one repair a month, for a missed week in the last two.",
          );
        const month = monthKey(l.inputs.today);
        l.inputs.repairs = [...l.inputs.repairs, { chainId: id, weekStart: week, month }];
        return [
          ctx.db.insert(streakRepairs).values({
            id: uuid7(now),
            userId: authed.userId,
            chainId: id,
            weekStart: week,
            month,
            createdAt: now,
            updatedAt: now,
          }),
        ];
      },
    },
  );
  return { outcome: publicOutcome(res) };
}

// ---- pauses ---------------------------------------------------------------------------------------------------

const spans = (ps: readonly { startsOn: string; endsOn: string | null }[]) =>
  ps.map((p) => ({ startsOn: p.startsOn, endsOn: p.endsOn }));

function pauseState(pauses: Parameters<typeof pausePayload>[0][], today: string) {
  const sorted = [...pauses].sort((a, b) => (a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : 0));
  return {
    pauses: sorted.map((p) => pausePayload(p, today)),
    budget: { days_used: pauseDaysUsed(spans(sorted), today), days_allowed: PAUSE_BUDGET_DAYS },
  };
}

export async function listPauses(ctx: Ctx, authed: AuthedBatch) {
  const snap = await snapshot(ctx, authed);
  return pauseState(snap.pauses, snap.today);
}

export async function createPause(ctx: Ctx, authed: AuthedBatch, body: PauseInput) {
  const now = ctx.clock.now();
  const id = uuid7(now);
  const note = (body.note ?? "").trim() || null;
  let today = "";
  const limit = perUser(ctx.db, BUCKETS.pause, authed.userId, now);
  await recompute(
    ctx,
    authed.userId,
    { notify: false, scope: null },
    {
      authed,
      apply: (l) => {
        today = l.inputs.today;
        const err = pauseError(
          { startsOn: body.starts_on, endsOn: body.ends_on },
          spans(l.inputs.pauses),
          today,
        );
        if (err !== null) throw conflict(err);
        l.inputs.pauses = [
          ...l.inputs.pauses,
          { id, startsOn: body.starts_on, endsOn: body.ends_on, reason: body.reason, note },
        ].sort((a, b) => (a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : 0));
        return [
          limit.counter,
          ctx.db.run(rateLimitGuard(limit.key, BUCKETS.pause.limit)),
          ctx.db.insert(streakPauses).values({
            id,
            userId: authed.userId,
            startsOn: body.starts_on,
            endsOn: body.ends_on,
            reason: body.reason,
            note,
            createdAt: now,
            updatedAt: now,
          }),
        ];
      },
    },
  );
  return pausePayload(
    { id, startsOn: body.starts_on, endsOn: body.ends_on, reason: body.reason, note },
    today,
  );
}

/** Back today: today counts again. A pause that has not started is simply removed. */
export async function endPause(ctx: Ctx, authed: AuthedBatch, id: string) {
  const now = ctx.clock.now();
  const res = await recompute(
    ctx,
    authed.userId,
    { notify: false, scope: null },
    {
      authed,
      apply: (l) => {
        const p = l.inputs.pauses.find((x) => x.id === id);
        if (p === undefined) throw notFound("Not found");
        const today = l.inputs.today;
        if (effectiveEnd(p) < today) throw conflict("That pause has already ended");
        const end = pauseEndFor(p, today);
        const mine = and(eq(streakPauses.id, id), eq(streakPauses.userId, authed.userId));
        if (end === null) {
          l.inputs.pauses = l.inputs.pauses.filter((x) => x.id !== id);
          return [ctx.db.delete(streakPauses).where(mine)];
        }
        l.inputs.pauses = l.inputs.pauses.map((x) => (x.id === id ? { ...x, endsOn: end } : x));
        return [ctx.db.update(streakPauses).set({ endsOn: end, updatedAt: now }).where(mine)];
      },
    },
  );
  return pauseState(res.snapshot.pauses, res.snapshot.today);
}

/**
 * Remove a pause that has not started, or undo one declared within a day. Its creation time is the UUIDv7's
 * timestamp, so no extra read is needed.
 */
export async function deletePause(ctx: Ctx, authed: AuthedBatch, id: string) {
  const now = ctx.clock.now();
  await recompute(
    ctx,
    authed.userId,
    { notify: false, scope: null },
    {
      authed,
      apply: (l) => {
        const p = l.inputs.pauses.find((x) => x.id === id);
        if (p === undefined) throw notFound("Not found");
        const created = uuid7Time(id) ?? 0;
        const recent = created >= now - 86_400_000;
        if (p.startsOn <= l.inputs.today && !recent)
          throw conflict("A pause that has started can be ended, not deleted");
        l.inputs.pauses = l.inputs.pauses.filter((x) => x.id !== id);
        return [
          ctx.db
            .delete(streakPauses)
            .where(and(eq(streakPauses.id, id), eq(streakPauses.userId, authed.userId))),
        ];
      },
    },
  );
}
