/**
 * Merge one account into another (Python app/admin/merge.py): everything the source owns moves to the
 * destination, then the source is deleted. The tables come from the generated FK-to-users list
 * (src/db/fk-users.gen.ts), so a table added later is merged too instead of being cascaded away.
 *
 * - Sign-in material (sessions and, through them, refresh tokens; one-time codes, passkeys, recovery codes,
 *   WebAuthn challenges) is not moved: the source's credentials must not start opening the destination.
 * - A row that would point an account at itself (following, blocking, pairing with yourself) is dropped.
 * - When a moved row collides with one the destination already has, the destination's row wins.
 *
 * Postgres did this with a savepoint per column and a row-by-row retry. D1 has no savepoints, so each column is
 * `UPDATE OR IGNORE` (moves every row that does not collide; OR IGNORE also skips CHECK failures) followed by
 * `DELETE ... WHERE col = source` (the rows left are exactly the colliding copies). All statements go in ONE
 * atomic batch, with the moved counts read from each UPDATE's `changes`.
 */
import { type SQL, sql } from "drizzle-orm";
import type { Stmt } from "../../db/batch.ts";
import type { Db } from "../../db/client.ts";
import { FK_USERS } from "../../db/fk-users.gen.ts";

export const NOT_MOVED: ReadonlySet<string> = new Set([
  "sessions",
  "refresh_tokens",
  "one_time_tokens",
  "passkeys",
  "recovery_codes",
  "webauthn_challenges",
]);

// Identifiers come from the generated schema list, never from a request; quoted anyway.
const q = (name: string) => sql.raw(`"${name.replace(/"/g, '""')}"`);

export interface MergePlan {
  /** Statements in batch order. */
  stmts: Stmt[];
  /** For each statement index that moves rows, the table it counts toward. */
  counts: Map<number, string>;
}

export function mergePlan(db: Db, source: string, dest: string, keepSourceProfile: boolean): MergePlan {
  const byTable = new Map<string, string[]>();
  for (const fk of FK_USERS) {
    if (NOT_MOVED.has(fk.table)) continue;
    const cols = byTable.get(fk.table) ?? [];
    cols.push(fk.column);
    byTable.set(fk.table, cols);
  }
  const statements: SQL[] = [];
  const counts = new Map<number, string>();
  if (keepSourceProfile) {
    // The destination keeps its login; the person-facing profile and its projection come from the source.
    for (const table of ["profiles", "user_stats"]) {
      if (byTable.has(table)) statements.push(sql`DELETE FROM ${q(table)} WHERE user_id = ${dest}`);
    }
  }
  for (const [table, columns] of byTable) {
    const t = q(table);
    for (const a of columns) {
      for (const b of columns) {
        if (a !== b) statements.push(sql`DELETE FROM ${t} WHERE ${q(a)} = ${source} AND ${q(b)} = ${dest}`);
      }
    }
    for (const column of columns) {
      const c = q(column);
      counts.set(statements.length, table);
      statements.push(sql`UPDATE OR IGNORE ${t} SET ${c} = ${dest} WHERE ${c} = ${source}`);
      statements.push(sql`DELETE FROM ${t} WHERE ${c} = ${source}`);
    }
  }
  statements.push(sql`DELETE FROM users WHERE id = ${source}`);
  return { stmts: statements.map((s) => db.run(s)), counts };
}

/** `{table: moved}` for tables that moved rows, sorted by table name (Python's return value). */
export function movedCounts(
  plan: MergePlan,
  results: readonly unknown[],
  offset: number,
): Record<string, number> {
  const moved = new Map<string, number>();
  for (const [i, table] of plan.counts) {
    const r = results[i + offset] as D1Result | undefined;
    const n = r?.meta.changes ?? 0;
    moved.set(table, (moved.get(table) ?? 0) + n);
  }
  return Object.fromEntries([...moved].filter(([, n]) => n > 0).sort(([a], [b]) => (a < b ? -1 : 1)));
}
