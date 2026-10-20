/**
 * Pure helpers shared by social, buddies and groups (spec/social.md §0): the public `person` card, `clean_text`,
 * invite codes and the encouragement presets. Nothing here touches D1.
 *
 * Privacy rule (AGENTS.md): a person card carries identity, level and the whole-life training streak only. It is
 * never built from habit rows, so a habit's name, amounts and slips cannot reach a feed, profile, group or board.
 */
import { b64urlDecode, b64urlEncode, utf8 } from "../../lib/b64url.ts";
import { toWire } from "../../lib/time.ts";

/** The person columns every social query selects (`PERSON_SQL` in repo.ts), keyed `p_*` / `s_*`. */
export interface PersonRow {
  p_id: string;
  p_handle: string | null;
  p_display_name: string | null;
  p_avatar_hue: number;
  p_visibility: string;
  p_official: number | boolean;
  p_gamified: number | boolean;
  /** user_stats.user_id from an outer join: null when there is no stats row (or none was joined). */
  s_user: string | null;
  s_level: number | null;
  s_streak: number | null;
}

export interface Person {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar_hue: number;
  visibility: string;
  official: boolean;
  level?: number;
  current_streak?: number;
  [extra: string]: unknown;
}

/**
 * Python `person(p, stats, **extra)`: stats add `level` (when gamification is on) and `current_streak`; a missing
 * stats row adds nothing. `withStats=false` is Python's call without stats.
 */
export function person(r: PersonRow, withStats = false, extra: Record<string, unknown> = {}): Person {
  const out: Person = {
    id: r.p_id,
    handle: r.p_handle,
    display_name: r.p_display_name,
    avatar_hue: r.p_avatar_hue,
    visibility: r.p_visibility,
    official: Boolean(r.p_official),
  };
  if (withStats && r.s_user !== null) {
    if (r.p_gamified) out.level = r.s_level ?? 1;
    out.current_streak = r.s_streak ?? 0;
  }
  return Object.assign(out, extra);
}

/** A `PersonRow` from a drizzle profile row and its stats (null: no stats row). */
export function personRow(
  p: {
    userId: string;
    handle: string | null;
    displayName: string | null;
    avatarHue: number;
    visibility: string;
    isOfficial: boolean;
    gamificationEnabled: boolean;
  },
  s: { level: number; current_streak: number } | null | undefined = null,
): PersonRow {
  return {
    p_id: p.userId,
    p_handle: p.handle,
    p_display_name: p.displayName,
    p_avatar_hue: p.avatarHue,
    p_visibility: p.visibility,
    p_official: p.isOfficial,
    p_gamified: p.gamificationEnabled,
    s_user: s == null ? null : p.userId,
    s_level: s?.level ?? null,
    s_streak: s?.current_streak ?? null,
  };
}

/** `"{display_name or '@' + handle}"`, the name notifications use. */
export const displayName = (p: { displayName: string | null; handle: string | null }) =>
  p.displayName || `@${p.handle ?? ""}`;

const KEEP = new Set(["\n", "\t"]);

/**
 * Python `clean_text`: NFKC, drop control/format/private-use characters (bidi overrides, zero-width, NUL) except
 * newline and tab, collapse runs of blank lines, strip. Python's `strip()` also strips `\x1c-\x1f` and `\x85`, but
 * those are Cc and already gone.
 */
export function cleanText(value: string): string {
  let v = value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Co}]/gu, (m) => (KEEP.has(m) ? m : ""));
  while (v.includes("\n\n\n")) v = v.replaceAll("\n\n\n", "\n\n");
  return v.trim();
}

/** `clean_text(v) or None if v else v`: falsy input unchanged, otherwise the cleaned text or null when emptied. */
export const cleanOrNull = (v: string | null | undefined): string | null | undefined =>
  v ? cleanText(v) || null : v;

/** Python slices count code points; `.slice` on a JS string counts UTF-16 units and could split an emoji. */
export const codePoints = (s: string, n: number) => Array.from(s).slice(0, n).join("");

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** 8 characters from a 31-letter alphabet without look-alikes, uniformly (rejection sampling). */
export function inviteCode(length = 8): string {
  let out = "";
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

/** Encouragement is a fixed set of messages, never free text: nothing to moderate, nothing to harass with. */
export const PRESETS: ReadonlyMap<string, string> = new Map([
  ["you-got-this", "You've got this."],
  ["one-more", "One more session keeps it going."],
  ["proud", "Proud of you for showing up."],
  ["rest-well", "Rest well. The streak will wait."],
  ["lets-go", "Training today too. Let's go."],
  ["welcome-back", "Good to see you back."],
]);

/** Feed item (Python `_feed_page` row), from the columns `feedItemSql` selects. */
export interface FeedRow extends PersonRow {
  e_id: string;
  e_kind: string;
  e_data: string;
  e_on: string;
  e_created: number;
  e_user: string;
  kudos: number;
  comments: number;
  my_reaction: string | null;
  reactions: string | null;
}

export function feedItem(r: FeedRow, viewer: string) {
  return {
    id: r.e_id,
    kind: r.e_kind,
    data: JSON.parse(r.e_data) as Record<string, unknown>,
    date: r.e_on,
    created_at: toWire(r.e_created),
    author: person(r),
    kudos: r.kudos,
    comments: r.comments,
    kudoed: r.my_reaction !== null,
    mine: r.e_user === viewer,
    reactions: (r.reactions === null ? {} : JSON.parse(r.reactions)) as Record<string, number>,
    my_reaction: r.my_reaction,
  };
}

/** `{events, next}`: 25 per page, a 26th row says there is more; `next` is the last row's opaque cursor. */
export function feedPage(rows: readonly FeedRow[], viewer: string) {
  const more = rows.length > PAGE;
  const page = rows.slice(0, PAGE);
  const last = page[page.length - 1];
  return {
    events: page.map((r) => feedItem(r, viewer)),
    next: more && last !== undefined ? encodeCursor({ at: last.e_created, id: last.e_id }) : null,
  };
}

export const PAGE = 25;

/**
 * A feed position: the last item's `created_at` and `id`, so events created in the same millisecond are never
 * skipped across a page boundary. `id` is null for the old timestamp-only cursor, still accepted.
 */
export interface FeedCursor {
  at: number;
  id: string | null;
}

/** Opaque on the wire: base64url of `<ms>.<id>`. Clients pass `next` back unchanged. */
export function encodeCursor(c: { at: number; id: string }): string {
  return b64urlEncode(utf8(`${c.at}.${c.id}`));
}

/** The composite cursor, or null when `s` is not one (the caller then tries the old ISO instant). */
export function decodeCursor(s: string): FeedCursor | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b64urlDecode(s));
  } catch {
    return null;
  }
  const m = /^(\d{1,15})\.([0-9a-f-]{1,64})$/.exec(text);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  return { at: Number(m[1]), id: m[2] };
}
