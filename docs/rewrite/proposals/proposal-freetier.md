# PaceStreak API on Cloudflare Workers: "freetier" architecture proposal

Author: architect "freetier". Date: 2026-10-17.
Inputs: spec/{core,auth,schema,misc,gaps}.md (read), the other specs (grepped), `app/src/lib/api.ts`.

Primary objective: the full feature set (266 routes, 12 worker jobs) runs inside the **Workers Free plan**
(10 ms CPU per invocation, 50 subrequests, 5 cron triggers, KV 1k writes/day, Queues 10k ops/day,
D1 5M reads/100k writes per day) without lowering quality. Moving to Paid is a config change, nothing else.

The design rests on one rule: **no invocation may assume more than ~6 ms CPU**. Anything that can't be
bounded that way (imports, exports, full recompute over years of history, fan-out) is split into
resumable slices that each fit, and those slices run on Queues. Waiting on I/O costs no CPU, so a request
can still return the result synchronously while slices run elsewhere. That is how the wire contract
survives.

Verified facts this rests on (fetched 2026-10-17):
- Durable Objects follow the plan's per-invocation CPU limit. On Free that is 10 ms, so a DO is **not**
  an escape hatch for CPU. DOs are used here only for coordination, and only where unavoidable.
- Queues are on Free: 10,000 operations a day, 24 h retention.
- Cloudflare Email Service sending to arbitrary recipients is **Paid-only**. It is not available on Free.

---

## 1. Decisions in one table

| Area | Decision |
|---|---|
| Runtime | One Worker `pacestreak-api`, Hono 4, `compatibility_date` pinned, `nodejs_compat` **off** (smaller bundle; nothing needs it) |
| DB | D1 (one DB per env), Drizzle ORM schema + drizzle-kit generated SQL migrations, applied with `wrangler d1 migrations apply` |
| IDs | UUIDv7 TEXT (hand-rolled, 20 lines); client-supplied UUIDs are accepted where the spec allows |
| Time | INTEGER epoch **milliseconds** in the DB; ISO-8601 `Z` on the wire (`toISOString()`); dates as TEXT `YYYY-MM-DD` |
| Passwords | PBKDF2-HMAC-SHA256, 100,000 iterations (the Workers maximum), 16-byte salt, 32-byte key, PHC-style string with the version and iteration count |
| JWT | HS256 via WebCrypto HMAC, hand-rolled (no `jose`); `kid` selects between 2 secrets for rotation |
| Sessions | D1 `sessions` table (one row per refresh family) joined to `users` in **one** query per authenticated request; no cache, no denylist |
| Rate limits | Per-IP `N/minute`: Workers Rate Limiting binding (no storage writes). Per-user hour and day buckets: one D1 UPSERT batched with the write it guards |
| KV | **Not used.** Removes the 1k writes/day risk entirely |
| Cache | Cache API for barcode lookups and `/health`; nothing else is cacheable (every response is per-user) |
| Background | `waitUntil` for the cheap post-response work; Queue `jobs` for anything that is heavy or fans out; 4 cron triggers as dispatchers |
| Email | `Mailer` interface. Free: Brevo **HTTP** API (same vendor and account as today, so no new vendor). Paid: Cloudflare Email Service `send_email` binding. One env var switches them |
| Push | Hand-rolled RFC 8291 (aes128gcm) + RFC 8292 (VAPID ES256) on WebCrypto, about 150 lines; new VAPID key |
| Photos | R2 binding for head/get/delete; `aws4fetch` presigns PUT/GET URLs |
| Heavy I/O | Imports and exports are chunked into resumable slices on Queues, with a staging object in R2; the HTTP handler waits on a D1 job row and returns the same JSON as today |
| Tooling | pnpm 10, TypeScript 5.9 strict, Biome 2 (lint + format), Vitest 3.2 + `@cloudflare/vitest-pool-workers`, Wrangler 4 |
| Deploy | Workers Builds (Git-connected, like the Pages projects): a push to `main` runs migrations and then deploys. Custom domain `api.pacestreak.com` attached to the Worker |

---

## 2. Project layout and tooling

```
api/                       (repo PaceStreak/api, rewritten in place on a branch `workers`)
  wrangler.jsonc
  package.json  pnpm-lock.yaml  tsconfig.json  biome.json  vitest.config.ts
  drizzle.config.ts
  migrations/0000_init.sql ...             (drizzle-kit output, committed, never edited by hand after merge)
  src/
    index.ts               (export default { fetch, scheduled, queue })
    app.ts                 (Hono app, middleware order, route mounting)
    env.ts                 (Env bindings type + parsed/validated config, cached per isolate)
    db/schema/*.ts         (one file per domain: auth, profile, training, game, habits, social, groups, notifications, nutrition, account, ops, trash)
    db/client.ts           (drizzle(d1) + query-counting wrapper used by tests)
    lib/                   (http errors, validation hook, time/tz, uuid7, crypto, base64url, pyround/formatG, isoweek, text-fold, ratelimit, mailer, push, r2, turnstile)
    auth/  profile/  training/  game/  habits/  social/  groups/  notifications/  nutrition/  account/  admin/  ops/  trash/  search/  insights/
       each: routes.ts (Hono sub-app), service.ts (pure + db), schemas.ts (zod), *.test.ts next to it
    jobs/                  (cron dispatchers, queue consumer, the 12 jobs as slice functions)
    heavy/                 (import/export slicers: gpx, fit, csv, account-json, zip writer)
  test/                    (shared fixtures, soft WebAuthn authenticator, contract tests)
  scripts/                 (admin CLI as `wrangler d1 execute` wrappers + a `tsx` script calling an admin-only internal route)
```

- **pnpm 10** (lockfile v9, `packageManager` field). CI uses `pnpm install --frozen-lockfile` (the
  equivalent of `npm ci`).
- **tsconfig**: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
  `verbatimModuleSyntax`, `module`/`moduleResolution` `bundler`, `target ES2023`, `types: ["@cloudflare/workers-types/2023-07-01"]`
  generated by `wrangler types` (committed `worker-configuration.d.ts`, checked in CI so it can't drift).
- **Biome 2**: lint + format, `noExplicitAny: error`, `noNonNullAssertion: error`, `useImportType`. A single tool keeps CI fast.
- **Build**: Wrangler's esbuild; no separate bundler. CI fails if the gzipped bundle exceeds **350 KiB**
  (Free limit is 3 MiB compressed; a small bundle keeps cold starts fast).

### wrangler.jsonc (shape)

```jsonc
{
  "name": "pacestreak-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "workers_dev": false,
  "routes": [{ "pattern": "api.pacestreak.com", "custom_domain": true }],
  "placement": { "mode": "smart" },          // runs next to D1: matters with 2-3 round trips per request
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "limits": { "cpu_ms": 30000 },             // ignored on Free; takes effect on Paid. The plan switch is this line
  "d1_databases": [{ "binding": "DB", "database_name": "pacestreak", "database_id": "…", "migrations_dir": "migrations" }],
  "r2_buckets": [{ "binding": "PHOTOS", "bucket_name": "pacestreak-photos" }, { "binding": "STAGING", "bucket_name": "pacestreak-staging" }],
  "queues": { "producers": [{ "binding": "JOBS", "queue": "pacestreak-jobs" }],
              "consumers": [{ "queue": "pacestreak-jobs", "max_batch_size": 10, "max_batch_timeout": 2, "max_retries": 5, "dead_letter_queue": "pacestreak-jobs-dlq" }] },
  "ratelimits": [
    { "name": "RL_SIGNUP", "namespace_id": "1001", "simple": { "limit": 5,  "period": 60 } },
    { "name": "RL_LOGIN",  "namespace_id": "1002", "simple": { "limit": 10, "period": 60 } },
    { "name": "RL_MFA",    "namespace_id": "1003", "simple": { "limit": 10, "period": 60 } },
    { "name": "RL_PWMAIL", "namespace_id": "1004", "simple": { "limit": 3,  "period": 60 } },
    { "name": "RL_30",     "namespace_id": "1005", "simple": { "limit": 30, "period": 60 } }
  ],
  "triggers": { "crons": ["*/5 * * * *", "*/15 * * * *", "7 * * * *", "23 3 * * *"] },
  "vars": { "ENVIRONMENT": "production", "MAILER": "brevo", "COOKIE_DOMAIN": "pacestreak.com", "CORS_ORIGINS": "https://app.pacestreak.com", "FRONTEND_URL": "https://app.pacestreak.com", "PUBLIC_API_URL": "https://api.pacestreak.com", "PLAN": "free" },
  "env": {
    "staging": { "name": "pacestreak-api-staging", "workers_dev": true, "routes": [], "vars": { "ENVIRONMENT": "staging", "COOKIE_DOMAIN": "", "CORS_ORIGINS": "http://localhost:5173" }, "...": "own D1, R2, queue" }
  }
}
```

Secrets (`wrangler secret put`, never in git): `JWT_SECRET_CURRENT`, `JWT_SECRET_PREVIOUS`, `DATA_KEY`
(AES-GCM key for TOTP secrets), `PEPPER` (HMAC key for codes, email hashes and unsubscribe links),
`VAPID_PRIVATE_JWK`, `TURNSTILE_SECRET_KEY`, `BREVO_API_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
Local development uses `.dev.vars` (gitignored, with a committed `.dev.vars.example`).

Environments: **dev** = `wrangler dev` (Miniflare: local D1, R2, Queues, rate limits; `MAILER=console`);
**staging** = `pacestreak-api-staging.<acct>.workers.dev` with its own D1, bucket and queue (Previews
from branches); **production** = `api.pacestreak.com`.

`PLAN` var (`free`|`paid`) is read in exactly one module (`lib/budget.ts`). It sets slice sizes, queue
batch sizes, the subrequest budget per invocation (40 vs 900) and the mailer default. Nothing else
branches on the plan.

### Startup config check
Workers have no lifespan. `env.ts` parses the config with zod once per isolate. In production, an
invalid config makes **every** request return 500 `{"detail":"Something went wrong on our side. Try again in a moment."}`
and logs `refusing to start: …`. The rules are the old ones minus Fernet and SMTP, plus the new ones:
`COOKIE_DOMAIN` set, `CORS_ORIGINS` without `*`, `TURNSTILE_SECRET_KEY`, both JWT secrets ≥ 32 bytes,
`PUBLIC_API_URL` https, and a working mailer config. A CI test boots with the production vars and fake
secrets to prove the check passes.

---

## 3. Libraries (exact versions to pin; each checked for Workers compatibility, no Node built-ins)

Pin exact versions (no `^`). Renovate is set with `minimumReleaseAge: "14 days"`. The versions below are
the latest I know of; Phase 0 confirms each against npm and bumps to the newest release ≥ 14 days old.

| Package | Version | Why / Workers note |
|---|---|---|
| `hono` | 4.9.x (pin exact) | Router (RegExpRouter), tiny, first-class Workers. `hono/cookie` is used for parsing only; Set-Cookie strings are built by hand for exact parity |
| `zod` | 4.1.x | Validation; v4 is about 2x faster than v3 and has a smaller `zod/mini` build. The full API is used for the error map |
| `@hono/zod-validator` | 0.7.x | With a custom hook that emits the FastAPI 422 shape (§5) |
| `drizzle-orm` | 0.44.x | D1 driver, `db.batch`, typed queries; no runtime codegen |
| `drizzle-kit` (dev) | 0.31.x | SQL migration generation |
| `@simplewebauthn/server` | 13.x | Passkeys; pure WebCrypto, Workers-supported |
| `aws4fetch` | 1.0.20 | SigV4 presigning for R2 (the binding can't presign) |
| `fflate` | 0.8.2 | Zip write (exports, backup attachment) and unzip (habit import); sync and streaming APIs, pure JS |
| `@garmin/fitsdk` | 21.x | Official FIT decoder, ESM. Used inside the FIT slicer (§11) |
| `saxes` | 6.0.0 | Streaming, resumable-by-offset XML for GPX. Rejects DTDs: any `doctype` event aborts with "That GPX file could not be read." (parity with defusedxml) |
| `@streamparser/json` | 0.0.22 | Streaming JSON tokenizer for the 25 MiB account import, fed in slices |
| `ipaddr.js` | 2.2.0 | `range()` checks for the push SSRF literal-IP guard |
| `uuid` | not used | uuidv7 is hand-rolled (fewer bytes) |
| `wrangler` (dev) | 4.x | |
| `@cloudflare/workers-types` (dev) | latest dated | Or `wrangler types` output |
| `@cloudflare/vitest-pool-workers` (dev) | 0.9.x | Tests run in workerd with real D1/R2/Queues |
| `vitest` (dev) | 3.2.x | Version required by the pool |
| `@biomejs/biome` (dev) | 2.2.x | |
| `typescript` (dev) | 5.9.x | |

Deliberately **not** used: `jose` (HS256 is 40 lines on WebCrypto), `otpauth` (TOTP is 25 lines),
`web-push` (needs Node), `worker-mailer`/SMTP (one HTTPS fetch is cheaper than an SMTP dialogue, and Brevo is
already the vendor), `date-fns-tz` (`Intl` plus a tz offset table, §10), `@hono/zod-openapi` (G1: docs dropped
in production; it adds bundle weight).

---

## 4. D1 schema strategy

- **One squashed migration** `0000_init.sql` with 60 tables plus `sync_seq`, generated from the Drizzle schema.
  Later changes follow expand/contract: deploy order is migrate, then code, so every migration must
  work with the previous code version. A CI step runs the old code's tests against the new schema.
- **Foreign keys**: every FK to `users` is `ON DELETE CASCADE` or `SET NULL` exactly as in Postgres. D1 enforces FKs.
- **Booleans** `integer({mode:'boolean'})`; **JSON** `text({mode:'json'}).$type<T>()`, always validated by zod
  on the way in. Never queried with `json_extract` on hot paths: any field used in a WHERE gets a real column.
- **varchar(n)** limits are enforced in zod (SQLite ignores them). The six security-relevant ones (email,
  handle, title, body…) also get `CHECK(length(x) <= n)` as a backstop.
- **Timestamps** INTEGER ms (`$defaultFn(Date.now)`, `$onUpdateFn(Date.now)`). That makes comparisons and
  ORDER BY trivially correct and indexes small. Pagination cursors (`before`) are ms integers or the ISO
  string they came from; both parse to the same ms.
- **Case-insensitive search**: shadow `*_fold` columns (`email_fold`, `handle_fold`, `name_fold`, `display_name_fold`,
  `note_fold`) written by the app as `s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()`, each with an index.
  Queries use `LIKE ? ESCAPE '\'` on the fold column with the term folded the same way. This gives **Unicode**
  case- and accent-insensitive matching (better than SQLite's ASCII LIKE), and prefix searches (`handle%`) use the index.
- **sync_seq**: single-row counter table. Writes that need a seq run in one `db.batch`:
  `UPDATE sync_seq SET value=value+1 WHERE id=1` followed by the INSERT/UPSERT, which takes
  `(SELECT value FROM sync_seq WHERE id=1)`. For n rows, n increment/insert pairs go in the same batch. That is one round trip.
- **Advisory lock (recompute serialisation)**: replaced by **optimistic concurrency**. `user_stats.rev` INTEGER;
  recompute reads `rev`, computes, and writes `UPDATE … SET …, rev=rev+1 WHERE user_id=? AND rev=?` in the
  same batch as its badge/record/notification inserts. All of those are guarded by `INSERT … ON CONFLICT DO NOTHING`
  on existing unique keys (`uq_notification_dedupe`, the achievement uniques), and the batch begins with a guard row.
  If `changes=0`, the batch is retried once with a fresh read. Duplicate "level up" notifications are impossible
  because they are dedupe-keyed. Test `test_recompute_is_serialized_across_concurrent_calls` is ported unchanged.
- **Savepoints (outbox `/workouts/batch`)**: all 200 ops are validated in JS first. Ops that would fail
  produce their `{ok:false,status,detail}` without touching the DB. The rest go in **one** `db.batch`. Each write is an
  UPSERT with `WHERE excluded.client_updated_at > workouts.client_updated_at` (last-writer-wins without a read).
  `applied` is derived from `RETURNING`. Recompute runs once afterwards. One round trip instead of 200 savepoints.
- **Interactive transactions**: none exist on D1. Every route is written as *read phase* (one `db.batch` of SELECTs) followed by
  *write phase* (one `db.batch` of writes, atomic). Check-then-insert races are settled by UNIQUE constraints and mapped to 409.
- **Account merge**: a **static, generated** list of `(table, column)` FKs to users (built from the Drizzle
  schema at build time, with a test asserting it matches `PRAGMA foreign_key_list` for every table). Per column:
  `UPDATE OR IGNORE t SET c=:d WHERE c=:s; DELETE FROM t WHERE c=:s;` with self-link deletes first. All of it goes in
  one batch. Then the game recompute is enqueued.
- **Precomputed columns for jobs** (this is what keeps cron under 10 ms):
  `profiles.tz_offset_min` is not stored (DST). Instead there is a tiny `tz_offsets(tz TEXT PK, offset_min INT, valid_until INT)` table,
  refreshed by cron for the distinct set of zones in use (tens of rows). Jobs select with
  `JOIN tz_offsets o ON o.tz = p.timezone WHERE ((:utc_min + o.offset_min) / 60 % 24 + 24) % 24 = p.reminder_hour`,
  so hour matching happens in SQL on indexed columns, with no per-row `Intl`.
- **Indexes**: every FK column; `(user_id, local_date)` on workouts, habit_logs, meal_entries; `(user_id, seq)` on workouts;
  `(user_id, created_at DESC)` on notifications; partial indexes for job selection (`habits(remind_hour) WHERE archived_at IS NULL AND kind!='quit'`,
  `habits(snoozed_until) WHERE snoozed_until IS NOT NULL`, `profiles(deletion_scheduled_at) WHERE … NOT NULL`,
  `client_errors(first_seen) WHERE alerted_at IS NULL`). Every query in a hot path is checked with `EXPLAIN QUERY PLAN` in a test (no `SCAN` on tables
  that can grow beyond 1k rows per user).

---

## 5. Request pipeline

Order (outermost first), as Hono middleware:

1. **`onError` / `notFound`** (registered globally). Unknown route gives 404 `{"detail":"Not Found"}`; wrong method gives 405 `{"detail":"Method Not Allowed"}` with `Allow`.
   `HttpError(status, detail)` gives `{detail}`. A D1 error whose message contains `UNIQUE|FOREIGN KEY|NOT NULL|CHECK constraint failed`
   gives 409 `{"detail":"That was saved twice at once. Try again."}`. Anything else is logged with the method, path and request id, and gives 500 with the standard text.
2. **Version header**: `PaceStreak-Version: 1` when the path starts with `/v1`, applied in a `finally`, so it lands on 422, 429, 500 and preflight responses too.
3. **CORS** (hand-written, about 40 lines, exact Starlette semantics from core.md 2.1). The allowlist is a `Set` built once per isolate.
   500 responses carry CORS headers because CORS wraps the error handler's output.
4. **Config gate** (production misconfiguration gives 500).
5. **Body limit**: 1 MiB default; 25 MiB on the two import routes, 5 MiB on habit import (413 with the spec texts).
6. **Per-IP rate limit** (route-level middleware, §7).
7. **Auth** (route-level: `auth()`, `authDb()`, `optionalAuth()`, `moderator()`, `admin()`), then **CSRF** on `/auth/refresh` and `/auth/logout` only.
8. **Validation** (`zValidator` with a hook that converts zod issues to
   `{"detail":[{"type","loc":["body",...path],"msg","input"}]}`). `app/src/lib/api.ts` reads only `detail[0].loc` (minus `"body"`) and `detail[0].msg`
   (with `Value error, ` stripped). The hook therefore emits pydantic-like `msg` text for the common cases (`String should have at least 16 characters`,
   `Field required`, `value is not a valid email address: …`, `Input should be …`), with a test table per code. Zod objects are
   non-strict (extra keys ignored, like pydantic). Coercions mirror pydantic lax mode only where the app sends strings.
9. **Handler**, which follows the two-phase read batch then write batch pattern.
10. **Post-response**: `c.executionCtx.waitUntil(...)` for delivery enqueue and `auth_failures` writes.

Errors with non-standard bodies are kept for parity: slowapi-style 429 `{"error":"Rate limit exceeded: 10 per 1 minute"}`
(the app shows its own text for a 429 anyway), per-user 429 `{"detail":"Slow down - try again in a little while."}`, and change-email's string 422.

`/docs`, `/redoc` and `/openapi.json` are **dropped** (G1, option 1). Unknown paths give 404.

---

## 6. Auth design

### Passwords: PBKDF2 measured against 10 ms
- Format: `pbkdf2-sha256$v=1$i=100000$<salt b64url>$<dk b64url>`. Verify parses `i`, so iterations can change later without migration
  (rehash on login when `i` is below current).
- **Cost**: 100k iterations is 200k SHA-256 compressions in BoringSSL. That is about 15–25 ms on SHA-NI hardware, which is **over** 10 ms.
  Free plan CPU enforcement is lenient on rare spikes, but that can't be relied on. Decision:
  - The login route and other hash routes (signup, login, change-password, reset, recover, 2fa enable/disable, passkey register/remove;
    about 10 routes, all rare) use **100k iterations**, the platform maximum, from day one. Their cost is measured in staging with
    `wrangler tail` `cpuTime` (Phase 0 spike, gate G-1).
  - If p99 is above 10 ms on Free, the **one** mitigation is moving production to Paid ($5/month, `PLAN=paid`). The design
    never lowers iterations to fit the budget. Before launch with real users the owner should expect Paid for this reason alone.
  - Unknown-email logins still run a dummy PBKDF2 against a fixed per-isolate dummy hash (timing parity).
- Recovery codes (50 bits of entropy) and email codes (20 bits, attempt-limited) **don't** need a slow hash:
  stored as `HMAC-SHA256(PEPPER, code)`. Recovery verify becomes 1 HMAC plus an indexed lookup instead of 10 Argon2 runs.
  OTP attempt counting is **fixed**: failed attempts are persisted (the spec's open question 1). This is a deliberate improvement.

### Tokens
- **Access JWT**: HS256, header `{alg,typ,kid}`, claims identical to today (`sub,type,ver,sid,jti,iss,aud,iat,exp`), 15 min.
  Verify cost is about 20 µs. HS256 because only this Worker signs and verifies: asymmetric keys buy nothing and cost CPU.
- **MFA challenge JWT**: same keys, `type:"mfa"`, 5 min.
- **Refresh**: 64 random bytes, base64url (86 chars), stored as SHA-256 hex. Rotation algorithm identical (30 s reuse grace, family burn on reuse).
- **Sessions**: new table `sessions(id = family_id, user_id, created_at, last_used_at, expires_at, revoked_at, user_agent, ip)`. `refresh_tokens` rows reference it.
  The per-request auth check is **one** D1 query:
  `SELECT u.id,u.email,u.role,u.is_active,u.is_verified,u.token_version, s.revoked_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?1 AND s.user_id=?2`.
  It returns 401 "Session has been logged out" if revoked or missing, plus the existing inactive and `ver` checks. Logout is effective immediately and globally,
  with no Redis and no KV. Handlers that need a read add their own SELECTs to the **same `db.batch`** as the auth query,
  so a typical authenticated GET is **one** round trip.
- `last_used_at` is updated only on refresh, never per request, which keeps D1 writes down.

### Cookies and CSRF
Exact names, path, domain, Max-Age and `expires` as in auth.md §1: `__Secure-refresh_token` (HttpOnly) and `__Secure-csrf_token`, `Path=/v1/auth`,
`Domain=pacestreak.com`, `SameSite=lax`, `Secure`. Deletion emits the matching attributes. CSRF uses a constant-time compare
(`crypto.subtle.timingSafeEqual`) of the cookie and `X-CSRF-Token` header, which gives 403 "Invalid CSRF token".

### TOTP, passkeys, email codes
- TOTP: SHA-1, 6 digits, 30 s, window ±1, `totp_last_used_step` replay guard; hand-rolled over WebCrypto HMAC-SHA1.
  The secret is 20 random bytes in base32, stored as `AES-256-GCM(DATA_KEY, secret)` (`v1.<iv>.<ct>` b64url). The provisioning URI format is identical.
- Passkeys: `@simplewebauthn/server` 13. rpID stays `app.pacestreak.com`, derived from FRONTEND_URL as today.
  Challenges live in `webauthn_challenges`, taken with `DELETE … RETURNING`. Public keys are BLOBs (COSE).
  The ES256 verify cost is about 0.3 ms.
- Email codes: 6 digits, HMAC-stored, invalidate prior codes, 5-attempt limit (persisted).

### Turnstile
`fetch` siteverify with `AbortSignal.timeout(5000)` and `remoteip` from `CF-Connecting-IP`. Fail-closed 503 and all texts as spec. One subrequest.

---

## 7. Rate limiting (no KV, no write exhaustion)

| Kind | Mechanism | Cost |
|---|---|---|
| Per-IP `N/minute` (signup 5, login 10, mfa 10, pw-email 3, client-errors/habit/nutrition 30) | **Workers Rate Limiting binding**, key `${route}:${ip}` (per-endpoint per-IP like slowapi). 60 s period matches `/minute` | Zero storage writes; about 0 ms. Counters are per-location and approximate. That is acceptable for abuse control, and Turnstile is the real guard |
| Per-user buckets (22, windows 60 s to 86,400 s) | D1 table `rate_counters(key TEXT PK, window_start INT, count INT)`. **One** statement: `INSERT … ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count+1 ELSE 1 END, window_start = excluded.window_start RETURNING count`, **placed first in the same `db.batch` as the guarded write**, and evaluated after. If over the limit, the handler issues a compensating no-op (the guarded write is predicated with `WHERE (SELECT count FROM rate_counters WHERE key=?) <= limit`), so a rejected call writes nothing but the counter | One extra row write per guarded mutation. Bounded by user actions; D1's 100k writes/day is ample. Daily cron deletes stale rows |
| `search` (60/60 s per user, read-only route) | Rate Limiting binding keyed by user id (period 60) | No write on a read route |
| `calendar_feed` (120/h by token hash) | Rate Limiting binding with `limit: 2, period: 60` as the per-minute equivalent, plus Cache API caching of the `.ics` for 5 min | No writes |

Fail-open on D1 counter errors is **not** kept: the counter is in the same atomic batch, so it can't fail independently.

---

## 8. Caching

- No user cache: the auth join is one indexed query (≈0.5 ms D1-side), cheaper than any cache invalidation scheme.
- **Cache API** (per-colo, free, no write quota): Open Food Facts barcode results (24 h; negative results 1 h),
  `GET /health` (5 s), calendar `.ics` (5 min, keyed by token hash).
- Static libraries (exercise library, achievement rules, quest pool, templates) are **compiled into the bundle** as frozen
  objects with precomputed lookup maps (e.g. exercise-name fold index). Built at module load once per isolate; never per request.
- `Intl.DateTimeFormat` instances are memoised per tz in a module-level `Map`.

---

## 9. Background work

### Three lanes
1. **`waitUntil`** (same invocation, shares its 10 ms CPU and 50 subrequests): only for cheap, bounded work such as writing `auth_failures`,
   or `JOBS.send` of a delivery message. It **never** sends push or email directly: fan-out is unbounded and would steal the request's budget.
2. **Queue `pacestreak-jobs`** (each consumer invocation gets its own budget): message types
   `deliver{ids[]}`, `recompute{userId,reason}`, `job-slice{job,cursor}`, `import-slice{jobId,offset}`, `export-slice{jobId,part}`, `purge{userIds[]}`.
   Consumer batch size 10. Each handler declares its subrequest and CPU cost, and `lib/budget.ts` packs messages so an invocation stays under
   **40 subrequests** and about 6 ms CPU on Free. Leftover messages are `retry()`d with `delaySeconds: 0`.
   Idempotency: every handler is idempotent (dedupe keys, `alerted_at`, job rows with `status`), so retries and redelivery are safe.
3. **Cron dispatchers**: they only *select ids* (SQL with tz offsets, indexed, LIMIT 500) and enqueue slices with `sendBatch` (≤100 per call).

### Cron mapping (4 of the 5 free triggers; the 5th stays spare)

| Trigger | Runs | Jobs (spec #) |
|---|---|---|
| `*/5 * * * *` | snoozes need 5-minute resolution | 4 habit_snoozes; delivery retry sweep (notifications with `delivered_at` null older than 2 min, from failed deliveries) |
| `*/15 * * * *` | hour-matched jobs. Every 15 min covers the :30 and :45 zone offsets; dedupe keys guarantee one send per local hour | 2 nudges, 3 habit_reminders, 5 habit_summary, 6 digest (local hour 9), 8 backup (local hour 9), 9 buddies (local hour 17). At minute 0: refresh `tz_offsets` |
| `7 * * * *` | hourly | 1 stats refresh (selects stale `user_stats`, enqueues `recompute`), 7 resolve_challenges, 12 error_alerts (hourly gate becomes "once per hourly trigger"; no lock needed) |
| `23 3 * * *` | daily | 10 purge_deleted_accounts (D1 cascade in batches of 50 users; R2 `delete(keys[≤1000])`), 11 housekeeping (180-day notifications, trash, challenges, auth_failures/client_errors retention, `rate_counters` older than 2 days, expired `sessions`/`refresh_tokens`, finished import/export jobs plus their STAGING objects) |

- **Overlap / lock**: the old Redis tick lock is replaced by idempotency plus a D1 lease row per trigger
  (`UPDATE job_leases SET until=?now+240000 WHERE name=? AND until<?now RETURNING 1`). It is one statement and covers the rare overlapping cron.
- **Heartbeat**: each dispatcher upserts `worker_heartbeats` name `scheduler` with `{job:{result}|{error}}`. Queue consumers add their counts with
  `UPDATE … SET jobs=json_patch(jobs, ?)`. `/health/worker` semantics are unchanged (503 before the first tick, stale after 15 min).
- **Queue op budget (Free)**: 10k ops/day ≈ 3,300 messages/day (write + read + delete). Fixed cost: about 290 (5-min) + 96 (15-min) + 24 + 1 dispatches ≈
  410 messages/day if each dispatch emits one message. Dispatchers therefore **don't enqueue when the selection is empty** (the common case at
  zero users), and pack up to 50 ids into one message. That leaves about 2,500 messages/day for recompute/deliver/import, enough for roughly
  hundreds of daily active users. Past that, `PLAN=paid` (1M ops/month included).

### Recompute under 10 ms
Full `snapshot` over a user's lifetime history is O(history) and will exceed 10 ms for heavy users. Decision:
- **Incremental projection**: `user_week_agg(user_id, chain_id, week_start, days_bitmask, sessions, detailed, distance, minutes, …)` and
  `user_records_best(user_id, key, value, achieved_on, workout_id)` are maintained **in the write batch** of every workout, set, habit log, pause and rest-day write
  (UPSERT on the affected week only). `snapshot` reads aggregates (≤ 26–371 rows) instead of raw history. Streaks, XP, levels, quests and badges are computed from them.
- **Records**: PR detection needs history only for the touched `(key)`s. An edit or delete of an old session triggers a per-key rescan of that key's observations
  (indexed `(user_id, exercise_id, local_date)`), not all keys.
- The **synchronous** part on write paths (the `outcome` the app shows: level up, new badges, new records) is computed in-request from the aggregates (target ≤ 3 ms).
- A **full rebuild** (`recompute{full:true}`) exists for import, merge, restore and schema changes. It runs as queue slices of 500 workouts that rebuild aggregates,
  then a final cheap projection step. Its correctness is tested by property tests: incremental result == full-rebuild result after random op sequences.

---

## 10. Email transport

- Interface `Mailer.send({to, subject, text, html?, headers?, attachments?})` that never throws (logs `failed to send email`), with three implementations:
  `console` (dev/test; logs the exact `[email:console]` line the tests read codes from), `brevo` (HTTPS `POST api.brevo.com/v3/smtp/email`,
  custom headers incl. `List-Unsubscribe`, `List-Unsubscribe-Post`, `Auto-Submitted`; attachments base64), and `cloudflare` (`send_email` binding).
- **Free plan: `brevo`.** Cloudflare Email Service can't send to arbitrary recipients on Free (verified). Brevo is the
  current vendor, so this adds no new vendor; it only changes SMTP credentials into an API key. Brevo's tracking stays off (transactional API, `headers` only;
  confirm in Brevo settings that open/click tracking is disabled for the API as well).
- **On Paid: switch to `cloudflare`** (`MAILER=cloudflare`) and retire Brevo. That gives 3,000 mails/month included, SPF/DKIM via `wrangler email sending enable pacestreak.com`.
- Each send is one subrequest. Delivery budget per queue invocation is accounted for (§9).
- Monthly backup zip attachment: built by an `export-slice` job into STAGING; the delivery handler fetches it (one R2 get) and attaches it if ≤ 10 MiB
  (base64-encoding about 1 ms/MiB plus JSON serialisation means a 10 MiB attachment would blow the 10 ms budget). So **on Free, attachments are capped at 2 MiB**; above that the
  email carries the existing "download" fallback text. On Paid the cap returns to 10 MiB. The cap comes from `budget.ts`.

---

## 11. Push

- RFC 8291 aes128gcm: ECDH P-256 (ephemeral), HKDF-SHA256 (auth secret, then CEK/nonce), AES-128-GCM, a single record (`rs=4096`), padding delimiter `0x02`.
  RFC 8292 VAPID: ES256 JWT `{aud: origin(endpoint), exp: now+12h, sub: VAPID_SUBJECT}`; header `Authorization: vapid t=…, k=…`; `TTL: 43200`.
  About 1 ms CPU per send. The VAPID JWT is cached per audience origin per invocation.
- New VAPID key pair (zero users: no existing subscriptions to preserve). The public key is served from the existing route the app reads.
- Status handling: 404/410 deletes the subscription, 2xx resets failures, anything else increments failures and deletes at 10. Timeout `AbortSignal.timeout(10000)`.
- **SSRF guard without DNS**: (1) `https:` only, no credentials, port empty or 443; (2) hostname is an IP literal → reject unless `ipaddr.js` range is `unicast` (rejects private,
  loopback, link-local incl. 169.254.169.254, CGNAT, ULA, mapped v4, reserved, multicast, documentation ranges); `https://8.8.8.8/push/abc` stays allowed per test;
  (3) hostname without a dot, `localhost`, `*.local`, `*.internal`, `*.localhost` → reject; (4) **allowlist of push-service suffixes** (`fcm.googleapis.com`,
  `push.apple.com`, `push.services.mozilla.com`, `notify.windows.com`, `push.vivaldi.net`…) required for hostnames. A DNS-name rebinding attack then needs control of a push vendor's DNS.
  Workers `fetch` can't reach RFC 1918 space anyway; the guard keeps the test contract and blocks reaching our own zone (`*.pacestreak.com` explicitly rejected).
  The allowlist is a behaviour change from "any public host". It is recorded in the README; unknown push services get 422 on subscribe.

---

## 12. R2 photos

- `PHOTOS` binding: `head` (verify size), ranged `get` (magic-byte check), `delete([…≤1000])`.
- Presigned PUT (300 s, Content-Type signed) and GET (60 s, `response-content-type`, `response-cache-control=private, no-store`) via `aws4fetch`
  `AwsClient.sign(..., {aws:{signQuery:true}})` against `https://<account>.r2.cloudflarestorage.com/pacestreak-photos/<key>`.
  Signing is local (no subrequest), ≈0.2 ms. The R2 bucket CORS policy allows PUT/GET from `https://app.pacestreak.com` only.
  App CSP: the existing `_headers` must allow the R2 S3 endpoint in `connect-src`/`img-src` **exactly as today** (no change if the account host is unchanged).

---

## 13. Imports and exports under the CPU limit

Constraint: a 15 MiB FIT/GPX or 25 MiB JSON can't be parsed in 10 ms (≈ 50–150 ms total CPU). The wire contract is a single synchronous
multipart POST returning counts. Decision: **stage, slice, wait.**

1. Handler (CPU ≈ 1–2 ms): validate the small fields, then **stream** the multipart file part to `STAGING.put("imports/<jobId>", stream)`.
   A minimal streaming multipart reader (boundary scan over `ReadableStream` chunks, no `formData()` buffering) handles this. Size cap enforced while streaming gives 413.
   Insert `import_jobs(id, user_id, kind, status='queued', offset=0, found, imported, duplicates, problems JSON)`; `JOBS.send({type:'import-slice', jobId})`.
2. Consumer: each `import-slice` invocation reads a **byte range** (`STAGING.get(key,{range:{offset,length:512 KiB}})`) and feeds the resumable parser:
   - GPX: `saxes` (stateful; the parser carries partial-element state, persisted as a compact `{offset of last complete <trk>/<trkpt> boundary, partial track summary}`). Slices restart from the last completed `<trk>` boundary.
   - FIT: record-oriented binary. Slices split at record boundaries (header gives sizes); definition messages carried in the slice state (small). Implementation: `@garmin/fitsdk` `Decoder` per slice on a `Stream` from the slice bytes with the carried definitions; if that API proves unable to resume, a 300-line purpose-built FIT record reader for the needed messages (session/record/lap) replaces it. Gate G-3.
   - CSV (Strong/Hevy/FitNotes/activity): line-oriented, trivially resumable at newline offsets.
   - Account JSON (25 MiB): `@streamparser/json` emits top-level array elements; the slice ends at an element boundary and stores that byte offset.
   Each slice converts sessions into batched UPSERTs (dedupe via the existing unique keys, 100 rows per `db.batch`), updates counters on the job row, and enqueues the next slice.
   About 4–6 ms CPU per slice.
3. The handler **waits without CPU**: after enqueueing, it polls the job row (`SELECT status,… FROM import_jobs WHERE id=?`) with backoff (250 ms, then 500 ms, …) up to 25 s of wall time
   (polling is I/O: ≈ 0.1 ms CPU per poll). When done it returns **exactly the old response** and enqueues a full recompute.
   If it is not done in 25 s it returns the same shape with what is known. That never happens on Paid, where slices run in-process (`PLAN=paid` → slice size = whole file, run inline).
4. **Exports** (JSON, ICS, CSV-zip): the same pattern in reverse. `export-slice` jobs write parts to STAGING (per table, ≤ 2k rows each),
   then a final slice streams them through `fflate` `Zip` into `exports/<jobId>.zip`. The handler waits, then streams the R2 object body to the client with the
   same `Content-Disposition`. The response body is streamed from R2 and costs no CPU. Small exports (row count < 2,000, which is most users) take the inline fast path.
5. The habit import (5 MiB, zip) uses the inline path with a budget check; over budget, it goes to the slice path.

Queue cost: a 15 MiB file in 512 KiB slices is 30 messages (90 ops). Acceptable for a rare action, and limited by `import_file` 30/h.

---

## 14. Observability

- Workers Logs (`observability.enabled`, Free: 200k events/day, 3-day retention). One structured JSON line per request:
  `{rid, method, route (pattern, not path: no ids or tokens), status, ms, d1_queries, cpu_hint}`. Unhandled errors log the stack.
  Never log bodies, emails, codes or tokens (console mailer only in dev/test).
- `cf-ray` is echoed as `X-Request-Id`.
- `POST /v1/client-errors` and `/v1/admin/client-errors`/`abuse` are unchanged (D1 tables, fingerprint upsert, the MAX_GROUPS bound).
- Health: `GET /health` → `{"status":"healthy"}` (no D1); `/health/ready` → `SELECT 1`; `/health/worker` → heartbeat age. Upptime keeps watching `/health`
  plus adds `/health/worker`.
- Error alerts: job 12 emails admins (hourly). No third-party APM.

---

## 15. Testing

- **vitest-pool-workers** with `isolatedStorage: true` (each test gets a fresh D1/R2 snapshot; no truncation and no risk to a dev DB, which removes the `make test` trap).
  Migrations are applied once in `setupFiles` via `applyD1Migrations`. Queues are tested by calling the consumer handler directly with `createMessageBatch`;
  cron via `createScheduledController`. `fetchMock` intercepts Turnstile, Brevo, OFF and push endpoints (no network in tests).
- **Porting the 285 pytest cases**: each pytest file becomes a `*.test.ts` with the same test names (snake_case kept in the `it()` title so a script can diff
  the lists). CI step `scripts/test-parity.ts` fails if any pytest name lacks a TS counterpart or an explicit `// parity: dropped because …` entry
  (e.g. Argon2/Fernet compatibility tests). Shared fixtures port conftest: `signup()`, `login()`, `authed()`, soft WebAuthn authenticator, `fakeStorage`.
- **Query-count budgets**: `db/client.ts` wraps D1 `prepare`/`batch` and counts round trips and statements per request. Every route test asserts
  `roundTrips <= budget` (table in §17). A regression test generator seeds a heavy user (5 years, 3k workouts, 30k sets, 20 habits) and asserts that budgets hold,
  so there is no N+1 by construction.
- **CPU budget tests**: a benchmark suite (`vitest bench` in workerd) measures recompute, snapshot, a 512 KiB import slice, a push encrypt and PBKDF2 on the heavy user,
  failing CI if the median exceeds the budget × 0.6 (CI hardware is slower and noisier; staging `wrangler tail` gives the real numbers).
- **Property tests** (`fast-check` 4.x, dev only): incremental projection == full rebuild; tz SQL hour match == `Intl` hour match for every IANA zone at random instants.
- **Contract tests against the app**: `app/src/lib/types.ts` is the client's view of every response. A script extracts the request paths from `app/src`
  (`api("/…")` calls) and asserts each one exists in the Hono router with the method used. Response zod schemas are type-checked against `app`'s
  TS types with a `satisfies` compile test (the `app` repo is a sibling submodule; CI checks it out). In addition, golden responses for ~40
  representative endpoints are recorded from the old FastAPI test suite (run once before decommissioning) and compared structurally (keys and types, not values).
- Playwright e2e in `app` runs against `wrangler dev` of the new API in CI.

---

## 16. CI/CD, deploy and retirement

- **GitHub Actions `ci.yml`** (PR + main): pnpm install --frozen-lockfile → `wrangler types --check` → `tsc --noEmit` → `biome ci` → `vitest run` (pool-workers)
  → bench (non-blocking on PR, blocking on main) → `wrangler deploy --dry-run --outdir dist` + bundle size gate → `drizzle-kit check` (migration drift)
  → gitleaks. No secrets are needed in CI.
- **Deploy: Workers Builds** connected to `PaceStreak/api` `main`, consistent with "push to `main` deploys" and needing no API token in GitHub.
  Build command `pnpm install --frozen-lockfile && pnpm test:unit`; deploy command
  `pnpm wrangler d1 migrations apply pacestreak --remote && pnpm wrangler deploy`. Migrations run first, so they must be backward compatible (as today).
  Non-production branches upload Preview versions against staging bindings.
- **Custom domain**: attach `api.pacestreak.com` to the Worker (`custom_domain: true`). This replaces the FastAPI Cloud DNS-only CNAME. Cutover order: deploy to
  staging, run the app e2e against it, then in the dashboard remove the FastAPI Cloud custom domain and its CNAME and deploy the Worker with the route (Wrangler creates the
  proxied record bound to a live deployment, so there is no 522 window per AGENTS.md). Rollback = `wrangler rollback` + version history.
- CSP: `app/public/_headers` `connect-src https://api.pacestreak.com` is unchanged (same host). Nothing changes in `web`/`blog`.
- **Retire after one clean week**: FastAPI Cloud app `pacestreak-api`; GitHub workflows `Worker tick`, `Migrate`, image publish; GHCR image and the
  `WORKER_ENV_JSON` secret; Neon project (no data to keep); Upstash Redis; the old JWT/VAPID/Fernet keys; Brevo SMTP credentials (replaced by an API key; Brevo
  itself goes when moving to Paid). Update `infra/TOPOLOGY.md`, `RUNBOOK.md`, `DECISIONS.md`, root `AGENTS.md` "How production runs", and
  **`/privacy`** (providers become Cloudflare + Brevo; drops Google Cloud/FastAPI Cloud/Neon/Upstash/GitHub-runner) with a **`terms_version` bump**
  (material change, as HANDOFF §6 requires).
- Backups: D1 Time Travel (30 days on Free and Paid) replaces Neon's 6-hour restore history, which is an improvement. `/privacy` wording is updated to match.
  No off-host backups (declined by the owner).

---

## 17. Performance budget per endpoint class (Free plan targets; enforced by tests)

| Class | Examples | D1 round trips | CPU (p99) | Subrequests |
|---|---|---|---|---|
| Health | `/health` | 0 | 0.3 ms | 0 |
| Auth-gated read | `/me/stats`, `/workouts?since`, `/habits`, `/notifications` | **1** (auth + reads in one batch) | 3 ms | 0 |
| Snapshot read | `/me/xp`, `/me/achievements`, `/me/review` | 1 | 5 ms (aggregates, not history) | 0 |
| Simple write | habit log, kudos, comment, settings | 2 (read batch, write batch incl. rate counter) | 3 ms | ≤1 (queue send) |
| Workout write + outcome | `PUT /workouts/{id}`, `/workouts/batch` (≤200 ops) | 2–3 | 6 ms | 1 |
| Password routes | login, signup, change/reset | 2 | PBKDF2 (gate G-1) + 1 ms | ≤2 (Turnstile, queue) |
| Search | `/search`, `/people` | 1 | 2 ms | 0 |
| Import/export | multipart import, export zip | 2 + polling | 2 ms in handler; ≤6 ms per slice | R2 + queue |
| Cron dispatcher | all four | ≤ 1 per job | ≤ 6 ms | ≤ 12 (`sendBatch`) |
| Queue consumer | deliver, recompute slice | ≤ 3 | ≤ 6 ms | ≤ 40 |

Wall-clock target: p95 < 60 ms for auth-gated reads from Europe/Asia with Smart Placement (one D1 round trip ≈ 10–30 ms from a co-located Worker).

---

## 18. Risks (ranked)

1. **PBKDF2 100k over 10 ms CPU on Free** (likely ~15–25 ms). Gate G-1 measures it in week 1. If confirmed, the honest answer is the $5 Paid plan before real users,
   and the design already switches with `PLAN=paid`. Iterations are never lowered.
2. **Free CPU enforcement and Workers runtime overheads** (JSON decode of D1 results, zod, Hono) eat more than estimated on heavy users. Mitigation: aggregates,
   bench gates, slicing; escape hatch is the same `PLAN=paid` switch.
3. **Incremental projection drift** from the full-history semantics of `snapshot` (streak repairs, wagers, pauses, requirements_history, records "cooled"/"flagged" rules).
   Mitigation: property tests against a full rebuild, plus a nightly sampled full rebuild that compares and logs mismatches.
4. **Queue ops (10k/day)** at moderate scale; bounded by packing and by not enqueueing empty work; Paid lifts it.
5. **Resumable FIT parsing with `@garmin/fitsdk`** may need a custom reader (G-3).
6. **Brevo HTTP API** stays a third-party dependency until Paid. Brevo's API might enable tracking defaults that its SMTP did not; verify before cutover.
7. **Push host allowlist** rejects an unknown push service. Mitigation: log rejections; the list is a config var.
8. **Rate Limiting binding is approximate and per-location**: a distributed attacker gets N/min per colo. Turnstile on every mailer and auth endpoint is the real control, as today.
9. D1 per-database limits (10 GB on Paid, 500 MB on Free for a single DB). Photos are in R2, so 500 MB holds very many users of text data; watch it on `/admin/metrics`.

---

## 19. Phased build order (for parallel agents)

Gates before Phase 1: **G-1** PBKDF2 CPU in staging, **G-2** `waitUntil` + Queue + polling-wait pattern proof, **G-3** FIT slice resume, **G-4** 422 message table vs pydantic.

**Phase 0 (one agent, ~1 day): skeleton.** Repo layout, tooling, wrangler envs, `env.ts`, error/validation/CORS/version middleware, D1 client with query counter,
uuid7, time helpers (ms ↔ ISO, tz offsets, ISO week, `pyRound`, `formatG`, text fold), `budget.ts`, test harness and fixtures, CI. Full Drizzle **schema for all 60 tables**
plus `sessions`, `rate_counters`, `job_leases`, `tz_offsets`, `import_jobs`, `export_jobs`, `user_week_agg`, `user_records_best`, then `0000_init.sql`. Every later module imports the schema; nobody edits it without a migration PR.

**Phase 1 (parallel, after 0):**
| Module | Depends on | Notes |
|---|---|---|
| A. `lib/crypto` (PBKDF2, HS256 JWT, HMAC, AES-GCM, TOTP, constant-time) | 0 | pure, unit-tested against RFC vectors |
| B. `lib/ratelimit` + `lib/turnstile` | 0 | |
| C. `lib/mailer` (console, brevo, cloudflare) + templates | 0 | port exact email strings from core.md §6.2 |
| D. `lib/push` (RFC 8291/8292) + SSRF guard | 0 | test against RFC 8291 appendix vectors |
| E. `lib/r2` (presign, verify upload) | 0 | |
| F. `jobs/` framework: queue consumer router, cron dispatchers, leases, heartbeat, budget packer | 0 | jobs plugged in later |
| G. `heavy/` slicers: multipart stream reader, GPX, FIT, CSV, JSON, zip writer | 0 | pure, no DB; fed bytes, emit rows |

**Phase 2 (parallel, after A–C):**
| Module | Depends on |
|---|---|
| H. `auth/` (29 routes, sessions, passkeys) | A, B, C |
| I. `ops/` (health, client-errors, abuse) + `admin/` (reports, users, merge, metrics) | H (gates), C |
| J. `notifications/` (11 routes, notify, deliver consumer, unsubscribe signing) | H, C, D, F |

**Phase 3 (parallel, after H and J):**
| Module | Depends on |
|---|---|
| K. `game/` engine: aggregates, snapshot, recompute (incremental + full slices), recap, quests, XP, badges | H, J, F |
| L. `profile/` + `account/` (settings, calendar feed, export/import routes, deletion) | H, K-interfaces, G, E |
| M. `training/` (workouts, sync, batch, sets, exercises, routines, plans, gear, gyms, photos, import route) | H, K-interfaces, G, E |
| N. `habits/` + `insights/` + journal + routines + habit import | H, K-interfaces, G |
| O. `nutrition/` (18 routes, OFF lookup + Cache API, expenditure) | H |
| P. `social/` + buddies + `groups/`/challenges + `search/` | H, J, K-interfaces |
| Q. `trash/` | M, N, O |

K publishes its **interfaces** (`applyWorkoutDelta`, `applyHabitDelta`, `recomputeSync`, `enqueueFull`) on day 1 of Phase 3 as stubs, so L–Q proceed in parallel.

**Phase 4 (after all):** the 12 jobs wired into F (each a ~50-line slice function using module services); contract tests vs `app`; app e2e against staging;
golden-response comparison; load/bench on the heavy-user seed; docs (README, infra, AGENTS.md, `/privacy` + `terms_version`); cutover and retirement (§16).
