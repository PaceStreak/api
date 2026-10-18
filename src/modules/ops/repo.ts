/** Ops queries: crash groups, abuse views, retention sweeps (Python app/ops). */
import { and, count, countDistinct, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import type { ExplainCase } from "../../db/explain.ts";
import { authFailures, clientErrors, securityEvents, users } from "../../db/schema/index.ts";

/** Distinct crash groups kept at once; resolving (deleting) one frees its slot. */
export const MAX_GROUPS = 1000;

export interface ClientErrorRow {
  id: string;
  fingerprint: string;
  message: string;
  stack: string | null;
  path: string | null;
  release: string | null;
  userAgent: string | null;
  now: number;
}

/**
 * The fingerprint upsert with the MAX_GROUPS bound in one statement: a known fingerprint always counts; a new
 * one is inserted only while fewer than MAX_GROUPS groups exist. An empty RETURNING means "not received".
 * (`INSERT ... SELECT ... WHERE` needs its WHERE for SQLite to parse the trailing ON CONFLICT.)
 */
export const upsertClientError = (db: Db, e: ClientErrorRow) =>
  db.run(sql`INSERT INTO client_errors
      (id, created_at, updated_at, fingerprint, message, stack, path, release, user_agent, count, first_seen, last_seen)
    SELECT ${e.id}, ${e.now}, ${e.now}, ${e.fingerprint}, ${e.message}, ${e.stack}, ${e.path}, ${e.release},
           ${e.userAgent}, 1, ${e.now}, ${e.now}
     WHERE EXISTS (SELECT 1 FROM client_errors WHERE fingerprint = ${e.fingerprint})
        OR (SELECT count(*) FROM client_errors) < ${MAX_GROUPS}
    ON CONFLICT (fingerprint) DO UPDATE SET
      count = count + 1, last_seen = excluded.last_seen, updated_at = excluded.updated_at,
      path = excluded.path, user_agent = excluded.user_agent, release = excluded.release
    RETURNING id`);

export const listClientErrors = (db: Db) =>
  db.select().from(clientErrors).orderBy(desc(clientErrors.lastSeen)).limit(100);

export const deleteClientError = (db: Db, id: string) =>
  db.delete(clientErrors).where(eq(clientErrors.id, id)).returning({ id: clientErrors.id });

export const failuresByKind = (db: Db, since: number) =>
  db
    .select({ kind: authFailures.kind, n: count() })
    .from(authFailures)
    .where(gte(authFailures.createdAt, since))
    .groupBy(authFailures.kind);

export const failuresByIp = (db: Db, since: number) =>
  db
    .select({ ip: authFailures.ipAddress, n: count(), accounts: countDistinct(authFailures.emailHash) })
    .from(authFailures)
    .where(gte(authFailures.createdAt, since))
    .groupBy(authFailures.ipAddress)
    .orderBy(desc(count()))
    .limit(20);

export const failuresByAccount = (db: Db, since: number) =>
  db
    .select({ account: users.email, n: count(), ips: countDistinct(authFailures.ipAddress) })
    .from(authFailures)
    .innerJoin(users, eq(users.id, authFailures.userId))
    .where(gte(authFailures.createdAt, since))
    .groupBy(users.email)
    .orderBy(desc(count()))
    .limit(20);

export const signupsByIp = (db: Db, since: number) =>
  db
    .select({ ip: securityEvents.ipAddress, n: count() })
    .from(securityEvents)
    .where(and(eq(securityEvents.kind, "signup"), gte(securityEvents.createdAt, since)))
    .groupBy(securityEvents.ipAddress)
    .orderBy(desc(count()))
    .limit(20);

/** Python `ops.service.sweep`: 30-day retention for auth failures and crash groups (JOBS-12 runs it). */
export const sweepStmts = (db: Db, cutoff: number) =>
  [
    db.delete(authFailures).where(lt(authFailures.createdAt, cutoff)),
    db.delete(clientErrors).where(lt(clientErrors.lastSeen, cutoff)),
  ] as const;

const ADMIN_SCAN = "admin-only view over a 24 h window of a 30-day-retention table";

export const explain: ExplainCase[] = [
  {
    name: "ops.upsertClientError",
    build: () =>
      sql`SELECT 1 WHERE EXISTS (SELECT 1 FROM client_errors WHERE fingerprint = ${"f"}) OR (SELECT count(*) FROM client_errors) < 1000`,
    scanOk: "client_errors holds at most MAX_GROUPS (1000) rows",
  },
  {
    name: "ops.listClientErrors",
    build: (db) => listClientErrors(db),
    scanOk: "index-ordered scan, LIMIT 100",
  },
  { name: "ops.deleteClientError", build: (db) => deleteClientError(db, "x") },
  { name: "ops.failuresByKind", build: (db) => failuresByKind(db, 0), scanOk: ADMIN_SCAN },
  { name: "ops.failuresByIp", build: (db) => failuresByIp(db, 0), scanOk: ADMIN_SCAN },
  { name: "ops.failuresByAccount", build: (db) => failuresByAccount(db, 0), scanOk: ADMIN_SCAN },
  { name: "ops.signupsByIp", build: (db) => signupsByIp(db, 0) },
  { name: "ops.sweep.authFailures", build: (db) => sweepStmts(db, 0)[0] },
  { name: "ops.sweep.clientErrors", build: (db) => sweepStmts(db, 0)[1] },
];
