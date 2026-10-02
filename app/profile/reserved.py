"""Which handles and display names only an official account may use.

A list alone can't do this: `admin_user`, `the_admin`, `adm1n` and `admin2`
are all different strings. So a handle is reserved if any of four rules
match, each on a normalised form:

1. it is in RESERVED as typed;
2. its *core* is in RESERVED - lowercased, look-alike digits folded back to
   letters, everything else dropped, so `_adm1n_2` reads as `admin`;
3. its core contains a word from CONTAINS anywhere (long words with no
   innocent superstrings), or starts or ends with one from AFFIXES - only the
   ends, so `badminton` and the name `padmini` stay available;
4. one of its words, split on underscores and digits, is in TOKENS - whole
   words only, so `run_mod` is reserved but `model` and `modern` are not.

Existing handles are never re-checked; this applies when a handle is set.
"""

import re

BRAND = "pacestreak"

# Look-alike characters folded back before matching, so "Pace5treak",
# "pace_streak" and "PACE.STREAK" read as what they are. A "1" or "|" can
# stand for "l" or "i", so both readings are checked: "adm1n" and "officia1".
_CONFUSABLES = (
    str.maketrans(
        {"0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "$": "s", "@": "a", "|": "l"}
    ),
    str.maketrans(
        {"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "$": "s", "@": "a", "|": "i"}
    ),
)

# Exact words, checked as typed and as the core.
# fmt: off
RESERVED = frozenset(
    {
        # The brand and anything that reads as speaking for it.
        "pacestreak", "official", "verified", "team", "staff", "crew", "hq",
        "support", "help", "helpdesk", "helpcenter", "contact", "hello", "info",
        "feedback", "news", "announcements", "updates", "press", "media",
        "blog", "status", "security", "abuse", "trust", "safety", "legal",
        "privacy", "terms", "policy", "copyright", "dmca", "compliance",
        "billing", "payments", "pricing", "sales", "marketing", "partners",
        "careers", "jobs", "hiring", "investors", "founder", "cofounder",
        "owner", "ceo", "cto", "coo", "cfo", "president", "director",
        "manager", "employee", "maintainer", "developer", "developers",
        "engineering", "ops", "devops", "sre", "oncall",
        # Authority.
        "admin", "admins", "administrator", "administrators", "sysadmin",
        "superadmin", "superuser", "root", "sudo", "system", "sys",
        "sysop", "operator", "mod", "mods", "moderator", "moderators",
        "moderation", "reviewer", "reviewers", "coach", "coaches", "referee",
        "police", "authority",
        # Mail and DNS conventions (RFC 2142 and friends).
        "postmaster", "hostmaster", "webmaster", "mailer", "mailerdaemon",
        "noreply", "donotreply", "bounce", "bounces", "listmaster", "www",
        "mail", "email", "smtp", "imap", "ftp", "dns", "ns", "mx",
        # Hosts and infrastructure.
        "api", "app", "apps", "web", "site", "cdn", "static", "assets", "img",
        "images", "files", "uploads", "download", "downloads",
        "health", "metrics", "monitor", "monitoring", "docs",
        "documentation", "wiki", "git", "github", "source", "code", "staging",
        "stage", "prod", "production", "test", "testing", "tests", "beta",
        "alpha", "demo", "sandbox", "localhost", "internal", "config",
        "server", "servers", "backup", "backups", "cron", "worker", "webhook",
        "webhooks", "oauth", "auth", "sso", "callback", "graphql", "rss",
        "feed", "feeds", "sitemap", "robots", "favicon", "manifest",
        # App routes and account words a profile URL could be confused with.
        "me", "you", "my", "mine", "self", "account", "accounts", "profile",
        "profiles", "user", "users", "member", "members", "people", "person",
        "settings", "preferences", "login", "logout", "signin", "signout",
        "signup", "register", "join", "welcome", "onboarding", "verify",
        "verification", "confirm", "password", "reset", "recover", "recovery",
        "unsubscribe", "offline", "home", "today", "dashboard", "explore",
        "search", "discover", "notifications", "inbox", "messages", "message",
        "chat", "groups", "group", "challenges", "challenge", "leaderboard",
        "leaderboards", "rankings", "buddies", "friends", "followers",
        "following", "log", "history", "workouts", "progress", "recap",
        "review", "records", "achievements", "badges", "exercises",
        "routines", "plans", "body", "food", "journal", "insights", "trash",
        "day", "share", "habits", "tools", "about", "faq", "changelog",
        "features", "streaks", "social", "export", "import", "calendar",
        "report", "reports", "u",
        # Placeholders and values that break code or read as nobody.
        "null", "nil", "none", "undefined", "nan", "true", "false", "void",
        "anonymous", "anon", "guest", "unknown", "deleted", "deleteduser",
        "removed", "suspended", "banned", "nobody", "everyone", "all", "here",
        "channel", "someone", "default", "example", "sample", "bot", "bots",
        "robot", "console", "everybody",
    }
)
# fmt: on

# Contained anywhere in the core: long enough that no ordinary word holds them.
CONTAINS = (
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
)

# At the start or end of the core only: `admin_user`, `the_admin`.
AFFIXES = ("admin", "official", "verified", "moderat")

# Whole words, after splitting on underscores and digits: `run_mod_42`.
# fmt: off
TOKENS = frozenset(
    {
        "admin", "admins", "mod", "mods", "staff", "support", "security",
        "official", "verified", "system", "sysop", "root", "sudo", "owner",
        "founder", "ceo", "helpdesk", "abuse", "noreply", "postmaster",
        "webmaster",
    }
)
# fmt: on


def _core(text: str, table: dict[int, str]) -> str:
    return "".join(ch for ch in text.lower().translate(table) if ch.isalpha())


def mentions_brand(text: str) -> bool:
    return any(BRAND in _core(text, table) for table in _CONFUSABLES)


def _matches(handle: str, table: dict[int, str]) -> bool:
    core = _core(handle, table)
    if core in RESERVED:
        return True
    if any(word in core for word in CONTAINS):
        return True
    if any(core.startswith(a) or core.endswith(a) for a in AFFIXES):
        return True
    words = re.split(r"[_0-9]+", handle.translate(table))
    return any(w in TOKENS for w in words if w)


def is_reserved(handle: str) -> bool:
    """Handles only an official account may hold."""
    handle = handle.lower()
    return handle in RESERVED or any(_matches(handle, table) for table in _CONFUSABLES)
