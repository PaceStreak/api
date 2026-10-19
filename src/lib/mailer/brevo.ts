/**
 * Brevo's transactional HTTP API (`POST /v3/smtp/email`), for the Workers Free plan, where the `send_email`
 * binding cannot send. One subrequest per send, with a timeout. A non-2xx answer or a timeout throws, and
 * `wrapTransport` turns that into a logged `false`, exactly as for the Cloudflare transport. Neither the API key
 * nor the body is ever logged: the error names only the HTTP status.
 */
import { SETTINGS } from "../../env.ts";
import { bytesToB64 } from "../b64url.ts";
import { parseFrom } from "./cloudflare.ts";
import type { MailMessage, Transport } from "./index.ts";

export const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
export const BREVO_TIMEOUT_MS = 10_000;

/** Brevo requires `htmlContent`; a text-only message goes as escaped, pre-wrapped text. */
function htmlOf(msg: MailMessage): string {
  if (msg.html !== undefined) return msg.html;
  const esc = msg.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<pre style="font-family:inherit;white-space:pre-wrap">${esc}</pre>`;
}

/** The JSON body Brevo receives (exported for tests). */
export function brevoPayload(msg: MailMessage, from: string, messageId: string) {
  const sender = parseFrom(from);
  for (const [k, v] of Object.entries(msg.headers ?? {}))
    if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) throw new Error(`invalid header ${k}`);
  return {
    sender: sender.name ? { name: sender.name, email: sender.address } : { email: sender.address },
    to: [{ email: msg.to }],
    replyTo: { email: SETTINGS.emailReplyTo },
    subject: msg.subject,
    htmlContent: htmlOf(msg),
    textContent: msg.text,
    headers: {
      ...(msg.headers ?? {}),
      "Auto-Submitted": "auto-generated",
      "Message-ID": messageId,
    },
    ...((msg.attachments ?? []).length > 0
      ? {
          attachment: (msg.attachments ?? []).map((a) => ({ name: a.filename, content: bytesToB64(a.data) })),
        }
      : {}),
  };
}

export function brevoTransport(apiKey: string, from: string, timeoutMs = BREVO_TIMEOUT_MS): Transport {
  const domain = parseFrom(from).address.split("@")[1] ?? "pacestreak.com";
  return async (msg) => {
    const body = brevoPayload(msg, from, `<${crypto.randomUUID()}@${domain}>`);
    const res = await fetch(BREVO_URL, {
      method: "POST",
      headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain the body either way; its text may echo the request, so it is never put in the error.
    await res.body?.cancel();
    if (!res.ok) throw new Error(`brevo answered ${res.status}`);
  };
}
