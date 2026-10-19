import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { b64ToBytes } from "../../src/lib/b64url.ts";
import { createLogger } from "../../src/lib/logger.ts";
import { buildMime, cloudflareTransport, encodeWord, parseFrom } from "../../src/lib/mailer/cloudflare.ts";
import { consoleLine, consoleTransport } from "../../src/lib/mailer/console.ts";
import { createMailer, MAX_ATTACHMENT_BYTES, wrapTransport } from "../../src/lib/mailer/index.ts";
import {
  emailChangedNotice,
  emailChangeEmail,
  escapeHtml,
  passwordChangedEmail,
  passwordResetEmail,
  sendVerificationEmail,
  verificationEmail,
} from "../../src/lib/mailer/templates.ts";
import { leafParts } from "../fixtures/mime.ts";

const FROM = "PaceStreak <hello@pacestreak.com>";
const log = createLogger({ test: "mailer" });
const SMTP_OFF = { host: "smtp.invalid", port: 587, user: null, password: null };

function headerOf(raw: string, name: string): string | undefined {
  const head = raw.split("\r\n\r\n")[0] ?? "";
  return new RegExp(`^${name}: (.*)$`, "im").exec(head)?.[1];
}

describe("console transport", () => {
  it("prints the exact Python line, attachments listed by size", async () => {
    const lines: string[] = [];
    const mailer = wrapTransport(
      consoleTransport((l) => lines.push(l)),
      log,
    );
    const ok = await mailer.send({
      to: "a@example.com",
      subject: "Hi",
      text: "Your code is: 123456",
      attachments: [{ filename: "backup.zip", data: new Uint8Array(42), mime: "application/zip" }],
    });
    expect(ok).toBe(true);
    expect(lines).toEqual([
      "[email:console] to=a@example.com subject=Hi attachments=backup.zip (42 bytes)\nYour code is: 123456",
    ]);
    expect(consoleLine({ to: "b@x.io", subject: "S", text: "t" })).toBe(
      "[email:console] to=b@x.io subject=S\nt",
    );
  });

  it("createMailer picks console from config and logs through console.log", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mailer = createMailer(
      { mailer: "console", mailFrom: FROM, emailEnabled: true, brevoApiKey: null, smtp: SMTP_OFF },
      env,
      log,
    );
    await sendVerificationEmail(mailer, "c@example.com", "111222");
    expect(
      spy.mock.calls.some(([l]) =>
        String(l).startsWith(
          "[email:console] to=c@example.com subject=Confirm your PaceStreak email address\nYour verification code is: 111222",
        ),
      ),
    ).toBe(true);
    spy.mockRestore();
  });
});

describe("EMAIL_ENABLED=0", () => {
  it("createMailer hands nothing to either transport", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const send = vi.fn(async () => {});
    for (const kind of ["console", "cloudflare", "brevo", "smtp"] as const) {
      const mailer = createMailer(
        { mailer: kind, mailFrom: FROM, emailEnabled: false, brevoApiKey: null, smtp: SMTP_OFF },
        { ...env, EMAIL: { send } } as unknown as Env,
        log,
      );
      await expect(sendVerificationEmail(mailer, "off@example.com", "333444")).resolves.toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
    expect(spy.mock.calls.some(([l]) => String(l).includes("off@example.com"))).toBe(false);
    spy.mockRestore();
  });
});

describe("Mailer never throws", () => {
  it("returns false and logs when the transport fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const mailer = wrapTransport(async () => {
      throw new Error("boom");
    }, log);
    await expect(mailer.send({ to: "a@example.com", subject: "S", text: "secret 123456" })).resolves.toBe(
      false,
    );
    const line = String(err.mock.calls[0]?.[0]);
    expect(line).toContain("failed to send email");
    expect(line).toContain('"subject":"S"');
    expect(line).not.toContain("123456");
    expect(line).not.toContain("a@example.com");
    err.mockRestore();
  });

  it("refuses attachments over the cap without calling the transport", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const transport = vi.fn(async () => {});
    const mailer = wrapTransport(transport, log);
    const big = {
      filename: "b.zip",
      data: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
      mime: "application/zip",
    };
    expect(await mailer.send({ to: "a@example.com", subject: "S", text: "t", attachments: [big] })).toBe(
      false,
    );
    expect(transport).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("header injection is refused, not sent", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn(async () => ({ messageId: "x" }));
    const mailer = wrapTransport(cloudflareTransport({ send } as unknown as SendEmail, FROM), log);
    const ok = await mailer.send({ to: "a@example.com\r\nBcc: evil@example.com", subject: "S", text: "t" });
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("cloudflare transport", () => {
  it("builds headers incl. List-Unsubscribe, List-Unsubscribe-Post and Auto-Submitted", () => {
    const raw = buildMime(
      {
        to: "a@example.com",
        subject: "Weekly digest",
        text: "body",
        headers: {
          "List-Unsubscribe": "<https://api.pacestreak.com/v1/unsubscribe/tok>",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      },
      { from: FROM, now: new Date(Date.UTC(2026, 9, 18, 9, 30, 0)), messageId: "<id@pacestreak.com>" },
    );
    expect(headerOf(raw, "From")).toBe("PaceStreak <hello@pacestreak.com>");
    expect(headerOf(raw, "To")).toBe("a@example.com");
    expect(headerOf(raw, "Subject")).toBe("Weekly digest");
    expect(headerOf(raw, "Date")).toBe("Sun, 18 Oct 2026 09:30:00 GMT");
    expect(headerOf(raw, "Message-ID")).toBe("<id@pacestreak.com>");
    expect(headerOf(raw, "Reply-To")).toBe("hello@pacestreak.com");
    expect(headerOf(raw, "Auto-Submitted")).toBe("auto-generated");
    expect(headerOf(raw, "List-Unsubscribe")).toBe("<https://api.pacestreak.com/v1/unsubscribe/tok>");
    expect(headerOf(raw, "List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
    expect(headerOf(raw, "MIME-Version")).toBe("1.0");
  });

  it("default Message-ID uses the sender domain", () => {
    const raw = buildMime({ to: "a@example.com", subject: "S", text: "t" }, { from: FROM });
    expect(headerOf(raw, "Message-ID")).toMatch(/^<[0-9a-f-]{36}@pacestreak\.com>$/);
  });

  it("wraps an attachment in multipart/mixed with the body alternative first", () => {
    const data = new Uint8Array([0, 1, 2, 250, 255]);
    const raw = buildMime(
      {
        to: "a@example.com",
        subject: "Backup",
        text: "plain",
        html: "<p>html</p>",
        attachments: [{ filename: "pacestreak-backup.zip", data, mime: "application/zip" }],
      },
      { from: FROM },
    );
    expect(headerOf(raw, "Content-Type")).toMatch(/^multipart\/mixed; boundary="/);
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain('Content-Disposition: attachment; filename="pacestreak-backup.zip"');
    const types = leafParts(raw).map((p) => p.type);
    expect(types).toEqual(["text/plain", "text/html", "application/zip"]);
    const b64 = /filename="pacestreak-backup.zip"\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(raw)?.[1] ?? "";
    expect([...b64ToBytes(b64.replace(/\s/g, ""))]).toEqual([...data]);
  });

  it("encodes non-ASCII subjects and keeps UTF-8 bodies intact", () => {
    const raw = buildMime({ to: "a@example.com", subject: "Streak 🔥", text: "Grüße" }, { from: FROM });
    expect(headerOf(raw, "Subject")).toBe(encodeWord("Streak 🔥"));
    expect(headerOf(raw, "Subject")).toMatch(/^=\?UTF-8\?B\?/);
    expect(leafParts(raw)[0]?.content).toBe("Grüße");
    expect([...raw].every((ch) => ch.charCodeAt(0) < 0x80)).toBe(true);
  });

  it("parses MAIL_FROM forms", () => {
    expect(parseFrom("PaceStreak <hello@pacestreak.com>")).toEqual({
      name: "PaceStreak",
      address: "hello@pacestreak.com",
    });
    expect(parseFrom('"Pace, Streak" <a@b.co>')).toEqual({ name: "Pace, Streak", address: "a@b.co" });
    expect(parseFrom("a@b.co")).toEqual({ name: "", address: "a@b.co" });
    expect(() => parseFrom("nope")).toThrow();
  });

  it("hands an EmailMessage with the envelope addresses to the binding", async () => {
    const send = vi.fn(async (_m: unknown) => ({ messageId: "x" }));
    const mailer = wrapTransport(cloudflareTransport({ send } as unknown as SendEmail, FROM), log);
    expect(await mailer.send(passwordResetEmail("a@example.com", "123456"))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0]?.[0] as { from: string; to: string };
    expect(msg.from).toBe("hello@pacestreak.com");
    expect(msg.to).toBe("a@example.com");
  });
});

describe("templates", () => {
  it("exact subjects and text bodies with app name PaceStreak", () => {
    const v = verificationEmail("a@x.io", "123456");
    expect(v.subject).toBe("Confirm your PaceStreak email address");
    expect(v.text).toBe(
      "Your verification code is: 123456\n\nEnter it in the app to confirm your address. It expires in 24 hours.\nIf you did not create this account, ignore this message.",
    );
    expect(v.html).toContain("You're receiving this because someone used this address on PaceStreak.");
    const r = passwordResetEmail("a@x.io", "654321");
    expect(r.subject).toBe("Reset your PaceStreak password");
    expect(r.text).toBe(
      "Your password reset code is: 654321\n\nEnter it in the app to choose a new password. It expires in 30 minutes and can be used once.\nIf you did not request this, ignore this message - your password has not changed.",
    );
    const c = passwordChangedEmail("a@x.io", "https://app.pacestreak.com");
    expect(c.subject).toBe("Your PaceStreak password was changed");
    expect(c.text).toBe(
      "Your password was just changed and all other sessions were signed out.\n\nIf this was not you, reset your password immediately.",
    );
    expect(c.html).toContain('href="https://app.pacestreak.com/reset-password"');
    expect(c.html).toContain("Reset password");
    const e = emailChangeEmail("new@x.io", "999000");
    expect(e.to).toBe("new@x.io");
    expect(e.subject).toBe("Confirm your new PaceStreak email address");
    expect(e.text).toBe(
      "Your confirmation code is: 999000\n\nEnter it in the app to use this address for your PaceStreak account. It expires in 24 hours.\nIf you didn't ask for this, ignore this message; nothing has changed.",
    );
    expect(e.html).toContain("Confirm this address for your PaceStreak account.");
    const n = emailChangedNotice("old@x.io", "new@x.io");
    expect(n.to).toBe("old@x.io");
    expect(n.subject).toBe("Your PaceStreak email address was changed");
    expect(n.text).toBe(
      "Your account now uses new@x.io. If this wasn't you, reply to this email straight away and we will help you get it back.",
    );
  });

  it("escapes like Python html.escape, including in the changed-notice address", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#x27;&amp;&#x27;&lt;/a&gt;");
    const n = emailChangedNotice("old@x.io", "<b>@x.io");
    expect(n.html).toContain("&lt;b&gt;@x.io");
    expect(n.html).not.toContain("<b>@x.io");
  });
});
