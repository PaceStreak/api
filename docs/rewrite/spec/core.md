# PaceStreak API core spec (for Hono + Workers + D1 + Drizzle port)

Scope: app/main.py, config.py, database.py, cache.py, ratelimit.py, turnstile.py, versioning.py,
schemas.py, models.py, storage.py, email.py, common/*, v1/router.py, ops/*, cli.py, Makefile,
.env.example, compose*.yaml, .github/workflows/*. Feature routers (auth, habits, etc.) are only
inventoried here; their bodies belong to other spec files.

---

## 0. Route inventory (mount map)

- 266 route decorators total: **3 unversioned** (`/health*`) + **263 under `/v1`**.
- `app/v1/router.py` includes routers in this order (order matters for path-matching collisions
  in FastAPI: first registered match wins; Hono also matches in registration order, so keep it):

| # | Module | Router prefix (under /v1) | Routes |
|---|---|---|---|
| 1 | auth/router.py | /auth | 22 |
| 2 | auth/passkeys.py | /auth/passkeys | 7 |
| 3 | profile/router.py | (none) | 5 |
| 4 | game/router.py | /me | 11 |
| 5 | account/router.py | /me | 5 |
| 6 | account/calendar.py | (none) | 4 |
| 7 | training/router.py | (none) | 34 |
| 8 | training/gear.py | /gear | 4 |
| 9 | training/personal.py | (none) | 16 |
| 10 | training/photos.py | /body-photos | 6 |
| 11 | habits/router.py | /habits | 19 |
| 12 | habits/routines.py | /habit-routines | 4 |
| 13 | insights/router.py | (none) | 4 |
| 14 | training/habits.py | /me | 6 |
| 15 | training/plans.py | /plans | 12 |
| 16 | nutrition/router.py | /nutrition | 18 |
| 17 | coach/router.py | /coach | 1 |
| 18 | social/router.py | (none) | 23 |
| 19 | social/buddies.py | (none) | 6 |
| 20 | groups/router.py | (none) | 26 |
| 21 | game/leaderboards.py | /leaderboards | 1 |
| 22 | notifications/router.py | /notifications | 11 |
| 23 | search/router.py | (none) | 2 |
| 24 | trash/router.py | /trash | 4 |
| 25 | admin/router.py | /admin | 8 |
| 26 | ops/router.py | (none) | 4 |
| — | ops/health.py (mounted on app root, NOT /v1) | /health | 3 |

Note `/me` prefix is shared by game, account and training/habits routers; `/admin/*` is served by
both admin/router.py and ops/router.py (`/admin/client-errors`, `/admin/abuse`).

## 1. Routes in scope (fully specified)

### 1.1 Health (unversioned; no `PaceStreak-Version` header; no auth; no rate limit)

| Method | Path | Behaviour | Response |
|---|---|---|---|
| GET | `/health` | Liveness. Touches nothing. | 200 `{"status":"healthy"}` |
| GET | `/health/ready` | `SELECT 1` on DB (any exception -> `"down"`); Redis `PING` (any exception -> `"degraded"`). Ready iff database ok; cache is reported only. | 200 `{"status":"ready","checks":{"database":"ok","cache":"ok"\|"degraded"}}` or 503 `{"status":"unavailable","checks":{...}}` |
| GET | `/health/worker` | Reads `worker_heartbeats` row `name='scheduler'`. | see below |

`/health/worker` logic:
- Exception while reading -> 503 `{"status":"unknown"}`.
- No row -> state `never_ran` -> 503 `{"status":"never_ran","age_seconds":null}`.
- `age = now - last_tick_at`; stale threshold = `max(180s, WORKER_INTERVAL_SECONDS*3)` (default 360s).
  `status = "stale"` if `age > threshold` else `"ok"`.
- Response only `{"status", "age_seconds": int(age.total_seconds())}` (truncation, not rounding); 200 iff ok else 503.
- Never expose `jobs`, `duration_ms`, `failing_ticks` here (test asserts `"jobs" not in json`).
- Internal `worker_state()` (used by admin panel elsewhere) returns `{status,last_tick_at (isoformat),age_seconds,duration_ms,failing_ticks,jobs}`.

### 1.2 Ops (under /v1)

| Method | Path | Auth | Rate limit | Request | Response |
|---|---|---|---|---|---|
| POST | `/v1/client-errors` | none | slowapi `30/minute` per client IP | `ClientErrorIn` | **202** `{"received": true}` or 202 `{"received": false}` |
| GET | `/v1/admin/client-errors` | admin (non-admin -> **404 "Not found"**) | — | — | 200 list (max 100) |
| DELETE | `/v1/admin/client-errors/{error_id}` | admin | — | path `error_id` str | **204** empty; 404 `"Not found"` if 0 rows |
| GET | `/v1/admin/abuse` | admin | — | — | 200 object |

`ClientErrorIn` (extra fields ignored, pydantic default):
| field | type | constraint | default |
|---|---|---|---|
| message | str | 1..2000 chars | required |
| stack | str\|null | max 20000 | null |
| url | str\|null | max 2000 | null |
| release | str\|null | max 40 | null |

POST /client-errors algorithm:
1. `path = urlsplit(url).path[:300]` if url truthy else null (query + fragment dropped; Python
   `urlsplit` of a relative/garbage string still returns a path — use `new URL(url, "http://x")`
   carefully: for an absolute URL take `.pathname`; for non-URL strings Python returns the part
   before `?`/`#` verbatim. Safest port: strip scheme+netloc if `^[a-z][a-z0-9+.-]*://[^/?#]*`,
   then cut at first `?` or `#`). Percent-encoding is NOT normalised by Python; don't let WHATWG
   URL re-encode.
2. `message = message[:500]`, `stack = stack[:4000]` if truthy else null (empty string -> null).
3. `agent = (User-Agent header or "")[:400] or null`.
4. `fp = sha256_hex(message + "|" + firstFrame)` where `firstFrame = (stack or "").strip().splitlines()[1:2]` joined
   -> i.e. the **second** line of the stripped stack (index 1), or "" . Uses the truncated
   message/stack. Python `splitlines` splits on \n, \r\n, \r, \v, \f, \x1c-\x1e, \x85,  ,  .
5. If fp not present: `count(*) from client_errors >= MAX_GROUPS (1000)` -> return `{"received":false}` (still 202).
6. Upsert: `INSERT ... ON CONFLICT(fingerprint) DO UPDATE SET count=count+1, last_seen=now,
   path=excluded.path, user_agent=excluded.user_agent, release=excluded.release` (message/stack/
   first_seen unchanged). D1/SQLite supports this `ON CONFLICT ... DO UPDATE` syntax (Drizzle
   `.onConflictDoUpdate`).
7. Return `{"received": true}`.

GET /admin/client-errors item: `{id (str uuid), message, stack, path, release, user_agent, count,
first_seen (isoformat), last_seen (isoformat)}` ordered `last_seen DESC LIMIT 100`. `alerted_at`
is not exposed.

DELETE: `DELETE FROM client_errors WHERE id = :error_id`. Note error_id is a raw string compared to
a UUID column: in Postgres a malformed UUID raises -> caught by middleware -> **500**. In D1 it would
just be 0 rows -> 404. Decide (recommend 404, low risk).

GET /admin/abuse (window `since = now - 24h`):
```
{
 "since": iso,
 "failures": {kind: count, ...},               -- auth_failures since, GROUP BY kind
 "by_ip": [{"ip", "failures", "accounts"}],    -- GROUP BY ip_address, count(*), count(DISTINCT email_hash), ORDER BY count DESC LIMIT 20
 "by_account": [{"account": email, "failures", "ips"}],  -- JOIN users ON users.id=auth_failures.user_id, GROUP BY users.email, count(*), count(DISTINCT ip_address) ORDER BY count DESC LIMIT 20
 "signups_by_ip": [{"ip","signups"}]           -- security_events WHERE kind='signup' AND created_at>=since GROUP BY ip_address ORDER BY count DESC LIMIT 20
}
```
NULL ip is grouped as its own row (`"ip": null`). Tie order unspecified in Postgres.
`count(DISTINCT x)` ignores NULLs (same in SQLite).

`require_admin` (admin/router.py): `get_current_user` then role != "admin" -> 404 "Not found"
(deliberately 404, not 403). Moderator also 404.

### 1.3 Ops service (used by auth routes)

- `record_failure(db, kind, request, email=None, user_id=None)`: kinds seen: `login`, `mfa`,
  `recover`, `passkey` (column String(12)). If user_id null and email given, look up
  `users.id WHERE email = lower(strip(email))`. Inserts AuthFailure{kind, ip_address=client_ip,
  email_hash, user_id}; commits; on any exception rollback and swallow.
- `client_ip`: first comma-part of `X-Forwarded-For` stripped, else socket peer; truncated to 45.
  On Workers use `CF-Connecting-IP` (most trustworthy) — but to preserve behaviour behind
  Cloudflare, `X-Forwarded-For` first entry equals client IP anyway.
- `email_hash(email) = HMAC-SHA256(key, lower(strip(email))).hex`, key =
  `sha256(b"auth-failure:" + JWT_PRIVATE_KEY_PEM_text)` (raw 32 bytes). The PEM text is the
  normalised one from `_read_key` (with `\\n` unescaped, `.strip() + "\n"`). Must byte-match to keep
  hashes comparable across the cutover (only matters for 30-day retention; low stakes).
  Port: WebCrypto `crypto.subtle.digest` + `importKey("raw", ..., {name:"HMAC",hash:"SHA-256"})`.
- `sweep(db)`: delete auth_failures created_at < now-30d; client_errors last_seen < now-30d (worker job).

## 2. Cross-cutting behaviour

### 2.1 Middleware stack (outermost first; Starlette add_middleware inserts at index 0)
1. `add_api_version_header`: if `request.url.path.startswith("/v1")` set `PaceStreak-Version: 1`
   on every response (including CORS preflight, 422, 429, 500). Note `startswith("/v1")` also
   matches e.g. `/v1foo`.
2. `CORSMiddleware`: `allow_origins = CORS_ORIGINS` (comma list, stripped, empties dropped),
   `allow_credentials=True`, `allow_methods=["*"]`, `allow_headers=["*","X-CSRF-Token"]`, no
   expose_headers, max_age default **600**.
   - Starlette semantics to replicate exactly:
     - Preflight = `OPTIONS` with `Origin` and `Access-Control-Request-Method`. Response 200 body
       `OK` (text/plain) if allowed; else **400** body `Disallowed CORS origin` (or
       `Disallowed CORS method/headers`). Headers on success: `Access-Control-Allow-Origin: <echoed origin>`,
       `Access-Control-Allow-Credentials: true`, `Access-Control-Allow-Methods: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT`,
       `Access-Control-Max-Age: 600`, `Access-Control-Allow-Headers: <echo of Access-Control-Request-Headers>`
       (because "*" with credentials echoes), `Vary: Origin`.
     - Simple/actual request with allowed Origin: adds `Access-Control-Allow-Origin: <origin>`,
       `Access-Control-Allow-Credentials: true`, `Vary: Origin`. Disallowed origin: no CORS
       headers, request still processed.
   - Hono's `hono/cors` with `origin: list, credentials: true` is close but returns 204 for
     preflight and does not 400 disallowed origins; the app doesn't care about status, but write
     a tiny custom CORS middleware if exact parity desired.
   - Startup validation: `"*"` in origin list -> refuse to boot (ValueError).
3. `SlowAPIMiddleware` + per-route `@limiter.limit` (see 2.3).
4. `server_error_as_json` (innermost, so 500s still carry CORS headers — test
   `test_a_500_still_carries_cors_headers`):
   - `sqlalchemy IntegrityError` -> **409** `{"detail":"That was saved twice at once. Try again."}`
   - any other unhandled exception -> log `Unhandled error on METHOD PATH` -> **500**
     `{"detail":"Something went wrong on our side. Try again in a moment."}`
   - Port: Hono `app.onError`. Map D1 `UNIQUE constraint failed` / `FOREIGN KEY constraint failed`
     / `NOT NULL constraint failed` errors (D1 throws `Error` with message `D1_ERROR: UNIQUE constraint failed: ...`)
     to 409. SQLAlchemy IntegrityError also covers FK and NOT NULL and CHECK violations -> 409.
     Note: Postgres enforces FKs always; D1 enforces FKs (PRAGMA foreign_keys is ON by default in D1).

### 2.2 Error envelope (all JSON)
| Source | Status | Body |
|---|---|---|
| `HTTPException(status, detail)` | as given | `{"detail": "<string>"}` (detail may also be dict/list in some feature routers; check them) |
| Request validation (pydantic) | 422 | `{"detail":[{"type","loc":[...],"msg","input","ctx"?,"url"?}]}` FastAPI/pydantic v2 shape. The app reads `detail` — check ../app for whether it parses array msgs (likely shows `detail[0].msg`). |
| Unknown route | 404 | `{"detail":"Not Found"}` (capital F — Starlette) |
| Wrong method | 405 | `{"detail":"Method Not Allowed"}` + `Allow` header |
| slowapi limit | 429 | **`{"error":"Rate limit exceeded: 10 per 1 minute"}`** — key is `error`, NOT `detail`. Text = `f"Rate limit exceeded: {limit}"` where limit renders like `10 per 1 minute`, `30 per 1 minute`, `3 per 1 minute`, `5 per 1 minute`. |
| per-user `enforce()` | 429 | `{"detail":"Slow down - try again in a little while."}` |
| IntegrityError | 409 | see above |
| unhandled | 500 | see above |
| Turnstile | 400/503 | see 2.4 |

### 2.3 Rate limiting

A) **slowapi (IP-based, Redis storage, fixed-window, headers disabled)**
- Key = `get_remote_address` = `request.client.host` (uvicorn rewrites it from X-Forwarded-For
  when the peer is in FORWARDED_ALLOW_IPS). On Workers use `CF-Connecting-IP`.
- slowapi keys per **route function** (limit is per endpoint per IP, not global per IP). Fixed
  window aligned to window start (limits lib `FixedWindowRateLimiter`, key `LIMITER/<ip>/<endpoint>/<limit>/...`).
- Limits (env-overridable strings):

| Setting | Default | Routes |
|---|---|---|
| RATE_LIMIT_SIGNUP | 5/minute | POST /v1/auth/signup (router.py:187) |
| RATE_LIMIT_LOGIN | 10/minute | POST /v1/auth/login (225); passkeys 302, 318 (login begin/finish) |
| RATE_LIMIT_MFA_VERIFY | 10/minute | auth/router.py 339, 429, 711, 765, 844 |
| RATE_LIMIT_PASSWORD_EMAIL | 3/minute | auth/router.py 363, 405, 807 |
| literal 30/minute | — | POST /v1/client-errors; habits/router.py:668; nutrition/router.py:376 |

(Exact paths per line belong to the auth spec; numbers above are source line numbers.)

B) **`common/limits.enforce(bucket, subject, limit, window_seconds)`** (per user, Redis fixed window)
- key `limit:{bucket}:{subject}`; `INCR`; if result == 1 `EXPIRE key window`; if count > limit ->
  429 `{"detail":"Slow down - try again in a little while."}`. Any RedisError -> **fail open**
  (return, no limit). Note the counter increments even on rejected calls.
- Call sites (bucket, subject, limit, window):

| bucket | subject | limit | window | where |
|---|---|---|---|---|
| body-photo | user.id | 60 | 3600 | training/photos.py:105 |
| workout-write | user.id | 240 | 3600 | training/router.py:368, 411 (shared bucket) |
| import_file | user.id | 30 | 3600 | training/router.py:1075 |
| pause | user.id | 20 | 86400 | training/router.py:1352 |
| buddy-invite | user.id | 10 | 86400 | social/buddies.py:170 |
| encourage | user.id | 20 | 86400 | social/buddies.py:324 |
| group-create | user.id | 5 | 3600 | groups/router.py:153 |
| group-join | user.id | 20 | 3600 | groups/router.py:185 |
| challenge-create | user.id | 10 | 3600 | groups/router.py:825 |
| assign-plan | user.id | 20 | 86400 | groups/router.py:1086 |
| announce | **group.id** | 5 | 86400 | groups/router.py:1168 |
| push-test | user.id | 5 | 600 | notifications/router.py:254 |
| search | user.id | 60 | 60 | social/router.py:129 |
| follow | user.id | 60 | 3600 | social/router.py:288 |
| kudos | user.id | 300 | 3600 | social/router.py:630 |
| comment | user.id | 30 | 3600 | social/router.py:789 |
| report | user.id | 20 | 3600 | social/router.py:849 |
| calendar_rotate | user.id | 10 | 3600 | account/calendar.py:175 |
| calendar_feed | sha(token)[:16] | 120 | 3600 | account/calendar.py:205 |
| export | user.id | 20 | 3600 | account/router.py:601 |
| import | user.id | 5 | 3600 | account/router.py:834 |
| import_habits | user.id | 20 | 3600 | habits/router.py:242 |

Subject renders as str(UUID) — lowercase hyphenated.

### 2.4 Turnstile (`verify_turnstile(request, token)`)
- `TURNSTILE_SECRET_KEY` empty/unset -> no-op.
- token falsy -> 400 `"Complete the verification challenge"`.
- POST form-encoded to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with
  `secret`, `response`, `remoteip` (= request.client.host or ""), timeout 5s.
- Network error / non-JSON body -> 503 `"Verification is temporarily unavailable"` (fail closed).
- `success` falsy -> 400 `"Verification failed, please try again"`.
- Port: `fetch` with `AbortSignal.timeout(5000)`; remoteip from `CF-Connecting-IP`.
- Callers: signup, login, forgot-password, resend-verification (skipped when signed-in owner), recover.

### 2.5 Cookies & CSRF (defined in auth/router.py, settings in config)
- Names: `__Secure-refresh_token` / `__Secure-csrf_token` when COOKIE_SECURE true, else bare
  `refresh_token` / `csrf_token`.
- Both: `Path=/v1/auth`, `Domain=COOKIE_DOMAIN` (omitted when unset; prod `pacestreak.com`),
  `Secure=COOKIE_SECURE`, `SameSite=COOKIE_SAMESITE` (default `lax`; Starlette writes `SameSite=lax`
  lowercase), `Max-Age = REFRESH_TOKEN_DAYS*86400` (604800), Starlette also emits
  `expires=<RFC1123 date>`.
- refresh: `HttpOnly`; csrf: NOT HttpOnly (JS reads and echoes as `X-CSRF-Token`).
- Clear: `delete_cookie` -> `Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/v1/auth; Domain=...`
  with value `""`; Starlette's delete_cookie also sets `SameSite=lax` and `HttpOnly`? (Starlette
  delete_cookie passes `secure`, `httponly` defaults False, samesite "lax"). Replicate with
  `hono/cookie` `deleteCookie(c, name, {path, domain})`.
- `require_csrf`: cookie and header both present and `secrets.compare_digest` equal, else 403
  `"Invalid CSRF token"`. Port with constant-time compare (e.g. `crypto.subtle.timingSafeEqual`
  on Workers).
- `hono/cookie` with `prefix: 'secure'` will auto-prefix `__Secure-`; or set names manually.

### 2.6 Versioning
- `API_VERSION="1"`, prefix `/v1`. Response header `PaceStreak-Version: 1` on `/v1*` paths only.

### 2.7 Startup / production config check (`_check_production_config`, only if ENVIRONMENT=="production")
Refuse to boot (exit 1, each line `refusing to start: ...` to stderr) if any:
COOKIE_SECURE false; DEBUG true; TOTP_ENCRYPTION_KEY empty; RESET_DB_ON_STARTUP true;
TURNSTILE_SECRET_KEY empty; EMAIL_BACKEND != "smtp" (else neither SMTP_SSL nor SMTP_STARTTLS);
no JWT_PRIVATE_KEY_PEM and no file at JWT_PRIVATE_KEY_PATH; PUBLIC_API_URL not `https://`.
Workers port: no lifespan — run the check lazily on first request (return 500) or in a test; the
EMAIL_BACKEND rule must change (see hazards).
- Dev only: RESET_DB_ON_STARTUP drop_all/create_all.
- Lifespan also inits/closes the Redis pool and disposes the engine.

### 2.8 Logging
Logger `app` gets a StreamHandler `"%(levelname)s:     %(name)s %(message)s"` at INFO. Console email
backend logs `[email:console] to=%s subject=%s[ attachments=name (N bytes), ...]\n<body>` — tests
read codes from this log line. Port: `console.log` with identical text.

## 3. Configuration (env vars; case-insensitive; `.env` file read unless PACESTREAK_ENV_FILE="")

| Var | Default | Notes |
|---|---|---|
| APP_NAME | PaceStreak API | used in email subjects, TOTP issuer |
| APP_VERSION | 0.1.0 | |
| ENVIRONMENT | development | `production` triggers checks |
| DEBUG | True | SQL echo |
| RESET_DB_ON_STARTUP | False | dev only |
| DATABASE_URL | postgresql+asyncpg://pacestreak:pacestreak@localhost:5432/pacestreak | -> D1 binding |
| JWT_ISSUER | api.pacestreak.com | |
| JWT_AUDIENCE | pacestreak | |
| ACCESS_TOKEN_MINUTES | 15 | |
| REFRESH_TOKEN_DAYS | 7 | cookie max-age |
| JWT_PRIVATE_KEY_PATH / JWT_PUBLIC_KEY_PATH | ./keys/private.pem / public.pem | no FS on Workers |
| JWT_PRIVATE_KEY_PEM / JWT_PUBLIC_KEY_PEM | None | `"\\n"` literal -> newline, `.strip()+"\n"`; RS256 |
| COOKIE_DOMAIN | None | |
| COOKIE_SECURE | False | |
| COOKIE_SAMESITE | lax | |
| REDIS_URL | redis://localhost:6379/0 | |
| REDIS_MAX_CONNECTIONS | 20 | |
| USER_CACHE_TTL_SECONDS | 60 | auth user cache |
| FRONTEND_URL | http://localhost:5173 | email links, passkey origin/rp_id |
| PUBLIC_API_URL | http://localhost:8000 | calendar feed + one-click unsubscribe links |
| REQUIRE_VERIFIED_EMAIL | False | prod compose True |
| EMAIL_VERIFY_TOKEN_HOURS | 24 | |
| PASSWORD_RESET_TOKEN_MINUTES | 30 | |
| EMAIL_BACKEND | console | `smtp` |
| EMAIL_FROM | no-reply@pacestreak.com | |
| SMTP_HOST/PORT/USER/PASSWORD | localhost/587/None/None | |
| SMTP_STARTTLS | True | |
| SMTP_SSL | False | |
| SMTP_TIMEOUT_SECONDS | 10.0 | |
| SMTP_ATTEMPTS | 3 | |
| EMAIL_FROM_NAME | PaceStreak | |
| EMAIL_REPLY_TO | hello@pacestreak.com | |
| MFA_CHALLENGE_MINUTES | 5 | |
| TOTP_VALID_WINDOW | 1 | |
| RECOVERY_CODE_COUNT | 10 | |
| TOTP_ENCRYPTION_KEY | None | **Fernet** key |
| TERMS_VERSION | 2026-10-02 | |
| EMAIL_CHANGE_TOKEN_HOURS | 24 | |
| WEBAUTHN_RP_ID | None -> hostname(FRONTEND_URL) or "localhost" | |
| WEBAUTHN_RP_NAME | PaceStreak | |
| WEBAUTHN_CHALLENGE_SECONDS | 300 | |
| MAX_PASSKEYS | 10 | |
| VAPID_PRIVATE_KEY_PATH / _PEM | ./keys/vapid_private.pem / None | EC P-256 PEM |
| VAPID_SUBJECT | mailto:hello@pacestreak.com | |
| WORKER_INTERVAL_SECONDS | 120 | affects /health/worker stale threshold |
| DELETION_GRACE_DAYS | 30 | |
| TURNSTILE_SECRET_KEY | None | |
| FOOD_LOOKUP_URL | https://world.openfoodfacts.org/api/v2/product/{barcode}.json | |
| R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET | None | all 4 required else StorageUnavailable |
| RATE_LIMIT_LOGIN / _MFA_VERIFY / _SIGNUP / _PASSWORD_EMAIL | 10/min, 10/min, 5/min, 3/min | |
| CORS_ORIGINS | http://localhost:5173 | prod https://app.pacestreak.com |

Derived: `passkey_origin = FRONTEND_URL.rstrip("/")`, `totp_issuer = APP_NAME`.
Compose/infra-only vars (not read by app): APP_MODE, APP_MODULE, APP_PORT, API_PORT,
API_HEALTH_PATH, WEB_CONCURRENCY, FORWARDED_ALLOW_IPS, POSTGRES_*, REDIS_HOST_PORT,
RUN_MIGRATIONS, HOST_UID/GID, PACESTREAK_PASSWORD (cli), PACESTREAK_ENV_FILE.
Production today: FastAPI Cloud env + GitHub secret `WORKER_ENV_JSON` (JSON NAME->value).

## 4. Data layer

### 4.1 Base columns (every table, `database.Base`)
| column | type | default |
|---|---|---|
| id | UUID PK | **uuid7** generated in Python (time-ordered; ordering by id == creation order in places) |
| created_at | timestamptz | server `now()` |
| updated_at | timestamptz | server `now()`, `onupdate=now()` (ORM-level: only bumped on ORM UPDATEs, not bulk `update()` statements... actually SQLAlchemy applies onupdate to Core `update()` too unless value given) |

D1 port: store UUID as TEXT (lowercase hyphenated), generate with `uuidv7` npm package (or
`uuid@10+` `v7()`); timestamps as TEXT ISO-8601 with offset or INTEGER ms. Responses use Python
`datetime.isoformat()` -> `2026-10-17T12:34:56.123456+00:00` (microseconds, `+00:00`, omitted
fraction when 0!). JS `toISOString()` gives `...56.123Z`. Decide whether the app parses both
(it should, via `new Date`), but string equality in tests/clients may differ. Microsecond precision
is lost in JS.

### 4.2 Tables in scope
`worker_heartbeats`: name String(40) UNIQUE NOT NULL, last_tick_at tz NOT NULL, duration_ms int,
jobs **JSONB** default {} , failing_ticks int default 0.
`client_errors`: fingerprint String(64) UNIQUE, message String(500), stack String(4000)?,
path String(300)?, release String(40)?, user_agent String(400)?, count int default 1,
first_seen, last_seen tz NOT NULL, alerted_at tz?.
`auth_failures`: kind String(12), ip_address String(45)? indexed, email_hash String(64)? indexed,
user_id FK users.id ON DELETE SET NULL indexed; index `ix_auth_failures_created(created_at)`.
`security_events` (account/models) read by /admin/abuse: kind, ip_address, created_at.
`app/models.py` registers all model modules: account, auth, game, groups, habits, insights,
notifications, nutrition, ops, profile, social, training, trash.

### 4.3 Query shapes in scope
- select by unique fingerprint; `count(*)`; Postgres `INSERT ... ON CONFLICT DO UPDATE`
  (`sqlalchemy.dialects.postgresql.insert`) -> SQLite same syntax works.
- GROUP BY with `count(DISTINCT)`, ORDER BY aggregate DESC LIMIT 20.
- `DELETE ... WHERE id=` with rowcount check (D1 `meta.changes`).
- `SELECT 1` readiness.

### 4.4 Redis key namespaces (whole app)
| key | owner | purpose |
|---|---|---|
| `LIMITER/...` | slowapi | IP rate limits |
| `limit:{bucket}:{subject}` | common/limits | per-user limits |
| `auth:user:{id}` | auth/cache.py | user cache, TTL 60s |
| `auth:revoked_sid:{sid}` | auth/cache.py | session denylist — **correctness-critical** (noeviction policy) |
| `food:{barcode}` | nutrition/lookup.py | OFF lookup cache |
| `worker:tick` | worker.py | tick lock |
| `worker:error-alert` | worker.py | alert dedupe |

## 5. Storage (R2 via boto3)

Functions (all raise `StorageUnavailable` if any of 4 R2 settings missing):
| fn | behaviour | Workers replacement |
|---|---|---|
| put_object(key,data,ct) | PutObject with ContentType | R2 binding `env.BUCKET.put(key, data, {httpMetadata:{contentType}})` |
| presigned_put_url(key,ct,expires=300) | SigV4 presigned PUT, ContentType signed (client must send identical Content-Type) | **R2 binding cannot presign** -> `aws4fetch` (`AwsClient.sign(url,{method:'PUT',headers:{'Content-Type':ct},aws:{signQuery:true}})` with `X-Amz-Expires=300`) against `https://<acct>.r2.cloudflarestorage.com/<bucket>/<key>`; keep the S3 credentials as secrets. Region `auto`, service `s3`. Note boto3 uses virtual-host or path style — URL shape irrelevant to the app, which just PUTs to it. |
| presigned_get_url(key,ct,expires=60) | presigned GET with `response-content-type` and `response-cache-control=private, no-store` | aws4fetch, add those query params before signing |
| verify_upload(key, magic, max_bytes) | HEAD -> 404/NoSuchKey => FileNotFoundError; size>max -> delete, ValueError("too large"); ranged GET bytes 0..len(magic)-1, not startswith(magic) -> delete, ValueError("wrong type"); returns size | `env.BUCKET.head(key)` (null => not found), `.size`; `env.BUCKET.get(key,{range:{offset:0,length:n}})` |
| get_object(key) | bytes; NoSuchKey -> FileNotFoundError | `BUCKET.get(key)` null -> not found |
| delete_object(key) | | `BUCKET.delete(key)` |
| delete_objects(keys) | batches of 1000, Quiet | `BUCKET.delete(keysArray)` (binding accepts up to 1000) |

Callers: training/photos.py (presign put/get, verify, delete), worker.py:389 (purge). Tests replace
all seven with an in-memory dict (conftest `fake_storage`).

## 6. Email

### 6.1 Transport
- `send_email(to, subject, body, headers=None, html=None, attachments=None)` never raises; logs
  exception `failed to send email (subject=%s)`.
- console backend: logs (see 2.8). smtp backend: builds MIME and sends with `smtplib` in a thread.
- Message headers: `From: PaceStreak <no-reply@pacestreak.com>` (display name EMAIL_FROM_NAME),
  `To`, `Subject`, `Date` (RFC 2822 GMT), `Message-ID` (`make_msgid(domain=<from domain>)`),
  `Reply-To` if EMAIL_REPLY_TO, `Auto-Submitted: auto-generated`, extra headers (e.g.
  `List-Unsubscribe`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click` from notifications/unsubscribe.py).
- Body: text/plain; if html -> multipart/alternative (text first, html second); attachments ->
  multipart/mixed with attachments (filename, bytes, mime).
- Retries: `SMTP_ATTEMPTS` (min 1). Retry on SMTP 4xx response or transient
  (disconnect/connect error/timeout/OSError); 5xx raises immediately. Backoff `sleep(2**(attempt-1))` = 1s, 2s.
- TLS: SMTP_SSL -> implicit TLS; else STARTTLS if SMTP_STARTTLS; login if user+password.
- Production provider: **Brevo SMTP** (300/day free).

### 6.2 Templates (exact strings; `{app_name}`=APP_NAME default "PaceStreak API"!)
Note subjects use `settings.app_name` = **"PaceStreak API"** by default unless APP_NAME is overridden
in prod env — verify the production value before porting (`Confirm your PaceStreak API email address`).

| fn | to | subject | text body |
|---|---|---|---|
| send_verification_email(to, code) | to | `Confirm your {app_name} email address` | `Your verification code is: {code}\n\nEnter it in the app to confirm your address. It expires in {EMAIL_VERIFY_TOKEN_HOURS} hours.\nIf you did not create this account, ignore this message.` |
| send_password_reset_email(to, code) | to | `Reset your {app_name} password` | `Your password reset code is: {code}\n\nEnter it in the app to choose a new password. It expires in {PASSWORD_RESET_TOKEN_MINUTES} minutes and can be used once.\nIf you did not request this, ignore this message - your password has not changed.` |
| send_password_changed_email(to) | to | `Your {app_name} password was changed` | `Your password was just changed and all other sessions were signed out.\n\nIf this was not you, reset your password immediately.` ; HTML button `Reset password` -> `{FRONTEND_URL}/reset-password` |
| send_email_change_email(to, code) | new address | `Confirm your new {app_name} email address` | `Your confirmation code is: {code}\n\nEnter it in the app to use this address for your {app_name} account. It expires in {EMAIL_CHANGE_TOKEN_HOURS} hours.\nIf you didn't ask for this, ignore this message; nothing has changed.` |
| send_email_changed_notice(old, new) | old | `Your {app_name} email address was changed` | `Your account now uses {new}. If this wasn't you, reply to this email straight away and we will help you get it back.` |

HTML: shared `_html_template(preheader, heading, body_html, button_text?, button_url?, footer_note?)`
— copy the template string verbatim from app/email.py lines ~165-235 (table layout, lime #d3ff3e
4px bar, logo `https://www.pacestreak.com/brand/logo-512.png` 36x36, h1 heading, footer
`&mdash; PaceStreak`, optional footer note, "Automated, transactional message from pacestreak.com.").
`_p(text)` = `<p style="margin:0 0 16px;">{html.escape(text)}</p>`; code block = digits joined by
single spaces (`1 2 3 4 5 6`) in monospace 28px span. Python `html.escape` escapes `& < > " '`
(`'` -> `&#x27;`). Verification email footer note: `You're receiving this because someone used this address on PaceStreak.`
Preheaders: `Your PaceStreak verification code.`, `Your PaceStreak password reset code.`,
`Your PaceStreak password was just changed.`, `Confirm this address for your {app_name} account.`,
`Your PaceStreak account email address was changed.`
Other callers of `send_email` directly: notifications/service.py, worker.py (error alerts, digests).

## 7. Common helpers

- `codes.invite_code(length=8)`: CSPRNG choice from `abcdefghjkmnpqrstuvwxyz23456789` (31 chars).
  Port: `crypto.getRandomValues` with rejection sampling (avoid modulo bias). Lookups lowercase.
- `net.is_safe_public_url(url)`: scheme must be `https` and hostname present; literal IP -> must be
  `is_global` and not multicast; hostname -> `getaddrinfo` all answers must be public; any error
  -> False. **Workers have no DNS resolve API**: use DNS-over-HTTPS (`fetch('https://cloudflare-dns.com/dns-query?name=..&type=A'` + AAAA, `accept: application/dns-json`)
  and an IP classifier (`ipaddr.js` npm: `ipaddr.parse(ip).range() === 'unicast'`; note Python
  `is_global` excludes 100.64/10 shared, 192.0.0/24, 198.18/15, TEST-NETs, 2001:db8::/32 etc.).
  Also: Workers' outbound `fetch` cannot reach private networks anyway, so SSRF risk is lower —
  but keep the check for parity (test_push_ssrf expects rejection -> 422/404).
- `time`:
  - `utcnow()` aware UTC.
  - `is_valid_timezone(name)`: membership in `zoneinfo.available_timezones()` (IANA list incl.
    legacy aliases like `US/Pacific`, `GMT`, `Etc/GMT+5`; excludes `localtime`). JS:
    `Intl.supportedValuesOf('timeZone')` returns **canonical only** (no aliases) — validate with
    `try { new Intl.DateTimeFormat('en',{timeZone}) }` instead, which accepts aliases; small
    divergence possible (e.g. `posixrules`, `Factory`).
  - `zone(name)`: unknown -> UTC (never raises).
  - `local_date(moment, tz)`: naive -> treat as UTC; convert to tz; date. JS: `Intl.DateTimeFormat('en-CA',{timeZone, year:'numeric',month:'2-digit',day:'2-digit'})`
    or `Temporal` polyfill (`@js-temporal/polyfill`) / `date-fns-tz`.
  - `week_start(day, week_starts_on)` 0=Mon..6=Sun: `day - ((weekday(day) - wso) mod 7)` where
    Python weekday Mon=0. JS `getUTCDay()` is Sun=0 -> `pyWeekday = (getUTCDay()+6)%7`. Python `%`
    is non-negative; JS `%` is not — use `((x%7)+7)%7`.
  - `month_key` `YYYY-MM`; `season_id` `"{year}-Q{(month-1)//3+1}"` (year not zero-padded);
    `season_bounds("2026-Q4")` -> (2026-10-01, 2026-12-31).
  - Represent dates as plain `YYYY-MM-DD` strings / UTC-midnight Date in JS to avoid TZ drift.

## 8. CLI (`python -m app.cli`) -> must become a script (wrangler d1 execute / node script)
| cmd | behaviour |
|---|---|
| create-admin EMAIL | fails if exists; password from env PACESTREAK_PASSWORD or getpass twice; min 16 chars; inserts User(email lower/strip, argon2/bcrypt hash via auth.security.hash_password, role=ADMIN, is_verified=True, verified_at=now, password_changed_at=now) |
| set-password EMAIL | new hash, password_changed_at=now, revoke_all_sessions (DB) + finish_revoke_all (Redis cache drop/denylist) |
| set-role EMAIL ROLE | role in UserRole values (user/moderator/admin); then finish_revoke_all to drop cached user |
| recompute-all | for each profile with onboarded_at not null: game.service.recompute(db, user_id, notify=False), commit per user; progress every 100 |
Makefile: keys (openssl RSA 2048), vapid (openssl P-256), dev/up/down, migrate (alembic), test,
lint (ruff), create-admin/set-password/recompute-all, backup (scripts/backup.sh + restore-check), prod-*.

## 9. CI / deploy (to be replaced)
- ci.yml: ruff lint/format; pytest against postgres:18 + redis:8 services, `make keys vapid`,
  `alembic upgrade head`, `alembic check`; docker image build.
- migrate.yml: on push touching alembic/** -> `alembic upgrade head` with env from WORKER_ENV_JSON.
  -> D1: `wrangler d1 migrations apply` (drizzle-kit generate SQL).
- publish.yml: GHCR image `ghcr.io/pacestreak/api:{latest,sha}`.
- worker.yml: cron `*/5 * * * *` runs `python -m app.worker --once` in the image (5 min timeout).
  -> Workers **Cron Trigger** `*/5 * * * *` calling the tick (`scheduled` handler). Health
  stale threshold uses WORKER_INTERVAL_SECONDS=120 default -> 360s, but cron is 5 min (300s) so
  prod value must be >=120; check WORKER_ENV_JSON / FastAPI Cloud value.

## 10. Porting hazards (Workers/D1)

| Python thing | Where | JS replacement / note |
|---|---|---|
| FastAPI + pydantic | everywhere | `hono` + `zod` + `@hono/zod-validator`; reproduce 422 shape `{"detail":[...]}` via custom hook (and pydantic msg texts if app shows them) |
| SQLAlchemy async + asyncpg (Postgres) | everywhere | `drizzle-orm/d1` |
| `postgresql.insert().on_conflict_do_update` | ops/router, others | SQLite UPSERT (`onConflictDoUpdate`) — supported |
| JSONB columns | worker_heartbeats.jobs + many | TEXT with `mode:'json'` in Drizzle; no JSONB operators in SQLite (`json_extract` only) |
| PG UUID type, uuid7 | Base | TEXT + `uuidv7` npm |
| timestamptz + `func.now()` server defaults & onupdate | Base | `$defaultFn(()=>new Date())`/`$onUpdateFn`; or `CURRENT_TIMESTAMP` (SQLite format `YYYY-MM-DD HH:MM:SS`, no tz!) — pick one format and make comparisons lexicographic-safe |
| `TRUNCATE ... RESTART IDENTITY CASCADE` | tests | per-table DELETE |
| IntegrityError -> 409 | main.py | parse D1 error message |
| Postgres-specific SQL elsewhere (files importing postgresql dialect / JSONB / ARRAY / ilike / with_for_update / text()): account/models, admin/merge, admin/router, auth/models, game/models, game/service, groups/*, habits/importer, habits/models+router, insights/router, notifications/*, nutrition/*, profile/models, search/router, social/*, training/habits+importers+models, trash/models, worker | — | review per spec file; `ILIKE` -> `LIKE` (SQLite LIKE is ASCII-case-insensitive only), `FOR UPDATE` -> none (D1 is single-writer; use `db.batch` for atomicity), ARRAY -> JSON text |
| Transactions | everywhere | **D1 has no interactive transactions**; only `db.batch([...])` atomic. Check-then-insert patterns lose atomicity -> rely on UNIQUE constraints + 409 mapping |
| redis.asyncio | cache, limits, auth cache, nutrition, worker | Workers KV is eventually consistent (bad for counters & revocation denylist, ~60s propagation). Use **Durable Objects** for rate limits + session denylist, or Cloudflare Rate Limiting binding (`ratelimit` binding: only 10s/60s periods — **cannot** express 3600/86400 windows), or a D1 table `rate_limits(key, count, expires_at)` with UPSERT (strongly consistent, simplest). Revocation denylist -> D1 table. |
| slowapi + limits | IP limits | custom Hono middleware on D1/DO, fixed window; reproduce 429 `{"error":"Rate limit exceeded: N per 1 minute"}` |
| httpx | turnstile, nutrition lookup | global `fetch` |
| boto3 presign | storage | R2 binding + `aws4fetch` for presigned URLs |
| smtplib (SMTP, STARTTLS, retries, `time.sleep`) | email | **Workers cannot do SMTP STARTTLS easily** (`cloudflare:sockets` `connect()` supports `startTls()`, so possible with a hand-rolled client, or `worker-mailer` npm package which implements SMTP over cloudflare:sockets). Alternatives: Brevo HTTP API (`POST https://api.brevo.com/v3/smtp/email`) — but AGENTS.md says no third-party email API was wired deliberately; that's an owner decision. Cloudflare Email Service (send_email binding) is first-party. MIME building: `mimetext` npm. Production check "EMAIL_BACKEND must be smtp" must be revisited. |
| `asyncio.to_thread`, `anyio.to_thread` | storage, email, notifications push | unnecessary; but retries with sleep should use `await scheduler.wait`/setTimeout and `ctx.waitUntil` |
| FastAPI BackgroundTasks | auth/router, passkeys, training, social, buddies, groups, notifications, admin | `c.executionCtx.waitUntil(promise)` (30s limit after response) |
| Web push (pywebpush/`asyncio.to_thread` in notifications/service.py:262) | notifications | `@block65/webcrypto-web-push` or `web-push` is Node-only; need WebCrypto VAPID/aes128gcm impl |
| `socket.getaddrinfo` | common/net | DoH + `ipaddr.js` |
| `zoneinfo` / `available_timezones` | common/time | `Intl` / `@js-temporal/polyfill` / `date-fns-tz` |
| `hmac`, `hashlib.sha256`, `secrets` | ops/service, codes, csrf | WebCrypto; `crypto.getRandomValues` |
| Fernet (TOTP secret at rest) | auth | `fernet` npm (uses crypto-js; or implement with WebCrypto AES-128-CBC + HMAC-SHA256) — must decrypt existing ciphertexts |
| RS256 JWT from PEM files | auth | `jose` (`importPKCS8`, `importSPKI`); PEM from env secrets only (no filesystem) |
| password hashing (auth.security) | auth/cli | likely argon2/bcrypt — CPU-heavy on Workers (CPU limit 10ms free / 30s paid); see auth spec |
| Filesystem: key files, `.env` | config | `wrangler secret` + `vars` |
| Lifespan startup checks, logging handler | main | none in Workers |
| Worker long-running loop + Redis tick lock | worker.py | Cron Trigger; lock -> DO or D1 row |
| GitHub Actions migrate/worker/publish | workflows | wrangler deploy, d1 migrations, cron trigger |
| CPU-heavy in scope | sha256 fingerprint (cheap); presigning (cheap) | fine |
| Python `str[:n]` slices count code points; JS slices UTF-16 units | ops truncations, user agent | use `Array.from(s).slice(0,n).join('')` for parity on astral chars (DB length limits were in chars) |

## 11. Tests covering this area
| file | what |
|---|---|
| tests/test_server_errors.py | 500 carries `access-control-allow-origin` = origin and has `detail`; IntegrityError on route `/v1/_race` -> 409 |
| tests/test_turnstile.py | off by default (signup 201); missing token 400 "Complete the verification challenge"; approved 201; declined 400 "Verification failed"; login needs token; Cloudflare unreachable 503; resend-verification needs token when anonymous, skips for signed-in owner (200), can't spam other address (400) |
| tests/test_email.py | multipart/alternative with text+html; single-part without html; verification text contains code + "If you did not create this account, ignore this message.", html has `1 2 3 4 5 6` and "PaceStreak"; reset text has "not changed", html "6 5 4 3 2 1" + "Reset your password"; html escapes `<script>` |
| tests/test_ops.py | `_read_key` unescapes `\\n` and caches (identity); From display name "PaceStreak", Message-ID/Date present, Auto-Submitted; extra headers pass through; one-click unsubscribe headers `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, forged signature 400; CLI refuses short passwords |
| tests/test_push_ssrf.py | internal URLs rejected (localhost, 127.x, 10.x, 169.254.169.254, http://, etc.); `https://8.8.8.8/push/abc` allowed; subscribe with internal endpoint -> 422 or 404 |
| tests/test_worker.py:63-80 | `/health` == `{"status":"healthy"}`; `/health/ready` 200 database ok; `/health/worker` 503 before tick, 200 `ok` after, no `jobs` key; :230-245 client-errors posts 202 then worker error_alerts emails admins once ("new app error") |
| tests/test_prelaunch.py:143-203 | client errors grouped (3 posts -> 1 row count 3), path `/reset-password` stripped of query, admin delete 204; abuse view: `failures.login==4`, `by_account == [{"account":"victim@example.com","failures":3,"ips":1}]` (nonexistent address not listed), `by_ip[0].failures==4`, signups counted, moderator gets 404; MAX_GROUPS bound -> `{"received": false}` but known fp still `true` |
| tests/conftest.py | env `PACESTREAK_ENV_FILE=""`, console email captured from `app.email` logger; truncates users, refresh_tokens, one_time_tokens, recovery_codes, webauthn_challenges, worker_heartbeats, client_errors, auth_failures CASCADE and FLUSHDB redis each test; fake_storage dict replacing all 7 storage fns |
| tests/test_auth.py | (also references 429/X-CSRF/cookies — see auth spec) |

## 12. Open questions
1. Production APP_NAME value: default makes email subjects say "PaceStreak API". Keep verbatim?
2. Email transport on Workers: hand-rolled SMTP over `cloudflare:sockets` (`worker-mailer`), Brevo HTTP API, or Cloudflare Email Service? Owner decision (no new vendors).
3. Redis replacement: D1 tables vs Durable Objects for rate limits, revocation denylist, user cache, worker lock. KV is unsuitable for counters/denylist.
4. Timestamp serialisation: keep Python `isoformat()` (`+00:00`, microseconds) or switch to JS `Z` form? Check ../app parsers.
5. 422 body shape fidelity: does ../app render pydantic `detail[].msg` texts?
6. DELETE /admin/client-errors/{bad-uuid}: 500 today vs 404 on D1.
7. slowapi key semantics (per-endpoint per-IP fixed window) — acceptable to approximate?
8. Password hash algorithm CPU cost on Workers (auth spec).
9. Data migration Postgres -> D1 (uuid/timestamp/JSONB conversion) and Neon restore history loss.
