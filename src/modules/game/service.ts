/**
 * The game engine's public surface (spec/game.md): snapshot, recompute, the aggregate refresh other modules put in
 * their write batches, and the queue consumers. The only file another module may import.
 *
 * Cost model (DESIGN.md §17):
 * - `snapshot` reads aggregates, never raw history: one D1 round trip (three on the very first read, which creates
 *   the profile and the default chain).
 * - `recompute` is one read and one write. Records are re-detected only for the keys a write touched (`scope`);
 *   everything else in the snapshot is cheap enough to derive whole.
 * - Writers call `statRefresh` inside their own write batch, so aggregates can never lag the rows they summarise.
 *
 * Concurrency replaces `pg_advisory_xact_lock` with optimistic concurrency on `user_stats.rev`: the write batch
 * starts with a guard that aborts unless `rev` is still what the read saw, and a lost race re-reads and retries.
 */
import { RULES, reached, TIERS } from "../../catalog/achievements.ts";
import { CUSTOM_PREFIX, ENDURANCE, EXERCISES } from "../../catalog/exercises.ts";
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, abortUnless, isCondAbort, runBatch, type Stmt } from "../../db/batch.ts";
import type { Db } from "../../db/client.ts";
import type { ConsumerRegistry } from "../../jobs/consumer.ts";
import { enqueue } from "../../jobs/dispatch.ts";
import { conflict, forbidden, HttpError, notFound } from "../../lib/errors.ts";
import { pyRound } from "../../lib/format.ts";
import { addDays, localDate, seasonId, weekStart, zone } from "../../lib/time.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import { dispatchNotified, type NotifyResult, notify } from "../notifications/service.ts";
import { learnReminderHour } from "./engine/quests.ts";
import type { Best, PrEvent } from "./engine/records.ts";
import { recordLabel, splitKey } from "./engine/records.ts";
import {
  buildSnapshot,
  customMap,
  detectRecords,
  eventOrder,
  type HabitView,
  type ProfileIn,
  rawKeysFor,
  recordKeysFor,
  recordsFromRows,
  type Snapshot,
  type SnapshotInputs,
  type StoredRecord,
  withAchievements,
} from "./engine/snapshot.ts";
import { pausedDays } from "./engine/streak.ts";
import * as views from "./engine/views.ts";
import * as repo from "./repo.ts";

export type { JointResult } from "./engine/quests.ts";
export { inQuietHour, jointStreak, learnReminderHour, reminderHour } from "./engine/quests.ts";
export { e1rm } from "./engine/records.ts";
export type { HabitView, Snapshot } from "./engine/snapshot.ts";
export type { ChainResult, Span, WeekCell } from "./engine/streak.ts";
export {
  computeChain,
  effectiveEnd,
  PAUSE_BUDGET_DAYS,
  PAUSE_MAX_DAYS,
  pauseDaysUsed,
  pausedDays,
  pauseEndFor,
  pauseError,
  requirementsResolver,
  targetResolver,
} from "./engine/streak.ts";
export type { Recap } from "./engine/views.ts";
export {
  buildRecap,
  chainPayload,
  digestLines,
  lastClosedWeek,
  pausePayload,
  weeksPayload,
} from "./engine/views.ts";
export type { RefreshScope } from "./repo.ts";

// ---- habits hook ----------------------------------------------------------------------------------------------

/**
 * The habits module registers how to read and judge a user's habits (Python `habit_views`), so the snapshot can
 * fold them into its single read batch without game importing habits. Until it does, users have no habits.
 */
export interface HabitSource {
  reads(db: Db, userId: string): Stmt[];
  views(
    results: readonly unknown[],
    today: string,
    weekStartsOn: number,
    sheltered: ReadonlySet<string>,
  ): HabitView[];
}

let habitSource: HabitSource | null = null;

export function setHabitSource(source: HabitSource | null): void {
  habitSource = source;
}

// ---- aggregates -----------------------------------------------------------------------------------------------

/**
 * Statements that rebuild the aggregates for `scope`, for the caller's write batch, placed after the writes that
 * changed workouts or sets. Pass the old and new local dates of every touched workout and the exercise ids of
 * its sets before and after the change; `null` rebuilds everything.
 */
export function statRefresh(ctx: Ctx, userId: string, scope: repo.RefreshScope): Stmt[] {
  return repo.refreshStatements(ctx.db, userId, scope);
}

/** Which record keys a write can have moved: exercises of the touched sets, disciplines of the touched sessions. */
export interface RecordScope {
  exercises: readonly string[];
  disciplines: readonly string[];
}

// ---- loading --------------------------------------------------------------------------------------------------

type ProfileRow = Awaited<ReturnType<typeof repo.profile>>[number];

function profileIn(p: ProfileRow): ProfileIn {
  return {
    userId: p.userId,
    timezone: zone(p.timezone),
    weekStartsOn: p.weekStartsOn,
    gamificationEnabled: p.gamificationEnabled,
    lifeTarget: p.lifeTarget,
    trainingDays: p.trainingDays,
    visibility: p.visibility,
    sharingPaused: p.sharingPaused,
    birthYear: p.birthYear,
    socialSuspendedAt: p.socialSuspendedAt,
    deletionScheduledAt: p.deletionScheduledAt,
    onboardedAt: p.onboardedAt,
    leaderboardOptIn: p.leaderboardOptIn,
    learnedReminderHour: p.learnedReminderHour,
    quietStart: p.quietStart,
    quietEnd: p.quietEnd,
  };
}

const baseReads = (db: Db, userId: string) =>
  [
    repo.profile(db, userId),
    repo.chains(db, userId),
    repo.repairs(db, userId),
    repo.pauses(db, userId),
    repo.wagers(db, userId),
    repo.days(db, userId),
    repo.exercises(db, userId),
    repo.customs(db, userId),
    repo.records(db, userId),
    repo.achievements(db, userId),
    repo.counts(db, userId),
    repo.restDayDates(db, userId),
    repo.wakingDates(db, userId),
    repo.stats(db, userId),
  ] as const;

type BaseResults = {
  -readonly [K in keyof ReturnType<typeof baseReads>]: Awaited<ReturnType<typeof baseReads>[K]>;
};
const BASE = 14;

export interface Loaded {
  inputs: Omit<SnapshotInputs, "habits" | "records">;
  stored: StoredRecord[];
  achievements: SnapshotInputs["achievements"];
  stats: BaseResults[13][number] | null;
  habitResults: unknown[];
  extra: unknown[];
}

/** Statement list for a snapshot read: the base reads, the habit source's reads, then `extra`. */
function readList(db: Db, userId: string, extra: readonly Stmt[]): Stmt[] {
  return [...baseReads(db, userId), ...(habitSource?.reads(db, userId) ?? []), ...extra];
}

/** Parses a read batch; `null` when the profile or the default chain still has to be created. */
function parse(ctx: Ctx, results: readonly unknown[], extraCount: number): Loaded | null {
  const base = results.slice(0, BASE) as unknown as BaseResults;
  const [
    profileRows,
    chainRows,
    repairs,
    pauses,
    wagers,
    days,
    exercises,
    customs,
    records,
    held,
    counts,
    rest,
    waking,
    stats,
  ] = base;
  const p = profileRows[0];
  if (p === undefined || chainRows.length === 0) return null;
  const profile = profileIn(p);
  const c = counts[0];
  return {
    inputs: {
      profile,
      today: localDate(ctx.clock.now(), profile.timezone),
      chains: chainRows,
      repairs,
      pauses,
      wagers,
      days,
      exercises,
      customs,
      achievements: held,
      counts: {
        kudos: c?.kudos ?? 0,
        groups: c?.groups ?? 0,
        finished: c?.finished ?? 0,
        bodyDays: c?.body_days ?? 0,
        firstWeigh: c?.first_weigh ?? null,
      },
      restDays: rest.map((r) => r.day),
      wakingDates: waking.map((r) => r.day),
    },
    stored: records,
    achievements: held,
    stats: stats[0] ?? null,
    habitResults: results.slice(BASE, results.length - extraCount) as unknown[],
    extra: results.slice(results.length - extraCount) as unknown[],
  };
}

/** Profile and default chain on first use (Python `get_profile` / `get_chains`). */
function ensureStatements(ctx: Ctx, userId: string): [Stmt, Stmt] {
  const now = ctx.clock.now();
  const hue = (crypto.getRandomValues(new Uint16Array(1))[0] ?? 0) % 360;
  return [
    repo.ensureProfile(ctx.db, userId, uuid7(now), hue, now),
    repo.ensureChain(ctx.db, userId, uuid7(now), now),
  ];
}

/**
 * Statements a caller runs in the same atomic batch as the first snapshot read, before the reads (a workout write
 * and its aggregate refresh): the read then sees them, and the write costs no round trip of its own. `done`
 * receives their results. They run once, never on a retry.
 */
export interface BeforeRead {
  stmts: readonly [Stmt, ...Stmt[]];
  done(results: readonly unknown[]): void;
}

/** Reads everything a snapshot needs plus `extra`, creating the profile/default chain when missing. */
async function load(
  ctx: Ctx,
  userId: string,
  extra: readonly Stmt[],
  authed?: AuthedBatch,
  before?: BeforeRead,
): Promise<Loaded> {
  let pending = before;
  const run = async () => {
    const list = readList(ctx.db, userId, extra);
    if (pending !== undefined) {
      const pre = pending;
      pending = undefined;
      const all = [...pre.stmts, ...list] as unknown as [Stmt, ...Stmt[]];
      const res = (
        authed === undefined ? await runBatch(ctx.db, all) : await authed.write(...all)
      ) as unknown[];
      pre.done(res.slice(0, pre.stmts.length));
      return res.slice(pre.stmts.length);
    }
    if (authed === undefined) return runBatch(ctx.db, list) as Promise<unknown[]>;
    const [, ...rest] = (await authed.read(...list)) as unknown[];
    return rest;
  };
  const first = parse(ctx, await run(), extra.length);
  if (first !== null) return first;
  await (authed === undefined
    ? runBatch(ctx.db, ensureStatements(ctx, userId))
    : authed.write(...ensureStatements(ctx, userId)));
  const second = parse(ctx, await run(), extra.length);
  if (second === null) throw new Error("profile or default chain missing after creating them");
  return second;
}

function snapshotOf(l: Loaded, records = recordsFromRows(l.stored)): Snapshot {
  const habits =
    habitSource === null
      ? []
      : habitSource.views(
          l.habitResults,
          l.inputs.today,
          l.inputs.profile.weekStartsOn,
          pausedDays(l.inputs.pauses.map((p) => ({ startsOn: p.startsOn, endsOn: p.endsOn }))),
        );
  return buildSnapshot({ ...l.inputs, habits, records });
}

/** The snapshot for a signed-in caller: one D1 round trip (plus `extra` statements in the same batch). */
export async function snapshot(ctx: Ctx, authed: AuthedBatch): Promise<Snapshot> {
  return snapshotOf(await load(ctx, authed.userId, [], authed));
}

/**
 * The snapshot plus the caller's own reads, in the same single round trip (the coach reads readiness and meals
 * next to it). `extra` results come back in order.
 */
export async function snapshotWith<T extends readonly Stmt[]>(
  ctx: Ctx,
  authed: AuthedBatch,
  extra: T,
): Promise<{ snapshot: Snapshot; extra: unknown[] }> {
  const l = await load(ctx, authed.userId, extra, authed);
  return { snapshot: snapshotOf(l), extra: l.extra };
}

/** A snapshot for a job (no session), e.g. the weekly digest. */
export async function snapshotFor(ctx: Ctx, userId: string): Promise<Snapshot> {
  return snapshotOf(await load(ctx, userId, []));
}

/** Users whose snapshot reads share one D1 batch in `snapshotsFor` (about 16 statements each). */
export const SNAPSHOT_CHUNK = 20;

/**
 * Snapshots of other people (a profile page, a coach's roster): their reads, plus `extra(userId)` statements next to
 * each, go out `SNAPSHOT_CHUNK` users per batch, the batches in parallel. A user still missing a profile or the
 * default chain falls back to `load`, which creates them. `held` (badges) feeds `buildRecap` for the weekly digest. No session: the caller has already authorised the read.
 */
export async function snapshotsFor(
  ctx: Ctx,
  userIds: readonly string[],
  extra: (userId: string) => Stmt[] = () => [],
): Promise<Map<string, { snapshot: Snapshot; extra: unknown[]; held: Loaded["achievements"] }>> {
  const chunks: string[][] = [];
  for (let i = 0; i < userIds.length; i += SNAPSHOT_CHUNK) chunks.push(userIds.slice(i, i + SNAPSHOT_CHUNK));
  const out = new Map<string, { snapshot: Snapshot; extra: unknown[]; held: Loaded["achievements"] }>();
  await Promise.all(
    chunks.map(async (chunk) => {
      const plans = chunk.map((userId) => {
        const ex = extra(userId);
        return { userId, ex, list: readList(ctx.db, userId, ex) };
      });
      const results = (await runBatch(
        ctx.db,
        plans.flatMap((p) => p.list),
      )) as unknown[];
      let at = 0;
      for (const p of plans) {
        const slice = results.slice(at, at + p.list.length);
        at += p.list.length;
        const l = parse(ctx, slice, p.ex.length) ?? (await load(ctx, p.userId, p.ex));
        out.set(p.userId, { snapshot: snapshotOf(l), extra: l.extra, held: l.achievements });
      }
    }),
  );
  return out;
}

// ---- recompute ------------------------------------------------------------------------------------------------

export interface Outcome {
  level: number;
  title: string;
  total_xp: number;
  xp_gained: number;
  leveled_up_to: number | null;
  new_achievements: NewBadge[];
  new_records: { key: string; label: string; value: number; previous: number; gain_pct: number }[];
  streak: { current: number; this_week_days: number; target: number; milestone: number | null };
}

interface NewBadge {
  id: string;
  title: string;
  tier: string | null;
  tier_name: string | null;
  hidden: boolean;
  description: string;
}

export interface RecomputeOptions {
  /** Emit activity events and notifications for what is new (default true). */
  notify?: boolean;
  /** Only records set by this workout are announced; an edit to an old session corrects silently. */
  workoutId?: string | null;
  /** Record keys to re-detect: `null` = all, the default `{[], []}` = none (nothing that sets records changed). */
  scope?: RecordScope | null;
}

const NO_SCOPE: RecordScope = { exercises: [], disciplines: [] };

function rawKeyScope(scope: RecordScope | null): string[] | null {
  if (scope === null) return null;
  const disciplines = scope.disciplines.filter((d) => ENDURANCE.has(d));
  return rawKeysFor(new Set(scope.exercises), new Set(disciplines));
}

/** Social visibility rule shared with leaderboards: old enough, onboarded, not suspended or leaving. */
export function socialAllowed(p: ProfileIn, year: number): boolean {
  return (
    p.birthYear !== null &&
    year - p.birthYear >= repo.SOCIAL_MIN_AGE &&
    p.socialSuspendedAt === null &&
    p.deletionScheduledAt === null &&
    p.onboardedAt !== null
  );
}

interface Plan {
  outcome: Outcome;
  snap: Snapshot;
  writes: Stmt[];
  notes: number[];
}

/**
 * Pure planning step: given what `load` read, decide the new projection and every statement that persists it.
 * `prefix` statements (the caller's own change, e.g. a wager) go first, right after the concurrency guard.
 */
function plan(ctx: Ctx, l: Loaded, opts: RecomputeOptions, prefix: readonly Stmt[]): Plan {
  const now = ctx.clock.now();
  const db = ctx.db;
  const userId = l.inputs.profile.userId;
  const rawKeys = rawKeyScope(opts.scope === undefined ? NO_SCOPE : opts.scope);
  const recordKeys = rawKeys === null ? null : new Set(recordKeysFor(rawKeys));

  // Records: re-detect the scoped keys from record_days, keep the stored projection for the rest.
  const stored = recordsFromRows(l.stored);
  let records = stored;
  let replaced: { events: PrEvent[]; bests: Map<string, Best> } | null = null;
  if (rawKeys === null || rawKeys.length > 0) {
    const rows = (l.extra[0] ?? []) as Parameters<typeof detectRecords>[0];
    replaced = detectRecords(rows, customMap(l.inputs.customs));
    const keep = (k: string) => recordKeys !== null && !recordKeys.has(k);
    const events = [...stored.events.filter((e) => keep(e.key)), ...replaced.events].sort(eventOrder);
    const bests = new Map([...stored.bests].filter(([k]) => keep(k)));
    for (const [k, b] of replaced.bests) bests.set(k, b);
    records = { events, bests };
  }
  let snap = snapshotOf(l, records);
  const profile = snap.profile;
  const main = snap.chains[0].result;

  // Badges, never revoked.
  const held = new Set(l.achievements.map((a) => `${a.achievementId}:${a.tier ?? ""}`));
  const badges: NewBadge[] = [];
  const writes: Stmt[] = [];
  for (const rule of RULES) {
    for (const tier of reached(rule, snap.context)) {
      if (held.has(`${rule.id}:${tier ?? ""}`)) continue;
      writes.push(
        repo.insertAchievement(
          db,
          {
            id: uuid7(now),
            userId,
            achievementId: rule.id,
            tier,
            unlockedOn: snap.today,
            value: pyRound(rule.value(snap.context), 1),
          },
          now,
        ),
      );
      badges.push({
        id: rule.id,
        title: rule.title,
        tier,
        tier_name:
          tier !== null && rule.tier_names.length > 0 ? (rule.tier_names[TIERS.indexOf(tier)] ?? null) : null,
        hidden: rule.hidden,
        description: rule.description,
      });
    }
  }
  snap = withAchievements(
    snap,
    badges.map((b) => ({ tier: b.tier, day: snap.today })),
  );

  // The records projection, replaced for the scoped keys only.
  if (replaced !== null) {
    writes.push(db.run(repo.deleteRecordsSql(userId, recordKeys === null ? null : [...recordKeys])));
    const rows = recordRows(replaced, now);
    for (let i = 0; i < rows.length; i += 500)
      writes.push(repo.insertRecords(db, userId, rows.slice(i, i + 500), now));
  }
  const previousRecords = new Set(l.stored.map((r) => `${r.key}\u0000${r.achievedOn}`));
  const newRecords = snap.events
    .filter(
      (e) =>
        e.rewarded &&
        !previousRecords.has(`${e.key}\u0000${e.day}`) &&
        (opts.workoutId == null || e.workoutId === opts.workoutId),
    )
    .map((e) => ({
      key: e.key,
      label: recordLabel(e.key, snap.names),
      value: e.value,
      previous: e.previous,
      gain_pct: e.gainPct,
    }));

  // The read model.
  const season = seasonId(snap.today);
  const recent = main.weeks
    .slice(0, -1)
    .filter((c) => c.status !== "paused")
    .slice(-4);
  const rewarded = snap.events.filter((e) => e.rewarded);
  writes.unshift(
    repo.upsertStats(
      db,
      userId,
      uuid7(now),
      {
        computedAt: now,
        computedFor: snap.today,
        totalXp: snap.xp.total,
        level: snap.level.level,
        seasonId: season,
        seasonXp: snap.xp.season,
        currentStreak: main.current,
        longestStreak: main.longest,
        consistency: main.consistency,
        thisWeekDays: main.thisWeekDays,
        thisWeekTarget: main.thisWeekTarget,
        recentWeeks: main.weeks.slice(-26).map((c) => c.status),
        lifeStreak: snap.life?.current ?? 0,
        weeklyDays4w: pyRound(recent.reduce((n, c) => n + c.days, 0) / Math.max(1, recent.length), 2),
        sessions: snap.sessions,
        activeDays: snap.days.length,
        seasonPrs: rewarded.filter((e) => seasonId(e.day) === season).length,
        totalPrs: rewarded.length,
        lastActive: snap.lastActive,
      },
      now,
    ),
  );

  // Smart reminders learn from the last 60 days of app-logged sessions.
  const hours = (l.extra[1] ?? []) as { hour: number }[];
  const learned = learnReminderHour(
    hours.map((h) => h.hour),
    profile.quietStart,
    profile.quietEnd,
  );
  if (learned !== profile.learnedReminderHour) writes.push(repo.setLearnedHour(db, userId, learned, now));

  const prev = l.stats;
  const leveled = snap.level.level > (prev?.level ?? 1) ? snap.level.level : null;
  const prevStreak = prev?.currentStreak ?? 0;
  const recentCut = addDays(snap.today, -13);
  const milestone =
    main.milestonesHit.find(([len, wk]) => len > prevStreak && len <= main.current && wk >= recentCut)?.[0] ??
    null;

  const notes: number[] = [];
  const gamified = profile.gamificationEnabled;
  if (opts.notify ?? true) {
    const visible =
      profile.visibility !== "private" &&
      !profile.sharingPaused &&
      socialAllowed(profile, new Date(now).getUTCFullYear());
    const event = (
      kind: string,
      refKey: string,
      data: Record<string, unknown>,
      workoutId?: string | null,
    ) => {
      if (visible)
        writes.push(
          repo.emitEvent(
            db,
            { id: uuid7(now), userId, kind, refKey, day: snap.today, data, workoutId: workoutId ?? null },
            now,
          ),
        );
    };
    const note = (n: Parameters<typeof notify>[1]) => {
      notes.push(writes.length);
      writes.push(notify(ctx, n));
    };
    for (const b of gamified ? badges : []) {
      event("achievement", `${b.id}:${b.tier ?? "None"}`, {
        id: b.id,
        title: b.title,
        tier: b.tier,
        tier_name: b.tier_name,
      });
      note({
        userId,
        kind: "achievement",
        category: "achievements",
        title: `Unlocked: ${b.tier_name ?? b.title}`,
        body: b.description,
        url: "/achievements",
        // Python rendered a single badge's tier as `None`; the key keeps that text so dedupe stays stable.
        dedupeKey: `achievement:${b.id}:${b.tier ?? "None"}`,
      });
    }
    for (const r of newRecords)
      event(
        "pr",
        `${r.key}:${snap.today}`,
        { label: r.label, key: r.key, value: r.value, gain_pct: r.gain_pct },
        opts.workoutId,
      );
    if (leveled !== null && gamified) {
      event("level", `level:${leveled}`, { level: leveled, title: snap.level.title });
      note({
        userId,
        kind: "level_up",
        category: "achievements",
        title: `Level ${leveled} - ${snap.level.title}`,
        body: "Consistency, compounding.",
        url: "/profile",
        dedupeKey: `level:${leveled}`,
      });
    }
    if (milestone !== null) {
      const chain = snap.chains[0].chain;
      const ref = `${chain.id}:${milestone}:${main.runStarted ?? "None"}`;
      event("streak", `streak:${ref}`, { weeks: milestone });
      note({
        userId,
        kind: "streak_milestone",
        category: "achievements",
        title: `${milestone}-week streak`,
        body: `${milestone} weeks of showing up on '${chain.name}'.`,
        url: "/",
        dedupeKey: `milestone:${ref}`,
      });
    }
  }

  const guard = abortUnless(db, repo.revIs(userId, prev?.rev ?? null));
  const all: Stmt[] = [guard, ...prefix, ...writes];
  return {
    snap,
    writes: all,
    // Positions in the batch: after the concurrency guard and the caller's prefix.
    notes: notes.map((i) => i + 1 + prefix.length),
    outcome: {
      level: snap.level.level,
      title: snap.level.title,
      total_xp: snap.xp.total,
      xp_gained: Math.max(0, snap.xp.total - (prev?.totalXp ?? 0)),
      leveled_up_to: leveled,
      new_achievements: gamified ? badges : [],
      new_records: newRecords,
      streak: {
        current: main.current,
        this_week_days: main.thisWeekDays,
        target: main.thisWeekTarget,
        milestone,
      },
    },
  };
}

function recordRows(r: { events: PrEvent[]; bests: Map<string, Best> }, now: number): repo.RecordRow[] {
  const byKeyDay = new Map(r.events.map((e) => [`${e.key}\u0000${e.day}`, e]));
  const rows: repo.RecordRow[] = [];
  for (const [key, b] of r.bests) {
    const e = byKeyDay.get(`${key}\u0000${b.day}`);
    rows.push({
      id: uuid7(now),
      key,
      value: b.value,
      previous: e?.previous ?? null,
      gain_pct: e?.gainPct ?? null,
      achieved_on: b.day,
      workout_id: b.workoutId || null,
      flagged: e?.flagged ?? false,
      rewarded: e?.rewarded ?? false,
      is_current: true,
    });
  }
  for (const e of r.events) {
    const b = r.bests.get(e.key);
    if (b !== undefined && b.day === e.day) continue;
    rows.push({
      id: uuid7(now),
      key: e.key,
      value: e.value,
      previous: e.previous,
      gain_pct: e.gainPct,
      achieved_on: e.day,
      workout_id: e.workoutId || null,
      flagged: e.flagged,
      rewarded: e.rewarded,
      is_current: false,
    });
  }
  return rows;
}

const MAX_ATTEMPTS = 4;

function recomputeExtra(ctx: Ctx, userId: string, opts: RecomputeOptions): Stmt[] {
  const now = ctx.clock.now();
  const raw = rawKeyScope(opts.scope === undefined ? NO_SCOPE : opts.scope);
  const sinceMs = now - 60 * 86_400_000;
  return [
    repo.recordDayRows(ctx.db, userId, raw ?? null),
    // Local dates run at most a day ahead of UTC, so one extra day bounds the index range safely.
    repo.recentStartHours(ctx.db, userId, new Date(sinceMs - 86_400_000).toISOString().slice(0, 10), sinceMs),
  ];
}

/**
 * Re-derives the projection, persists it and reports what changed (Python `recompute`). One read and one write;
 * a concurrent recompute that wins the race makes this one re-read and try again. `mutate` lets a caller apply its
 * own change in memory and in the same write batch (`prefix`), so the projection includes it with no extra trip;
 * `before` puts a caller's write in the read batch instead (see `BeforeRead`).
 */
export async function recompute(
  ctx: Ctx,
  userId: string,
  opts: RecomputeOptions = {},
  change?: {
    authed?: AuthedBatch;
    apply?: (l: Loaded) => Stmt[];
    /** Receives the results of the `apply` statements once the batch commits (e.g. an `UPDATE ... RETURNING`). */
    written?: (results: unknown[]) => void;
    before?: BeforeRead;
  },
): Promise<Outcome & { snapshot: Snapshot }> {
  const scoped = opts.scope === undefined ? { ...opts, scope: NO_SCOPE } : opts;
  for (let attempt = 1; ; attempt++) {
    const before = attempt === 1 ? change?.before : undefined;
    const l = await load(ctx, userId, recomputeExtra(ctx, userId, scoped), change?.authed, before);
    const prefix = change?.apply?.(l) ?? [];
    const p = plan(ctx, l, scoped, prefix);
    try {
      const all = p.writes as [Stmt, ...Stmt[]];
      const results = (
        change?.authed === undefined ? await runBatch(ctx.db, all) : await change.authed.write(...all)
      ) as unknown[];
      change?.written?.(results.slice(1, 1 + prefix.length));
      dispatchNotified(ctx, ...p.notes.map((i) => (results[i] ?? []) as NotifyResult));
      return { ...p.outcome, snapshot: p.snap };
    } catch (err) {
      if (!isCondAbort(err) || attempt >= MAX_ATTEMPTS) throw err;
      ctx.log.info("recompute lost a race; retrying", { attempt });
    }
  }
}

/** The public Outcome (no snapshot), as the training routes return it. */
export const publicOutcome = ({ snapshot: _, ...o }: Outcome & { snapshot: Snapshot }): Outcome => o;

/** Rebuilds every aggregate from source rows, then recomputes with every record key (merge, import, restore). */
export async function rebuild(ctx: Ctx, userId: string, opts: { notify?: boolean } = {}): Promise<Outcome> {
  const refresh = statRefresh(ctx, userId, { dates: null, exercises: null });
  await runBatch(ctx.db, refresh);
  return publicOutcome(await recompute(ctx, userId, { notify: opts.notify ?? false, scope: null }));
}

/** Asks the queue for a full rebuild (imports, merges, restores). */
export const enqueueRebuild = (ctx: Ctx, userId: string) =>
  enqueue(ctx.env.JOBS, [{ type: "recompute", userId, full: true }]);

/** Registers the `recompute` (and `rebuild-slice`) consumers. Called once from the Worker entry. */
export function registerConsumers(registry: ConsumerRegistry): void {
  registry.register("recompute", async (ctx, msg) => {
    if (msg.full) await rebuild(ctx, msg.userId);
    else await recompute(ctx, msg.userId, { notify: false });
  });
  // The full rebuild fits one batch, so a slice is a whole rebuild; the cursor is ignored.
  registry.register("rebuild-slice", async (ctx, msg) => {
    await rebuild(ctx, msg.userId);
  });
}

// ---- route services -------------------------------------------------------------------------------------------

export async function stats(ctx: Ctx, authed: AuthedBatch) {
  return views.statsPayload(await snapshot(ctx, authed));
}

/**
 * POST /me/wager: the option is judged on the snapshot the recompute reads, the insert rides in the recompute's
 * write batch, and the returned state includes the new wager: two round trips (Python: snapshot, insert,
 * recompute, snapshot again).
 */
export async function makeWager(ctx: Ctx, authed: AuthedBatch, week: "this" | "next") {
  const now = ctx.clock.now();
  const res = await recompute(
    ctx,
    authed.userId,
    { notify: false },
    {
      authed,
      apply: (l) => {
        const option = views.wagerState(snapshotOf(l)).options.find((o) => o.week === week);
        if (option === undefined) throw new Error(`unknown wager option ${week}`);
        if (option.blocked !== null) throw conflict(option.blocked);
        l.inputs.wagers = [...l.inputs.wagers, { weekStart: option.week_start, days: option.days }].sort(
          (a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0),
        );
        return [repo.insertWager(ctx.db, uuid7(now), authed.userId, option.week_start, option.days, now)];
      },
    },
  );
  return views.wagerState(res.snapshot);
}

/**
 * DELETE /me/wager/{week}: idempotent. Unlike Python (which left user_stats stale until the next write), the
 * delete rides in a recompute's write batch, so the projection never disagrees with the wagers.
 */
export async function cancelWager(ctx: Ctx, authed: AuthedBatch, week: string) {
  await recompute(
    ctx,
    authed.userId,
    { notify: false },
    {
      authed,
      apply: (l) => {
        const snap = snapshotOf(l);
        const thisWeek = weekStart(snap.today, snap.profile.weekStartsOn);
        if (week < thisWeek || (week === thisWeek && snap.chains[0].result.thisWeekDays > 0))
          throw conflict("That wager is already under way");
        l.inputs.wagers = l.inputs.wagers.filter((w) => w.weekStart !== week);
        return [repo.deleteWager(ctx.db, authed.userId, week)];
      },
    },
  );
}

function defaultMonth(today: string): string {
  if (Number(today.slice(8, 10)) > 7) return today.slice(0, 7);
  return addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
}

/** GET /me/recap/month: one round trip when `month` is given, two when it defaults (it needs the local date). */
export async function monthRecap(ctx: Ctx, authed: AuthedBatch, month: string | undefined) {
  const monthReads = (m: string) => {
    const [first, last] = views.monthBounds(m);
    return [
      repo.monthLifts(ctx.db, authed.userId, first, last),
      repo.liftsBefore(ctx.db, authed.userId, first, last),
    ] as const;
  };
  const l = await load(ctx, authed.userId, month === undefined ? [] : monthReads(month), authed);
  const snap = snapshotOf(l);
  const m = month ?? defaultMonth(snap.today);
  if (m > snap.today.slice(0, 7)) throw new HttpError(422, "That month has not started");
  let lifts = l.extra;
  if (month === undefined) {
    const [, ...rest] = await authed.read(...monthReads(m));
    lifts = rest;
  }
  const out = views.buildMonth(
    snap,
    m,
    (lifts[0] ?? []) as Parameters<typeof views.buildMonth>[2],
    (lifts[1] ?? []) as Parameters<typeof views.buildMonth>[3],
  );
  if (out === null) throw notFound("Nothing logged that month");
  return out;
}

export async function recap(ctx: Ctx, authed: AuthedBatch, week: string | undefined) {
  const l = await load(ctx, authed.userId, [], authed);
  const snap = snapshotOf(l);
  const target = week ?? views.lastClosedWeek(snap);
  if (target > snap.today) throw new HttpError(422, "That week has not started");
  const out = views.buildRecap(snap, l.achievements, target);
  if (out === null) throw notFound("Nothing to recap for that week");
  return out;
}

export async function review(ctx: Ctx, authed: AuthedBatch, year: number | undefined) {
  const l = await load(ctx, authed.userId, [], authed);
  const snap = snapshotOf(l);
  const wanted = year ?? Number(snap.today.slice(0, 4));
  let out = views.buildYear(snap, l.achievements, wanted);
  if (out === null && year === undefined) out = views.buildYear(snap, l.achievements, wanted - 1);
  if (out === null) throw notFound("Nothing logged that year");
  return out;
}

export async function recordHistory(ctx: Ctx, authed: AuthedBatch, key: string) {
  const out = views.recordHistory(await snapshot(ctx, authed), key);
  if (out === null) throw notFound("No such record");
  return out;
}

export async function xp(ctx: Ctx, authed: AuthedBatch) {
  return views.xpBreakdown(await snapshot(ctx, authed));
}

/** GET /me/records reads the projection only (no snapshot), as in Python. */
export async function records(ctx: Ctx, authed: AuthedBatch) {
  const [, rows, customs] = await authed.read(
    repo.records(ctx.db, authed.userId),
    repo.customs(ctx.db, authed.userId),
  );
  const names = libraryNames(customs);
  const sorted = [...rows].sort((a, b) =>
    a.achievedOn < b.achievedOn ? 1 : a.achievedOn > b.achievedOn ? -1 : 0,
  );
  const out = (r: (typeof rows)[number]) => {
    const [kind, subject] = splitKey(r.key);
    return {
      key: r.key,
      kind,
      subject,
      label: recordLabel(r.key, names),
      value: r.value,
      previous: r.previous,
      gain_pct: r.gainPct,
      date: r.achievedOn,
      workout_id: r.workoutId,
      flagged: r.flagged,
      rewarded: r.rewarded,
    };
  };
  return {
    current: sorted.filter((r) => r.isCurrent).map(out),
    recent: sorted
      .filter((r) => r.previous !== null)
      .slice(0, 30)
      .map(out),
  };
}

function libraryNames(customs: readonly { id: string; name: string }[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const e of EXERCISES) names.set(e.id, e.name);
  for (const c of customs) names.set(`${CUSTOM_PREFIX}${c.id}`, c.name);
  return names;
}

export async function achievements(ctx: Ctx, authed: AuthedBatch) {
  const l = await load(
    ctx,
    authed.userId,
    [repo.onboardedCount(ctx.db), repo.achievementCounts(ctx.db)],
    authed,
  );
  const population = ((l.extra[0] ?? []) as { n: number }[])[0]?.n ?? 0;
  const counts = (l.extra[1] ?? []) as { achievementId: string; tier: string | null; n: number }[];
  return views.achievementsPayload(snapshotOf(l), l.achievements, population, counts);
}

/** GET /me/progress: the series rows are read in the snapshot's batch from a UTC-safe lower bound. */
export async function progress(ctx: Ctx, authed: AuthedBatch, weeks: number) {
  const utcToday = new Date(ctx.clock.now()).toISOString().slice(0, 10);
  const since = addDays(utcToday, -7 * weeks - 2);
  const l = await load(
    ctx,
    authed.userId,
    [
      repo.progressWorkouts(ctx.db, authed.userId, since),
      repo.progressSets(ctx.db, authed.userId, since),
      repo.progressBody(ctx.db, authed.userId, since),
    ],
    authed,
  );
  const [workouts, sets, body] = l.extra as [
    views.ProgressRows["workouts"],
    views.ProgressRows["sets"],
    views.ProgressRows["body"],
  ];
  return views.buildProgress(snapshotOf(l), weeks, { workouts, sets, body });
}

// ---- leaderboards ---------------------------------------------------------------------------------------------

export const BOARD_NAMES = Object.keys(repo.BOARDS) as repo.Board[];

/** GET /v1/leaderboards/{board}: one round trip (profile, board rows and group membership together). */
export async function leaderboard(
  ctx: Ctx,
  authed: AuthedBatch,
  board: string,
  scope: repo.BoardScope,
  groupId: string | null,
) {
  if (!(board in repo.BOARDS)) throw notFound("No such board");
  const b = board as repo.Board;
  const now = new Date(ctx.clock.now());
  const year = now.getUTCFullYear();
  const season = seasonId(now.toISOString().slice(0, 10));
  const viewer = authed.userId;
  const [, profileRows, rows, member] = await authed.read(
    repo.profile(ctx.db, viewer),
    repo.board(ctx.db, viewer, b, scope, { year, season, groupId }),
    repo.groupMembership(ctx.db, groupId ?? "", viewer),
  );
  const me = profileRows[0];
  if (me === undefined || !socialAllowed(profileIn(me), year))
    throw forbidden("Leaderboards are not available");
  if (scope === "group") {
    if (groupId === null) throw new HttpError(422, "group_id is required");
    if (member.length === 0) throw notFound("Not found");
  }
  const person = (r: repo.BoardRow) => ({
    id: r.user_id,
    handle: r.handle,
    display_name: r.display_name,
    avatar_hue: r.avatar_hue,
    visibility: r.visibility,
    official: r.is_official === 1,
    ...(r.gamification_enabled === 1 ? { level: r.level } : {}),
    current_streak: r.current_streak,
    value: r.value,
    rank: r.rank,
    me: r.user_id === viewer,
  });
  return {
    board: b,
    scope,
    participants: rows.find((r) => r.part === 2)?.participants ?? 0,
    opted_in: me.leaderboardOptIn,
    rows: rows.filter((r) => r.part === 0).map(person),
    me: ((r) => (r === undefined ? null : person(r)))(rows.find((r) => r.part === 1)),
  };
}

/** For benches and tests only: the read and the pure derivation, separately. */
export const internal = { load, snapshotOf };
