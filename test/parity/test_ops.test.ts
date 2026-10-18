/** Port of tests/test_ops.py: operator tooling, outgoing mail plumbing and one-click unsubscribe. */
import { SELF } from "cloudflare:test";
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
import { listHeaders } from "../../src/modules/notifications/service.ts";
import { signup } from "../fixtures/auth.ts";
import { BASE } from "../fixtures/http.ts";
import { jobCtx } from "../jobs/helpers.ts";

// parity-dropped: test_pem_from_environment_is_unescaped_and_cached: there are no PEM keys any more; JWT_KEYS,
// PEPPER and DATA_KEY are base64 secrets parsed once by the config gate (test/lib and src/env.ts).

const header = (raw: string, name: string) =>
  new RegExp(`^${name}: (.*)$`, "im").exec(raw.split("\r\n\r\n")[0] ?? "")?.[1];

/** A mail client's RFC 8058 POST: a form body, no session, no CSRF header. */
const oneClick = (path: string) =>
  SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });

describe("test_ops", () => {
  it("one_click_unsubscribe", async () => {
    const me = await signup();
    const headers = await listHeaders(jobCtx(), me.userId, "digest");
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const first = (headers["List-Unsubscribe"] ?? "").split(">")[0]?.replace(/^</, "") ?? "";
    const url = new URL(first);
    const path = `${url.pathname}${url.search}`;
    const ok = await oneClick(path);
    expect(ok.status, await ok.clone().text()).toBe(200);
    const forged = await oneClick(path.replace("s=", "s=0"));
    expect(forged.status).toBe(400);
  });

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
