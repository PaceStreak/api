/** Port of tests/test_ops.py: operator tooling and outgoing mail plumbing. */
import { describe, expect, it } from "vitest";
import { verifyPassword } from "../../src/lib/crypto/pbkdf2.ts";
import { buildMime } from "../../src/lib/mailer/cloudflare.ts";
import {
  checkPassword,
  createAdminSql,
  OperatorError,
  setPasswordSql,
  setRoleSql,
} from "../../src/modules/admin/operator.ts";

// parity-dropped: test_pem_from_environment_is_unescaped_and_cached: there are no PEM keys any more; JWT_KEYS,
// PEPPER and DATA_KEY are base64 secrets parsed once by the config gate (test/lib and src/env.ts).
// test_one_click_unsubscribe belongs to the notifications unit (NOTIF), which owns unsubscribe signing.

const header = (raw: string, name: string) =>
  new RegExp(`^${name}: (.*)$`, "im").exec(raw.split("\r\n\r\n")[0] ?? "")?.[1];

describe("test_ops", () => {
  it("outgoing_mail_carries_the_headers_providers_expect", () => {
    const raw = buildMime(
      {
        to: "someone@example.com",
        subject: "Hello",
        text: "Body",
        headers: { "List-Unsubscribe-Post": "x" },
      },
      { from: "PaceStreak <hello@pacestreak.com>" },
    );
    expect(header(raw, "From")).toMatch(/^PaceStreak </);
    expect(header(raw, "Message-ID")).toBeTruthy();
    expect(header(raw, "Date")).toBeTruthy();
    expect(header(raw, "Auto-Submitted")).toBe("auto-generated");
    expect(header(raw, "List-Unsubscribe-Post")).toBe("x");
  });

  it("cli_refuses_short_passwords", () => {
    expect(() => checkPassword("short")).toThrow(OperatorError);
    expect(() => checkPassword("short")).toThrow(/16/);
    expect(checkPassword("a".repeat(16))).toBe("a".repeat(16));
  });

  it("operator SQL hashes with the pepper, normalises the email and checks the role", async () => {
    const pepper = new Uint8Array(32).fill(7);
    const sql = await createAdminSql("  Boss@Example.com ", "a-long-enough-password", pepper, 1000);
    expect(sql).toContain("'boss@example.com'");
    expect(sql).toContain("'admin'");
    const hash = /'(pbkdf2-sha256\$[^']+)'/.exec(sql)?.[1] ?? "";
    expect(await verifyPassword(hash, "a-long-enough-password", pepper)).toBe(true);
    await expect(setPasswordSql("x@example.com", "short", pepper, 1)).rejects.toThrow(/16/);
    expect(await setPasswordSql("x@example.com", "another-long-password", pepper, 1)).toContain(
      "token_version = token_version + 1",
    );
    expect(setRoleSql("o'neil@example.com", "moderator", 5)).toContain("'o''neil@example.com'");
    expect(() => setRoleSql("x@example.com", "root", 5)).toThrow(/Role must be one of/);
  });
});
