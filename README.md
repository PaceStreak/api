# PaceStreak API

Backend for [PaceStreak](https://www.pacestreak.com), a workout streak tracker.
Will be served from **`api.pacestreak.com`**.

**Nothing is built here yet.** This repository exists so the decisions below are
recorded before code is written, rather than rediscovered afterwards.

Copyright (c) 2026 PaceStreak. Licensed under [AGPL-3.0](./LICENSE) — anyone
running a modified version of this over a network must offer its source to
their users. That is the point of AGPL over GPL for a hosted service.

## Status

| | |
| --- | --- |
| Stack | Undecided |
| Hostname | `api.pacestreak.com` (not yet pointed anywhere) |
| Consumers | `PaceStreak/app` (the product frontend, also unbuilt) |
| Monitoring | To be added to [`PaceStreak/status`](https://github.com/PaceStreak/status) once it responds |

## Constraints already settled

These are not suggestions. Each one is either load-bearing for the frontend or
was learned by breaking something.

### Cookies and CORS

`api.pacestreak.com` and `www.pacestreak.com` are **cross-origin but same-site**
— they share the registrable domain `pacestreak.com`. Consequences:

- **`SameSite=Lax` works.** You do *not* need `SameSite=None`, and reaching for
  it would needlessly widen exposure.
- **The auth cookie must be scoped `Domain=pacestreak.com`** to be sent from the
  frontend to this API. That means it is sent to *every* subdomain, so nothing
  untrusted may ever be hosted under `pacestreak.com`.
- **You cannot use the `__Host-` prefix** — it forbids a `Domain` attribute.
  Use `__Secure-` with `HttpOnly`, `Secure`, `SameSite=Lax`.
- CORS must send `Access-Control-Allow-Credentials: true` and an **explicit**
  `Access-Control-Allow-Origin` — a wildcard is rejected when credentials are
  included.

### The frontend's CSP will block this API until it is widened

`PaceStreak/web` (and `app`, when it exists) ships:

```http
Content-Security-Policy: default-src 'self'; connect-src 'self'; …
```

The first `fetch()` to `api.pacestreak.com` will be blocked by the browser,
silently from the page's perspective. Whoever wires the first call must add
`connect-src 'self' https://api.pacestreak.com` to that site's `public/_headers`
in the same change.

In practice the caller is `app.pacestreak.com`, not `www` — the public site is
deliberately static and makes no authenticated requests at all.

### Versioning

Prefix routes with `/v1/`. Retrofitting a version prefix after clients exist is
far more expensive than carrying one from the first commit.

### Data export is a product promise

The public site states: *"Full JSON and CSV export from day one."* Export is a
launch requirement, not a later feature — design the schema so a complete export
is a query, not a migration.

## Local development

Nothing to run yet. When there is, this section documents the one command that
starts it and the one that runs the tests. Anything longer than that is a bug in
the setup.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the pieces fit and why
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to work on this
- [SECURITY.md](./SECURITY.md) — reporting a vulnerability
- [CHANGELOG.md](./CHANGELOG.md) — what changed
- [Infrastructure](https://github.com/PaceStreak/infra) — DNS, Cloudflare, runbooks
