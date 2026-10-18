/**
 * Leaving with your data, bringing it back, and leaving for good (Python app/account/{router,calendar,backup}.py,
 * spec/account.md §1 routes 6-14). The only file other modules may import.
 *
 * - Export: one guarded write (rate counter + security event), then one read batch for every section. Always built
 *   inline: on Workers Paid the inline export cap is unlimited (DESIGN.md §2), so `export_jobs` stays unused.
 * - Import: inline up to `INLINE_IMPORT_BYTES` (one context read, one atomic write of `json_each` bulk inserts, then
 *   game's `rebuild`); larger files are staged in R2 and imported by `import-slice` queue messages, and the
 *   response carries the additive `"queued": true` (DESIGN.md §13).
 * - Calendar feed: rate counter and every read in one batch, then the colo Cache API for five minutes.
 */
import { sql } from "drizzle-orm";
import type { Ctx } from "../../ctx.ts";
import { type AuthedBatch, abortUnless, isCondAbort, runBatch, type Stmt, toWire } from "../../db/batch.ts";
import { importJobs } from "../../db/schema/index.ts";
import { SETTINGS } from "../../env.ts";
import {
  type AccountJsonEvent,
  AccountJsonReader,
  type AccountJsonState,
  accountJsonString,
  BACKUP_UNREADABLE,
  initialAccountJsonState,
  NOT_JSON,
  parseAccountJson,
} from "../../heavy/account-json.ts";
import { FormatError } from "../../heavy/bytes.ts";
import { collectMultipart } from "../../heavy/multipart.ts";
import { type ZipInput, zipFiles } from "../../heavy/zip.ts";
import type { ConsumerRegistry } from "../../jobs/consumer.ts";
import { enqueue } from "../../jobs/dispatch.ts";
import { b64urlEncode, randomBytes } from "../../lib/b64url.ts";
import { sha256Hex } from "../../lib/crypto/hmac.ts";
import { verifyPassword } from "../../lib/crypto/pbkdf2.ts";
import { forbidden, HttpError, notFound } from "../../lib/errors.ts";
import { fold } from "../../lib/fold.ts";
import type { Attachment } from "../../lib/mailer/index.ts";
import { BUCKETS, calendarFeedCounter, perUser } from "../../lib/ratelimit.ts";
import { addDays, localDate, pyWeekday, zone } from "../../lib/time.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import { type Meta, revokeAllStatements, securityEvent } from "../auth/service.ts";
import { enqueueRebuild, rebuild } from "../game/service.ts";
import { dispatchNotified, notify, setExportAttachmentProvider } from "../notifications/service.ts";
import { ensureStatements } from "../profile/service.ts";
import { buildCalendar } from "./calendar.ts";
import {
  buildExport,
  csvReads,
  csvSheets,
  type ExportRows,
  exportReads,
  photoName,
  README,
} from "./export.ts";
import {
  EXPORT_FORMAT,
  type Existing,
  emptyRows,
  type ImportCounts,
  type ImportMaps,
  idsToCheck,
  MAX_IMPORT_WORKOUTS,
  type Planner,
  planSection,
  type Rows,
  SECTION_ORDER,
  SECTIONS,
  type Section,
  weighKey,
} from "./importer.ts";
import * as repo from "./repo.ts";

const MiB = 1024 * 1024;
export const MAX_IMPORT_BYTES = 25 * MiB;
/** Larger files are staged in R2 and imported by queue slices. */
export const INLINE_IMPORT_BYTES = 4 * MiB;
/** Bytes of the staged file one `import-slice` message reads. */
export const SLICE_BYTES = MiB;
export const MAX_ATTACHMENT_BYTES = 10 * MiB;
const FEED_HISTORY_DAYS = 400;
const FEED_CACHE_SECONDS = 300;

export const LABELS: Readonly<Record<string, string>> = {
  login: "Signed in",
  logout_all: "Signed out everywhere",
  password_changed: "Password changed",
  password_reset: "Password reset by email",
  totp_enabled: "Two-factor turned on",
  totp_disabled: "Two-factor turned off",
  recovery_codes_regenerated: "Recovery codes replaced",
  session_revoked: "A session was signed out",
  email_verified: "Email address confirmed",
  deletion_scheduled: "Account deletion scheduled",
  deletion_cancelled: "Account deletion cancelled",
  data_exported: "Data exported",
  signup: "Account created",
  password_recovered: "Password set with a recovery code",
  email_change_requested: "Email change requested",
  email_changed: "Email address changed",
  terms_accepted: "Terms accepted",
  passkey_added: "Passkey added",
  passkey_removed: "Passkey removed",
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** strftime `%d %B %Y` in UTC. */
function longDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export interface FileOut {
  body: string | Uint8Array;
  contentType: string;
  filename: string;
}

// ---- export -------------------------------------------------------------------------------------------------

async function exportDoc(ctx: Ctx, rows: ExportRows) {
  const doc = buildExport(ctx.clock.now(), rows);
  if (doc === null) throw new HttpError(401, "User is inactive or missing");
  return doc;
}

export async function exportData(ctx: Ctx, authed: AuthedBatch, format: "json" | "csv" | "ics", meta: Meta) {
  const now = ctx.clock.now();
  const u = authed.userId;
  const limit = perUser(ctx.db, BUCKETS.export, u, now);
  const [counter] = await authed.write(
    limit.counter,
    ctx.db.run(repo.eventIfSql(uuid7(now), u, sql`'data_exported'`, limit.allowed, meta, now, { format })),
  );
  limit.check(counter);
  const stamp = new Date(now).toISOString().slice(0, 10);
  if (format === "json") {
    const [, , , ...rows] = await authed.read(
      ...ensureStatements(ctx, authed, true),
      ...exportReads(ctx.db, u),
    );
    // One top-level array element per line: still plain JSON, and a large file can be re-imported in slices.
    const body = accountJsonString(await exportDoc(ctx, rows as unknown as ExportRows));
    return { body, contentType: "application/json", filename: `pacestreak-${stamp}.json` } satisfies FileOut;
  }
  if (format === "ics") {
    const [, workouts, pauses] = await authed.read(repo.icsWorkouts(ctx.db, u), repo.pauses(ctx.db, u));
    const body = buildCalendar("PaceStreak training", now, workouts, pauses);
    return {
      body,
      contentType: "text/calendar; charset=utf-8",
      filename: `pacestreak-${stamp}.ics`,
    } satisfies FileOut;
  }
  const [, ...rows] = await authed.read(...csvReads(ctx.db, u));
  const sheets = csvSheets(rows as unknown as Parameters<typeof csvSheets>[0]);
  const photos = rows[8] as Awaited<ReturnType<typeof repo.photos>>;
  const images: ZipInput[] = [];
  await Promise.all(
    photos.map(async (p, i) => {
      const obj = await ctx.env.PHOTOS.get(p.objectKey);
      if (obj !== null) images[i] = { name: photoName(p), data: new Uint8Array(await obj.arrayBuffer()) };
    }),
  );
  const body = zipFiles([
    ...sheets,
    ...images.filter((x) => x !== undefined),
    { name: "README.txt", data: README },
  ]);
  return { body, contentType: "application/zip", filename: `pacestreak-${stamp}.zip` } satisfies FileOut;
}

/** The monthly backup email's attachment: the JSON export, zipped; `null` when too big (the email sends a link). */
export async function exportAttachment(
  ctx: Ctx,
  userId: string,
  cap = MAX_ATTACHMENT_BYTES,
): Promise<Attachment | null> {
  const rows = (await runBatch(ctx.db, exportReads(ctx.db, userId))) as unknown as ExportRows;
  const doc = buildExport(ctx.clock.now(), rows);
  if (doc === null) return null;
  const name = `pacestreak-export-${new Date(ctx.clock.now()).toISOString().slice(0, 7)}`;
  const data = zipFiles([{ name: `${name}.json`, data: JSON.stringify(doc) }]);
  if (data.length > cap) return null;
  return { filename: `${name}.zip`, data, mime: "application/zip" };
}

// ---- import -------------------------------------------------------------------------------------------------

const ORDER: (keyof Rows)[] = [
  "custom_exercises",
  "gear",
  "gyms",
  "workouts",
  "workout_sets",
  "streak_pauses",
  "body_metrics",
  "weigh_ins",
  "exercise_notes",
  "weight_goals",
  "habits",
  "habit_logs",
  "readiness",
  "week_reflections",
];

/** Bulk inserts for planned rows, parents before children. */
function rowStatements(ctx: Ctx, userId: string, now: number, rows: Rows): Stmt[] {
  const out: Stmt[] = [];
  for (const table of ORDER) {
    let list = rows[table];
    if (table === "custom_exercises" || table === "habits")
      list = list.map((r) => ({ ...r, name_fold: fold(String(r.name)) }));
    for (const part of repo.chunkRows(list)) {
      if (table === "workouts") {
        out.push(ctx.db.run(repo.bumpSeqSql(part.length)));
        out.push(ctx.db.run(repo.bulkInsertSql("workouts", userId, now, part, { workouts: true })));
      } else out.push(ctx.db.run(repo.bulkInsertSql(table, userId, now, part)));
    }
  }
  return out;
}

/** The context reads, for a statement list (`profile` first, the two id lookups last). */
function contextReads(ctx: Ctx, userId: string, ids: { workouts: string[]; weighIns: string[] }) {
  const db = ctx.db;
  return [
    repo.profileRow(db, userId),
    repo.customNames(db, userId),
    repo.gearNames(db, userId),
    repo.gymNames(db, userId),
    repo.pauseSpans(db, userId),
    repo.weighKeys(db, userId),
    repo.metricDays(db, userId),
    repo.notedExercises(db, userId),
    repo.weightGoal(db, userId),
    repo.habitNames(db, userId),
    repo.habitLogDays(db, userId),
    repo.readyDays(db, userId),
    repo.reflectionWeeks(db, userId),
    repo.workoutOwners(db, ids.workouts),
    repo.weighInIdsTaken(db, ids.weighIns),
  ] as const;
}
type ContextReads = ReturnType<typeof contextReads>;
type ContextRows = { -readonly [K in keyof ContextReads]: Awaited<ContextReads[K]> };

function existingFrom(r: ContextRows): Existing {
  const [
    p,
    customs,
    gear,
    gyms,
    pauses,
    weighs,
    metrics,
    noted,
    goal,
    habits,
    logs,
    ready,
    refl,
    owners,
    weighIds,
  ] = r;
  const habitDays = new Map<string, Set<string>>();
  for (const l of logs) {
    const s = habitDays.get(l.habitId) ?? new Set<string>();
    s.add(l.day);
    habitDays.set(l.habitId, s);
  }
  return {
    tz: zone(p[0]?.timezone),
    customs: new Map(customs.map((c) => [c.name.toLowerCase(), `custom-${c.id}`])),
    gear: new Map(gear.map((g) => [g.name.toLowerCase(), g.id])),
    gyms: new Map(gyms.map((g) => [g.name.toLowerCase(), g.id])),
    pauses: pauses.map((x) => ({ startsOn: x.startsOn, endsOn: x.endsOn })),
    weighKeys: new Set(weighs.map((w) => weighKey(w.localDate, w.moment, w.weightKg))),
    metricDays: new Set(metrics.map((m) => m.day)),
    noted: new Set(noted.map((n) => n.exerciseId)),
    hasGoal: goal.length > 0,
    habits: new Map(habits.map((h) => [h.name.toLowerCase(), h.id])),
    habitDays,
    readyDays: new Set(ready.map((x) => x.day)),
    reflectionWeeks: new Set(refl.map((x) => x.week)),
    workoutOwners: new Map(owners.map((o) => [o.id, o.userId])),
    weighInIds: new Set(weighIds.map((w) => w.id)),
  };
}

const emptyMaps = (): ImportMaps => ({ ex: {}, gear: {}, gym: {} });

function missingFile(): HttpError {
  return new HttpError(422, [{ type: "missing", loc: ["body", "file"], msg: "Field required", input: null }]);
}

export async function importData(
  ctx: Ctx,
  authed: AuthedBatch,
  body: ReadableStream<Uint8Array> | null,
  contentType: string | undefined,
) {
  const now = ctx.clock.now();
  const limit = perUser(ctx.db, BUCKETS.import, authed.userId, now);
  const [counter] = await authed.write(limit.counter);
  limit.check(counter);
  const form = await collectMultipart(body, contentType, { maxFileBytes: MAX_IMPORT_BYTES });
  const file = form.files.get("file");
  if (file === undefined) throw missingFile();
  if (file.bytes.length > INLINE_IMPORT_BYTES) return queueImport(ctx, authed, file.bytes);

  let events: AccountJsonEvent[];
  try {
    events = parseAccountJson(file.bytes);
  } catch {
    throw new HttpError(422, NOT_JSON);
  }
  const doc: Record<string, unknown> = {};
  for (const e of events) {
    if (e.type === "member") doc[e.key] = e.value;
    else if (e.type === "arrayStart") doc[e.key] = [];
    else if (e.type === "element") (doc[e.key] as unknown[]).push(e.value);
  }
  if (doc.format !== EXPORT_FORMAT) throw new HttpError(422, "Not a PaceStreak export");
  const workouts = Array.isArray(doc.workouts) ? doc.workouts : [];
  if (workouts.length > MAX_IMPORT_WORKOUTS) throw new HttpError(413, "Too many sessions in one file");

  const sections = doc as Partial<Record<Section, unknown>>;
  const [, , ...ctxRows] = await authed.read(
    ...ensureStatements(ctx, authed),
    ...contextReads(ctx, authed.userId, idsToCheck(sections)),
  );
  const pl: Planner = {
    userId: authed.userId,
    now,
    ex: existingFrom(ctxRows as unknown as ContextRows),
    maps: emptyMaps(),
    counts: { imported: 0, skipped: 0 },
    rows: emptyRows(),
  };
  for (const s of SECTION_ORDER) if (s in sections) planSection(pl, s, sections[s]);
  const stmts = rowStatements(ctx, authed.userId, now, pl.rows);
  if (stmts.length > 0) {
    await authed.write(...(stmts as [Stmt, ...Stmt[]]));
    await rebuild(ctx, authed.userId, { notify: false });
  }
  return pl.counts;
}

// ---- queued import ------------------------------------------------------------------------------------------

/** What a queued import carries between slices, on `import_jobs.state`. */
interface SliceState {
  /** 1: every section but `workouts` (counting them); 2: only `workouts`, with the id maps from pass 1. */
  pass: 1 | 2;
  reader: AccountJsonState;
  maps: ImportMaps;
  counts: ImportCounts;
  workouts: number;
}

async function queueImport(ctx: Ctx, authed: AuthedBatch, bytes: Uint8Array) {
  // The exporter writes `format` first; anything else this large is refused up front.
  let events: AccountJsonEvent[];
  try {
    events = new AccountJsonReader().push(bytes.subarray(0, 64 * 1024));
  } catch (err) {
    if (err instanceof FormatError) throw new HttpError(422, BACKUP_UNREADABLE);
    throw err;
  }
  const first = events.find((e) => e.type === "member");
  if (first?.type !== "member" || first.key !== "format" || first.value !== EXPORT_FORMAT)
    throw new HttpError(422, "Not a PaceStreak export");
  const now = ctx.clock.now();
  const id = uuid7(now);
  const key = `imports/${id}`;
  await ctx.env.STAGING.put(key, bytes);
  const state: SliceState = {
    pass: 1,
    reader: initialAccountJsonState(),
    maps: emptyMaps(),
    counts: { imported: 0, skipped: 0 },
    workouts: 0,
  };
  await authed.write(
    ctx.db.insert(importJobs).values({
      id,
      userId: authed.userId,
      kind: "account",
      objectKey: key,
      size: bytes.length,
      state: state as unknown as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await enqueue(ctx.env.JOBS, [{ type: "import-slice", jobId: id }]);
  return { imported: 0, skipped: 0, queued: true };
}

/** One `import-slice`: reads the next byte range, plans and writes it with the job's progress in one batch. */
export async function importSlice(ctx: Ctx, jobId: string): Promise<void> {
  const [jobs] = await runBatch(ctx.db, [repo.importJob(ctx.db, jobId)] as const);
  const job = jobs[0];
  if (job === undefined || (job.status !== "queued" && job.status !== "running")) return;
  const state = job.state as unknown as SliceState;
  const offset = job.offset;
  const now = ctx.clock.now();
  const finish = async (status: "done" | "failed", error: string | null, title: string, body: string) => {
    const note = notify(ctx, {
      userId: job.userId,
      kind: "import_done",
      category: "backup",
      title,
      body,
      url: "/settings/data",
      dedupeKey: `import:${job.id}`,
    });
    const [, inserted] = await runBatch(ctx.db, [
      repo.updateImportJob(ctx.db, job.id, { status, error, finishedAt: now, state: state as never }, now),
      note,
    ]);
    dispatchNotified(ctx, (inserted ?? []) as { id: string }[]);
    await ctx.env.STAGING.delete(job.objectKey);
  };

  const obj = await ctx.env.STAGING.get(job.objectKey, { range: { offset, length: SLICE_BYTES } });
  if (obj === null) return finish("failed", "staged file missing", "Your import failed", BACKUP_UNREADABLE);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const reader = new AccountJsonReader(state.reader);
  const last = offset + bytes.length >= job.size;
  let events: AccountJsonEvent[];
  try {
    events = reader.push(bytes);
    if (last) events.push(...reader.end());
  } catch {
    return finish("failed", BACKUP_UNREADABLE, "Your import failed", BACKUP_UNREADABLE);
  }

  // Runs of consecutive items per section, in arrival order.
  const runs: [Section, unknown][] = [];
  for (const e of events) {
    if (e.type === "member" && e.key === "weight_goal" && state.pass === 1)
      runs.push(["weight_goal", e.value]);
    if (e.type !== "element" || !SECTIONS.has(e.key)) continue;
    const s = e.key as Section;
    if (s === "workouts") state.workouts++;
    if ((s === "workouts") !== (state.pass === 2)) continue;
    const prev = runs.at(-1);
    if (prev !== undefined && prev[0] === s && Array.isArray(prev[1])) prev[1].push(e.value);
    else runs.push([s, [e.value]]);
  }
  const sections: Partial<Record<Section, unknown>> = {};
  for (const [s, v] of runs)
    sections[s] = Array.isArray(v) ? [...((sections[s] as unknown[]) ?? []), ...v] : v;
  const results = await runBatch(ctx.db, contextReads(ctx, job.userId, idsToCheck(sections)));
  const pl: Planner = {
    userId: job.userId,
    now,
    ex: existingFrom(results as unknown as ContextRows),
    maps: state.maps,
    counts: state.counts,
    rows: emptyRows(),
  };
  for (const [s, v] of runs) planSection(pl, s, v);

  let next: SliceState = { ...state, reader: reader.state };
  let nextOffset = offset + bytes.length;
  if (last && state.pass === 1) {
    if (state.workouts > MAX_IMPORT_WORKOUTS)
      return finish("failed", "too many sessions", "Your import failed", "Too many sessions in one file");
    next = { ...next, pass: 2, reader: initialAccountJsonState(), workouts: 0 };
    nextOffset = 0;
  }
  const stmts: Stmt[] = [
    // A redelivered message finds the offset moved on and writes nothing.
    abortUnless(ctx.db, sql`(SELECT "offset" FROM import_jobs WHERE id = ${job.id}) = ${offset}`),
    ...rowStatements(ctx, job.userId, now, pl.rows),
    repo.updateImportJob(
      ctx.db,
      job.id,
      { status: "running", offset: nextOffset, state: next as unknown as Record<string, unknown> },
      now,
    ),
  ];
  try {
    await runBatch(ctx.db, stmts);
  } catch (err) {
    if (isCondAbort(err)) return;
    throw err;
  }
  if (last && state.pass === 2) {
    await finish(
      "done",
      null,
      "Your import is done",
      `Imported ${pl.counts.imported} sessions; skipped ${pl.counts.skipped}.`,
    );
    await enqueueRebuild(ctx, job.userId);
    return;
  }
  await enqueue(ctx.env.JOBS, [{ type: "import-slice", jobId: job.id }]);
}

// ---- deletion -----------------------------------------------------------------------------------------------

export async function scheduleDeletion(ctx: Ctx, authed: AuthedBatch, password: string, meta: Meta) {
  const [, rows] = await authed.read(repo.account(ctx.db, authed.userId));
  const u = rows[0];
  if (u === undefined || !(await verifyPassword(u.hashedPassword, password, ctx.cfg.pepper)))
    throw forbidden("Incorrect password");
  const now = ctx.clock.now();
  const when = now + SETTINGS.deletionGraceDays * 86_400_000;
  const note = notify(ctx, {
    userId: authed.userId,
    kind: "deletion_scheduled",
    category: "security",
    title: "Your PaceStreak account is scheduled for deletion",
    body: `Everything will be deleted on ${longDate(when)}. Sign in before then to cancel.`,
    url: "/settings/data",
  });
  const results = await authed.write(
    ...(ensureStatements(ctx, authed) as [Stmt]),
    repo.scheduleDeletion(ctx.db, authed.userId, when, now),
    securityEvent(ctx, authed.userId, "deletion_scheduled", meta),
    note,
    ...revokeAllStatements(ctx, authed.userId),
  );
  dispatchNotified(ctx, (results[3] ?? []) as { id: string }[]);
  return { deletion_scheduled_at: toWire(when) };
}

/** One write: the event lands only if a deletion was scheduled, then the deletion is cleared. */
export async function cancelDeletion(ctx: Ctx, authed: AuthedBatch, meta: Meta) {
  const now = ctx.clock.now();
  const u = authed.userId;
  const [, cleared] = await authed.write(
    ctx.db.run(repo.eventIfSql(uuid7(now), u, sql`'deletion_cancelled'`, repo.scheduled(u), meta, now)),
    repo.cancelDeletion(ctx.db, u, now),
  );
  return { cancelled: cleared.length > 0 };
}

export async function securityEvents(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.recentEvents(ctx.db, authed.userId));
  return rows.map((e) => ({
    id: e.id,
    kind: e.kind,
    label: LABELS[e.kind] ?? e.kind,
    ip_address: e.ipAddress,
    user_agent: e.userAgent,
    meta: e.meta,
    created_at: toWire(e.createdAt),
  }));
}

// ---- calendar feed ------------------------------------------------------------------------------------------

const cacheKey = (hash: string) => new Request(`https://calendar-cache.pacestreak.internal/${hash}`);

function forgetFeed(ctx: Ctx, hash: string | null | undefined) {
  if (hash) ctx.defer(caches.default.delete(cacheKey(hash)));
}

export async function calendarStatus(ctx: Ctx, authed: AuthedBatch) {
  const [, , rows] = await authed.read(
    ...ensureStatements(ctx, authed),
    repo.calendarState(ctx.db, authed.userId),
  );
  const s = rows[0];
  return { enabled: !!s?.hash, created_at: toWire(s?.createdAt ?? null) };
}

/** Creates or replaces the feed in one write: the old URL stops working at once. */
export async function createFeed(ctx: Ctx, authed: AuthedBatch, meta: Meta) {
  const now = ctx.clock.now();
  const u = authed.userId;
  const limit = perUser(ctx.db, BUCKETS.calendarRotate, u, now);
  const token = b64urlEncode(randomBytes(32));
  const hash = await sha256Hex(token);
  const kind = sql`CASE WHEN ${repo.feedSet(u)} THEN 'calendar_feed_rotated' ELSE 'calendar_feed_created' END`;
  const [counter, , old] = await authed.write(
    limit.counter,
    ...(ensureStatements(ctx, authed) as [Stmt]),
    repo.calendarState(ctx.db, u),
    ctx.db.run(repo.eventIfSql(uuid7(now), u, kind, limit.allowed, meta, now)),
    repo.setFeed(ctx.db, u, hash, now, limit.allowed),
  );
  limit.check(counter);
  forgetFeed(ctx, old[0]?.hash);
  return {
    url: `${ctx.cfg.publicApiUrl.replace(/\/+$/, "")}/v1/calendar/${token}.ics`,
    created_at: toWire(now),
  };
}

export async function revokeFeed(ctx: Ctx, authed: AuthedBatch, meta: Meta) {
  const now = ctx.clock.now();
  const u = authed.userId;
  const [old] = await authed.write(
    repo.calendarState(ctx.db, u),
    ctx.db.run(repo.eventIfSql(uuid7(now), u, sql`'calendar_feed_revoked'`, repo.feedSet(u), meta, now)),
    repo.setFeed(ctx.db, u, null, now),
  );
  forgetFeed(ctx, old[0]?.hash);
}

const FEED_HEADERS = {
  "Content-Type": "text/calendar; charset=utf-8",
  "Cache-Control": "private, max-age=900",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

/** `GET /v1/calendar/{token}.ics`: the URL is the credential. Wrong token and closed account answer the same 404. */
export async function feed(ctx: Ctx, token: string): Promise<Response> {
  if (token.length < 20 || token.length > 100) throw notFound();
  const hash = await sha256Hex(token);
  const cached = await caches.default.match(cacheKey(hash));
  if (cached !== undefined) return new Response(cached.body, { headers: FEED_HEADERS });
  const now = ctx.clock.now();
  const since = now - FEED_HISTORY_DAYS * 86_400_000;
  // Keyed on the hash, never the token.
  const limit = calendarFeedCounter(ctx.db, hash.slice(0, 16), now);
  const [counter, owners, workouts, pauses] = await runBatch(ctx.db, [
    limit.counter,
    repo.feedOwner(ctx.db, hash),
    repo.feedWorkouts(ctx.db, hash, since, addDays(new Date(since).toISOString().slice(0, 10), -1)),
    repo.feedPauses(ctx.db, hash),
  ] as const);
  limit.check(counter);
  const p = owners[0];
  if (p === undefined || !p.isActive || p.deletionScheduledAt !== null) throw notFound();
  const today = localDate(now, zone(p.timezone));
  // Always Monday, whatever the week start (Python parity).
  const anchor = addDays(today, -pyWeekday(today));
  const body = buildCalendar("PaceStreak training", now, workouts, pauses, p.trainingDays, anchor);
  ctx.defer(
    caches.default.put(
      cacheKey(hash),
      new Response(body, { headers: { "Cache-Control": `max-age=${FEED_CACHE_SECONDS}` } }),
    ),
  );
  return new Response(body, { headers: FEED_HEADERS });
}

// ---- registration -------------------------------------------------------------------------------------------

/** Registers the `import-slice` consumer and the backup-attachment provider. Called once from the Worker entry. */
export function registerConsumers(registry: ConsumerRegistry): void {
  registry.register("import-slice", async (ctx, msg) => {
    await importSlice(ctx, msg.jobId);
  });
  setExportAttachmentProvider((ctx, userId) => exportAttachment(ctx, userId));
}
