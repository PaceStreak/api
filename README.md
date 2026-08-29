# PaceStreak API

Backend for [PaceStreak](https://www.pacestreak.com), a workout streak tracker.
Will be served from **`api.pacestreak.com`**.

Python 3.14, FastAPI, and the Astral toolchain — [uv](https://docs.astral.sh/uv/)
for packaging, [Ruff](https://docs.astral.sh/ruff/) for linting and formatting,
[ty](https://docs.astral.sh/ty/) for type checking.

**There are no product endpoints yet.** What exists is the skeleton, the
toolchain, and the constraints below encoded as code and tests rather than as
prose that can drift.

Copyright (c) 2026 PaceStreak. Licensed under [AGPL-3.0](./LICENSE) — anyone
running a modified version of this over a network must offer its source to
their users. That is the point of AGPL over GPL for a hosted service.

## Status

| | |
| --- | --- |
| Stack | Python 3.14 · FastAPI · uv · Ruff · ty |
| Hostname | `api.pacestreak.com` (not yet pointed anywhere) |
| Consumers | `PaceStreak/app` (the product frontend, also unbuilt) |
| Hosting | **Undecided.** See [Deployment](#deployment) — this is the open question. |
| Monitoring | To be added to [`PaceStreak/status`](https://github.com/PaceStreak/status) once it responds |

## Getting started

```bash
uv sync --locked --all-groups   # or: make install
uv run pre-commit install       # or: make dev
make run                        # http://127.0.0.1:8000
```

`make help` lists everything. There is no `pip`, no `requirements.txt` and no
`python -m venv` step — uv manages the interpreter named in `.python-version`
as well as the packages.

Before pushing:

```bash
make check      # ruff check, ty, pytest, ruff format --check
```

That is exactly what CI runs, so it passing locally means the pull request
passes.

## Layout

```text
app/            The application package.
  main.py       create_app() - the factory. `app.main:app` is the ASGI entry point.
  config.py     Settings, environment-driven. No secret has a working default.
  security.py   Session cookie attributes, in one place, asserted by tests.
  health.py     /health. Deliberately not under /v1 - see below.
  v1/           Versioned public API. Empty, and reserved from the first commit.
tests/          pytest. 100% coverage today; keep it meaningful, not decorative.
Dockerfile      Multi-stage, non-root, ~55MB.
```

## Constraints already settled

These are not suggestions. Each one is either load-bearing for the frontend or
was learned by breaking something. **Where a constraint could be expressed as a
test, it is** — see `tests/test_security.py` and `tests/test_cors.py`.

### Cookies and CORS

`api.pacestreak.com` and `app.pacestreak.com` are **cross-origin but same-site**
— they share the registrable domain `pacestreak.com`. Consequences:

- **`SameSite=Lax` works.** You do *not* need `SameSite=None`, and reaching for
  it would needlessly widen exposure.
- **The auth cookie must be scoped `Domain=pacestreak.com`** to be sent from the
  frontend to this API. That means it is sent to *every* subdomain, so nothing
  untrusted may ever be hosted under `pacestreak.com`.
- **You cannot use the `__Host-` prefix** — it forbids a `Domain` attribute.
  `__Secure-` with `HttpOnly`, `Secure`, `SameSite=Lax` is what `security.py`
  implements.
- CORS must send `Access-Control-Allow-Credentials: true` and an **explicit**
  `Access-Control-Allow-Origin`. A wildcard is rejected by the browser when
  credentials are included, so `"*"` here produces a *blocked* request, not a
  permissive one. `Settings` raises at construction if you try.

### The frontend's CSP will block this API until it is widened

`PaceStreak/app` (and `web`) ship:

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

Client-facing routes live under `/v1/`. Retrofitting a version prefix after
clients exist is far more expensive than carrying one from the first commit.

**`/health` is deliberately outside `/v1`.** It is an operational endpoint, not
part of the client contract: when `/v2` ships, the uptime monitor should not
have to move, and `/v1` should not have to be kept alive to answer a health
check. `tests/test_health.py` asserts both halves of that.

The health response body is `{"status": "ok", "version": …}`. The monitor
matches on the body, not just the status code — a container that boots and then
cannot reach its database still answers 200 from a bare handler.

### Data export is a product promise

The public site states: *"Full JSON and CSV export from day one."* Export is a
launch requirement, not a later feature — design the schema so a complete export
is a query, not a migration.

## Deployment

**This is the open decision, and it is a real one.**
[ARCHITECTURE.md](./ARCHITECTURE.md) previously assumed Cloudflare Workers plus
D1, because everything else in this organization is free-tier serverless on
Cloudflare. **Choosing Python and FastAPI rules that out** — Cloudflare's Python
Workers run under Pyodide and will not carry FastAPI with a real database
driver.

So this service needs somewhere to run. `Dockerfile` builds a ~55MB non-root
image that any container host will take; Google Cloud Run and Fly.io are the two
that scale to zero and stay near-free at this traffic. The decision is recorded
as open in [ARCHITECTURE.md](./ARCHITECTURE.md#hosting) and belongs in
[`PaceStreak/infra`](https://github.com/PaceStreak/infra)'s `DECISIONS.md` once
made.

**Do not create the `api.pacestreak.com` DNS record before something answers
on it.** A proxied Cloudflare record with nothing behind it returns `522`, which
reads to a visitor as a broken product rather than an unlaunched one.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the pieces fit and why
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to work on this
- [SECURITY.md](./SECURITY.md) — reporting a vulnerability
- [CHANGELOG.md](./CHANGELOG.md) — what changed
- [Infrastructure](https://github.com/PaceStreak/infra) — DNS, Cloudflare, runbooks
