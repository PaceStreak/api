/**
 * The signed-in person: bootstrap (`GET /me`), onboarding, terms, settings and handle checks (spec/account.md
 * §1 routes 1-5). The only file other modules may import.
 *
 * Round trips: `GET /me`, terms, handle checks and plain settings changes are 1-2. Onboarding, and a settings change
 * that moves the week (`timezone`, `week_starts_on`, `weekly_target`), ride inside game's `recompute`: its read
 * batch is the only read and the profile update goes into its write batch, so they cost 2.
 */
import type { Ctx } from "../../ctx.ts";
import type { AuthedBatch, Stmt } from "../../db/batch.ts";
import { toWire, withFoldPatch } from "../../db/batch.ts";
import { profiles } from "../../db/schema/index.ts";
import type { TargetHistory } from "../../db/schema/training.ts";
import { SETTINGS } from "../../env.ts";
import { conflict, forbidden, HttpError, isConstraintError } from "../../lib/errors.ts";
import { checkHandle, mentionsBrand } from "../../lib/handles.ts";
import { clientIp } from "../../lib/http.ts";
import { isValidTimezone, localDate, weekStart } from "../../lib/time.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import type { Meta } from "../auth/service.ts";
import { securityEvent } from "../auth/service.ts";
import { type Loaded, recompute } from "../game/service.ts";
import * as repo from "./repo.ts";
import type { OnboardingInput, ProfilePatchInput } from "./schemas.ts";

/** Who is asking, for security events: descriptive only. */
export const requestMeta = (req: { header(name: string): string | undefined }): Meta => ({
  ip: clientIp(req),
  userAgent: req.header("User-Agent")?.slice(0, 400) || null,
});

export const MIN_AGE = 13;
export const SOCIAL_MIN_AGE = 16;

export const HANDLE_TAKEN = "That handle is taken";
const BRAND_NAME = "Display names can't use the PaceStreak name";
const UNKNOWN_TZ = "Unknown timezone";

export type ProfileRow = typeof profiles.$inferSelect;

/** Python `profile_out`, keys in the same order. */
export function profileOut(p: ProfileRow) {
  return {
    handle: p.handle,
    display_name: p.displayName,
    official: p.isOfficial,
    bio: p.bio,
    avatar_hue: p.avatarHue,
    timezone: p.timezone,
    week_starts_on: p.weekStartsOn,
    weight_unit: p.weightUnit,
    distance_unit: p.distanceUnit,
    training_days: p.trainingDays,
    max_hr: p.maxHr,
    life_target: p.lifeTarget,
    favourite_disciplines: p.favouriteDisciplines,
    onboarded_at: toWire(p.onboardedAt),
    birth_year: p.birthYear,
    onboarded: p.onboardedAt !== null,
    visibility: p.visibility,
    sharing_paused: p.sharingPaused,
    gamification_enabled: p.gamificationEnabled,
    leaderboard_opt_in: p.leaderboardOptIn,
    social_suspended: p.socialSuspendedAt !== null,
    deletion_scheduled_at: toWire(p.deletionScheduledAt),
    reminder_hour: p.reminderHour,
    reminder_mode: p.reminderMode,
    learned_reminder_hour: p.learnedReminderHour,
    quiet_start: p.quietStart,
    quiet_end: p.quietEnd,
    quiet_days: p.quietDays,
  };
}

interface SocialFields {
  birthYear: number | null;
  socialSuspendedAt: number | null;
  deletionScheduledAt: number | null;
  onboardedAt: number | null;
}

/** Python `Profile.social_allowed(year)`. */
export function socialAllowed(p: SocialFields, year: number): boolean {
  return (
    p.birthYear !== null &&
    year - p.birthYear >= SOCIAL_MIN_AGE &&
    p.socialSuspendedAt === null &&
    p.deletionScheduledAt === null &&
    p.onboardedAt !== null
  );
}

const randomHue = () => (crypto.getRandomValues(new Uint16Array(1))[0] ?? 0) % 360;

/**
 * Statements that create the profile (and, with `chain`, the default chain) on first use. Safe at the head of a
 * read batch: they insert only while the caller's session is live, and never twice.
 */
export function ensureStatements(ctx: Ctx, authed: AuthedBatch, chain = false): Stmt[] {
  const now = ctx.clock.now();
  const out: Stmt[] = [repo.ensureProfile(ctx.db, authed.principal, uuid7(now), randomHue(), now)];
  if (chain) out.push(repo.ensureChain(ctx.db, authed.principal, uuid7(now), now));
  return out;
}

/** The profile row for a statement list that started with `ensureStatements`. */
export const profileStatement = (ctx: Ctx, userId: string) => repo.profile(ctx.db, userId);

function only<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("profile missing after ensureProfile");
  return row;
}

/** A unique-handle violation is the spec's 409; anything else passes through. */
function handleClash(err: unknown): unknown {
  return isConstraintError(err) && String((err as Error).message).includes("profiles.handle")
    ? conflict(HANDLE_TAKEN)
    : err;
}

const utcYear = (ctx: Ctx) => new Date(ctx.clock.now()).getUTCFullYear();

// ---- GET /me ------------------------------------------------------------------------------------------------

/** Everything the client needs to render its shell. One round trip. */
export async function me(ctx: Ctx, authed: AuthedBatch) {
  const id = authed.userId;
  const [u, , rows, extras, unread, requests] = await authed.read(
    ...(ensureStatements(ctx, authed) as [Stmt]),
    repo.profile(ctx.db, id),
    repo.userExtras(ctx.db, id),
    repo.unreadCount(ctx.db, id),
    repo.followRequests(ctx.db, id),
  );
  const p = only(rows);
  return {
    user: {
      id: u.id,
      email: u.email,
      is_verified: u.isVerified,
      role: u.role,
      totp_enabled: extras[0]?.totpEnabled ?? false,
    },
    profile: profileOut(p),
    needs_onboarding: p.onboardedAt === null,
    needs_terms: p.onboardedAt !== null && p.acceptedTermsVersion !== SETTINGS.termsVersion,
    terms_version: SETTINGS.termsVersion,
    social_allowed: socialAllowed(p, utcYear(ctx)),
    min_age: MIN_AGE,
    social_min_age: SOCIAL_MIN_AGE,
    unread_notifications: unread[0]?.n ?? 0,
    follow_requests: requests[0]?.n ?? 0,
    push_public_key: ctx.cfg.vapid?.publicKey ?? null,
  };
}

// ---- onboarding ---------------------------------------------------------------------------------------------

/** Python `check_display_name`; reads `is_official` only in the rare case a name mentions the brand. */
async function checkDisplayName(
  ctx: Ctx,
  authed: AuthedBatch,
  name: string | null | undefined,
  official?: boolean,
) {
  if (!name || !mentionsBrand(name)) return;
  let isOfficial = official;
  if (isOfficial === undefined) {
    const [, rows] = await authed.read(repo.isOfficial(ctx.db, authed.userId));
    isOfficial = rows[0]?.isOfficial ?? false;
  }
  if (!isOfficial) throw conflict(BRAND_NAME);
}

/** Points the in-memory snapshot inputs at a new zone/week start, as the write will. */
function retime(ctx: Ctx, l: Loaded, timezone: string | undefined, weekStartsOn: number | undefined) {
  const p = l.inputs.profile;
  if (timezone !== undefined) {
    p.timezone = timezone;
    l.inputs.today = localDate(ctx.clock.now(), timezone);
  }
  if (weekStartsOn !== undefined) p.weekStartsOn = weekStartsOn;
}

function mainChainOf(l: Loaded) {
  const main = l.inputs.chains[0];
  if (main === undefined) throw new Error("no main chain after recompute's load");
  return main;
}

export async function onboarding(ctx: Ctx, authed: AuthedBatch, body: OnboardingInput) {
  if (!body.accept_terms) throw new HttpError(422, "Please accept the terms");
  const year = utcYear(ctx);
  if (year - body.birth_year < MIN_AGE) throw forbidden(`PaceStreak is for people aged ${MIN_AGE} and over.`);
  if (!isValidTimezone(body.timezone)) throw new HttpError(422, UNKNOWN_TZ);
  const handle = checkHandle(body.handle);
  // A handle held by someone else fails the write on the unique index (409 below), saving a read.
  await checkDisplayName(ctx, authed, body.display_name);

  const now = ctx.clock.now();
  const displayName = (body.display_name ?? "").trim() || null;
  const visibility = (year - body.birth_year >= SOCIAL_MIN_AGE ? body.visibility : "private") as
    | "private"
    | "followers"
    | "public";
  let row: ProfileRow | undefined;
  try {
    await recompute(
      ctx,
      authed.userId,
      { notify: false },
      {
        authed,
        apply: (l) => {
          const p = l.inputs.profile;
          const onboardedAt = p.onboardedAt ?? now;
          retime(ctx, l, body.timezone, body.week_starts_on);
          p.birthYear = body.birth_year;
          p.visibility = visibility;
          p.onboardedAt = onboardedAt;
          const main = mainChainOf(l);
          const history: TargetHistory = [{ from: "2000-01-03", target: body.weekly_target }];
          main.targetHistory = history;
          return [
            repo.updateProfile(
              ctx.db,
              authed.userId,
              withFoldPatch(profiles, {
                handle,
                displayName,
                birthYear: body.birth_year,
                acceptedTermsAt: now,
                acceptedTermsVersion: SETTINGS.termsVersion,
                timezone: body.timezone,
                weekStartsOn: body.week_starts_on,
                weightUnit: body.weight_unit as "kg" | "lb",
                distanceUnit: body.distance_unit as "km" | "mi",
                visibility,
                onboardedAt,
              }),
              now,
            ),
            repo.setChainHistory(ctx.db, main.id, history, now),
          ];
        },
        written: (results) => {
          row = (results[0] as ProfileRow[])[0];
        },
      },
    );
  } catch (err) {
    throw handleClash(err);
  }
  if (row === undefined) throw new Error("onboarding wrote no profile");
  return { profile: profileOut(row) };
}

// ---- terms --------------------------------------------------------------------------------------------------

/** One write: the profile (created if needed), the acceptance and its security event. */
export async function acceptTerms(ctx: Ctx, authed: AuthedBatch, version: string, meta: Meta) {
  if (version !== SETTINGS.termsVersion) throw conflict("The terms changed again. Reload and review them.");
  const now = ctx.clock.now();
  await authed.write(
    ...(ensureStatements(ctx, authed) as [Stmt]),
    repo.updateProfile(
      ctx.db,
      authed.userId,
      { acceptedTermsAt: now, acceptedTermsVersion: SETTINGS.termsVersion },
      now,
    ),
    securityEvent(ctx, authed.userId, "terms_accepted", meta, { version }),
  );
  return { accepted: SETTINGS.termsVersion };
}

// ---- PATCH /me/profile --------------------------------------------------------------------------------------

/** Columns that are NOT NULL: an explicit `null` for them is ignored (Python wrote it and answered 500). */
const NOT_NULL = new Set([
  "avatar_hue",
  "week_starts_on",
  "weight_unit",
  "distance_unit",
  "favourite_disciplines",
  "visibility",
  "sharing_paused",
  "gamification_enabled",
  "leaderboard_opt_in",
  "reminder_hour",
  "reminder_mode",
  "quiet_start",
  "quiet_end",
]);

const COLUMN: Record<string, keyof ProfileRow> = {
  display_name: "displayName",
  bio: "bio",
  avatar_hue: "avatarHue",
  timezone: "timezone",
  week_starts_on: "weekStartsOn",
  weight_unit: "weightUnit",
  distance_unit: "distanceUnit",
  training_days: "trainingDays",
  max_hr: "maxHr",
  life_target: "lifeTarget",
  favourite_disciplines: "favouriteDisciplines",
  visibility: "visibility",
  sharing_paused: "sharingPaused",
  gamification_enabled: "gamificationEnabled",
  leaderboard_opt_in: "leaderboardOptIn",
  reminder_hour: "reminderHour",
  reminder_mode: "reminderMode",
  quiet_start: "quietStart",
  quiet_end: "quietEnd",
  quiet_days: "quietDays",
};

/** Snapshot inputs a profile change can move (game's ProfileIn), by column. */
const SNAPSHOT_FIELDS = [
  "timezone",
  "weekStartsOn",
  "gamificationEnabled",
  "lifeTarget",
  "trainingDays",
  "visibility",
  "sharingPaused",
  "leaderboardOptIn",
  "quietStart",
  "quietEnd",
] as const;

interface PatchPlan {
  values: repo.ProfileValues;
  target: number | null;
  recompute: boolean;
}

/** Python's checks 2-7 in order, against whatever profile the caller has in hand. */
function planPatch(data: ProfilePatchInput, handle: string | null, p: SocialFields, year: number): PatchPlan {
  const d: Record<string, unknown> = { ...data };
  delete d.handle;
  if ("timezone" in d && !isValidTimezone((d.timezone as string | null) ?? ""))
    throw new HttpError(422, UNKNOWN_TZ);
  for (const k of Object.keys(d)) if (d[k] === null && NOT_NULL.has(k)) delete d[k];
  const allowed = socialAllowed(p, year);
  if ((d.visibility === "followers" || d.visibility === "public") && !allowed)
    throw forbidden("Sharing is not available on this account.");
  if (d.leaderboard_opt_in && !allowed) throw forbidden("Leaderboards are not available on this account.");
  if (d.gamification_enabled === false) d.leaderboard_opt_in = false;
  const target = (d.weekly_target as number | null | undefined) ?? null;
  delete d.weekly_target;
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    const col = COLUMN[k];
    if (col === undefined) continue;
    values[col] = (k === "display_name" || k === "bio") && !v ? null : v;
  }
  if (handle !== null) values.handle = handle;
  return {
    values: withFoldPatch(profiles, values as repo.ProfileValues),
    target,
    recompute: target !== null || "week_starts_on" in d || "timezone" in d,
  };
}

const currentTarget = (h: TargetHistory) => h.at(-1)?.target ?? 3;

/** Python `set_chain_target`: weeks before `week` keep the target they were judged by. */
function withTarget(h: TargetHistory, target: number, week: string): TargetHistory {
  return [...h.filter((e) => e.from < week), { from: week, target }];
}

export async function patchProfile(ctx: Ctx, authed: AuthedBatch, data: ProfilePatchInput) {
  const handle = data.handle == null ? null : checkHandle(data.handle);
  const year = utcYear(ctx);
  const now = ctx.clock.now();
  const brandCheck = "display_name" in data && !!data.display_name && mentionsBrand(data.display_name);

  // Changes that move the week ride inside a recompute: its read is the only read.
  const movesWeek =
    (data.weekly_target ?? null) !== null || (data.week_starts_on ?? null) !== null || "timezone" in data;
  if (movesWeek) {
    if (brandCheck) await checkDisplayName(ctx, authed, data.display_name);
    let row: ProfileRow | undefined;
    try {
      await recompute(
        ctx,
        authed.userId,
        { notify: false },
        {
          authed,
          apply: (l) => {
            const p = l.inputs.profile;
            const plan = planPatch(data, handle, p, year);
            const v = plan.values;
            for (const f of SNAPSHOT_FIELDS) if (f in v) (p as unknown as Record<string, unknown>)[f] = v[f];
            retime(ctx, l, v.timezone, v.weekStartsOn);
            const stmts: Stmt[] = [repo.updateProfile(ctx.db, authed.userId, v, now)];
            if (plan.target !== null) {
              const main = mainChainOf(l);
              if (plan.target !== currentTarget(main.targetHistory)) {
                const week = weekStart(l.inputs.today, p.weekStartsOn);
                main.targetHistory = withTarget(main.targetHistory, plan.target, week);
                stmts.push(repo.setChainHistory(ctx.db, main.id, main.targetHistory, now));
              }
            }
            return stmts;
          },
          written: (results) => {
            row = (results[0] as ProfileRow[])[0];
          },
        },
      );
    } catch (err) {
      throw handleClash(err);
    }
    if (row === undefined) throw new Error("profile update returned nothing");
    return { profile: profileOut(row) };
  }

  const [, , rows, taken] = await authed.read(
    ...(ensureStatements(ctx, authed) as [Stmt]),
    repo.profile(ctx.db, authed.userId),
    repo.handleTaken(ctx.db, handle ?? "", authed.userId),
  );
  const p = only(rows);
  if (handle !== null && taken.length > 0) throw conflict(HANDLE_TAKEN);
  const plan = planPatch(data, handle, p, year);
  if ("display_name" in data) await checkDisplayName(ctx, authed, data.display_name, p.isOfficial);
  try {
    const [updated] = await authed.write(repo.updateProfile(ctx.db, authed.userId, plan.values, now));
    return { profile: profileOut(only(updated)) };
  } catch (err) {
    throw handleClash(err);
  }
}

// ---- GET /handles/{handle} ----------------------------------------------------------------------------------

export async function handleAvailable(ctx: Ctx, authed: AuthedBatch, raw: string) {
  let clean: string;
  try {
    clean = checkHandle(raw);
  } catch (err) {
    if (err instanceof HttpError) return { handle: raw, available: false, reason: err.message };
    throw err;
  }
  const [, taken] = await authed.read(repo.handleTaken(ctx.db, clean, authed.userId));
  return { handle: clean, available: taken.length === 0, reason: taken.length > 0 ? "Taken" : null };
}
