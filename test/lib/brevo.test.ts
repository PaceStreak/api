/** The Brevo transport against a mocked fetch: request shape, auth header, failures and the timeout. */
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/lib/logger.ts";
import { BREVO_URL, brevoTransport } from "../../src/lib/mailer/brevo.ts";
import { createMailer, wrapTransport } from "../../src/lib/mailer/index.ts";
import { mockFetch } from "../fixtures/fetch.ts";

const FROM = "PaceStreak <noreply@pacestreak.com>";
const KEY = "xkeysib-not-a-real-key";
const log = createLogger({ test: "brevo" });
const SMTP_OFF = { host: "smtp.invalid", port: 587, user: null, password: null };

describe("brevo transport", () => {
  it("POSTs the documented JSON with the api-key header", async () => {
    let seen: { headers: Headers; body: unknown; method: string } | null = null;
    mockFetch(BREVO_URL, async (req) => {
      seen = { headers: req.headers, body: await req.json(), method: req.method };
      return Response.json({ messageId: "<1@relay>" }, { status: 201 });
    });
    await brevoTransport(
      KEY,
      FROM,
    )({
      to: "a@example.com",
      subject: "Your week",
      text: "Three sessions.",
      html: "<p>Three sessions.</p>",
      headers: { "List-Unsubscribe": "<https://x/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      attachments: [{ filename: "backup.zip", data: new Uint8Array([1, 2, 3]), mime: "application/zip" }],
    });
    expect(seen).not.toBeNull();
    const s = seen as unknown as { headers: Headers; body: Record<string, unknown>; method: string };
    expect(s.method).toBe("POST");
    expect(s.headers.get("api-key")).toBe(KEY);
    expect(s.headers.get("content-type")).toBe("application/json");
    const { headers, ...rest } = s.body as { headers: Record<string, string> };
    expect(rest).toEqual({
      sender: { name: "PaceStreak", email: "noreply@pacestreak.com" },
      to: [{ email: "a@example.com" }],
      replyTo: { email: "hello@pacestreak.com" },
      subject: "Your week",
      htmlContent: "<p>Three sessions.</p>",
      textContent: "Three sessions.",
      attachment: [{ name: "backup.zip", content: "AQID" }],
    });
    expect(headers["List-Unsubscribe"]).toBe("<https://x/u>");
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(headers["Auto-Submitted"]).toBe("auto-generated");
    expect(headers["Message-ID"]).toMatch(/^<[0-9a-f-]{36}@pacestreak\.com>$/);
  });

  it("sends text-only mail with an escaped HTML body and no attachment field", async () => {
    let body: Record<string, unknown> = {};
    mockFetch(BREVO_URL, async (req) => {
      body = (await req.json()) as Record<string, unknown>;
      return new Response(null, { status: 201 });
    });
    await brevoTransport(KEY, FROM)({ to: "b@example.com", subject: "S", text: "a < b & c" });
    expect(body.htmlContent).toBe(
      '<pre style="font-family:inherit;white-space:pre-wrap">a &lt; b &amp; c</pre>',
    );
    expect(body).not.toHaveProperty("attachment");
  });

  it.each([400, 401, 429, 500, 503])(
    "a %i is a failed send, logged without the key or the body",
    async (status) => {
      mockFetch(BREVO_URL, () =>
        Response.json({ message: "nope", echo: "Your code is: 123456" }, { status }),
      );
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const mailer = wrapTransport(brevoTransport(KEY, FROM), log);
      await expect(
        mailer.send({ to: "c@example.com", subject: "S", text: "Your code is: 123456" }),
      ).resolves.toBe(false);
      const line = err.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(line).toContain("failed to send email");
      expect(line).toContain(`brevo answered ${status}`);
      expect(line).not.toContain(KEY);
      expect(line).not.toContain("123456");
      err.mockRestore();
    },
  );

  it("gives up after the timeout", async () => {
    mockFetch(
      BREVO_URL,
      (req) =>
        new Promise<Response>((_, reject) => {
          req.signal.addEventListener("abort", () => reject(req.signal.reason));
        }),
    );
    const start = Date.now();
    await expect(
      brevoTransport(KEY, FROM, 50)({ to: "d@example.com", subject: "S", text: "t" }),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("createMailer picks brevo from config; without a key nothing is sent", async () => {
    const calls = mockFetch(BREVO_URL, () => new Response(null, { status: 201 }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const on = createMailer(
      { mailer: "brevo", mailFrom: FROM, emailEnabled: true, brevoApiKey: KEY, smtp: SMTP_OFF },
      env,
      log,
    );
    await expect(on.send({ to: "e@example.com", subject: "S", text: "t" })).resolves.toBe(true);
    const keyless = createMailer(
      { mailer: "brevo", mailFrom: FROM, emailEnabled: true, brevoApiKey: null, smtp: SMTP_OFF },
      env,
      log,
    );
    await expect(keyless.send({ to: "e@example.com", subject: "S", text: "t" })).resolves.toBe(false);
    expect(calls.calls).toHaveLength(1);
    err.mockRestore();
  });
});
