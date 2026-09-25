# Architecture

How the API fits together and why. The feature list is in
[README.md](./README.md#what-it-does); this file is the reasoning.

## Where it sits

```text
www.pacestreak.com     Cloudflare Pages (static)   →  PaceStreak/web    the public site
app.pacestreak.com     Cloudflare Pages (planned)  →  PaceStreak/app    the product
api.pacestreak.com     THIS REPOSITORY             →  the backend
blog.pacestreak.com    Cloudflare Pages (static)   →  PaceStreak/blog   the blog
status.pacestreak.com  GitHub Pages (Upptime)      →  public status page
```

All of them sit under one registrable domain, `pacestreak.com`, on Cloudflare DNS.
That single fact drives most of the constraints below.

## Trust boundary

The auth cookie must be scoped `Domain=pacestreak.com` so the frontend can send
it here. There is therefore **one trust boundary for the whole domain**: any
subdomain that can set or read cookies can reach this API's session.

Practical rules that follow:

- No user-generated content on any `*.pacestreak.com` hostname.
- No third-party tooling (analytics dashboards, preview environments, status
  widgets) on a subdomain. Use a separate domain if one is ever needed.
- Treat every subdomain as production, because to the cookie it is.

## Statelessness and deployment

**Decided, and it breaks the free-tier pattern elsewhere in this org.** The
stack is FastAPI, PostgreSQL and Redis, run via Docker Compose
(`compose.yaml`, `Dockerfile`). An earlier attempt at this was reverted at the
owner's request specifically because a prior session scaffolded it
unasked — see `CHANGELOG.md` and the git history of `ab6c736`. Two findings
from that attempt are still true regardless of framework and are worth
repeating: Python Workers run under Pyodide, so **FastAPI rules out
Cloudflare Workers** as a hosting target outright; and a health route
typo (`/heatlth`) would have made monitoring report a permanent outage - the
route is `/health` here.

This means **hosting is still an open, unpaid decision** the rest of the org's
infrastructure does not need: `web`, `blog` and `status` are static or
Git-connected Pages projects with no server to run. This API needs a place to
run a container plus a Postgres instance plus a Redis instance around the
clock - Cloudflare Pages cannot do that. Fly.io, Railway, Render, or a small
VPS are the shapes that fit `compose.yaml` most directly; whichever is chosen,
`docker/entrypoint.sh` already reads `WEB_CONCURRENCY` and
`FORWARDED_ALLOW_IPS` the way a container platform expects.

## Auth

Token-based: a short-lived RS256-signed access token (15 min, bearer header,
verified by signature alone - no database hit) and a long-lived, single-use,
rotating refresh token (7 days, httpOnly cookie). Reusing an already-rotated
refresh token burns its entire session, which is the signature of a stolen
token. TOTP two-factor sits between password and session issuance as a
separate MFA challenge token, never as an extension of the access token.

Full file-by-file design lives in the code itself (`app/auth/*.py`) rather
than duplicated here, since duplicating it would just be a second place for it
to go stale. `app/auth/service.py` and `app/auth/router.py` carry the
"why", not just the "what", on every non-obvious decision - reuse detection,
the dummy password hash for timing, generic error messages that avoid
enumeration, TOTP replay protection, and why `/2fa/enable` requires the
password.

Known gaps, all deliberate and tracked so they are not rediscovered as
surprises: see [README.md#known-gaps](./README.md#known-gaps).

## URL structure and versioning

`app/versioning.py` defines `API_V1_PREFIX = "/v1"` once. `app/v1/router.py`
is the only file that mounts anything under it: every feature router is
included unprefixed and given its `/v1` by the aggregator rather than
hardcoding it itself. A new feature area follows
the same shape: its own `app/<feature>/router.py` with no version in its own
prefix, added to `app/v1/router.py`'s `include_router` calls.

This is what makes `/v2` additive rather than a rewrite when it's eventually
needed - see [VERSIONING.md](./VERSIONING.md) for the full policy on what
counts as a breaking change, how a `/v2` gets added feature-area by feature
area, and how a version gets deprecated with `Deprecation`/`Sunset` headers
rather than just a changelog entry.

## The engine: pure functions, recomputed on read

`app/game/service.py`'s `snapshot()` loads one user's history and runs the pure
engines over it: streak, XP, levels, records, achievements. `recompute()`
persists the projections (`user_stats`, `personal_records`, new achievements)
and emits events for anything new.

Nothing a user sees about their streak is stored as authoritative state. There
is no cron that closes a week. Editing last month's session corrects every
streak, record and total after it, with no incremental bookkeeping to get wrong.
It is linear in history; if it ever becomes slow, `snapshot()` is the one
function to optimise.

Week statuses, in the order the engine decides them: `kept` (target met),
`paused` (a declared pause covers 4+ days of the week), `open` (the current
week), `repaired`, `frozen` (auto-spent, only with a run to protect), `missed`.

## Sync

Workouts are created with client-chosen ids and upserted, last-write-wins on
the client's `client_updated_at`. A single Postgres sequence (`sync_seq`) is the
change cursor: `/workouts/changes?since=N` returns everything after N,
deletions included. A sequence, not a timestamp, because timestamps collide and
clocks step backwards.

## The worker

`python -m app.worker` ticks every `WORKER_INTERVAL_SECONDS`, taking a Redis
lock per tick (two replicas are safe) and giving every notification a dedupe
key (a retried tick cannot notify twice). `--once` runs one tick for cron-style
platforms. Anyone on an active pause gets no nudges.

## Privacy boundaries in code

- Social visibility: `app/social/service.py`, checked at emit and again at read.
- Age gates: `Profile.social_allowed()`. Under 16: nothing is shown to anyone.
- Moderation removes social privileges only; the training log is untouched.
- The calendar feed stores only a SHA-256 of its token and never includes notes.
- Reserved handles: `is_reserved()` in `app/profile/router.py`; only
  `POST /admin/users/{id}/official` may assign one.

## What is deliberately not decided here

Where this actually runs in production (see "Statelessness and deployment"
above), and which email provider sends verification and reset mail.
