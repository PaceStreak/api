# Architecture

Nothing is built yet. This records the shape the API has to fit, so the first
commit does not have to guess.

## Where it sits

```text
www.pacestreak.com     Cloudflare Pages (static)   →  PaceStreak/web    the public site
app.pacestreak.com     Cloudflare Pages            →  PaceStreak/app    the product
api.pacestreak.com     THIS REPOSITORY             →  the backend
blog.pacestreak.com    Cloudflare Pages (static)   →  PaceStreak/blog   the build log
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

Undecided, but the surrounding infrastructure is entirely serverless and
free-tier: Cloudflare Pages for the static sites, GitHub Actions for monitoring.
An API that needs a long-running VM breaks that pattern and its cost profile.
Cloudflare Workers plus D1 or KV is the path of least resistance; anything else
should be a deliberate, written decision rather than a default.

## What is deliberately not decided here

Language, framework, database and ORM. Recording those before there is a single
endpoint would be premature. What is recorded above is only the set of things
that are *already true* because of choices made elsewhere.
