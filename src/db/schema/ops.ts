import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.ts";
import { base, enumCheck, json, ms } from "./columns.ts";

export const securityEvents = sqliteTable(
  "security_events",
  {
    ...base(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    ipAddress: text(),
    userAgent: text(),
    meta: json<Record<string, unknown>>(),
  },
  (t) => [
    index("ix_security_events_user").on(t.userId, t.createdAt),
    index("ix_security_events_kind_created").on(t.kind, t.createdAt),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    ...base(),
    actorId: text().references(() => users.id, { onDelete: "set null" }),
    action: text().notNull(),
    targetType: text(),
    targetId: text(),
    detail: json<Record<string, unknown>>(),
  },
  (t) => [index("ix_audit_log_created").on(t.createdAt), index("ix_audit_log_actor_id").on(t.actorId)],
);

export type HeartbeatJobs = Record<string, { result: number } | { error: string }>;

export const workerHeartbeats = sqliteTable(
  "worker_heartbeats",
  {
    ...base(),
    name: text().notNull(),
    lastTickAt: ms().notNull(),
    durationMs: integer().notNull(),
    jobs: json<HeartbeatJobs>().notNull().default({}),
    failingTicks: integer().notNull().default(0),
  },
  (t) => [uniqueIndex("uq_worker_heartbeats_name").on(t.name)],
);

export const clientErrors = sqliteTable(
  "client_errors",
  {
    ...base(),
    fingerprint: text().notNull(),
    message: text().notNull(),
    stack: text(),
    path: text(),
    release: text(),
    userAgent: text(),
    count: integer().notNull().default(1),
    firstSeen: ms().notNull(),
    lastSeen: ms().notNull(),
    alertedAt: ms(),
  },
  (t) => [
    uniqueIndex("uq_client_errors_fingerprint").on(t.fingerprint),
    index("ix_client_errors_last_seen").on(t.lastSeen),
    index("ix_client_errors_unalerted").on(t.firstSeen).where(sql`${t.alertedAt} IS NULL`),
  ],
);

export const authFailures = sqliteTable(
  "auth_failures",
  {
    ...base(),
    kind: text().notNull(),
    ipAddress: text(),
    emailHash: text(),
    userId: text().references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("ix_auth_failures_created").on(t.createdAt),
    index("ix_auth_failures_ip_address").on(t.ipAddress),
    index("ix_auth_failures_email_hash").on(t.emailHash),
    index("ix_auth_failures_user_id").on(t.userId),
  ],
);

/**
 * Per-user fixed-window counters (DESIGN.md §7). Statement 0 of a guarded write batch UPSERTs the row; the
 * guarded writes are predicated on the count, so a rejected call writes only the counter.
 */
export const rateCounters = sqliteTable(
  "rate_counters",
  {
    key: text().primaryKey(),
    windowStart: ms().notNull(),
    count: integer().notNull(),
  },
  (t) => [index("ix_rate_counters_window_start").on(t.windowStart)],
);

/** Cron overlap guard: `UPDATE ... SET until=? WHERE name=? AND until<?` (self-seeding UPSERT). */
export const jobLeases = sqliteTable("job_leases", {
  name: text().primaryKey(),
  until: ms().notNull(),
});

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export const IMPORT_KINDS = ["activity", "lifting", "account", "habits"] as const;
export const EXPORT_KINDS = ["json", "csv", "ics", "backup"] as const;

/** Large imports staged in R2 and processed in queue slices (DESIGN.md §13). */
export const importJobs = sqliteTable(
  "import_jobs",
  {
    ...base(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text({ enum: IMPORT_KINDS }).notNull(),
    status: text({ enum: JOB_STATUSES }).notNull().default("queued"),
    objectKey: text().notNull(),
    size: integer().notNull(),
    /** Byte offset the next slice resumes from. */
    offset: integer().notNull().default(0),
    /** Resumable parser state; shape owned by the parser. */
    state: json<Record<string, unknown>>(),
    counts: json<Record<string, number>>().notNull().default({}),
    error: text(),
    finishedAt: ms(),
  },
  (t) => [
    index("ix_import_jobs_user_id").on(t.userId),
    index("ix_import_jobs_open").on(t.status, t.createdAt).where(sql`${t.status} IN ('queued', 'running')`),
    enumCheck("ck_import_jobs_kind", t.kind, IMPORT_KINDS),
    enumCheck("ck_import_jobs_status", t.status, JOB_STATUSES),
  ],
);

export const exportJobs = sqliteTable(
  "export_jobs",
  {
    ...base(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text({ enum: EXPORT_KINDS }).notNull(),
    status: text({ enum: JOB_STATUSES }).notNull().default("queued"),
    /** Part keys written so far, in order. */
    parts: json<string[]>().notNull().default([]),
    objectKey: text(),
    error: text(),
    finishedAt: ms(),
  },
  (t) => [
    index("ix_export_jobs_user_id").on(t.userId),
    index("ix_export_jobs_open").on(t.status, t.createdAt).where(sql`${t.status} IN ('queued', 'running')`),
    enumCheck("ck_export_jobs_kind", t.kind, EXPORT_KINDS),
    enumCheck("ck_export_jobs_status", t.status, JOB_STATUSES),
  ],
);

/**
 * Never holds a row. A guarded write batch starts with
 * `INSERT INTO batch_guards (session, rate_limit) SELECT NULL, 0 WHERE NOT EXISTS (<live session>)`: when the
 * session is gone the NOT NULL constraint fails, and D1 rolls back the whole batch atomically. The error message
 * names the column, so `AuthedBatch` maps it to the right 401/429 (src/db/batch.ts).
 */
export const batchGuards = sqliteTable("batch_guards", {
  session: integer().notNull(),
  rateLimit: integer().notNull(),
});
