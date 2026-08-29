# Architecture

The stack is chosen; no product endpoints exist yet. This records the shape the
API has to fit and the one question still genuinely open.

## Stack

Python 3.14, FastAPI, and the Astral toolchain: **uv** for packaging and the
interpreter, **Ruff** for linting and formatting, **ty** for type checking.

**Why it was chosen:** the owner's preference, and a deliberate one. The
practical consequences are recorded below rather than left to be discovered.

**ty is pre-1.0** (`0.0.x`). Its diagnostics still move between releases, so it
is pinned through `uv.lock`; a new version cannot break CI without an explicit,
reviewable dependency bump. If it ever becomes an obstacle, swapping it for
mypy is a `pyproject.toml` change, not a rewrite - nothing depends on
ty-specific syntax.

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

## Hosting

**This is the open decision.**

An earlier version of this file said Cloudflare Workers plus D1 was the path of
least resistance, because everything else in this organization is free-tier
serverless on Cloudflare. **Choosing FastAPI closes that path.** Cloudflare's
Python Workers run under Pyodide; they will not carry FastAPI together with a
real database driver. This is the deliberate, written decision that the earlier
text asked for, and the cost is stated plainly: **this is the first component
that will not be free.**

What is already true:

- `Dockerfile` produces a ~55MB non-root image. Any container host will take
  it, so this decision is not locked in by the code.
- Scale-to-zero matters more than throughput at this traffic. Google Cloud Run
  and Fly.io both do it and both stay near-free at zero usage.
- Whatever runs it sits behind Cloudflare's proxy on `api.pacestreak.com`, so
  the edge, the WAF and TLS termination are unchanged from the rest of the
  estate.
- **Do not create the DNS record until something answers on it.** A proxied
  record with nothing behind it returns `522`, which reads as a broken product
  rather than an unlaunched one.

Record the choice in [`PaceStreak/infra`](https://github.com/PaceStreak/infra)'s
`DECISIONS.md` when it is made.

## What is deliberately not decided here

Database and ORM. Recording those before there is a single endpoint would be
premature - but note that the hosting decision above and the database decision
are coupled, and picking a managed Postgres before picking a host is how a
service ends up paying for cross-region egress on every query.
