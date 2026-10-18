/**
 * iCalendar output for the one-off export and the private subscription feed (Python app/account/calendar.py,
 * spec/account.md §2 "iCalendar"). The feed carries the minimum: when, which discipline, a title and the
 * duration or distance. Never notes, sets, body metrics, habits or anything social.
 */
import { DISCIPLINE_BY_ID } from "../../catalog/exercises.ts";
import { addDays } from "../../lib/time.ts";

const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
/** streak pauses run at most this long (Python `PAUSE_MAX_DAYS`). */
const PAUSE_MAX_DAYS = 84;

/** RFC 5545 §3.3.11 TEXT escaping. */
export function escapeText(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\r\n", "\\n")
    .replaceAll("\n", "\\n");
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/**
 * RFC 5545 §3.1: lines longer than 75 octets continue on the next line, which starts with a space. Counts bytes
 * and never splits a code point.
 */
export function fold(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const n = utf8Length(ch);
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + n > limit) {
      out.push(current);
      current = ch;
      bytes = n;
    } else {
      current += ch;
      bytes += n;
    }
  }
  out.push(current);
  return out.join("\r\n ");
}

/** UTC `YYYYMMDDTHHMMSSZ`. */
export function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/** Python `str.title()`: capitalise the first letter after every non-letter. */
function pyTitle(s: string): string {
  let out = "";
  let prev = false;
  for (const ch of s) {
    const letter = /\p{L}/u.test(ch);
    out += letter ? (prev ? ch.toLowerCase() : ch.toUpperCase()) : ch;
    prev = letter;
  }
  return out;
}

export interface CalendarWorkout {
  id: string;
  discipline: string;
  title: string | null;
  startedAt: number;
  durationSec: number | null;
  distanceM: number | null;
}

export interface CalendarPause {
  id: string;
  startsOn: string;
  endsOn: string | null;
}

export function summaryFor(w: CalendarWorkout): string {
  let text = w.title || DISCIPLINE_BY_ID.get(w.discipline)?.name || pyTitle(w.discipline);
  if (w.distanceM) text += ` · ${(w.distanceM / 1000).toFixed(1)} km`;
  return text;
}

function effectiveEnd(p: CalendarPause): string {
  const cap = addDays(p.startsOn, PAUSE_MAX_DAYS - 1);
  return p.endsOn === null || p.endsOn > cap ? cap : p.endsOn;
}

const compact = (date: string) => date.replaceAll("-", "");

export function buildCalendar(
  name: string,
  now: number,
  workouts: readonly CalendarWorkout[],
  pauses: readonly CalendarPause[] = [],
  trainingDays: number | null = null,
  weekAnchor: string | null = null,
): string {
  const ts = stamp(now);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PaceStreak//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];
  for (const w of workouts) {
    const minutes = Math.max(1, Math.floor((w.durationSec || 1800) / 60));
    lines.push(
      "BEGIN:VEVENT",
      `UID:${w.id}@pacestreak.com`,
      `DTSTAMP:${ts}`,
      `DTSTART:${stamp(w.startedAt)}`,
      `DURATION:PT${minutes}M`,
      `SUMMARY:${escapeText(summaryFor(w))}`,
      "CATEGORIES:TRAINING",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  for (const p of pauses) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:pause-${p.id}@pacestreak.com`,
      `DTSTAMP:${ts}`,
      `DTSTART;VALUE=DATE:${compact(p.startsOn)}`,
      `DTEND;VALUE=DATE:${compact(addDays(effectiveEnd(p), 1))}`,
      "SUMMARY:Streak paused",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  if (trainingDays && weekAnchor) {
    const days = BYDAY.filter((_, i) => trainingDays & (1 << i)).join(",");
    lines.push(
      "BEGIN:VEVENT",
      "UID:planned-training@pacestreak.com",
      `DTSTAMP:${ts}`,
      `DTSTART;VALUE=DATE:${compact(weekAnchor)}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${days}`,
      "SUMMARY:Planned training day",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
