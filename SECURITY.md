# Security Policy

## Reporting

**Do not open a public issue.** Email **<hello@pacestreak.com>** with what you
found, how to reproduce it, and the impact. You will get an acknowledgement
within 72 hours. There is no bug bounty; what you will get is a straight answer.

This file exists per-repository because community health files in a **public**
`.github` repository do not apply to **private** ones, and this repository is
private.

## Scope

Once this service exists, it holds user training data and session cookies, which
makes it the highest-value target in the organization.

| In scope | Out of scope |
| --- | --- |
| Authentication and session handling | Cloudflare and GitHub infrastructure |
| Authorization — reading or writing another user's data | Findings with no demonstrated impact |
| Injection, SSRF, deserialization | Rate limiting on unauthenticated endpoints, unless it enables something worse |
| Anything that leaks the `Domain=pacestreak.com` cookie | Social engineering |

## Known and deliberate

- **The session cookie is scoped to the whole registrable domain.** It has to
  be: the frontend and this API are on different subdomains. The mitigation is
  that nothing untrusted is ever hosted under `pacestreak.com` — if you find
  something that is, *that* is the report worth sending.
- **`SameSite=Lax`, not `None`.** The two hosts are same-site, so `Lax` is
  sufficient and narrower.
