# Security Policy

## Reporting

**Do not open a public issue.** Email **<hello@pacestreak.com>** with what you
found, how to reproduce it, and the impact. You will get an acknowledgement
within 72 hours. There is no bug bounty; what you will get is a straight answer.

This file is kept per-repository, alongside the organisation-wide copy in
[PaceStreak/.github](https://github.com/PaceStreak/.github), so the policy
travels with the code if this repository is forked or mirrored.

## Scope

This service holds user account data, credentials, and session cookies, which
makes it the highest-value target in the organization.

| In scope | Out of scope |
| --- | --- |
| Authentication and session handling, including 2FA/TOTP and recovery codes | Cloudflare and GitHub infrastructure |
| Authorization — reading or writing another user's data | Findings with no demonstrated impact |
| Injection, SSRF, deserialization | Rate limits configured too loosely, unless it enables something worse |
| Anything that leaks the `Domain=pacestreak.com` cookie, or bypasses CSRF or rate limiting entirely | Social engineering |

## Known and deliberate

- **The session cookie is scoped to the whole registrable domain.** It has to
  be: the frontend and this API are on different subdomains. The mitigation is
  that nothing untrusted is ever hosted under `pacestreak.com` — if you find
  something that is, *that* is the report worth sending.
- **`SameSite=Lax`, not `None`.** The two hosts are same-site, so `Lax` is
  sufficient and narrower.
