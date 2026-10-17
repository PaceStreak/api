/**
 * EXPLAIN QUERY PLAN lint registry (DESIGN.md §4 "Indexes"). Every `repo.ts` exports
 * `export const explain: ExplainCase[]` with one entry per statement shape it runs; test/explain plans each one
 * against the migrated schema and fails on a full scan of a user-data table unless the case says why it is fine.
 */
import type { SQL } from "drizzle-orm";
import type { Db } from "./client.ts";

export interface ExplainCase {
  /** `module.statement`, e.g. `habits.listForUser`. */
  name: string;
  /** Builds the statement with representative parameters. Never executed, only planned. */
  build: (db: Db) => { toSQL(): { sql: string; params: unknown[] } } | SQL;
  /** Why a full scan is acceptable here (tiny table, admin-only, bounded by LIMIT on an index...). */
  scanOk?: string;
}
