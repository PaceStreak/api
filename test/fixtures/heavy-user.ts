/** Seeds the heavy user into the test D1 for budget and bench suites. */
import { env } from "cloudflare:test";
import { uuid7 } from "../../src/lib/uuid7.ts";
import {
  HEAVY_TABLE_ORDER,
  type HeavyData,
  type HeavyOptions,
  heavyUserData,
  insertStatements,
} from "./heavy-user-data.ts";

const STATEMENTS_PER_BATCH = 500;

export async function seedHeavyUser(opts: Partial<HeavyOptions> = {}): Promise<HeavyData> {
  const data = heavyUserData({ userId: opts.userId ?? uuid7(), ...opts });
  const stmts = HEAVY_TABLE_ORDER.flatMap((t) => insertStatements(t, data[t])).map((s) =>
    env.DB.prepare(s.sql).bind(...s.params),
  );
  for (let i = 0; i < stmts.length; i += STATEMENTS_PER_BATCH) {
    await env.DB.batch(stmts.slice(i, i + STATEMENTS_PER_BATCH));
  }
  await env.DB.prepare(
    "INSERT INTO sync_seq (id, value) VALUES (1, ?1) ON CONFLICT (id) DO UPDATE SET value = max(value, ?1)",
  )
    .bind(data.maxSeq)
    .run();
  return data;
}
