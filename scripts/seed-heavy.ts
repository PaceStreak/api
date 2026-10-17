/**
 * Writes the heavy user as SQL for a local D1:
 *   pnpm seed:heavy > /tmp/heavy.sql && pnpm wrangler d1 execute pacestreak --local --file /tmp/heavy.sql
 * Never run it against a remote database.
 */
import { HEAVY_TABLE_ORDER, heavyUserData, insertStatements } from "../test/fixtures/heavy-user-data.ts";

const userId = process.argv[2] ?? "01900000-0000-7000-8000-00000000beef";
const data = heavyUserData({ userId });

function literal(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

const out: string[] = [];
for (const t of HEAVY_TABLE_ORDER) {
  for (const s of insertStatements(t, data[t])) {
    let i = 0;
    out.push(`${s.sql.replace(/\?/g, () => literal(s.params[i++] ?? null))};`);
  }
}
out.push(
  `INSERT INTO sync_seq (id, value) VALUES (1, ${data.maxSeq}) ON CONFLICT (id) DO UPDATE SET value = max(value, ${data.maxSeq});`,
);
process.stdout.write(`${out.join("\n")}\n`);
