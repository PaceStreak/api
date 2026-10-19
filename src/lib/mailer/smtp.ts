/**
 * SMTP submission over Workers TCP sockets (`cloudflare:sockets`), for Brevo's SMTP relay with an SMTP key: port
 * 587, STARTTLS, AUTH LOGIN. The message is `buildMime`'s, so its headers are identical to the Cloudflare
 * transport's. Every reply code is checked; anything unexpected throws `smtp <step> answered <code>` (never the
 * credentials, the body or the server's text), and `wrapTransport` turns that into a logged `false`. One overall
 * timeout covers the whole exchange, and the socket is always closed.
 */
import { connect } from "cloudflare:sockets";
import { bytesToB64, utf8 } from "../b64url.ts";
import { buildMime, parseFrom } from "./cloudflare.ts";
import type { Transport } from "./index.ts";

export const SMTP_TIMEOUT_MS = 20_000;

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  timeoutMs?: number;
  /** Name sent in EHLO. */
  helo?: string;
}

/** The parts of a Workers `Socket` this client uses, so tests can script a server. */
export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls(): SmtpSocket;
  close(): Promise<void> | void;
}
export type Connect = (
  addr: { hostname: string; port: number },
  opts: { secureTransport: "starttls" },
) => SmtpSocket;

export class SmtpError extends Error {
  constructor(
    readonly step: string,
    readonly code: number | null,
  ) {
    super(code === null ? `smtp ${step} failed` : `smtp ${step} answered ${code}`);
    this.name = "SmtpError";
  }
}

/** RFC 5321 §4.5.2: a line starting with "." gets one more. The body is CRLF-terminated by buildMime. */
export function dotStuff(data: string): string {
  const crlf = data.replace(/\r?\n/g, "\r\n");
  return crlf.replace(/(^|\r\n)\./g, "$1..");
}

class Conn {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buf = "";
  private readonly dec = new TextDecoder();

  constructor(readonly socket: SmtpSocket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  /** One reply, multi-line included ("250-a", "250-b", "250 c"): returns its code. */
  async reply(step: string): Promise<number> {
    for (;;) {
      let nl = this.buf.indexOf("\r\n");
      while (nl >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 2);
        const m = /^(\d{3})([ -])/.exec(line) ?? /^(\d{3})$/.exec(line);
        if (m === null) throw new SmtpError(step, null);
        if (m[2] !== "-") return Number(m[1]);
        nl = this.buf.indexOf("\r\n");
      }
      const { value, done } = await this.reader.read();
      if (done) throw new SmtpError(step, null);
      this.buf += this.dec.decode(value, { stream: true });
    }
  }

  async expect(step: string, ...codes: number[]): Promise<void> {
    const code = await this.reply(step);
    if (!codes.includes(code)) throw new SmtpError(step, code);
  }

  async send(text: string): Promise<void> {
    await this.writer.write(utf8(text));
  }

  async command(step: string, line: string, ...codes: number[]): Promise<void> {
    await this.send(`${line}\r\n`);
    await this.expect(step, ...codes);
  }

  /** Hands the socket over to startTls(): the old streams are released first. */
  release(): SmtpSocket {
    this.reader.releaseLock();
    this.writer.releaseLock();
    return this.socket;
  }
}

const safeAddr = (a: string) => {
  if (/[\s<>]/.test(a) || !a.includes("@")) throw new Error("invalid address");
  return a;
};

/** Sends one message; resolves when the server accepted it (250 after DATA). */
export async function smtpSend(
  opts: SmtpOptions,
  to: string,
  mime: string,
  connectFn: Connect = connect as unknown as Connect,
): Promise<void> {
  const from = safeAddr(parseFrom(opts.from).address);
  const rcpt = safeAddr(to);
  const helo = opts.helo ?? from.split("@")[1] ?? "localhost";
  const sockets: SmtpSocket[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmtpError("timeout", null)), opts.timeoutMs ?? SMTP_TIMEOUT_MS);
  });
  const run = async () => {
    const plain = connectFn({ hostname: opts.host, port: opts.port }, { secureTransport: "starttls" });
    sockets.push(plain);
    let c = new Conn(plain);
    await c.expect("greeting", 220);
    await c.command("ehlo", `EHLO ${helo}`, 250);
    await c.command("starttls", "STARTTLS", 220);
    const tls = c.release().startTls();
    sockets.push(tls);
    c = new Conn(tls);
    await c.command("ehlo", `EHLO ${helo}`, 250);
    await c.command("auth", "AUTH LOGIN", 334);
    await c.command("auth", bytesToB64(utf8(opts.user)), 334);
    await c.command("auth", bytesToB64(utf8(opts.password)), 235);
    await c.command("mail-from", `MAIL FROM:<${from}>`, 250);
    await c.command("rcpt-to", `RCPT TO:<${rcpt}>`, 250, 251);
    await c.command("data", "DATA", 354);
    const body = dotStuff(mime);
    await c.send(`${body}${body.endsWith("\r\n") ? "" : "\r\n"}.\r\n`);
    await c.expect("message", 250);
    // Accepted: a failed QUIT changes nothing.
    await c.command("quit", "QUIT", 221).catch(() => undefined);
  };
  const exchange = run();
  // After a timeout the exchange still rejects (its socket is closed below); that rejection is already handled.
  exchange.catch(() => undefined);
  try {
    await Promise.race([exchange, timeout]);
  } finally {
    clearTimeout(timer);
    for (const s of sockets.reverse()) {
      try {
        await s.close();
      } catch {
        /* already closed */
      }
    }
  }
}

export function smtpTransport(opts: SmtpOptions, connectFn?: Connect): Transport {
  return async (msg) => {
    await smtpSend(opts, msg.to, buildMime(msg, { from: opts.from }), connectFn);
  };
}
