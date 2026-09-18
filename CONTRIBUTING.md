# Contributing

See the [organization guide](https://github.com/PaceStreak/.github/blob/main/CONTRIBUTING.md)
for anything general. This file covers what is specific to the API.

## Before you start

**Open an issue first for anything that isn't auth.** The stack (FastAPI,
PostgreSQL, Redis, Docker Compose) and the auth system are built — see
[README.md](./README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md). Everything
else about the product (streaks, workouts, export) is still a proposal, so a
pull request there is a conversation about the schema first, not just a diff.

## Non-negotiables

These come from decisions already made elsewhere and will fail review if broken:

- **Routes are versioned.** `/v1/…`, mounted from `app/versioning.py`'s
  `API_V1_PREFIX` via `app/v1/router.py` — a new router includes into that
  file unprefixed, it does not hardcode `/v1` itself. Full policy on what
  counts as a breaking change and how `/v2` gets added:
  [VERSIONING.md](./VERSIONING.md).
- **Auth cookies:** `__Secure-` prefix, `HttpOnly`, `Secure`,
  `SameSite=Lax`, `Domain=pacestreak.com`. Not `__Host-` — it forbids `Domain`,
  which this setup requires. Not `SameSite=None` — the frontend and API are
  same-site, so it buys nothing and widens exposure.
- **CORS sends an explicit origin**, never a wildcard, because credentials are
  included and a wildcard is rejected outright with them.
- **Export exists.** The product promises full JSON and CSV export. If a schema
  change makes export harder, that is a design problem, not a later chore.

## When `PaceStreak/app` makes its first call to this API

`app` doesn't exist yet, so this hasn't happened. Do these in the same pull
request as whichever one wires up the first `fetch()`, or the frontend
breaks silently:

1. Widen `connect-src` in [`PaceStreak/app`](https://github.com/PaceStreak/app)'s
   `public/_headers` to include `https://api.pacestreak.com`. The CSP is
   `default-src 'self'`, so the browser blocks the call with no visible error on
   the page.
2. Register `/health` (already built - `app/main.py`) in
   [`PaceStreak/status`](https://github.com/PaceStreak/status) with a body
   content assertion — a 200 alone does not prove the service works.

## Security

Do not open an issue for a vulnerability. Email **<hello@pacestreak.com>** —
see [SECURITY.md](./SECURITY.md).
