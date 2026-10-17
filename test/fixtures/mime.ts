import { b64ToBytes } from "../../src/lib/b64url.ts";

export interface Part {
  type: string;
  content: string;
}

/** Minimal reader for the MIME we build: returns leaf text parts, decoded. */
export function leafParts(raw: string): Part[] {
  const [head = "", ...rest] = raw.split("\r\n\r\n");
  const body = rest.join("\r\n\r\n");
  const type = /Content-Type: ([^;\r\n]+)/i.exec(head)?.[1] ?? "text/plain";
  const boundary = /boundary="([^"]+)"/.exec(head)?.[1];
  if (type.startsWith("multipart/") && boundary !== undefined) {
    const chunks = body.split(`--${boundary}`).slice(1, -1);
    return chunks.flatMap((c) => leafParts(c.replace(/^\r\n/, "")));
  }
  const bytes = b64ToBytes(body.replace(/\s+/g, ""));
  return [{ type, content: new TextDecoder().decode(bytes) }];
}
