# PaceStreak API

Backend for [PaceStreak](https://www.pacestreak.com), a workout streak tracker.
Will be served from **`api.pacestreak.com`**.

Auth is built: email/password signup and login, RS256 access tokens, rotating
refresh tokens with reuse detection, CSRF-protected cookie transport, and two
independent revocation paths — log out this device, or log out everywhere.
Also: email verification, password reset and change, remote session
management, and TOTP two-factor with recovery codes. Everything else this API
will eventually do (streaks, workouts, export) is still undecided.

Copyright (c) 2026 PaceStreak. Licensed under [AGPL-3.0](./LICENSE) — anyone
running a modified version of this over a network must offer its source to
their users. That is the point of AGPL over GPL for a hosted service.

## Status

| | |
| --- | --- |
| Stack | FastAPI, PostgreSQL, Redis, on Docker Compose |
| Hostname | `api.pacestreak.com` (not yet pointed anywhere) |
| Consumers | `PaceStreak/app` (the product frontend, also unbuilt) |
| Monitoring | To be added to [`PaceStreak/status`](https://github.com/PaceStreak/status) once it responds |

## Quick start

```bash
make keys          # generate the RS256 keypair into ./keys
cp .env.example .env
make dev           # build and start api + postgres + redis, with reload
make migrate       # apply migrations (in a second terminal, once healthy)
```

The API is on `http://localhost:8000`, interactive docs at `/docs`.

```bash
make logs          # tail the api container
make ps            # container status
make down          # stop
make clean         # stop and delete both data volumes (Postgres and Redis)
```

## Auth endpoints

All under `/v1/auth`, per the versioning rule below.

| Method | Path | Auth required | Purpose |
| --- | --- | --- | --- |
| `POST` | `/signup` | — | Create an account. Returns `201`. Does **not** log you in. |
| `POST` | `/login` | — | Exchange credentials for a token pair, or an MFA challenge. |
| `POST` | `/refresh` | refresh cookie + CSRF header | Rotate the refresh token, mint a new access token. |
| `POST` | `/logout` | refresh cookie + CSRF header | End this session only. |
| `POST` | `/logout-all` | bearer | End every session for this user, on every device. |
| `GET` | `/me` | bearer | The current user. |
| `POST` | `/verify-email` | — | Redeem a link from the verification email. |
| `POST` | `/resend-verification` | — | Request another verification link. |
| `POST` | `/forgot-password` | — | Email a reset link. Always reports success. |
| `POST` | `/reset-password` | reset token | Set a new password and sign out everywhere. |
| `POST` | `/change-password` | bearer + current password | Change password, keep this session, end the others. |
| `GET` | `/sessions` | bearer | List active sessions, with the current one flagged. |
| `DELETE` | `/sessions/{id}` | bearer | End one session remotely. |
| `GET` | `/2fa` | bearer | Two-factor status and remaining recovery codes. |
| `POST` | `/2fa/setup` | bearer | Generate a TOTP secret and provisioning URI. |
| `POST` | `/2fa/enable` | bearer + password + code | Confirm setup, receive recovery codes. |
| `POST` | `/2fa/verify` | MFA challenge | Second half of login. TOTP or a recovery code. |
| `POST` | `/2fa/recovery-codes` | bearer + code | Replace the recovery codes. |
| `POST` | `/2fa/disable` | bearer + password + code | Turn two-factor off. |

The access token goes in an `Authorization: Bearer` header; the refresh token
is an httpOnly cookie you never touch directly. There is no endpoint that
issues a CSRF token — it arrives in the `csrf_token` cookie at login and is
*replaced on every refresh*, so re-read it each time and send it back as
`X-CSRF-Token`. Passwords must be **at least 16 characters**.

In production the cookies carry the `__Secure-` prefix and `Domain=pacestreak.com`
so `app.pacestreak.com` can send them here — see `app/auth/router.py` and
`CLAUDE.md`/`ARCHITECTURE.md` for why. Locally, with `COOKIE_SECURE=False`,
they are named `refresh_token` / `csrf_token` with no prefix, because the
prefix requires `Secure` and local development is plain HTTP.

Full design in [ARCHITECTURE.md](./ARCHITECTURE.md).

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
far more expensive than carrying one from the first commit. Every response
under `/v1` also carries a `PaceStreak-Version` header naming the URL version
that served it. Full policy - what counts as a breaking change, how `/v2`
would get added, how a version eventually gets deprecated - is in
[VERSIONING.md](./VERSIONING.md).

### Data export is a product promise

The public site states: *"Full JSON and CSV export from day one."* Export is a
launch requirement, not a later feature — design the schema so a complete export
is a query, not a migration.

## Migrations

Alembic is the only thing allowed to change the schema.

```bash
make migration m="add whatever"   # autogenerate from model changes
make migrate                      # apply, inside the running containers
make current                      # what revision the database is on
make history                      # the full chain
make downgrade                    # back one revision
```

`RUN_MIGRATIONS=1` in `.env` also runs `alembic upgrade head` from the
container entrypoint on boot — off by default so a multi-replica deploy does
not race itself; see `docker/entrypoint.sh`.

## Tests

```bash
make dev      # the suite runs against the real Postgres and Redis
make test
```

Nothing is mocked: the behaviour under test is mostly about transactions,
rotation and revocation, which a mock would not exercise. Every test starts
from an empty database and a flushed Redis.

## Known gaps

- **`totp_last_used_step` prevents a TOTP code being replayed only for
  *this* installation's own login flow.** It does not protect a code shared
  out-of-band before it is used once here.
- **No account lockout after repeated failed logins** beyond the per-IP rate
  limit in `app/ratelimit.py` — a distributed attacker still gets
  `RATE_LIMIT_LOGIN` guesses per IP.
- **No outbound email provider wired in.** `EMAIL_BACKEND=console` (the
  default) logs the message instead of sending it; `smtp` needs a real
  `SMTP_HOST`. Deciding on a provider is a separate, deliberate choice per
  CLAUDE.md's "no third-party services on the free tier" stance — SMTP itself
  is a protocol, not a vendor, so this doesn't force that decision.

## Local development

See **Quick start** above for the container workflow. Without containers:

```bash
make install       # uv sync
make migrate-local # apply migrations to the DATABASE_URL in .env
make run           # fastapi dev
```

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the pieces fit and why
- [VERSIONING.md](./VERSIONING.md) — the API versioning and deprecation policy
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to work on this
- [SECURITY.md](./SECURITY.md) — reporting a vulnerability
- [CHANGELOG.md](./CHANGELOG.md) — what changed
- [Infrastructure](https://github.com/PaceStreak/infra) — DNS, Cloudflare, runbooks
