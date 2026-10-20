/** Photo uploads for route tests, shaped like the app's (src/lib/photos.ts). */
import { SELF } from "cloudflare:test";
import { BASE, randomIp, recordStatements } from "./http.ts";

const today = () => new Date().toISOString().slice(0, 10);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const pad = (head: number[], n = 64) => new Uint8Array([...head, ...new Array<number>(n).fill(0)]);

export const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
export const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const WEBP = pad([...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WEBPVP8 ")]);

/** The app's upload: raw bytes typed by Content-Type, date and pose in the query. */
export function putPhoto(
  token: string | undefined,
  id: string,
  bytes: Uint8Array,
  type = "image/jpeg",
  q: { date?: string; pose?: string } = {},
): Promise<Response> {
  const query = new URLSearchParams({ date: q.date ?? today(), pose: q.pose ?? "front" });
  return SELF.fetch(`${BASE}/v1/body-photos/${id}?${query}`, {
    method: "PUT",
    headers: {
      "Content-Type": type,
      "CF-Connecting-IP": randomIp(),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: bytes,
  }).then((res) => {
    recordStatements(`PUT /v1/body-photos/${id}`, res);
    return res;
  });
}
