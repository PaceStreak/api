import type { MailMessage, Transport } from "./index.ts";

/**
 * The exact Python console line (spec/core.md §2.8), plain-text part only:
 * `[email:console] to=<to> subject=<subject>[ attachments=name (N bytes), ...]\n<body>`.
 * Tests and local development read verification codes from it, so it bypasses the JSON logger.
 */
export function consoleLine(msg: MailMessage): string {
  const names = (msg.attachments ?? []).map((a) => `${a.filename} (${a.data.byteLength} bytes)`).join(", ");
  return `[email:console] to=${msg.to} subject=${msg.subject}${names ? ` attachments=${names}` : ""}\n${msg.text}`;
}

export function consoleTransport(print: (line: string) => void = console.log): Transport {
  return async (msg) => {
    print(consoleLine(msg));
  };
}
