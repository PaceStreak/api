/**
 * Health, crash reports and the operator's abuse view (spec/core.md §1.1-§1.3, DESIGN.md §14).
 */
import { sql } from "drizzle-orm";
import type { Ctx } from "../../ctx.ts";
import type { AuthedBatch } from "../../db/batch.ts";
import { runBatch, toWire, writeBatch } from "../../db/batch.ts";
import { healthWorker, readHeartbeatStmt, workerState } from "../../jobs/heartbeat.ts";
import { sha256Hex } from "../../lib/crypto/hmac.ts";
import { notFound } from "../../lib/errors.ts";
import { uuid7 } from "../../lib/uuid7.ts";
import * as repo from "./repo.ts";

export { MAX_GROUPS } from "./repo.ts";

// ---- health -------------------------------------------------------------------------------------------------

/** `/health/ready`: `SELECT 1` on D1. There is no cache tier any more, so only the database is reported. */
export async function ready(ctx: Ctx): Promise<{ status: 200 | 503; body: Record<string, unknown> }> {
  let database = "ok";
  try {
    await runBatch(ctx.db, [ctx.db.run(sql`SELECT 1`)]);
  } catch (err) {
    ctx.log.error("readiness check failed", err);
    database = "down";
  }
  const ok = database === "ok";
  return { status: ok ? 200 : 503, body: { status: ok ? "ready" : "unavailable", checks: { database } } };
}

export async function worker(ctx: Ctx) {
  try {
    const [rows] = await runBatch(ctx.db, [readHeartbeatStmt(ctx.db)]);
    return healthWorker(rows?.[0], ctx.clock.now());
  } catch (err) {
    ctx.log.error("worker health read failed", err);
    return healthWorker("error", ctx.clock.now());
  }
}

/** The admin panel's view of the scheduler (Python `worker_state()`), for /v1/admin/metrics. */
export const workerStateStmt = readHeartbeatStmt;
export { workerState };

// ---- client errors ------------------------------------------------------------------------------------------

// Python str.splitlines() boundaries (the file separators 0x1c-0x1e included, hence the constructor).
const LINE_BREAK = new RegExp(
  `\\r\\n|[${["\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"].join("")}]`,
);

/** Same bug, same row: the message plus the stack's second line (its first frame), Python `fingerprint`. */
export function fingerprint(message: string, stack: string | null): Promise<string> {
  const first = (stack ?? "").trim().split(LINE_BREAK)[1] ?? "";
  return sha256Hex(`${message}|${first}`);
}

/**
 * Python `urlsplit(url).path`: drop `scheme://netloc` when present, then cut at the first `?` or `#`. Kept as
 * string surgery on purpose: WHATWG URL would re-encode and normalise what Python leaves verbatim.
 */
export function urlPath(url: string): string {
  let rest = url;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    if (rest.startsWith("//")) rest = rest.slice(2).replace(/^[^/?#]*/, "");
  } else if (rest.startsWith("//")) {
    rest = rest.slice(2).replace(/^[^/?#]*/, "");
  }
  const cut = rest.search(/[?#]/);
  return cut === -1 ? rest : rest.slice(0, cut);
}

export interface ClientErrorIn {
  message: string;
  stack?: string | null | undefined;
  url?: string | null | undefined;
  release?: string | null | undefined;
}

/**
 * No authentication and no user id: a crash on the sign-in screen must be reportable, and a crash report is not a
 * reason to know who someone is. The URL is cut to its path, because query strings carry reset tokens.
 */
export async function reportClientError(ctx: Ctx, body: ClientErrorIn, userAgent: string | undefined) {
  const now = ctx.clock.now();
  const message = body.message.slice(0, 500);
  const stack = body.stack ? body.stack.slice(0, 4000) : null;
  const [rows] = await writeBatch(ctx, [
    repo.upsertClientError(ctx.db, {
      id: uuid7(now),
      fingerprint: await fingerprint(message, stack),
      message,
      stack,
      path: body.url ? urlPath(body.url).slice(0, 300) : null,
      release: body.release ?? null,
      userAgent: (userAgent ?? "").slice(0, 400) || null,
      now,
    }),
  ]);
  return { received: (rows.results ?? []).length > 0 };
}

export async function listClientErrors(ctx: Ctx, authed: AuthedBatch) {
  const [, rows] = await authed.read(repo.listClientErrors(ctx.db));
  return rows.map((e) => ({
    id: e.id,
    message: e.message,
    stack: e.stack,
    path: e.path,
    release: e.release,
    user_agent: e.userAgent,
    count: e.count,
    first_seen: toWire(e.firstSeen),
    last_seen: toWire(e.lastSeen),
  }));
}

/**
 * Mark fixed by deleting; if it happens again it comes back counting from one. The role is checked by the read
 * first (role gates apply to reads), then the delete runs in the guarded write.
 */
export async function deleteClientError(ctx: Ctx, authed: AuthedBatch, id: string): Promise<void> {
  await authed.read();
  const [gone] = await authed.write(repo.deleteClientError(ctx.db, id));
  if (gone.length === 0) throw notFound();
}

const DAY_MS = 86_400_000;

export async function abuse(ctx: Ctx, authed: AuthedBatch) {
  const since = ctx.clock.now() - DAY_MS;
  const [, kinds, byIp, byAccount, signups] = await authed.read(
    repo.failuresByKind(ctx.db, since),
    repo.failuresByIp(ctx.db, since),
    repo.failuresByAccount(ctx.db, since),
    repo.signupsByIp(ctx.db, since),
  );
  return {
    since: toWire(since),
    failures: Object.fromEntries(kinds.map((k) => [k.kind, k.n])),
    by_ip: byIp.map((r) => ({ ip: r.ip, failures: r.n, accounts: r.accounts })),
    by_account: byAccount.map((r) => ({ account: r.account, failures: r.n, ips: r.ips })),
    signups_by_ip: signups.map((r) => ({ ip: r.ip, signups: r.n })),
  };
}

/** Retention sweep statements for the daily job (JOBS-12). */
export const sweepStmts = (ctx: Ctx) => repo.sweepStmts(ctx.db, ctx.clock.now() - 30 * DAY_MS);

// ---- dead letters -------------------------------------------------------------------------------------------

export interface DeadLetter {
  /** The queue message id: one crash group per dead message, so a redelivered DLQ message only bumps its count. */
  msgId: string;
  /** Job type and ids only; never a message body, which can hold personal data. */
  summary: string;
  queue: string;
}

/**
 * Records dead-lettered queue messages as crash groups in `client_errors`, which the hourly `error_alerts` job
 * emails to admins and Admin > Ops lists. One write batch for the whole queue batch.
 */
export async function recordDeadLetters(ctx: Ctx, letters: readonly DeadLetter[]): Promise<void> {
  const now = ctx.clock.now();
  // Hash first: drizzle statements are thenables, so awaiting them inside Promise.all would run each one alone.
  const prints = await Promise.all(letters.map((l) => sha256Hex(`dlq|${l.queue}|${l.msgId}`)));
  const stmts = letters.map((l, i) =>
    repo.upsertClientError(ctx.db, {
      id: uuid7(now),
      fingerprint: prints[i] ?? "",
      message: `Dead-lettered job: ${l.summary}`.slice(0, 500),
      stack: null,
      path: `queue:${l.queue}`,
      release: null,
      userAgent: null,
      now,
    }),
  );
  if (stmts.length > 0) await runBatch(ctx.db, stmts);
}
