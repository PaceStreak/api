/**
 * SSRF guard for push endpoints (DESIGN.md §11), applied at subscribe time and again before every send. A push
 * endpoint is a URL the server later requests on the user's behalf, so it must never point at internal space or at
 * our own zone. No DNS resolution: IP literals are classified here, hostnames must be on the allowlist.
 */

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".pacestreak.com"];
const BLOCKED_NAMES = new Set(["localhost", "pacestreak.com"]);

/** `[network, prefix length]` for IPv4 ranges that are not global unicast. */
const V4_BLOCKED: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10/8 private
  [0x64400000, 10], // 100.64/10 CGNAT
  [0x7f000000, 8], // 127/8 loopback
  [0xa9fe0000, 16], // 169.254/16 link-local (cloud metadata)
  [0xac100000, 12], // 172.16/12 private
  [0xc0000000, 24], // 192.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2/24 TEST-NET-1
  [0xc0586300, 24], // 192.88.99/24 6to4 relay anycast (deprecated)
  [0xc0a80000, 16], // 192.168/16 private
  [0xc6120000, 15], // 198.18/15 benchmarking
  [0xc6336400, 24], // 198.51.100/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113/24 TEST-NET-3
  [0xe0000000, 4], // 224/4 multicast
  [0xf0000000, 4], // 240/4 reserved, includes 255.255.255.255 broadcast
];

/** Strict dotted quad (no shorthand, no leading zeros) as an unsigned 32-bit number, or null. */
export function parseIpv4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

export function isGlobalIpv4(n: number): boolean {
  return !V4_BLOCKED.some(([net, len]) => n >>> (32 - len) === net >>> (32 - len));
}

function hexGroups(h: string): number[] | null {
  if (h === "") return [];
  const out: number[] = [];
  for (const g of h.split(":")) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(Number.parseInt(g, 16));
  }
  return out;
}

/** Eight 16-bit groups, or null. Accepts `::` compression and a trailing dotted IPv4; no zone ids. */
export function parseIpv6(input: string): number[] | null {
  let s = input;
  if (s.includes(".")) {
    const cut = s.lastIndexOf(":");
    const v4 = parseIpv4(s.slice(cut + 1));
    if (cut < 0 || v4 === null) return null;
    s = `${s.slice(0, cut + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = hexGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? hexGroups(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

const v4Of = (g: readonly number[]): number => ((g[6] ?? 0) * 0x10000 + (g[7] ?? 0)) >>> 0;
const zeros = (g: readonly number[], from: number, to: number): boolean =>
  g.slice(from, to).every((x) => x === 0);

export function isGlobalIpv6(g: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = g;
  // Embedded IPv4: ::/96 (compat; covers :: and ::1, which land in 0/8), ::ffff:0:0/96 (mapped), 64:ff9b::/96.
  if (zeros(g, 0, 5) && (g[5] === 0 || g[5] === 0xffff)) return isGlobalIpv4(v4Of(g));
  if (a === 0x64 && b === 0xff9b && zeros(g, 2, 6)) return isGlobalIpv4(v4Of(g));
  // Only 2000::/3 is global unicast: ULA fc00::/7, link-local fe80::/10, multicast ff00::/8 and the rest fall out.
  if ((a & 0xe000) !== 0x2000) return false;
  if (a === 0x2001 && b < 0x200) return false; // 2001::/23 IETF protocol assignments (Teredo, benchmarking)
  if (a === 0x2001 && b === 0x0db8) return false; // 2001:db8::/32 documentation
  if (a === 0x3fff && b < 0x1000) return false; // 3fff::/20 documentation (RFC 9637)
  if (a === 0x2002) return isGlobalIpv4(((b << 16) | c) >>> 0); // 6to4 embeds an IPv4
  return true;
}

/**
 * True when `raw` may be stored and later fetched as a push endpoint. `allowlist` holds push-service domains
 * (`PUSH_HOST_ALLOWLIST`); a hostname must equal one or be a subdomain of one. Public IP literals pass without
 * the allowlist (kept from the Python contract: `https://8.8.8.8/push/abc`).
 */
export function isSafePushEndpoint(raw: string, allowlist: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  // The URL parser drops the default port, so anything left is not 443.
  if (url.port !== "") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) {
    const g = parseIpv6(host.slice(1, -1));
    return g !== null && isGlobalIpv6(g);
  }
  // WHATWG URL already canonicalises IPv4 shorthands (0x7f.1, 2130706433) to dotted quads.
  const v4 = parseIpv4(host);
  if (v4 !== null) return isGlobalIpv4(v4);
  if (!host.includes(".")) return false;
  if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return false;
  return allowlist.some((d) => host === d || host.endsWith(`.${d}`));
}
