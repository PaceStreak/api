/**
 * Outbound email (DESIGN.md §10, spec/core.md §6). Two transports, chosen by `MAILER`:
 *
 *   console     dev and tests: prints the plain-text body on one `[email:console]` line that tests read codes from.
 *   cloudflare  a MIME message through the `EMAIL` send_email binding (Cloudflare Email Service, Workers Paid).
 *   smtp        SMTP submission (587, STARTTLS, AUTH LOGIN) over TCP sockets: Brevo's relay with an SMTP key.
 *   brevo       Brevo's transactional HTTP API with `BREVO_API_KEY` (works on the Workers Free plan).
 *
 * `EMAIL_ENABLED=0` (the Workers Free plan has no Email Service sending) turns both off: `createMailer` then returns
 * a mailer that drops everything.
 *
 * Sending is best-effort and never throws into a handler: by the time a mail goes out the caller has committed
 * its writes, and a mail outage must not turn "we sent you a code" into a 500. The user can always ask again.
 */
import type { Config } from "../../env.ts";
import type { Logger } from "../logger.ts";
import { brevoTransport } from "./brevo.ts";
import { cloudflareTransport } from "./cloudflare.ts";
import { consoleTransport } from "./console.ts";
import { smtpTransport } from "./smtp.ts";

export interface Attachment {
  filename: string;
  data: Uint8Array;
  /** e.g. `application/zip`. */
  mime: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  /** Always the plain-text part; the HTML part, when given, is the preferred alternative. */
  text: string;
  html?: string;
  /** Extra headers, e.g. `List-Unsubscribe` and `List-Unsubscribe-Post`. */
  headers?: Record<string, string>;
  attachments?: Attachment[];
}

/** A transport may throw; `wrapTransport` makes sure callers never see it. */
export type Transport = (msg: MailMessage) => Promise<void>;

export interface Mailer {
  /** Resolves true when the transport accepted the message, false when it failed (already logged). Never rejects. */
  send(msg: MailMessage): Promise<boolean>;
}

/**
 * Total attachment bytes one message may carry. Cloudflare Email Service caps a whole message at 25 MiB and
 * base64 grows attachments by a third, so 10 MiB stays well inside it (the Paid-plan backup cap, DESIGN.md §10).
 * Callers check this first and fall back to the download text; an oversized message is refused, not truncated.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function attachmentBytes(msg: Pick<MailMessage, "attachments">): number {
  return (msg.attachments ?? []).reduce((n, a) => n + a.data.byteLength, 0);
}

export function wrapTransport(transport: Transport, log: Logger): Mailer {
  return {
    async send(msg) {
      try {
        if (attachmentBytes(msg) > MAX_ATTACHMENT_BYTES) {
          throw new Error("attachments exceed MAX_ATTACHMENT_BYTES");
        }
        await transport(msg);
        return true;
      } catch (err) {
        // The address and body are deliberately not logged: the body can hold a live code.
        log.error("failed to send email", err, { subject: msg.subject });
        return false;
      }
    },
  };
}

/**
 * With `EMAIL_ENABLED=0` nothing reaches a transport: every send resolves false. Callers gate email work themselves
 * (no codes issued, no email channel); this is the backstop that makes "never sends" hold whatever a caller does.
 */
const OFF: Mailer = { send: async () => false };

export function createMailer(
  cfg: Pick<Config, "mailer" | "mailFrom" | "emailEnabled" | "brevoApiKey" | "smtp">,
  env: Env,
  log: Logger,
): Mailer {
  if (!cfg.emailEnabled) return OFF;
  // The config gate refuses a missing binding or key when email is on; `missing` only guards misuse in code.
  const missing =
    (what: string): Transport =>
    async () => {
      throw new Error(`${what} is not configured`);
    };
  let transport: Transport;
  if (cfg.mailer === "cloudflare") {
    const binding = (env as { EMAIL?: SendEmail }).EMAIL;
    transport =
      binding === undefined ? missing("the EMAIL binding") : cloudflareTransport(binding, cfg.mailFrom);
  } else if (cfg.mailer === "brevo") {
    const key = cfg.brevoApiKey;
    transport = key === null ? missing("BREVO_API_KEY") : brevoTransport(key, cfg.mailFrom);
  } else if (cfg.mailer === "smtp") {
    const { host, port, user, password } = cfg.smtp;
    transport =
      user === null || password === null
        ? missing("SMTP_USER/SMTP_PASSWORD")
        : smtpTransport({ host, port, user, password, from: cfg.mailFrom });
  } else transport = consoleTransport();
  return wrapTransport(transport, log);
}
