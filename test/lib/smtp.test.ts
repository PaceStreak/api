/** The SMTP client against a fake socket that scripts a Brevo-like server conversation. */
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/lib/logger.ts";
import { wrapTransport } from "../../src/lib/mailer/index.ts";
import {
  type Connect,
  dotStuff,
  SmtpError,
  type SmtpSocket,
  smtpTransport,
} from "../../src/lib/mailer/smtp.ts";

const FROM = "PaceStreak <noreply@pacestreak.com>";
const USER = "owner@example.com";
const PASSWORD = "xsmtpsib-not-a-real-key";
const opts = { host: "smtp-relay.brevo.com", port: 587, user: USER, password: PASSWORD, from: FROM };

interface Script {
  /** Reply code overrides by step. */
  codes?: Partial<Record<"auth" | "rcpt" | "message", number>>;
  /** The server stops answering after the greeting. */
  hang?: boolean;
}

interface Server {
  connect: Connect;
  /** Client lines, in order, with a marker for the TLS upgrade. */
  log: string[];
  data: string;
  closed: number;
  connectedTo: unknown[];
}

function fakeServer(script: Script = {}): Server {
  const server: Server = {
    connect: null as unknown as Connect,
    log: [],
    data: "",
    closed: 0,
    connectedTo: [],
  };
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function socket(tls: boolean): SmtpSocket {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const say = (s: string) => ctrl.enqueue(enc.encode(s));
    let buf = "";
    let inData = false;
    let authStep = 0;
    const onLine = (line: string) => {
      server.log.push(line);
      if (script.hang) return;
      if (/^EHLO /.test(line))
        return say(
          `250-smtp-relay.brevo.com\r\n250-${tls ? "AUTH LOGIN PLAIN" : "STARTTLS"}\r\n250 8BITMIME\r\n`,
        );
      if (line === "STARTTLS") return say("220 2.0.0 Ready to start TLS\r\n");
      if (line === "AUTH LOGIN") return say("334 VXNlcm5hbWU6\r\n");
      if (authStep === 0 && line === btoa(USER)) {
        authStep = 1;
        return say("334 UGFzc3dvcmQ6\r\n");
      }
      if (authStep === 1) {
        authStep = 2;
        const code = script.codes?.auth ?? (line === btoa(PASSWORD) ? 235 : 535);
        return say(`${code} auth\r\n`);
      }
      if (line.startsWith("MAIL FROM:")) return say("250 ok\r\n");
      if (line.startsWith("RCPT TO:")) return say(`${script.codes?.rcpt ?? 250} rcpt\r\n`);
      if (line === "DATA") {
        inData = true;
        return say("354 go ahead\r\n");
      }
      if (line === "QUIT") return say("221 bye\r\n");
      say("500 what\r\n");
    };
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        buf += dec.decode(chunk);
        for (;;) {
          if (inData) {
            const end = buf.indexOf("\r\n.\r\n");
            if (end < 0) return;
            server.data = buf.slice(0, end + 2);
            buf = buf.slice(end + 5);
            inData = false;
            say(`${script.codes?.message ?? 250} queued\r\n`);
            continue;
          }
          const nl = buf.indexOf("\r\n");
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          onLine(line);
        }
      },
    });
    if (!tls) say("220 smtp-relay.brevo.com ESMTP\r\n");
    return {
      readable,
      writable,
      startTls: () => {
        server.log.push("<tls>");
        return socket(true);
      },
      close: () => {
        server.closed++;
        try {
          ctrl.close();
        } catch {
          /* closed */
        }
      },
    };
  }
  server.connect = (addr, o) => {
    server.connectedTo.push({ addr, o });
    return socket(false);
  };
  return server;
}

const msg = {
  to: "a@example.com",
  subject: "Confirm your PaceStreak email address",
  text: "Your verification code is: 123456",
  headers: { "List-Unsubscribe": "<https://x/u>" },
};

describe("smtp transport", () => {
  it("runs EHLO, STARTTLS, EHLO, AUTH LOGIN, MAIL, RCPT, DATA, QUIT and sends buildMime's message", async () => {
    const s = fakeServer();
    await smtpTransport(opts, s.connect)(msg);
    expect(s.connectedTo).toEqual([
      { addr: { hostname: "smtp-relay.brevo.com", port: 587 }, o: { secureTransport: "starttls" } },
    ]);
    expect(s.log).toEqual([
      "EHLO pacestreak.com",
      "STARTTLS",
      "<tls>",
      "EHLO pacestreak.com",
      "AUTH LOGIN",
      btoa(USER),
      btoa(PASSWORD),
      "MAIL FROM:<noreply@pacestreak.com>",
      "RCPT TO:<a@example.com>",
      "DATA",
      "QUIT",
    ]);
    expect(s.data).toContain("From: PaceStreak <noreply@pacestreak.com>\r\n");
    expect(s.data).toContain("Reply-To: hello@pacestreak.com\r\n");
    expect(s.data).toContain("Auto-Submitted: auto-generated\r\n");
    expect(s.data).toContain("List-Unsubscribe: <https://x/u>\r\n");
    expect(s.data).toMatch(/Message-ID: <[0-9a-f-]+@pacestreak\.com>\r\n/);
    expect(s.closed).toBeGreaterThanOrEqual(1);
  });

  it("an auth failure (535) is a failed send that carries the code, not the credentials", async () => {
    const s = fakeServer({ codes: { auth: 535 } });
    const err = await smtpTransport(opts, s.connect)(msg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect((err as SmtpError).message).toBe("smtp auth answered 535");
    expect(s.log).not.toContain("DATA");
    expect(s.closed).toBeGreaterThanOrEqual(1);

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const mailer = wrapTransport(
      smtpTransport(opts, fakeServer({ codes: { auth: 535 } }).connect),
      createLogger({}),
    );
    await expect(mailer.send(msg)).resolves.toBe(false);
    const line = logged.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(line).toContain("smtp auth answered 535");
    for (const secret of [PASSWORD, btoa(PASSWORD), USER, "123456"]) expect(line).not.toContain(secret);
    logged.mockRestore();
  });

  it("a rejected recipient (550) fails before DATA", async () => {
    const s = fakeServer({ codes: { rcpt: 550 } });
    await expect(smtpTransport(opts, s.connect)(msg)).rejects.toThrow("smtp rcpt-to answered 550");
    expect(s.log).not.toContain("DATA");
  });

  it("a message the server refuses after DATA (554) fails", async () => {
    const s = fakeServer({ codes: { message: 554 } });
    await expect(smtpTransport(opts, s.connect)(msg)).rejects.toThrow("smtp message answered 554");
  });

  it("a server that stops answering times out and the socket is closed", async () => {
    const s = fakeServer({ hang: true });
    const start = Date.now();
    await expect(smtpTransport({ ...opts, timeoutMs: 50 }, s.connect)(msg)).rejects.toThrow(
      "smtp timeout failed",
    );
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(s.closed).toBeGreaterThanOrEqual(1);
  });

  it("dot-stuffs lines that start with a dot", async () => {
    expect(dotStuff(".a\r\nb\r\n..c\r\n.")).toBe("..a\r\nb\r\n...c\r\n..");
    expect(dotStuff("x\n.y")).toBe("x\r\n..y");
    // End to end: the server unstuffs nothing here, so the stuffed line arrives as sent.
    const s = fakeServer();
    await smtpTransport(opts, s.connect)({ ...msg, attachments: [], headers: { "X-Note": "fine" } });
    expect(s.data.split("\r\n").some((l) => l.startsWith(".") && !l.startsWith(".."))).toBe(false);
  });
});
