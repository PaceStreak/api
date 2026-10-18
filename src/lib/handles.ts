/**
 * Handle rules shared by the profile module and the admin "official account" route (Python `profile/reserved.py`
 * and `profile/router.py::_check_handle`). A handle is reserved if any of four rules match on a normalised form:
 * the exact word, its letters-only "core" (look-alike digits folded back), a long word contained anywhere or an
 * authority word at either end, or a whole word after splitting on underscores and digits.
 */
import { HttpError } from "./errors.ts";

export const BRAND = "pacestreak";
export const HANDLE_RE = /^[a-z0-9_]{3,30}$/;
export const HANDLE_FORMAT = "Handles are 3-30 characters: lowercase letters, numbers and underscores.";
export const HANDLE_RESERVED = "That handle is reserved";

// A "1" or "|" can stand for "l" or "i", so both readings are checked.
const CONFUSABLES: readonly Readonly<Record<string, string>>[] = [
  { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", $: "s", "@": "a", "|": "l" },
  { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", $: "s", "@": "a", "|": "i" },
];

const RESERVED = new Set(
  (
    "pacestreak official verified team staff crew hq support help helpdesk helpcenter contact hello info " +
    "feedback news announcements updates press media blog status security abuse trust safety legal privacy " +
    "terms policy copyright dmca compliance billing payments pricing sales marketing partners careers jobs " +
    "hiring investors founder cofounder owner ceo cto coo cfo president director manager employee maintainer " +
    "developer developers engineering ops devops sre oncall " +
    "admin admins administrator administrators sysadmin superadmin superuser root sudo system sys sysop " +
    "operator mod mods moderator moderators moderation reviewer reviewers coach coaches referee police " +
    "authority " +
    "postmaster hostmaster webmaster mailer mailerdaemon noreply donotreply bounce bounces listmaster www " +
    "mail email smtp imap ftp dns ns mx " +
    "api app apps web site cdn static assets img images files uploads download downloads health metrics " +
    "monitor monitoring docs documentation wiki git github source code staging stage prod production test " +
    "testing tests beta alpha demo sandbox localhost internal config server servers backup backups cron " +
    "worker webhook webhooks oauth auth sso callback graphql rss feed feeds sitemap robots favicon manifest " +
    "me you my mine self account accounts profile profiles user users member members people person settings " +
    "preferences login logout signin signout signup register join welcome onboarding verify verification " +
    "confirm password reset recover recovery unsubscribe offline home today dashboard explore search discover " +
    "notifications inbox messages message chat groups group challenges challenge leaderboard leaderboards " +
    "rankings buddies friends followers following log history workouts progress recap review records " +
    "achievements badges exercises routines plans body food journal insights trash day share habits tools " +
    "about faq changelog features streaks social export import calendar report reports u " +
    "null nil none undefined nan true false void anonymous anon guest unknown deleted deleteduser removed " +
    "suspended banned nobody everyone all here channel someone default example sample bot bots robot console " +
    "everybody"
  ).split(" "),
);

const CONTAINS = [
  BRAND,
  "administrator",
  "moderator",
  "superuser",
  "superadmin",
  "sysadmin",
  "webmaster",
  "postmaster",
  "hostmaster",
  "helpdesk",
  "trustandsafety",
  "customersupport",
  "customerservice",
  "officialaccount",
  "staffaccount",
];

const AFFIXES = ["admin", "official", "verified", "moderat"];

const TOKENS = new Set(
  (
    "admin admins mod mods staff support security official verified system sysop root sudo owner founder " +
    "ceo helpdesk abuse noreply postmaster webmaster"
  ).split(" "),
);

const translate = (text: string, table: Readonly<Record<string, string>>) =>
  [...text].map((ch) => table[ch] ?? ch).join("");

// Python `str.isalpha` is Unicode-aware; `\p{L}` is the closest equivalent.
const core = (text: string, table: Readonly<Record<string, string>>) =>
  [...translate(text.toLowerCase(), table)].filter((ch) => /\p{L}/u.test(ch)).join("");

export function mentionsBrand(text: string): boolean {
  return CONFUSABLES.some((t) => core(text, t).includes(BRAND));
}

function matches(handle: string, table: Readonly<Record<string, string>>): boolean {
  const c = core(handle, table);
  if (RESERVED.has(c)) return true;
  if (CONTAINS.some((w) => c.includes(w))) return true;
  if (AFFIXES.some((a) => c.startsWith(a) || c.endsWith(a))) return true;
  return translate(handle, table)
    .split(/[_0-9]+/)
    .some((w) => w !== "" && TOKENS.has(w));
}

/** Handles only an official account may hold. */
export function isReserved(handle: string): boolean {
  const h = handle.toLowerCase();
  return RESERVED.has(h) || CONFUSABLES.some((t) => matches(h, t));
}

/** Python `_check_handle`: normalises, then 422 for the format and 409 for a reserved handle. */
export function checkHandle(raw: string, allowReserved = false): string {
  const handle = raw.trim().toLowerCase().replace(/^@+/, "");
  if (!HANDLE_RE.test(handle)) throw new HttpError(422, HANDLE_FORMAT);
  if (!allowReserved && isReserved(handle)) throw new HttpError(409, HANDLE_RESERVED);
  return handle;
}
