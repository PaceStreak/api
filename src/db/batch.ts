/**
 * The only paths to D1 for request code (DESIGN.md §4-§5):
 *
 * - `AuthedBatch.read(...q)`: one round trip; statement 0 is the session/user check, so a revoked session or a
 *   stale token is rejected before any handler row is returned. No cache, no denylist.
 * - `AuthedBatch.write(...q)`: one atomic round trip; statement 0 is a guard that aborts the whole batch if the
 *   session died since the read (a write racing a logout cannot land).
 * - `writeBatch(ctx, q)`: an atomic batch for unauthenticated writes (signup, jobs).
 * - `withFold` / `withFoldPatch`: the only way to write `*_fold` columns.
 * - `toWire(ms)`: the only timestamp format on the wire.
 */
import { and, eq, getTableName, is, type SQL, sql } from "drizzle-orm";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import { type SQLiteColumn, SQLiteSelectBase, type SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Ctx } from "../ctx.ts";
import { constraintMessage, HttpError, SLOW_DOWN } from "../lib/errors.ts";
import { foldOrNull, likePattern } from "../lib/fold.ts";
import type { Db } from "./client.ts";
import type { UserRole } from "./schema/auth.ts";
import { sessions, users } from "./schema/auth.ts";

export { toWire } from "../lib/time.ts";

export type Stmt = BatchItem<"sqlite">;

/** Who the access token says is calling. Verified by the JWT layer; confirmed against D1 by AuthedBatch. */
export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
  readonly tokenVersion: number;
}

/** The auth row returned as element 0 of every `read`. */
export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly isVerified: boolean;
  readonly tokenVersion: number;
}

export const SESSION_LOGGED_OUT = "Session has been logged out";
export const USER_INACTIVE = "User is inactive or missing";
export const TOKEN_REVOKED = "Token has been revoked";

/**
 * The parts of a drizzle query this module needs to batch it. drizzle-orm 0.45's own `db.batch` crashes on raw
 * `db.run(sql\`...\`)` statements with parameters (it calls `stmt.bind` on a query that has no prepared `stmt`), and
 * the guards below are raw statements, so batches are assembled here. Pinned drizzle version + tests in
 * test/db/batch.test.ts keep this honest.
 */
interface DrizzlePrepared {
  getQuery(): { sql: string; params: unknown[] };
  mapResult(result: unknown, isFromBatch?: boolean): unknown;
  stmt?: D1PreparedStatement;
}

/** One atomic D1 batch of drizzle queries (builders or `db.run(sql)`), results mapped like `db.batch`. */
export async function runBatch<T extends readonly Stmt[]>(db: Db, stmts: T): Promise<BatchResponse<T>> {
  if (stmts.length === 0) return [] as unknown as BatchResponse<T>;
  const prepared = stmts.map((q) => (q as unknown as { _prepare(): DrizzlePrepared })._prepare());
  const bound = prepared.map((p) => {
    const { sql: text, params } = p.getQuery();
    return (p.stmt ?? db.$client.prepare(text)).bind(...params);
  });
  const results = await db.$client.batch(bound);
  return results.map((r, i) => prepared[i]?.mapResult(r, true)) as unknown as BatchResponse<T>;
}

/** A prepared drizzle select: its selected fields, in SELECT-list order. */
interface PreparedSelect extends DrizzlePrepared {
  fields?: readonly unknown[];
}

/**
 * Several drizzle selects as ONE D1 statement. The Workers Free plan allows 50 D1 queries per invocation and counts
 * every statement of a batch (src/lib/plan.ts), so a request that reads fifteen small tables spends fifteen of them;
 * fused, it spends one. Each select becomes a CTE whose columns are renamed positionally, and the outer row carries
 * each one's rows as a JSON array of arrays, which the select's own mapper then decodes exactly as it would a batch
 * result (values come back in SELECT-list order, so booleans, JSON and timestamp columns map the same).
 *
 * The result of the fused statement is the list of the parts' results, in order. Limits: each part's JSON must stay
 * under D1's 2 MB value size, so fuse bounded reads only (one user's settings, chains, badges), never an unbounded
 * history; parts use drizzle's anonymous `?` parameters (D1's 100-parameter cap applies to the sum); no BLOB columns.
 */
export function fuse(stmts: readonly Stmt[]): Stmt {
  const fused = {
    _prepare(): DrizzlePrepared {
      const prepared = stmts.map((q) => (q as unknown as { _prepare(): PreparedSelect })._prepare());
      const parts = prepared.map((p, i) => {
        const { sql: text, params } = p.getQuery();
        const n = p.fields?.length ?? 0;
        if (n === 0) throw new Error(`fuse: part ${i} is not a select with fields`);
        if (/\?\d/.test(text)) throw new Error(`fuse: part ${i} uses numbered parameters`);
        const cols = Array.from({ length: n }, (_, c) => `c${c}`).join(", ");
        return { text, params, cols };
      });
      const ctes = parts.map((p, i) => `t${i}(${p.cols}) AS (${p.text})`).join(", ");
      const outs = parts
        .map((p, i) => `(SELECT coalesce(json_group_array(json_array(${p.cols})), '[]') FROM t${i}) AS r${i}`)
        .join(", ");
      const text = `WITH ${ctes} SELECT ${outs}`;
      const params = parts.flatMap((p) => p.params);
      return {
        getQuery: () => ({ sql: text, params }),
        mapResult(result: unknown) {
          const row = (result as { results: Record<string, string>[] }).results[0] ?? {};
          return prepared.map((p, i) =>
            p.mapResult({ results: JSON.parse(row[`r${i}`] ?? "[]") as unknown[][] }, true),
          );
        },
      };
    },
  };
  return fused as unknown as Stmt;
}

/**
 * A read list packed for the statement cap: every drizzle select whose index `separate` does not name is fused into
 * ONE statement (`fuse`), placed first; raw statements and the named (unbounded) reads stay statements of their own.
 * `unpack` turns the packed results back into one result per original read, in the original order.
 */
export function packReads(
  stmts: readonly Stmt[],
  separate: (i: number) => boolean = () => false,
): { stmts: Stmt[]; unpack(results: readonly unknown[]): unknown[] } {
  const fusedAt: number[] = [];
  const aloneAt: number[] = [];
  stmts.forEach((q, i) => {
    (is(q, SQLiteSelectBase) && !separate(i) ? fusedAt : aloneAt).push(i);
  });
  if (fusedAt.length < 2) return { stmts: [...stmts], unpack: (r) => [...r] };
  const pick = (at: number[]) => at.map((i) => stmts[i] as Stmt);
  return {
    stmts: [fuse(pick(fusedAt)), ...pick(aloneAt)],
    unpack(results) {
      const out: unknown[] = new Array(stmts.length);
      const fused = (results[0] ?? []) as unknown[];
      fusedAt.forEach((i, k) => {
        out[i] = fused[k];
      });
      aloneAt.forEach((i, k) => {
        out[i] = results[k + 1];
      });
      return out;
    },
  };
}

/** Runs `stmts` as one atomic D1 batch through the counting client: the commit path for unauthenticated writes. */
export function writeBatch<T extends readonly [Stmt, ...Stmt[]]>(
  db: Db | Ctx,
  stmts: T,
): Promise<BatchResponse<T>> {
  return runBatch("db" in db ? db.db : db, stmts);
}

function authStatement(db: Db, p: Principal) {
  return db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      isVerified: users.isVerified,
      tokenVersion: users.tokenVersion,
      // Aliased: D1 returns batch rows as objects keyed by column name, so two `id` columns would collapse.
      sessionId: sql<string | null>`${sessions.id}`.as("session_id"),
      revokedAt: sessions.revokedAt,
    })
    .from(users)
    .leftJoin(sessions, and(eq(sessions.id, p.sessionId), eq(sessions.userId, users.id)))
    .where(eq(users.id, p.userId));
}

type AuthRow = Awaited<ReturnType<typeof authStatement>>[number];

/** Same order and texts as the Python dependency (spec/auth.md "Auth dependency"). */
function checkAuth(rows: readonly AuthRow[], p: Principal): AuthUser {
  const row = rows[0];
  if (row === undefined) throw new HttpError(401, USER_INACTIVE);
  if (row.sessionId === null || row.revokedAt !== null) throw new HttpError(401, SESSION_LOGGED_OUT);
  if (!row.isActive) throw new HttpError(401, USER_INACTIVE);
  if (row.tokenVersion !== p.tokenVersion) throw new HttpError(401, TOKEN_REVOKED);
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    isActive: row.isActive,
    isVerified: row.isVerified,
    tokenVersion: row.tokenVersion,
  };
}

/**
 * `INSERT INTO batch_guards ... SELECT NULL ... WHERE NOT EXISTS (live session)`: inserts nothing while the session
 * is live; otherwise the NOT NULL violation aborts the batch, which D1 rolls back as a unit (gate G-3).
 */
export function sessionGuard(p: Principal) {
  return sql`INSERT INTO batch_guards (session, rate_limit)
    SELECT NULL, 0 WHERE NOT EXISTS (
      SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ${p.sessionId} AND s.user_id = ${p.userId} AND s.revoked_at IS NULL
         AND u.is_active = 1 AND u.token_version = ${p.tokenVersion})`;
}

/**
 * A guard that aborts the batch when `count > limit` for a rate-counter key that an earlier statement in the
 * same batch UPSERTed. Note the abort also rolls back that UPSERT; P1-GUARD decides whether rejected calls count.
 */
export function rateLimitGuard(key: string, limit: number) {
  return sql`INSERT INTO batch_guards (session, rate_limit)
    SELECT 0, NULL WHERE (SELECT count FROM rate_counters WHERE key = ${key}) > ${limit}`;
}

/**
 * Aborts the whole batch unless `cond` holds when this statement runs. D1 runs a batch serially and atomically, so
 * a guard placed before the writes it protects makes check-then-act race free (single-use codes, challenges,
 * TOTP replay). Catch the abort with `isCondAbort(err)`.
 */
export function abortUnless(db: Db, cond: SQL) {
  return db.run(
    sql`INSERT INTO batch_guards (session, rate_limit, cond) SELECT 0, 0, NULL WHERE NOT (${cond})`,
  );
}

export function isCondAbort(err: unknown): boolean {
  return constraintMessage(err)?.includes("batch_guards.cond") ?? false;
}

/** Maps a guard abort to its HTTP error; any other error passes through unchanged. */
export function guardError(err: unknown): unknown {
  const m = constraintMessage(err);
  if (m?.includes("batch_guards.session")) return new HttpError(401, SESSION_LOGGED_OUT);
  if (m?.includes("batch_guards.rate_limit")) return new HttpError(429, SLOW_DOWN);
  return err;
}

export class AuthedBatch {
  /**
   * `require` runs on the auth row of every `read` (role gates: `moderator()`, `admin()`). Handlers behind a role
   * gate must read before they write, which every admin route does anyway.
   */
  constructor(
    private readonly db: Db,
    readonly principal: Principal,
    private readonly require?: (user: AuthUser) => void,
  ) {}

  get userId(): string {
    return this.principal.userId;
  }

  /** One round trip: `[authUser, ...results]`. Throws 401 before exposing any row if the caller is not live. */
  async read<T extends readonly Stmt[]>(...stmts: T): Promise<[AuthUser, ...BatchResponse<T>]> {
    const all = [authStatement(this.db, this.principal), ...stmts] as const;
    const [authRows, ...rest] = (await runBatch(this.db, all)) as unknown as [AuthRow[], ...BatchResponse<T>];
    const user = checkAuth(authRows, this.principal);
    this.require?.(user);
    return [user, ...rest];
  }

  /** The session guard `write` prepends, for callers that must assemble their own batch. */
  guardStatement() {
    return this.db.run(sessionGuard(this.principal));
  }

  /** One atomic round trip, aborted with 401 if the session is no longer live. Results exclude the guard. */
  async write<T extends readonly [Stmt, ...Stmt[]]>(...stmts: T): Promise<BatchResponse<T>> {
    const all = [this.db.run(sessionGuard(this.principal)), ...stmts] as const;
    try {
      const [, ...rest] = (await runBatch(this.db, all)) as unknown as [unknown, ...BatchResponse<T>];
      return rest as unknown as BatchResponse<T>;
    } catch (err) {
      throw guardError(err);
    }
  }
}

// ---- fold columns -------------------------------------------------------------------------------------------

/** source column -> fold column, per table. A schema test asserts this covers every `*_fold` column. */
export const FOLD_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  profiles: { handle: "handleFold", displayName: "displayNameFold" },
  custom_exercises: { name: "nameFold" },
  routines: { name: "nameFold" },
  groups: { name: "nameFold" },
  habits: { name: "nameFold" },
  foods: { name: "nameFold" },
  recipes: { name: "nameFold" },
  journal_days: { note: "noteFold" },
};

type FoldKey<K> = K extends `${string}Fold` ? K : never;
type WithoutFold<T> = { [K in keyof T as K extends `${string}Fold` ? never : K]: T[K] };

function addFolds(table: SQLiteTable, values: Record<string, unknown>): Record<string, unknown> {
  const map = FOLD_COLUMNS[getTableName(table)];
  if (map === undefined) return values;
  const out: Record<string, unknown> = { ...values };
  for (const [src, dst] of Object.entries(map)) {
    if (src in values) {
      const v = values[src];
      out[dst] = typeof v === "string" ? foldOrNull(v) : null;
    }
  }
  return out;
}

/** Insert values with every fold column computed from its source. Callers cannot pass fold columns themselves. */
export function withFold<T extends SQLiteTable>(
  table: T,
  values: WithoutFold<T["$inferInsert"]>,
): T["$inferInsert"] {
  return addFolds(table, values as Record<string, unknown>) as T["$inferInsert"];
}

/** Update values: fold columns are recomputed for whichever sources the patch contains. */
export function withFoldPatch<T extends SQLiteTable>(
  table: T,
  patch: WithoutFold<Partial<T["$inferInsert"]>>,
): Partial<T["$inferInsert"]> & Partial<Pick<T["$inferInsert"], FoldKey<keyof T["$inferInsert"]>>> {
  return addFolds(table, patch as Record<string, unknown>) as Partial<T["$inferInsert"]>;
}

/** `fold_col LIKE <escaped folded term> ESCAPE '\\'`: case/accent-insensitive search; `prefix` can use the index. */
export function foldLike(col: SQLiteColumn, term: string, mode: "prefix" | "contains") {
  return sql`${col} LIKE ${likePattern(term, mode)} ESCAPE '\\'`;
}
