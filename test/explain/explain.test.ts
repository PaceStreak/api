/**
 * EXPLAIN QUERY PLAN lint: plans every registered statement (src/db/explain-core.ts and each module's
 * `repo.ts` `explain` export) against the migrated schema. A full scan (`SCAN t`, with or without
 * `USING INDEX`) of a user-data table fails unless the case carries `scanOk: "<reason>"`.
 */
import { env } from "cloudflare:test";
import { eq, is, SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import type { ExplainCase } from "../../src/db/explain.ts";
import { explain as core } from "../../src/db/explain-core.ts";
import { users, workouts } from "../../src/db/schema/index.ts";
import { testDb } from "../fixtures/db.ts";

/** Tables that are tiny by construction: scanning them is cheaper than an index. */
const SMALL_TABLES = new Set(["sync_seq", "job_leases", "batch_guards", "worker_heartbeats"]);

const modules = import.meta.glob<{ explain?: ExplainCase[] }>("../../src/modules/*/repo.ts", { eager: true });
const jobRepos = import.meta.glob<{ explain?: ExplainCase[] }>("../../src/jobs/tasks/repo.ts", {
  eager: true,
});
const cases: ExplainCase[] = [
  ...core,
  ...[...Object.values(modules), ...Object.values(jobRepos)].flatMap((m) => m.explain ?? []),
];

const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });

async function plan(c: ExplainCase): Promise<string[]> {
  const { db } = testDb();
  const built = c.build(db);
  const q = is(built, SQL) ? dialect.sqlToQuery(built) : built.toSQL();
  const res = await env.DB.prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
    .bind(...q.params)
    .all<{ detail: string }>();
  return res.results.map((r) => r.detail);
}

/**
 * Full scans of tables outside SMALL_TABLES. A `VIRTUAL TABLE` scan is a `json_each` over a bound parameter (a
 * list of keys, ids or record families), not user data.
 */
function fullScans(details: readonly string[]): string[] {
  return details.filter((d) => {
    const m = /^SCAN (\w+)/.exec(d);
    return (
      m !== null &&
      m[1] !== undefined &&
      !SMALL_TABLES.has(m[1]) &&
      !/^SCAN CONSTANT ROW/.test(d) &&
      !/^SCAN \w+ VIRTUAL TABLE/.test(d)
    );
  });
}

describe("EXPLAIN QUERY PLAN lint", () => {
  it("registry is not empty and names are unique", () => {
    expect(cases.length).toBeGreaterThan(0);
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const c of cases) {
    it(`${c.name} uses an index`, async () => {
      const scans = fullScans(await plan(c));
      if (c.scanOk === undefined) expect(scans, `${c.name} plans a full scan`).toEqual([]);
    });
  }

  it("self-test: an unindexed predicate is detected", async () => {
    const bad: ExplainCase = {
      name: "selftest.unindexed",
      build: (db) => db.select({ id: workouts.id }).from(workouts).where(eq(workouts.title, "x")),
    };
    expect(fullScans(await plan(bad))).toEqual(["SCAN workouts"]);
    const good: ExplainCase = {
      name: "selftest.indexed",
      build: (db) => db.select({ id: users.id }).from(users).where(eq(users.email, "a@b.c")),
    };
    expect(fullScans(await plan(good))).toEqual([]);
  });
});
