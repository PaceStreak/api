/**
 * Cloudflare Email Service through the `send_email` binding (OWNER-DECISIONS: Brevo is dropped). The raw MIME is
 * built here so the message carries the same headers as the Python SMTP backend (spec/core.md §6.1): Date,
 * Message-ID, Reply-To, Auto-Submitted, and caller headers such as List-Unsubscribe / List-Unsubscribe-Post.
 * One subrequest per send.
 */
import { EmailMessage } from "cloudflare:email";
import { SETTINGS } from "../../env.ts";
import { bytesToB64, utf8 } from "../b64url.ts";
import type { MailMessage, Transport } from "./index.ts";

export interface Sender {
  name: string;
  address: string;
}

/** `PaceStreak <hello@pacestreak.com>` or a bare address. Throws on anything else. */
export function parseFrom(from: string): Sender {
  const m = /^\s*(.*?)\s*<([^<>\s@]+@[^<>\s@]+)>\s*$/.exec(from);
  if (m?.[2] !== undefined) return { name: (m[1] ?? "").replace(/^"(.*)"$/, "$1"), address: m[2] };
  const bare = from.trim();
  if (!/^[^<>\s@]+@[^<>\s@]+$/.test(bare)) throw new Error("MAIL_FROM is not an address");
  return { name: "", address: bare };
}

const CRLF = "\r\n";

/** A CR or LF in a header is header injection: refuse the whole message rather than strip it. */
function headerLine(name: string, value: string): string {
  if (/[\r\n:]/.test(name) || /[\r\n]/.test(value)) throw new Error(`invalid header ${name}`);
  return `${name}: ${value}`;
}

/** RFC 2047 encoded-word for non-ASCII header text (subjects, display names). */
export function encodeWord(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${bytesToB64(utf8(text))}?=`;
}

function displayName(name: string): string {
  const enc = encodeWord(name);
  if (enc !== name) return enc;
  return /[()<>@,;:\\".[\]]/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : name;
}

function b64Lines(bytes: Uint8Array): string {
  const b64 = bytesToB64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}

/** Base64 bodies: always 7-bit safe, whatever the text holds (names, emoji, long HTML lines). */
function textPart(subtype: "plain" | "html", body: string): string {
  return [
    `Content-Type: text/${subtype}; charset="utf-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(utf8(body)),
  ].join(CRLF);
}

function multipart(subtype: "alternative" | "mixed", parts: string[]): string {
  const b = `=_ps_${crypto.randomUUID().replaceAll("-", "")}`;
  return [
    `Content-Type: multipart/${subtype}; boundary="${b}"`,
    "",
    ...parts.map((p) => `--${b}${CRLF}${p}`),
    `--${b}--`,
    "",
  ].join(CRLF);
}

function safeFilename(name: string): string {
  return [...name].map((ch) => (ch.charCodeAt(0) < 0x20 || ch === '"' || ch === "\\" ? "_" : ch)).join("");
}

export interface MimeOptions {
  from: string;
  now?: Date;
  messageId?: string;
}

/**
 * The full RFC 5322 message. Text alone is single-part; with HTML it is multipart/alternative (text first, HTML
 * second and preferred); attachments wrap that in multipart/mixed. Throws on header injection or a bad sender.
 */
export function buildMime(msg: MailMessage, opts: MimeOptions): string {
  const sender = parseFrom(opts.from);
  const domain = sender.address.split("@")[1] ?? "pacestreak.com";
  const headers: [string, string][] = [
    ["From", sender.name ? `${displayName(sender.name)} <${sender.address}>` : sender.address],
    ["To", msg.to],
    ["Subject", encodeWord(msg.subject)],
    ["Date", (opts.now ?? new Date()).toUTCString()],
    ["Message-ID", opts.messageId ?? `<${crypto.randomUUID()}@${domain}>`],
    ["Reply-To", SETTINGS.emailReplyTo],
    // Automated mail: tells well-behaved auto-responders not to reply to it.
    ["Auto-Submitted", "auto-generated"],
    ...Object.entries(msg.headers ?? {}),
    ["MIME-Version", "1.0"],
  ];
  let body =
    msg.html === undefined
      ? textPart("plain", msg.text)
      : multipart("alternative", [textPart("plain", msg.text), textPart("html", msg.html)]);
  const attachments = msg.attachments ?? [];
  if (attachments.length > 0) {
    body = multipart("mixed", [
      body,
      ...attachments.map((a) => {
        const name = safeFilename(a.filename);
        if (!/^[\w.+-]+\/[\w.+-]+$/.test(a.mime)) throw new Error("invalid attachment type");
        return [
          `Content-Type: ${a.mime}; name="${name}"`,
          "Content-Transfer-Encoding: base64",
          `Content-Disposition: attachment; filename="${name}"`,
          "",
          b64Lines(a.data),
        ].join(CRLF);
      }),
    ]);
  }
  return `${headers.map(([k, v]) => headerLine(k, v)).join(CRLF)}${CRLF}${body}`;
}

export function cloudflareTransport(binding: SendEmail, from: string): Transport {
  return async (msg) => {
    const raw = buildMime(msg, { from });
    await binding.send(new EmailMessage(parseFrom(from).address, msg.to, raw));
  };
}
