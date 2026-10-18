/**
 * Operator commands (Python `python -m app.cli`), printed as SQL for D1:
 *
 *   PEPPER=<base64> pnpm admin create-admin admin@pacestreak.com > /tmp/op.sql
 *   PEPPER=<base64> pnpm admin set-password admin@pacestreak.com > /tmp/op.sql
 *   pnpm admin set-role someone@example.com moderator > /tmp/op.sql
 *   pnpm wrangler d1 execute pacestreak --remote --file /tmp/op.sql && rm /tmp/op.sql
 *
 * The password comes from PACESTREAK_PASSWORD or a hidden prompt (asked twice), never from argv. PEPPER must be
 * the Worker's PEPPER secret, or the new hash will not verify. Recompute-all is a queue message now (GAME unit).
 */
import { createInterface } from "node:readline";
import { b64ToBytes } from "../src/lib/b64url.ts";
import { createAdminSql, OperatorError, setPasswordSql, setRoleSql } from "../src/modules/admin/operator.ts";

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    out._writeToOutput = (s: string) => {
      if (s.includes(prompt)) process.stderr.write(prompt);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

async function password(): Promise<string> {
  const fromEnv = process.env.PACESTREAK_PASSWORD;
  if (fromEnv) return fromEnv;
  const first = await ask("New password: ");
  if ((await ask("Repeat it: ")) !== first) throw new OperatorError("Passwords do not match.");
  return first;
}

function pepper(): Uint8Array {
  const raw = process.env.PEPPER;
  if (!raw) throw new OperatorError("Set PEPPER to the Worker's PEPPER secret (base64).");
  return b64ToBytes(raw.trim());
}

async function main(argv: string[]): Promise<string> {
  const [cmd, email, role] = argv;
  const now = Date.now();
  if (cmd === "create-admin" && email) return createAdminSql(email, await password(), pepper(), now);
  if (cmd === "set-password" && email) return setPasswordSql(email, await password(), pepper(), now);
  if (cmd === "set-role" && email && role) return setRoleSql(email, role, now);
  throw new OperatorError("usage: admin create-admin EMAIL | set-password EMAIL | set-role EMAIL ROLE");
}

main(process.argv.slice(2)).then(
  (sql) => process.stdout.write(`${sql}\n`),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
