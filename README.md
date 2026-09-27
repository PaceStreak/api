# PaceStreak API

Backend for [PaceStreak](https://www.pacestreak.com), a workout streak tracker.
Will be served from **`api.pacestreak.com`**.

The whole product backend is built: about 180 routes under `/v1`, a background
worker, and a test suite that runs against real Postgres and Redis. It is not
deployed yet. Where it runs is the open decision; see
[ARCHITECTURE.md](./ARCHITECTURE.md#statelessness-and-deployment).

Copyright (c) 2026 PaceStreak. Licensed under [AGPL-3.0](./LICENSE) — anyone
running a modified version of this over a network must offer its source to
their users. That is the point of AGPL over GPL for a hosted service.

## Status

| | |
| --- | --- |
| Stack | FastAPI, PostgreSQL, Redis, on Docker Compose |
| Hostname | `api.pacestreak.com` (no DNS record yet, deliberately) |
| Consumers | `PaceStreak/app` (the product frontend, built, not deployed) |
| Tests | 162, `make test`, nothing mocked; CI runs lint, tests, `alembic check` and an image build |
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

## What it does

| Area | Module | Highlights |
| --- | --- | --- |
| Auth | `app/auth/` | Signup, login, rotating refresh with reuse detection, CSRF, email verification, reset, sessions, TOTP + recovery codes, **passkeys (WebAuthn)** |
| Profile | `app/profile/` | Onboarding, age gates (13 / 16), settings, reserved handles and brand-impersonation checks |
| Training | `app/training/` | Workouts with offline-safe batch sync and a sequence change feed, 78-exercise library, routines, custom exercises, body metrics, streak chains with **requirements**, repairs, **pauses** (incl. travel), **GPX/FIT/CSV file import**, **tags**, **gear**, **training plans** |
| Game | `app/game/` | Week-based streak engine, XP, levels, self-relative records, 23 achievements, 4 opt-in leaderboards, **weekly recap**, **year review**, **record history**, **joint (buddy/group) streaks** |
| Social | `app/social/` | Follows with approval, feed, kudos, comments, blocks, reports, **buddy streaks**, **preset encouragement**; visibility checked at emit and at read |
| Groups | `app/groups/` | Crews and coaching groups, coach consent, attendance challenges, mute, **group streak** |
| Notifications | `app/notifications/` | Inbox, Web Push (VAPID), email, per-category preferences, RFC 8058 unsubscribe |
| Account | `app/account/` | Export (JSON/CSV/ICS), import, deletion with a 30-day grace, security history, **private calendar feed** |
| Admin | `app/admin/` | Reports, moderation, append-only audit log, metrics, **official accounts** |
| Worker | `app/worker.py` | Stale-stat refresh, timezone-aware nudges (silent during a pause), weekly digest, challenge resolution, **monthly backup reminder**, deletion purge, housekeeping; writes a **heartbeat** every tick |
| Ops | `app/ops/` | `/health` (liveness), `/health/ready` (Postgres required, Redis reported), `/health/worker` (503 after three missed ticks) |

The pure engines (`game/streak.py`, `xp.py`, `levels.py`, `records.py`,
`achievements.py`, `training/pauses.py`, `training/importers.py`) do no I/O and
are tested without a database. Everything a user sees about their streak is
recomputed from their log on read; nothing is stored that can drift.

### Pauses

`/v1/pauses`: declare an injury/illness/life break. A week the pause covers
for 4+ days is `paused`: it neither breaks nor extends the run, spends and earns
no freeze, pays no XP, and is excluded from consistency. Limits: start up to 14
days back or 30 ahead, 12 weeks each, 120 days per trailing year, no overlaps;
a pause that has sheltered weeks can be ended but not deleted.

### File import

`POST /v1/workouts/import` (multipart `file`, optional `discipline`). GPX via
`defusedxml`, FIT via `fitdecode`, CSV with forgiving column names. Imported
rows are `source="import"` with a deterministic `uuid5` id and a 3-minute
duplicate window, so re-uploads never double-count. They count for the streak,
never for challenges or rewarded records.

### Calendar feed

`POST /v1/me/calendar` returns a feed URL once; only its SHA-256 is stored.
`DELETE` revokes it; creating again rotates it. The public
`GET /v1/calendar/{token}.ics` carries time, discipline, title and
duration/distance, never notes. Needs `PUBLIC_API_URL`.

### Passkeys

`/v1/auth/passkeys`: `register/options` (needs the password) then `register`;
`sign-in/options` then `sign-in` (usernameless, no allow-list, rate limited
like login). User verification is required, so a passkey sign-in skips the TOTP
step. Challenges are rows in `webauthn_challenges`, deleted on use and swept by
the worker. The relying party id defaults to the host of `FRONTEND_URL`
(`app.pacestreak.com`); set `WEBAUTHN_RP_ID` only if that must differ, and
never change it after launch - every registered passkey is bound to it.
Tests use a software authenticator that produces real signatures.

### Streak requirements, consistency, review

A chain's `requirements` ("at least 2 days of run", max 3, summing to no more
than the target) have a history like `target_history` and apply from the week
they were set. `consistency_12`/`consistency_52` join the 4-week score.
`GET /v1/me/review?year=` and `GET /v1/me/records/history?key=` read the same
snapshot as everything else. Attendance only, never volume.

### Tags, gear, plans

Workouts carry private `tags` (normalised slugs, max 8) and an optional
`gear_id`; unknown or foreign gear is dropped, not rejected, so offline edits
still sync. `/v1/gear` mileage is summed from the log, never stored.
`/v1/plans` (templates in `training/plan_templates.py`): one plan runs at a
time; what's done is read from the log, and a session moved to another day of
the same week still counts.

### Buddies, group streaks, encouragement

`/v1/buddies` pairs people with an accepted follow in either direction. A
shared week is judged from each member's own week verdicts
(`game/joint.py`), stored as `user_stats.recent_weeks` so no replay is needed.
Blocking ends a pair. Group detail includes `streak`, judged against the
owner's `streak_threshold` (50-100). `POST /v1/people/{handle}/encourage`
takes one of six preset ids, once a day per pair.

After deploying a release that adds a projected stats field, run
`make recompute-all` once.

### Recovery, email change, terms versions

`POST /v1/auth/recover` sets a password with a 2FA recovery code (no email
needed). `POST /v1/auth/change-email` needs the password and only moves the
account when the link sent to the new address is confirmed
(`/v1/auth/confirm-email-change`); the old address is told. `TERMS_VERSION`
is the date of the current terms/privacy wording: **bump it in the same
change as a material edit to /terms or /privacy on www**, and every
signed-in person is asked to accept again (`POST /v1/me/terms`).

### Crash reports and the abuse view

`POST /v1/client-errors` is unauthenticated and anonymous, rate-limited,
cut to the URL path, grouped by fingerprint and capped at 1000 groups.
Failed sign-in, 2FA, passkey and recovery attempts are recorded with the IP
and a keyed hash of the address. Admins see both under `/v1/admin/client-errors`
and `/v1/admin/abuse`; the worker sweeps both after 30 days.

### Habits, depth and shared plans

Smart reminders (`reminder_mode=smart`) nudge an hour before the most
common training hour of the last 60 days (`game/reminders.py`). Monthly goals
and rest days live under `/v1/me/monthly-goal` and `/v1/me/rest-days`; neither
touches a streak. Sets carry an optional `superset` number; imported
GPX/FIT tracks produce kilometre `splits`. Plans export and import as
`pacestreak-plan` files; `plan_sessions` challenges and coach suggestions
(`POST /v1/groups/{id}/members/{uid}/plan`, consent required) reuse the same
helpers. Group owners and admins post `/v1/groups/{id}/announcements`.

### Official accounts

`POST /v1/admin/users/{id}/official` (admin only, audited) is the only way a
reserved handle such as `pacestreak` can be assigned. Non-official accounts
cannot use the brand anywhere in a handle or display name, including with
separators or look-alike digits.

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

### Cloudflare Turnstile guards the mailer and password/recovery endpoints

`/auth/signup`, `/auth/login`, `/auth/forgot-password`, `/auth/resend-verification`
and `/auth/recover` call `app/turnstile.py` before doing anything else. This is
a deliberate, narrow exception to "no third-party services": Turnstile is
Cloudflare's own product, already trusted for DNS and the CDN, and it exists
specifically to stop a script from emptying Brevo's free SMTP quota (300/day)
by hammering signup or resend-verification, or from grinding past the per-IP
rate limits in `app/ratelimit.py` by spreading requests across addresses.

- `TURNSTILE_SECRET_KEY` unset (the default) turns verification off entirely -
  local development and the test suite need no Cloudflare account, same as
  `EMAIL_BACKEND=console`. It is **required** in production
  (`compose.prod.yaml`), enforced by `_check_production_config` in `app/main.py`.
- The frontend's site key is public by design (`app/.env.example`,
  `PUBLIC_TURNSTILE_SITE_KEY`) and renders the widget via
  `challenges.cloudflare.com`, which the app's CSP allows in `script-src`,
  `connect-src` and `frame-src` - the one embedded third-party script this
  product ships, and it is not optional.
- `/auth/resend-verification` skips the check for a caller who is already
  signed in and asking to resend to *their own* address (`get_optional_user`
  in `app/auth/dependencies.py`) - a live session already proves who they are,
  so Today's coach card and the Settings resend button need no widget. Asking
  to resend to any other address still requires a token.
- A Turnstile token is single-use: Signup's immediate auto-login after a
  successful signup call gets its own fresh token
  (`captchaRef.current.getFreshToken()` in `app/src/routes/auth/Signup.tsx`),
  not a reuse of the signup one.

### Data export is a product promise

The public site promises full export. It is built (`/v1/me/export`, JSON, CSV
and ICS), and any new table holding user data must be added to both
`build_export` and `import_data` in `app/account/router.py`, as pauses were.

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

**`make test` truncates every table in the database it points at.** Run it
against a throwaway database if the dev one holds anything you care about:

```bash
docker compose exec postgres psql -U pacestreak -c "CREATE DATABASE pacestreak_test"
DATABASE_URL=postgresql+asyncpg://pacestreak:pacestreak@localhost:5432/pacestreak_test \
REDIS_URL=redis://localhost:6379/15 uv run alembic upgrade head
DATABASE_URL=postgresql+asyncpg://pacestreak:pacestreak@localhost:5432/pacestreak_test \
REDIS_URL=redis://localhost:6379/15 uv run pytest
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

## Production

Host-agnostic: any machine with Docker and a TLS-terminating reverse proxy
(Caddy, nginx, a platform load balancer, Cloudflare Tunnel) in front of
`127.0.0.1:8000`. Where it runs is still undecided; nothing here assumes one.

```bash
cp .env.example .env && chmod 600 .env   # then fill in the required values
make prod-config                          # names any required variable still missing
make prod-up                              # migrate once, then api + worker
```

`compose.prod.yaml` refuses to start without `POSTGRES_PASSWORD`,
`JWT_PRIVATE_KEY_PEM`, `JWT_PUBLIC_KEY_PEM`, `TOTP_ENCRYPTION_KEY`,
`SMTP_HOST` and `FORWARDED_ALLOW_IPS`. The app itself then refuses to start
unless email is `smtp` with TLS, cookies are secure, `DEBUG` is off and
`PUBLIC_API_URL` is https. Keys are passed as PEM contents in environment
variables; a flattened one-line PEM with literal `\n` works. Keys are read
once per process, so restart after rotating them.

Containers run with a read-only root filesystem, `no-new-privileges`, memory
limits and rotated logs. Migrations run once in a `migrate` container before
the API starts, never from every replica.

### Email

`EMAIL_BACKEND=smtp` works with any provider: STARTTLS on 587 (default) or
implicit TLS on 465 (`SMTP_SSL=True`, `SMTP_STARTTLS=False`). Transient
failures retry three times with backoff. Notification mail carries RFC 8058
`List-Unsubscribe` headers, and mail clients' one-click POST goes to
`/v1/notifications/unsubscribe/one-click`. The provider is still to be
chosen; set up SPF, DKIM and DMARC for the sending domain when it is.

### Admin accounts

```bash
make create-admin email=you@example.com   # prompts for the password
make set-password email=you@example.com   # also signs out every session
make recompute-all                        # rebuild every stats projection
docker compose exec api python -m app.cli set-role someone@example.com moderator
```

Passwords are prompted for (or read from `PACESTREAK_PASSWORD` for
automation), never taken from argv.

### Health and monitoring

Point the status page at `/health/ready` (API and database) and
`/health/worker` (reminders, digests and purges actually running). The admin
Metrics tab shows each job's last result.

### Backups

```bash
make backup                      # scripts/backup.sh, then restore-check.sh
scripts/restore-check.sh FILE    # restore into a scratch DB and verify
scripts/restore.sh FILE          # restore OVER the live DB (asks first)
```

Dumps are custom-format, checksummed and mode 0600 in `./backups` (git-ignored),
kept for `BACKUP_KEEP_DAYS` (default 14). The newest is never pruned. Every
backup is immediately test-restored into a throwaway database and compared
against the live schema revision; a backup that has never been restored is not
trusted. Schedule `make backup` daily (cron or a systemd timer) and copy
`./backups` off the host. For production, prefix both with
`COMPOSE="docker compose -f compose.yaml -f compose.prod.yaml"`.

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
