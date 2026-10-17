/**
 * Column conventions shared by every table (DESIGN.md §4):
 * - ids are UUIDv7 TEXT (client-supplied where the spec allows),
 * - timestamps are INTEGER epoch milliseconds, dates are TEXT `YYYY-MM-DD`,
 * - enums are TEXT with a CHECK constraint, booleans INTEGER 0/1, JSON is TEXT.
 * Column names are snake_case: the drizzle client and drizzle-kit both use `casing: "snake_case"`.
 */
import { type SQL, sql } from "drizzle-orm";
import { check, integer, type SQLiteColumn, text } from "drizzle-orm/sqlite-core";
import { uuid7 } from "../../lib/uuid7.ts";

/** Epoch milliseconds. Repos pass `ctx.clock.now()`; the default is only a fallback. */
export const ms = () => integer();

export const id = () =>
  text()
    .primaryKey()
    .$defaultFn(() => uuid7());

export const base = () => ({
  id: id(),
  createdAt: ms()
    .notNull()
    .$defaultFn(() => Date.now()),
  updatedAt: ms()
    .notNull()
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now()),
});

export const bool = () => integer({ mode: "boolean" });

/** A JSON TEXT column. Validate the value with zod before writing; never filter on it in SQL. */
export const json = <T>() => text({ mode: "json" }).$type<T>();

/** `CHECK (col IN (...))` for a TEXT enum column. */
export function enumCheck(name: string, col: SQLiteColumn, values: readonly string[]) {
  const list = sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", "));
  return check(name, sql`${col} IN (${list})`);
}

/** `CHECK (col IS NULL OR <cond>)` helper for nullable range checks. */
export function nullableCheck(name: string, col: SQLiteColumn, cond: SQL) {
  return check(name, sql`${col} IS NULL OR ${cond}`);
}

export function maxLength(name: string, col: SQLiteColumn, n: number) {
  return check(name, sql`length(${col}) <= ${sql.raw(String(n))}`);
}
