# Contributing

See the [organization guide](https://github.com/PaceStreak/.github/blob/main/CONTRIBUTING.md)
for anything general. This file covers what is specific to the API.

## Before you start

**Open an issue first.** There is no code here yet, so any pull request is
effectively a proposal about the stack. That is a conversation, not a diff.

## Non-negotiables

These come from decisions already made elsewhere and will fail review if broken:

- **Routes are versioned.** `/v1/…` from the first endpoint.
- **Auth cookies:** `__Secure-` prefix, `HttpOnly`, `Secure`,
  `SameSite=Lax`, `Domain=pacestreak.com`. Not `__Host-` — it forbids `Domain`,
  which this setup requires. Not `SameSite=None` — the frontend and API are
  same-site, so it buys nothing and widens exposure.
- **CORS sends an explicit origin**, never a wildcard, because credentials are
  included and a wildcard is rejected outright with them.
- **Export exists.** The product promises full JSON and CSV export. If a schema
  change makes export harder, that is a design problem, not a later chore.

## When you add the first endpoint

Do these in the same pull request, or the frontend breaks silently:

1. Widen `connect-src` in [`PaceStreak/app`](https://github.com/PaceStreak/app)'s
   `public/_headers` to include `https://api.pacestreak.com`. The CSP is
   `default-src 'self'`, so the browser blocks the call with no visible error on
   the page.
2. Add a health endpoint and register it in
   [`PaceStreak/status`](https://github.com/PaceStreak/status) with a body
   content assertion — a 200 alone does not prove the service works.

## Security

Do not open an issue for a vulnerability. Email **<hello@pacestreak.com>** —
see [SECURITY.md](./SECURITY.md).
