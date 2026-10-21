/** Body metrics, weigh-ins and progress-photo backup (spec/training-a.md §1.6, §1.7, §1.11). All private. */
import { and, eq } from "drizzle-orm";
import type { Ctx } from "../../ctx.ts";
import type { AuthedBatch, Stmt } from "../../db/batch.ts";
import { bodyMetrics, bodyPhotos, weighIns } from "../../db/schema/index.ts";
import { conflict, HttpError, notFound } from "../../lib/errors.ts";
import { pyRound } from "../../lib/format.ts";
import { deleteMany, isPhotoType, storeChecked } from "../../lib/r2.ts";
import { BUCKETS, perUser } from "../../lib/ratelimit.ts";
import { addDays, localDate, parseInstant, toWire } from "../../lib/time.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import { recompute } from "../game/service.ts";
import * as repo from "./repo.ts";
import type { BodyMetricInput, PhotoInput, WeighInInput } from "./schemas.ts";
import { FUTURE_TOLERANCE_MS, MAX_BACKDATE_DAYS, profileOf } from "./workouts.ts";

const DAY_MS = 86_400_000;
const utcToday = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * Rows since `local today - days`: read from one day earlier than the UTC equivalent (a local date is within a day
 * of UTC), then trimmed once the profile's zone is known, so the read is one round trip.
 */
const sinceBound = (now: number, days: number) => addDays(utcToday(now), -days - 1);

// ---- body metrics ---------------------------------------------------------------------------------------------

type MetricRow = typeof bodyMetrics.$inferSelect;
const METRIC_FIELDS = [
  ["body_fat_pct", "bodyFatPct"],
  ["resting_hr", "restingHr"],
  ["sleep_hours", "sleepHours"],
  ["neck_cm", "neckCm"],
  ["shoulders_cm", "shouldersCm"],
  ["chest_cm", "chestCm"],
  ["waist_cm", "waistCm"],
  ["arm_cm", "armCm"],
  ["forearm_cm", "forearmCm"],
  ["hips_cm", "hipsCm"],
  ["thigh_cm", "thighCm"],
  ["calf_cm", "calfCm"],
  ["note", "note"],
] as const;

export function metricOut(m: MetricRow) {
  const out: Record<string, unknown> = { date: m.measuredOn };
  for (const [wire, col] of METRIC_FIELDS) out[wire] = m[col];
  return out;
}

export async function listMetrics(ctx: Ctx, authed: AuthedBatch, days: number) {
  const now = ctx.clock.now();
  const [, prof, rows] = await authed.read(
    repo.profile(ctx.db, authed.userId),
    repo.metricsSince(ctx.db, authed.userId, sinceBound(now, days)),
  );
  const since = addDays(localDate(now, profileOf(prof).timezone), -days);
  return rows.filter((m) => m.measuredOn >= since).map(metricOut);
}

/** Read the zone (round trip 1); write riding in the recompute's read (2); the recompute's write (3). */
export async function putMetric(ctx: Ctx, authed: AuthedBatch, day: string, body: BodyMetricInput) {
  const now = ctx.clock.now();
  const [, prof] = await authed.read(repo.profile(ctx.db, authed.userId));
  if (day > localDate(now, profileOf(prof).timezone))
    throw new HttpError(422, "That day has not happened yet");
  if (Object.values(body).every((v) => v === null)) throw new HttpError(422, "Nothing to record");
  const values = {
    bodyFatPct: body.body_fat_pct,
    waistCm: body.waist_cm,
    restingHr: body.resting_hr,
    sleepHours: body.sleep_hours,
    note: body.note,
    neckCm: body.neck_cm,
    shouldersCm: body.shoulders_cm,
    chestCm: body.chest_cm,
    armCm: body.arm_cm,
    forearmCm: body.forearm_cm,
    hipsCm: body.hips_cm,
    thighCm: body.thigh_cm,
    calfCm: body.calf_cm,
  };
  let row: MetricRow | undefined;
  await recompute(
    ctx,
    authed.userId,
    { notify: true },
    {
      authed,
      before: {
        stmts: [
          ctx.db
            .insert(bodyMetrics)
            .values({
              id: uuid7(now),
              userId: authed.userId,
              measuredOn: day,
              createdAt: now,
              updatedAt: now,
              ...values,
            })
            .onConflictDoUpdate({
              target: [bodyMetrics.userId, bodyMetrics.measuredOn],
              set: { ...values, updatedAt: now },
            })
            .returning(),
        ],
        done: (r) => {
          row = (r[0] as MetricRow[])[0];
        },
      },
    },
  );
  if (row === undefined) throw new Error("body metric upsert returned nothing");
  return metricOut(row);
}

export async function deleteMetric(ctx: Ctx, authed: AuthedBatch, day: string) {
  await authed.write(
    ctx.db
      .delete(bodyMetrics)
      .where(and(eq(bodyMetrics.userId, authed.userId), eq(bodyMetrics.measuredOn, day))),
  );
}

// ---- weigh-ins ------------------------------------------------------------------------------------------------

type WeighRow = typeof weighIns.$inferSelect;

export const weighInOut = (w: WeighRow) => ({
  id: w.id,
  weighed_at: toWire(w.weighedAt),
  date: w.localDate,
  moment: w.moment,
  weight_kg: w.weightKg,
  note: w.note,
});

export async function listWeighIns(ctx: Ctx, authed: AuthedBatch, days: number) {
  const now = ctx.clock.now();
  const [, prof, rows] = await authed.read(
    repo.profile(ctx.db, authed.userId),
    repo.weighInsSince(ctx.db, authed.userId, sinceBound(now, days)),
  );
  const since = addDays(localDate(now, profileOf(prof).timezone), -days);
  return rows.filter((w) => w.localDate >= since).map(weighInOut);
}

export async function putWeighIn(ctx: Ctx, authed: AuthedBatch, id: string, body: WeighInInput) {
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(body.weighed_at)) throw new HttpError(422, "Time needs a timezone");
  const at = parseInstant(body.weighed_at) ?? Number.NaN;
  const now = ctx.clock.now();
  if (at > now + FUTURE_TOLERANCE_MS) throw new HttpError(422, "That time has not happened yet");
  if (at < now - MAX_BACKDATE_DAYS * DAY_MS)
    throw new HttpError(422, `Weigh-ins can be backdated up to ${MAX_BACKDATE_DAYS} days`);
  const [, prof, owner] = await authed.read(
    repo.profile(ctx.db, authed.userId),
    repo.weighInOwner(ctx.db, id),
  );
  const o = owner[0];
  if (o !== undefined && o.userId !== authed.userId) throw notFound("Not found");
  const values = {
    weighedAt: at,
    localDate: localDate(at, profileOf(prof).timezone),
    moment: body.moment,
    weightKg: pyRound(body.weight_kg, 2),
    note: body.note,
  };
  let row: WeighRow | undefined;
  const upsert: Stmt = ctx.db
    .insert(weighIns)
    .values({ id, userId: authed.userId, createdAt: now, updatedAt: now, ...values })
    .onConflictDoUpdate({
      target: weighIns.id,
      set: { ...values, updatedAt: now },
      setWhere: eq(weighIns.userId, authed.userId),
    })
    .returning();
  await recompute(
    ctx,
    authed.userId,
    { notify: true },
    {
      authed,
      before: {
        stmts: [upsert],
        done: (r) => {
          row = (r[0] as WeighRow[])[0];
        },
      },
    },
  );
  if (row === undefined) throw notFound("Not found");
  return weighInOut(row);
}

export async function deleteWeighIn(ctx: Ctx, authed: AuthedBatch, id: string) {
  await authed.write(
    ctx.db.delete(weighIns).where(and(eq(weighIns.userId, authed.userId), eq(weighIns.id, id))),
  );
}

// ---- photos ---------------------------------------------------------------------------------------------------

export const MAX_PHOTOS = 500;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const BACKUP_OFF = "Photo backup is off for this account. Turn it on to upload photos.";

type PhotoRow = typeof bodyPhotos.$inferSelect;
export const photoOut = (p: PhotoRow) => ({ id: p.id, date: p.takenOn, pose: p.pose, size: p.size });
export const objectKey = (userId: string, photoId: string) => `body-photos/${userId}/${photoId}`;
/** The declared type, without parameters (`image/jpeg; charset=x` is `image/jpeg`); never trusted on its own. */
const mediaType = (header: string | undefined) => (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

/** Python `_check`, on rows read in the caller's batch. */
function check(
  ctx: Ctx,
  authed: AuthedBatch,
  prof: Parameters<typeof profileOf>[0],
  existing: PhotoRow | undefined,
  body: PhotoInput,
  contentType: string,
) {
  if (!isPhotoType(contentType)) throw new HttpError(415, "Send a JPEG, WebP or PNG");
  const today = localDate(ctx.clock.now(), profileOf(prof).timezone);
  if (body.date > addDays(today, 1)) throw new HttpError(422, "That day has not happened yet");
  if (existing !== undefined && existing.userId !== authed.userId) throw conflict("Pick another id");
}

export async function listPhotos(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.photos(ctx.db, authed.userId));
  return rows.map(photoOut);
}

/**
 * The photo's bytes, streamed from the PHOTOS binding with the stored type. Owner only: anyone else, a deleted row
 * or a missing object is the same 404. Never cached anywhere: these are body photos.
 */
export async function getPhoto(ctx: Ctx, authed: AuthedBatch, id: string): Promise<Response> {
  const [, rows] = await authed.read(repo.photoById(ctx.db, id));
  const p = rows[0];
  if (p === undefined || p.userId !== authed.userId) throw notFound("Not found");
  const obj = await ctx.env.PHOTOS.get(p.objectKey);
  if (obj === null) throw notFound("Not found");
  return new Response(obj.body, {
    headers: {
      "Content-Type": p.contentType,
      "Content-Length": String(obj.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}

/**
 * One request: the raw bytes, typed by Content-Type, with `date` and `pose` in the query. Round trip 1 reads the
 * profile, the id's owner and the count, and counts the call against `body-photo` (60/h); the bytes then stream into
 * R2 with their first bytes checked against the declared type before anything is stored; round trip 2 writes the
 * row. A rejected upload stores nothing and leaves an earlier version of the photo as it was.
 */
export async function uploadPhoto(
  ctx: Ctx,
  authed: AuthedBatch,
  id: string,
  body: PhotoInput,
  upload: {
    contentType: string | undefined;
    contentLength: string | undefined;
    stream: ReadableStream<Uint8Array> | null;
  },
) {
  const limit = perUser(ctx.db, BUCKETS.bodyPhoto, authed.userId, ctx.clock.now());
  const [, counter, prof, rows, count] = await authed.read(
    limit.counter,
    repo.profile(ctx.db, authed.userId),
    repo.photoById(ctx.db, id),
    repo.countPhotos(ctx.db, authed.userId),
  );
  limit.check(counter);
  if (!prof[0]?.photoBackup) throw conflict(BACKUP_OFF);
  const existing = rows[0];
  const contentType = mediaType(upload.contentType);
  check(ctx, authed, prof, existing, body, contentType);
  if (existing === undefined && (count[0]?.n ?? 0) >= MAX_PHOTOS)
    throw conflict(`You have ${MAX_PHOTOS} photos backed up. Delete some old ones first.`);
  const size = /^\d+$/.test(upload.contentLength ?? "") ? Number(upload.contentLength) : Number.NaN;
  if (Number.isNaN(size)) throw new HttpError(411, "Send the photo with its Content-Length");
  if (size > MAX_PHOTO_BYTES) throw new HttpError(413, "That photo is too large");
  if (size === 0 || upload.stream === null) throw new HttpError(400, "Send the photo");
  const key = objectKey(authed.userId, id);
  const stored = await storeChecked(ctx.env.PHOTOS, key, contentType, upload.stream, size);
  if (!stored.ok) throw new HttpError(415, "Not the image type it claims");
  const now = ctx.clock.now();
  const values = { takenOn: body.date, pose: body.pose, contentType, size };
  const [saved, dropped] = await authed.write(
    ctx.db
      .insert(bodyPhotos)
      .values({ id, userId: authed.userId, objectKey: key, createdAt: now, updatedAt: now, ...values })
      .onConflictDoUpdate({
        target: bodyPhotos.id,
        set: { ...values, updatedAt: now },
        setWhere: eq(bodyPhotos.userId, authed.userId),
      })
      .returning(),
    repo.dropPhotoIfBackupOff(ctx.db, authed.userId, id),
  );
  if (dropped.length > 0) {
    await ctx.env.PHOTOS.delete(key);
    throw conflict(BACKUP_OFF);
  }
  const row = saved[0];
  if (row === undefined) throw conflict("Pick another id");
  return photoOut(row);
}

/** Not the caller's: 204 all the same. The object goes after the row. */
export async function deletePhoto(ctx: Ctx, authed: AuthedBatch, id: string) {
  const [rows] = await authed.write(
    ctx.db
      .delete(bodyPhotos)
      .where(and(eq(bodyPhotos.id, id), eq(bodyPhotos.userId, authed.userId)))
      .returning({ key: bodyPhotos.objectKey }),
  );
  const key = rows[0]?.key;
  if (key !== undefined) await ctx.env.PHOTOS.delete(key);
}

/**
 * Wiping the account's backed-up photos, in two halves so a caller can put the row delete in its own write batch
 * (turning `photo_backup` off does): the statement, then `purge` with its result once the batch commits. The rows
 * go first; objects whose rows are gone are unreachable, and an account purge sweeps the prefix.
 */
export const photoWipe = (ctx: Ctx, userId: string) => ({
  statement: repo.deleteAllPhotos(ctx.db, userId),
  purge: (rows: readonly { key: string }[]) =>
    deleteMany(
      ctx.env.PHOTOS,
      rows.map((r) => r.key),
    ),
});

/** `DELETE /body-photos`: the server copies go; the account's `photo_backup` setting is left as it is. */
export async function deleteAllPhotos(ctx: Ctx, authed: AuthedBatch) {
  const wipe = photoWipe(ctx, authed.userId);
  const [rows] = await authed.write(wipe.statement);
  await wipe.purge(rows);
}
