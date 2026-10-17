import { describe, expect, it } from "vitest";
import { buildMime } from "../../src/lib/mailer/cloudflare.ts";
import { passwordResetEmail, verificationEmail } from "../../src/lib/mailer/templates.ts";
import { leafParts } from "../fixtures/mime.ts";

const FROM = "PaceStreak <hello@pacestreak.com>";

describe("test_email", () => {
  it("build_message_is_multipart_alternative_with_text_and_html", () => {
    const raw = buildMime(
      {
        to: "someone@example.com",
        subject: "Subject",
        text: "plain body",
        html: "<html><body>html body</body></html>",
      },
      { from: FROM },
    );
    expect(raw).toMatch(/^Content-Type: multipart\/alternative/m);
    const parts = leafParts(raw);
    expect(new Set(parts.map((p) => p.type))).toEqual(new Set(["text/plain", "text/html"]));
    expect(parts[0]?.type).toBe("text/plain");
    expect(parts.find((p) => p.type === "text/plain")?.content.trim()).toBe("plain body");
    expect(parts.find((p) => p.type === "text/html")?.content).toContain("html body");
  });

  it("build_message_without_html_stays_single_part", () => {
    const raw = buildMime(
      { to: "someone@example.com", subject: "Subject", text: "plain body" },
      { from: FROM },
    );
    expect(raw).not.toContain("multipart/");
    const parts = leafParts(raw);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.content.trim()).toBe("plain body");
  });

  it("verification_email_keeps_plain_text_security_wording", () => {
    const sent = verificationEmail("new@example.com", "123456");
    expect(sent.to).toBe("new@example.com");
    expect(sent.text).toContain("123456");
    expect(sent.text).toContain("If you did not create this account, ignore this message.");
    expect(sent.html).toBeDefined();
    expect(sent.html).toContain("1 2 3 4 5 6");
    expect(sent.html).toContain("PaceStreak");
  });

  it("password_reset_email_html_has_matching_code", () => {
    const sent = passwordResetEmail("someone@example.com", "654321");
    expect(sent.text).toContain("654321");
    expect(sent.text).toContain("not changed");
    expect(sent.html).toContain("6 5 4 3 2 1");
    expect(sent.html).toContain("Reset your password");
  });

  it("html_template_escapes_untrusted_values", () => {
    const raw = buildMime(
      {
        to: "someone@example.com",
        subject: "Subject",
        text: "plain body",
        html: "<html><body>&lt;script&gt;</body></html>",
      },
      { from: FROM },
    );
    const html = leafParts(raw).find((p) => p.type === "text/html");
    expect(html?.content).not.toContain("<script>");
  });
});
