/**
 * Weak ETags for sync-class reads (DESIGN.md §8). The inputs (sync_seq value, user_stats.rev, ...) come back in the
 * same batch as the auth row, so a 304 costs one round trip and no serialisation.
 */
export function weakEtag(...parts: readonly (string | number | null)[]): string {
  return `W/"${parts.map((p) => (p === null ? "-" : String(p))).join(".")}"`;
}

/** True when `If-None-Match` (a list, or `*`) matches `etag` under weak comparison (RFC 9110 §13.1.2). */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  const want = stripWeak(etag);
  return ifNoneMatch.split(",").some((t) => {
    const tag = t.trim();
    return tag === "*" || stripWeak(tag) === want;
  });
}

function stripWeak(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}
