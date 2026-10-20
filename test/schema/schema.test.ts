import { env } from "cloudflare:test";
import { getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { FK_USERS } from "../../src/db/fk-users.gen.ts";
import * as schema from "../../src/db/schema/index.ts";

const tables: string[] = [];
for (const value of Object.values(schema) as unknown[]) {
  if (is(value, SQLiteTable)) tables.push(getTableName(value));
}
tables.sort();

async function all<T>(query: string, ...binds: unknown[]): Promise<T[]> {
  const res = await env.DB.prepare(query)
    .bind(...binds)
    .all<T>();
  return res.results;
}

/**
 * D1 refuses the pragma table-valued functions (`pragma_foreign_key_list(...)` in a join), but allows the PRAGMA
 * statements themselves, so run one per table in a single batch and tag each row with its table.
 */
async function pragmaPerTable<T>(pragma: string, names: readonly string[]): Promise<(T & { tbl: string })[]> {
  const res = await env.DB.batch(names.map((n) => env.DB.prepare(`PRAGMA ${pragma}("${n}")`)));
  return res.flatMap((r, i) => (r.results as T[]).map((row) => ({ ...row, tbl: names[i] ?? "" })));
}

type FkRow = { from: string; table: string; on_delete: string };
type IndexRow = { name: string };
type IndexInfoRow = { seqno: number; name: string };

/** (table, column, position) for every column of every index, including PK autoindexes. */
async function indexColumns(): Promise<{ tbl: string; col: string; seqno: number }[]> {
  const idx = await pragmaPerTable<IndexRow>("index_list", tables);
  const info = await env.DB.batch(idx.map((i) => env.DB.prepare(`PRAGMA index_info("${i.name}")`)));
  return info.flatMap((r, k) =>
    (r.results as IndexInfoRow[]).map((row) => ({ tbl: idx[k]?.tbl ?? "", col: row.name, seqno: row.seqno })),
  );
}

describe("schema", () => {
  it("migrations create exactly the tables the drizzle schema declares", async () => {
    const rows = await all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name",
    );
    expect(rows.map((r) => r.name)).toEqual(tables);
    // 60 tables ported from Postgres, the 10 new ones from DESIGN.md §4, and the two for email codes at sign-in.
    expect(tables).toHaveLength(72);
  });

  it("fk-users.gen.ts equals pragma_foreign_key_list", async () => {
    const rows = await pragmaPerTable<FkRow>("foreign_key_list", tables);
    const fromDb = rows
      .filter((r) => r.table === "users")
      .map((r) => ({ table: r.tbl, column: r.from, onDelete: r.on_delete.toLowerCase() }))
      .sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
    const sorted = [...FK_USERS].sort(
      (a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column),
    );
    expect(fromDb).toEqual(sorted.map((f) => ({ ...f })));
  });

  it("every foreign key column leads some index", async () => {
    const fks = await pragmaPerTable<FkRow>("foreign_key_list", tables);
    const leading = (await indexColumns()).filter((c) => c.seqno === 0);
    const have = new Set(leading.map((r) => `${r.tbl}.${r.col}`));
    const missing = fks.map((f) => `${f.tbl}.${f.from}`).filter((k) => !have.has(k));
    expect(missing).toEqual([]);
  });

  it("every fold column has its source column and an index", async () => {
    const cols = (await pragmaPerTable<{ name: string }>("table_info", tables)).map((c) => ({
      tbl: c.tbl,
      col: c.name,
    }));
    const names = new Set(cols.map((c) => `${c.tbl}.${c.col}`));
    const folds = cols.filter((c) => c.col.endsWith("_fold"));
    expect(folds.map((f) => `${f.tbl}.${f.col}`).sort()).toEqual(
      [
        "custom_exercises.name_fold",
        "foods.name_fold",
        "groups.name_fold",
        "habits.name_fold",
        "journal_days.note_fold",
        "profiles.display_name_fold",
        "profiles.handle_fold",
        "recipes.name_fold",
        "routines.name_fold",
      ].sort(),
    );
    for (const f of folds) expect(names.has(`${f.tbl}.${f.col.slice(0, -"_fold".length)}`)).toBe(true);

    const indexed = await indexColumns();
    const idx = new Set(indexed.map((r) => `${r.tbl}.${r.col}`));
    // journal notes are searched with `contains`, which no index can serve.
    const unindexed = folds.filter((f) => f.tbl !== "journal_days" && !idx.has(`${f.tbl}.${f.col}`));
    expect(unindexed).toEqual([]);
  });

  it("enum CHECK constraints reject unknown values", async () => {
    const now = Date.now();
    await expect(
      env.DB.prepare(
        "INSERT INTO users (id, created_at, updated_at, email, hashed_password, role) VALUES ('u1', ?1, ?1, 'a@b.c', 'x', 'root')",
      )
        .bind(now)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("deleting a user cascades and nulls exactly as declared", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, created_at, updated_at, email, hashed_password) VALUES ('ua', ?1, ?1, 'a@x.y', 'h'), ('ub', ?1, ?1, 'b@x.y', 'h')",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO notifications (id, created_at, updated_at, user_id, kind, category, title, actor_id) VALUES ('n1', ?1, ?1, 'ub', 'k', 'c', 't', 'ua')",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO follows (id, created_at, updated_at, follower_id, followee_id) VALUES ('f1', ?1, ?1, 'ua', 'ub')",
      ).bind(now),
    ]);
    await env.DB.prepare("DELETE FROM users WHERE id = 'ua'").run();
    const n = await env.DB.prepare("SELECT actor_id FROM notifications WHERE id = 'n1'").first<{
      actor_id: string | null;
    }>();
    expect(n?.actor_id).toBeNull();
    const f = await env.DB.prepare("SELECT count(*) AS c FROM follows").first<{ c: number }>();
    expect(f?.c).toBe(0);
  });
});
