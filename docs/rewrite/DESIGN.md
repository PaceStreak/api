# PaceStreak API on Cloudflare Workers: final design

Date: 2026-10-17. Status: final, ready for implementation agents.
Base: proposal "freetier" (highest judge scores). Every flaw the three judges raised is fixed here.
The best ideas from "maint" and "perf" are grafted in. Section 20 lists each judge flaw and how it was
resolved.

Inputs: spec/{core,auth,account,training-a,training-b,game,habits,social,misc,schema,gaps}.md,
`app/src` (grepped), `app/public/_headers`, npm registry (queried 2026-10-17).

Facts re-verified for this document:

| Fact | Source / check | Consequence |
|---|---|---|
| Email Service `send_email` to arbitrary recipients needs Workers Paid; Free can send only to verified destination addresses | Email Service pricing/docs (all three judges agree, checked 2026-10-17) | Brevo HTTP API is the **default** on Free |
| D1 Time Travel: **7 days on Free**, 30 days on Paid | D1 docs (two judges plus maint agree) | `/privacy` says 7 days while on Free |
| PBKDF2 in Workers WebCrypto is capped at 100,000 iterations | owner brief | 100k, never lower |
| `app/public/_headers` `connect-src` already allows `https://fef2509f0377fba1f3201a655090ec0a.r2.cloudflarestorage.com` | grep | Presigned PUT/GET straight to R2, as today; no proxy route |
| The app's sync cursor (`sync.cursor` in IndexedDB `pacestreak`) is **global per device**, is not keyed by user and is not cleared on logout | `app/src/lib/sync.ts:20,227-241`, `app/src/lib/db.ts:72` | `sync_seq` stays a **single global** monotonic counter (exact parity). A per-user counter would change cursor semantics for a device used by two accounts |
| `@cloudflare/vitest-pool-workers` peer dependency is `vitest ^4.1.0` (vitest 5 is not supported) | `npm view` | vitest 4.1.11 |
| CPU limit on Free applies to every invocation type (fetch, cron, queue, DO) | Workers limits docs | Heavy work is sliced; DOs are not a CPU escape hatch |

---

## 1. Decisions in one table

| Area | Decision |
|---|---|
| Runtime | One Worker `pacestreak-api` (fetch + scheduled + queue handlers), Hono, `nodejs_compat` **off** |
| Repo | `PaceStreak/api`, rewritten in place on branch `workers`; the Python tree is deleted in the same PR that cuts over |
| DB | D1, one database per environment. Drizzle ORM schema; drizzle-kit generated SQL migrations; applied with `wrangler d1 migrations apply` |
| IDs | UUIDv7 as TEXT, in-house (`lib/uuid7.ts`, about 20 lines); client-supplied UUIDs accepted where the spec allows |
| Time | INTEGER epoch ms in the DB; ISO-8601 with `Z` on the wire through one `toWire()` helper; dates TEXT `YYYY-MM-DD` |
| Passwords | PBKDF2-HMAC-SHA256, 100,000 iterations, HMAC pepper first, PHC-style self-describing string. Over CPU budget means `PLAN=paid`, never fewer iterations |
| JWT | HS256 on WebCrypto, in-house (about 60 lines), `kid` key ring in one secret |
| Sessions | `sessions` table (one row per refresh family). The auth SELECT (`sessions JOIN users`) is **statement 0 of the handler's own `db.batch`**. No cache, no denylist, revocation is immediate |
| Rate limits | Per-IP per-minute: Workers Rate Limiting binding. Per-user hour/day buckets: a D1 counter UPSERT as statement 0 of the guarded write batch, with the write predicated on the count |
| KV | Not used |
| Caching | Cache API for barcode lookups and `/health`; ETag/304 on `/v1/sync`-class reads and `/v1/me/stats`; static catalogues compiled into the bundle |
| Background | `waitUntil` for cheap bounded work; Queue `pacestreak-jobs` for fan-out and heavy work; 3 cron triggers (2 spare) |
| Email | `Mailer` interface: `brevo` (HTTP API, Free default), `cloudflare` (`send_email`, for Paid), `console` (dev/test). One var selects |
| Push | RFC 8291 + RFC 8292 in-house on WebCrypto; new VAPID key; SSRF guard by host allowlist plus IP-literal rules |
| Photos | R2 binding for head/get/delete; `aws4fetch` presigned PUT/GET, same wire flow as today |
| Imports/exports | Inline under a plan-dependent size cap; above it, staged in R2 and processed by queue slices, with an additive `"queued": true` in the same response shape |
| Plan switch | `PLAN` var read only in `lib/budget.ts`; `limits.cpu_ms` already in wrangler config |
| Tooling | pnpm 10, TypeScript 7.0.2 strict, Biome 2.5.15, vitest 4.1.11 + pool-workers 0.22.0, wrangler 4.147.0 |
| Deploy | Workers Builds (Git-connected, push to `main` deploys, migrations first); custom domain `api.pacestreak.com` |

---

## 2. Project layout and tooling

```
api/
  wrangler.jsonc  package.json  pnpm-lock.yaml  tsconfig.json  biome.json  vitest.config.ts
  drizzle.config.ts  renovate.json  .dev.vars.example  worker-configuration.d.ts (wrangler types output, committed)
  migrations/0000_init.sql ...                 drizzle-kit output; never edited after merge
  src/
    index.ts            export default { fetch, scheduled, queue }
    app.ts              Hono app, middleware order, route mounting
    env.ts              Env type + zod-parsed config, cached per isolate, production gate
    ctx.ts              Ctx {db, clock, env, cfg, defer, log} built per request/job, injected everywhere
    db/
      schema/*.ts       one file per module; index.ts re-exports
      client.ts         drizzle(d1) + counting wrapper (round trips, statements)
      batch.ts          AuthedBatch, writeBatch, withFold(), toWire()
      fk-users.gen.ts   generated (table, column) list of FKs to users, for merge/purge
    lib/                pure helpers: errors, validation hook, http (CORS, version), time/tz, isoweek,
                        uuid7, b64url, crypto (pbkdf2, hs256, hmac, aes-gcm, totp), format (pyRound, formatG),
                        fold, budget, ratelimit, turnstile, mailer/, push/, r2, etag, logger
    modules/
      auth/ profile/ account/ training/ game/ habits/ insights/ nutrition/ social/ groups/
      notifications/ search/ admin/ ops/ trash/
        each: routes.ts (Hono sub-app), service.ts (the ONLY file other modules may import),
              repo.ts (statements), schemas.ts (zod), *.test.ts
    catalog/            exercise library, achievements, quest pool, templates (frozen data + lookup maps)
    heavy/              pure parsers/writers: multipart stream reader, csv, gpx, fit, account-json, zip
    jobs/               cron dispatchers, queue consumer router, leases, heartbeat, the 12 jobs
  test/                 fixtures (signup/login/authed, soft WebAuthn authenticator, fake R2 presign),
                        contract/, parity/, bench/, explain/
  scripts/              admin CLI (create-admin, set-password, set-role) as tsx scripts over wrangler d1 execute;
                        test-parity.ts; extract-app-routes.ts; check-module-deps.ts
```

- **Package manager**: pnpm 10 (`packageManager: "pnpm@10.18.x"` pinned exactly by Phase 0), `pnpm install --frozen-lockfile` in CI and Workers Builds.
- **tsconfig**: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `verbatimModuleSyntax`, `isolatedModules`, `module: "preserve"`, `moduleResolution: "bundler"`, `target: "ES2024"`, `lib: ["ES2024"]`,
  `types: ["./worker-configuration.d.ts", "@cloudflare/vitest-pool-workers"]`. Runtime types come from `wrangler types` (committed; CI runs `wrangler types --check`).
- **Lint/format**: Biome 2.5.15 only. `noExplicitAny`, `noNonNullAssertion`, `useImportType`, `noFloatingPromises` all set to error.
- **Module dependency rule**: `scripts/check-module-deps.ts` (CI) fails when a file in `modules/X` imports anything from `modules/Y` other than `modules/Y/service.ts`, or when `lib/` imports from `modules/`. Handlers never touch `env.DB` directly: only `Ctx.db` and `AuthedBatch`.
- **Build**: Wrangler's esbuild. CI runs `wrangler deploy --dry-run --outdir dist` and fails if the gzipped bundle exceeds **400 KiB**.
- **Renovate**: `minimumReleaseAge: "14 days"`, exact pins, grouped weekly PRs.

### wrangler.jsonc

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "pacestreak-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "workers_dev": false,
  "preview_urls": false,
  "routes": [{ "pattern": "api.pacestreak.com", "custom_domain": true }],
  "placement": { "mode": "smart" },
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "limits": { "cpu_ms": 30000 },              // ignored on Free, active on Paid
  "d1_databases": [{ "binding": "DB", "database_name": "pacestreak", "database_id": "<id>", "migrations_dir": "migrations" }],
  "r2_buckets": [
    { "binding": "PHOTOS",  "bucket_name": "pacestreak-photos" },
    { "binding": "STAGING", "bucket_name": "pacestreak-staging" }   // lifecycle rule: delete after 2 days
  ],
  "queues": {
    "producers": [{ "binding": "JOBS", "queue": "pacestreak-jobs" }],
    "consumers": [{ "queue": "pacestreak-jobs", "max_batch_size": 10, "max_batch_timeout": 2,
                    "max_retries": 5, "dead_letter_queue": "pacestreak-jobs-dlq" }]
  },
  "ratelimits": [
    { "name": "RL_SIGNUP",  "namespace_id": "1001", "simple": { "limit": 5,  "period": 60 } },
    { "name": "RL_LOGIN",   "namespace_id": "1002", "simple": { "limit": 10, "period": 60 } },
    { "name": "RL_MFA",     "namespace_id": "1003", "simple": { "limit": 10, "period": 60 } },
    { "name": "RL_PWMAIL",  "namespace_id": "1004", "simple": { "limit": 3,  "period": 60 } },
    { "name": "RL_30",      "namespace_id": "1005", "simple": { "limit": 30, "period": 60 } },
    { "name": "RL_SEARCH",  "namespace_id": "1006", "simple": { "limit": 60, "period": 60 } }
  ],
  "triggers": { "crons": ["*/5 * * * *", "2,17,32,47 * * * *", "23 3 * * *"] },
  "vars": {
    "ENVIRONMENT": "production", "PLAN": "free", "MAILER": "brevo",
    "COOKIE_DOMAIN": "pacestreak.com", "CORS_ORIGINS": "https://app.pacestreak.com",
    "FRONTEND_URL": "https://app.pacestreak.com", "PUBLIC_API_URL": "https://api.pacestreak.com",
    "R2_ACCOUNT_HOST": "fef2509f0377fba1f3201a655090ec0a.r2.cloudflarestorage.com",
    "MAIL_FROM": "PaceStreak <hello@pacestreak.com>", "VAPID_SUBJECT": "mailto:hello@pacestreak.com",
    "PUSH_HOST_ALLOWLIST": "fcm.googleapis.com,push.apple.com,push.services.mozilla.com,notify.windows.com,push.vivaldi.net"
  },
  "env": {
    "staging": {
      "name": "pacestreak-api-staging", "workers_dev": true, "preview_urls": true, "routes": [],
      "vars": { "ENVIRONMENT": "staging", "PLAN": "free", "MAILER": "brevo", "COOKIE_DOMAIN": "",
                "CORS_ORIGINS": "http://localhost:5173,https://staging.pacestreak-app.pages.dev" },
      "d1_databases": [{ "binding": "DB", "database_name": "pacestreak-staging", "database_id": "<id>", "migrations_dir": "migrations" }],
      "r2_buckets": [{ "binding": "PHOTOS", "bucket_name": "pacestreak-photos-staging" }, { "binding": "STAGING", "bucket_name": "pacestreak-staging-staging" }],
      "queues": { "producers": [{ "binding": "JOBS", "queue": "pacestreak-jobs-staging" }], "consumers": [{ "queue": "pacestreak-jobs-staging", "max_batch_size": 10, "max_batch_timeout": 2, "max_retries": 5 }] },
      "triggers": { "crons": ["*/5 * * * *", "2,17,32,47 * * * *", "23 3 * * *"] }
    }
  }
}
```
(Rate limit and observability blocks repeat in `env.staging` with distinct namespace ids, since Wrangler does not inherit them.)

**Environments**: dev = `wrangler dev` (local D1/R2/Queues/rate limits, `MAILER=console`, `.dev.vars`);
staging = `pacestreak-api-staging.<acct>.workers.dev` with its own D1, buckets and queue; production = `api.pacestreak.com`.
Note that the staging cookie has no Domain, so staging is used from `wrangler dev` of the app or by tests, not from `app.pacestreak.com`.

**Secrets** (`wrangler secret put`, never in git, `.dev.vars.example` lists names only):
`JWT_KEYS` (JSON `{"current":"k2","keys":{"k2":"<b64 32B>","k1":"<b64 32B>"}}`), `PEPPER` (HMAC key: passwords, one-time codes,
recovery codes, unsubscribe and habit-action signing, calendar tokens), `DATA_KEY` (AES-256-GCM for TOTP secrets),
`VAPID_PRIVATE_JWK`, `VAPID_PUBLIC_KEY`, `TURNSTILE_SECRET_KEY`, `BREVO_API_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.

**Startup config gate** (`env.ts`): zod-parses vars and secrets once per isolate. In production a failure makes every request
return 500 `{"detail":"Something went wrong on our side. Try again in a moment."}` and logs `refusing to start: <reason>`.
Rules: the spec's §2.7 rules minus Fernet/SMTP, plus: `COOKIE_DOMAIN` set, no `*` in `CORS_ORIGINS`, `TURNSTILE_SECRET_KEY`
present, every JWT key at least 32 bytes, `PUBLIC_API_URL` https, `MAILER` config complete (`BREVO_API_KEY` when `brevo`;
`EMAIL` binding when `cloudflare`). A CI test boots with production vars and fake secrets.

`lib/budget.ts` is the only reader of `PLAN`:

| Budget | free | paid |
|---|---|---|
| subrequests per invocation (own soft cap) | 40 | 900 |
| queue consumer messages processed per invocation | 10 | 10 |
| deliveries per `deliver` message | 15 | 100 |
| inline import cap (bytes) | 256 KiB | 25 MiB (all spec caps) |
| import slice size | 256 KiB | n/a (inline) |
| inline export row cap | 2,000 rows | unlimited |
| backup email attachment cap | 2 MiB | 10 MiB (spec value) |
| full-rebuild slice (workouts) | 300 | 100,000 |

---

## 3. Libraries (exact pins; each is at least 14 days old today, pure JS/WebCrypto, no Node built-ins)

| Package | Version | Why |
|---|---|---|
| `hono` | 4.13.12 (2026-09-30) | Router (RegExpRouter), middleware, cookie parsing; first-class Workers |
| `zod` | 4.6.5 (2026-09-13) | All validation and config parsing; full API, needed for the custom 422 error map |
| `@hono/zod-validator` | 0.9.1 (2026-08-31) | `zValidator` with the custom FastAPI-shape hook |
| `drizzle-orm` | 0.45.3 (2026-09-21) | D1 driver, typed queries, `db.batch`; stay on 0.45 until 1.0 is GA |
| `@simplewebauthn/server` | 14.0.3 (2026-09-25) | Passkeys on WebCrypto. The Phase 0 spike proves it runs without `nodejs_compat` (soft authenticator test). Fallback: `nodejs_compat` scoped acceptance, decided in the spike, not by an agent later |
| `aws4fetch` | 1.0.20 (2024-08) | SigV4 query presigning for R2. Last release 2024, 6 KB, zero deps, recommended in R2 docs; SigV4 is a frozen spec |
| `fflate` | 0.8.3 (2026-07-20) | Zip write (CSV export, backup attachment) and unzip (habit import) |

Dev:

| Package | Version |
|---|---|
| `wrangler` | 4.147.0 (2026-10-02) |
| `@cloudflare/vitest-pool-workers` | 0.22.0 (2026-08-18), peer `vitest ^4.1.0` |
| `vitest` | 4.1.11 (2026-08-18). Not vitest 5: the pool does not support it |
| `drizzle-kit` | 0.31.11 (2026-09-21) |
| `@biomejs/biome` | 2.5.15 (2026-09-30) |
| `typescript` | 7.0.2 (2026-07-08). If drizzle types misbehave under TS 7 in the Phase 0 spike, pin 5.9.3 instead; decided in Phase 0 |
| `fast-check` | 4.10.2 (2026-09-19) |
| `tsx` | latest at least 14 days old, admin scripts only |

Deliberately **not** used, with the reason:
- `jose`: HS256 sign/verify is about 60 lines on WebCrypto, with no bundle cost.
- `otpauth`: TOTP is about 25 lines.
- `web-push`: needs Node.
- `@hono/zod-openapi`: adds bundle size and cold-start CPU on every route. `/openapi.json` is not served (gaps G1, option 1); a dev-only script can generate one later from the same zod schemas.
- `saxes`, `@garmin/fitsdk`, `@streamparser/json`: replaced by small in-house resumable readers (§13). saxes has had no release since 2021, the JSON parser is pre-1.0, and fitsdk resumability is unproven.
- `ipaddr.js`: IP-literal classification is about 50 lines over parsed octets (§11).
- `uuidv7`, `date-fns-tz`: `Intl` and 20 lines respectively.
- Any SMTP library: one HTTPS POST to Brevo is cheaper than an SMTP dialogue.

---

## 4. D1 schema strategy

- **Source of truth**: Drizzle schema in `src/db/schema/<module>.ts`; schema.md §1.2 is the checklist (60 tables).
  New tables: `sessions`, `rate_counters`, `job_leases`, `import_jobs`, `export_jobs`, `stat_weeks`, `stat_days`, `records_best`, `sync_seq`.
- **Migrations**: no data exists, so `0000_init.sql` is generated fresh. Afterwards drizzle-kit generates `NNNN_*.sql`.
  CI runs `drizzle-kit check` plus a drift test (apply all migrations to an empty D1, compare `sqlite_master` with a fresh generate).
  Deploy applies migrations **before** the code, so every migration is expand/contract and must work with the deployed code.
- **IDs**: UUIDv7 TEXT, generated in JS.
- **Timestamps**: INTEGER epoch ms (`$defaultFn(clock.now)`, `$onUpdateFn`). Cursors (`before`) accept the ISO string they came from and parse to ms.
  On the wire everything goes through `toWire(ms) = new Date(ms).toISOString()`. The app parses with `Date` (verified: no format-specific parsing in `app/src/lib`), so pydantic's `+00:00`/µs form is not reproduced. A contract test asserts every timestamp field matches `/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/`.
- **Dates**: TEXT `YYYY-MM-DD` (lexicographic order is chronological).
- **Enums**: TEXT with `CHECK(col IN (...))`; Drizzle `text({enum})` gives TS unions.
- **Booleans**: `integer({mode:'boolean'})`. **Binary** (passkey public keys): `blob`.
- **JSON columns**: `text({mode:'json'}).$type<T>()`, each with a zod schema applied on write; never queried with `json_extract` on hot paths; any field used in WHERE gets a real column. Arrays: JSON text with default `'[]'`.
- **Lengths**: zod `.max(n)` from the old varchar sizes (over-length becomes 422, an intentional change, §19). `CHECK(length(x) <= n)` only on email, handle, title, body as a backstop.
- **Floats**: `real`; Python output rules (`%g`, banker's rounding) live in `lib/format.ts`, tested against a table produced by the old service.
- **Foreign keys**: D1 enforces them. Every FK to `users` is `ON DELETE CASCADE` or `SET NULL` exactly as schema.md §1.3. Every FK column is indexed.
- **Case-insensitive search**: shadow `*_fold` columns written only through `withFold()` (a schema test asserts each fold column has its source column and is written in every insert/update helper): `users.email` stored folded; `profiles.handle_fold`, `profiles.display_name_fold`, `foods.name_fold`, `recipes.name_fold`, `habits.name_fold`, `routines.name_fold`, `groups.name_fold`, `custom_exercises.name_fold`, `journal.note_fold`. Fold = `s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()`. Queries use `x_fold LIKE ? ESCAPE '\'` with the term folded and escaped by `likePattern(term, 'prefix'|'contains')`. Prefix searches use the index. `ORDER BY name` becomes `ORDER BY name_fold, name`; NULL ordering is explicit where schema.md §2 #22-23 lists it.
- **Replacing Postgres-only behaviour**:

| Postgres | D1 replacement |
|---|---|
| Interactive transactions | Every route is *read phase* (one `db.batch` of SELECTs, starting with the auth statement) then *write phase* (one atomic `db.batch`). Check-then-insert races are closed by UNIQUE constraints; the global handler maps constraint errors to 409. `writeBatch(ctx, stmts)` is the only commit path |
| `sync_seq` sequence | **Global** single-row `sync_seq(id=1, value)`. A workout write batch contains `UPDATE sync_seq SET value=value+1 WHERE id=1` and then the row write using `(SELECT value FROM sync_seq WHERE id=1)`. For n rows, n pairs in the same batch: one round trip. D1 serialises writes, so it is strictly monotonic. Kept global because the app's cursor is per device, not per user (verified above) |
| `pg_advisory_xact_lock` around recompute | Optimistic concurrency without `changes()`: `user_stats.rev`. The recompute write batch starts with `UPDATE user_stats SET ..., rev=rev+1 WHERE user_id=?1 AND rev=?2`, and every later statement is guarded by `WHERE EXISTS (SELECT 1 FROM user_stats WHERE user_id=?1 AND rev=?2+1)` (an explicit predicate, not reliant on `changes()` across batch statements). On a lost race (RETURNING empty) it re-reads and retries once; level-up/badge/record notifications carry dedupe keys with `ON CONFLICT DO NOTHING`, so duplicates are impossible either way. Ported test `test_recompute_is_serialized_across_concurrent_calls` passes unchanged |
| Savepoint per outbox op (`/workouts/batch`) | Validate all ops in JS (pure), producing `{ok:false,status,detail}` for invalid ones. Then **one** `db.batch` of LWW UPSERTs `INSERT ... ON CONFLICT(id) DO UPDATE SET ... WHERE excluded.client_updated_at > workouts.client_updated_at RETURNING id, seq`; `applied` is derived from RETURNING. If the batch fails with a constraint error, it falls back to per-op batches to isolate the bad op (rare path). Recompute runs once afterwards |
| Catalog-driven account merge | `fk-users.gen.ts` (generated from the Drizzle schema; a test asserts it equals `pragma_foreign_key_list` across all tables). Per column `UPDATE OR IGNORE t SET c=:dst WHERE c=:src; DELETE FROM t WHERE c=:src;` in one batch, self-links first, then a full-rebuild recompute is enqueued |
| `timezone(tz, now())` hour matching | JS: `SELECT DISTINCT timezone FROM profiles` (index `profiles(timezone)`, tens of rows). The local hour/date for each zone comes from a memoised `Intl.DateTimeFormat`, and the zones are grouped by local hour. The job query then uses `WHERE p.timezone IN (...zones whose local hour = H)` chunked at 90 binds. Always fresh: no offset table, so DST cannot go stale |
| `date_trunc('week')` | computed in JS (`lib/isoweek.ts`) and bound as a parameter |

- **Precomputed aggregates** (keep recompute and snapshot reads bounded):
  - `stat_days(user_id, local_date, chain_id, sessions, detailed, minutes, distance_m, xp) WITHOUT ROWID, PK(user_id, chain_id, local_date)`
  - `stat_weeks(user_id, chain_id, week_start, days_mask, sessions, detailed, minutes, distance_m) WITHOUT ROWID, PK(user_id, chain_id, week_start)`
  - `records_best(user_id, key, value, achieved_on, workout_id) WITHOUT ROWID, PK(user_id, key)`
  These are UPSERTed **inside the write batch** of every workout, set, habit log, pause and rest-day write (affected day/week only), using deltas computed by the pure engine.
  `snapshot()` reads aggregates (at most ~371 day rows / 106 week rows), never raw history. Old-session edits rescan only the touched record keys (index `(user_id, exercise_id, local_date)`).
  A full rebuild (import, merge, restore, engine version bump) runs as queue slices. **Property test** (fast-check): incremental result equals full replay for random op sequences.
  `user_stats` stays the read model for `/me/*`, feeds and leaderboards; it carries `version` for ETags.
- **Indexes**: every FK; `workouts(user_id, seq)`, `workouts(seq)` (global changes feed), `workouts(user_id, local_date)`, `habit_logs(habit_id, day)`, `meal_entries(user_id, local_date)`,
  `notifications(user_id, created_at DESC)`, `notifications(delivered_at) WHERE delivered_at IS NULL`, `profiles(timezone)`, `habits(remind_hour) WHERE remind_hour IS NOT NULL AND archived_at IS NULL`,
  `habits(snoozed_until) WHERE snoozed_until IS NOT NULL`, `profiles(deletion_scheduled_at) WHERE deletion_scheduled_at IS NOT NULL`, `client_errors(first_seen) WHERE alerted_at IS NULL`,
  `user_stats(season_xp DESC)`, `sessions(user_id)`, `refresh_tokens(token_hash)`, each `*_fold` column.
  **EXPLAIN QUERY PLAN lint** (`test/explain/`): every statement registered in a `repo.ts` is planned against the migrated schema; a `SCAN` of a user-data table fails unless annotated `// scan-ok: <reason>`.

---

## 5. Request pipeline

Order (outermost first):

1. **Error boundary** (`app.onError`, `app.notFound`, method-not-allowed): 404 `{"detail":"Not Found"}`, 405 `{"detail":"Method Not Allowed"}` with `Allow`.
   `HttpError(status, detail, headers?)` gives `{detail}`. A D1 error matching `UNIQUE|FOREIGN KEY|NOT NULL|CHECK constraint failed` gives
   409 `{"detail":"That was saved twice at once. Try again."}`. Anything else is logged with rid, method, route pattern, stack and gives 500 `{"detail":"Something went wrong on our side. Try again in a moment."}`.
2. **Version header**: `PaceStreak-Version: 1` on every response whose path starts with `/v1` (applied after `next()` in a `finally`, so 422/429/500/preflight carry it). Health routes do not get it (spec 1.1).
3. **CORS**: in-house (about 40 lines), exact Starlette semantics from core.md §2.1: explicit origin `Set` built once per isolate, `Access-Control-Allow-Credentials: true`, `Vary: Origin`, preflight answered with 200 and the allowed methods/headers (incl. `X-CSRF-Token`, `Content-Type`, `Authorization`). It wraps the error boundary output, so 500s carry CORS headers.
4. **Config gate** (production misconfiguration gives 500).
5. **Request context**: `Ctx` with request id (`cf-ray`, echoed as `X-Request-Id`), clock, counting D1 wrapper, logger.
6. **Body limit**: 1 MiB default; 25 MiB on the two import routes; 5 MiB on habit import; spec 413 texts. Multipart imports are streamed, never buffered (§13).
7. **Per-IP rate limit** (route-level, §7).
8. **Turnstile** (route-level on signup, login, forgot-password, resend-verification, recover).
9. **Auth** (route-level: `auth()`, `optionalAuth()`, `moderator()`, `admin()`). It does **not** query D1 itself: it verifies the JWT (about 20 µs) and attaches an `AuthedBatch` whose statement 0 is the session/user check (§6). **CSRF** check on `/v1/auth/refresh` and `/v1/auth/logout` only.
10. **Validation**: `zValidator` with a hook producing `{"detail":[{"type","loc":["body",...path],"msg","input"}]}` with 422. The app reads only `detail[0].loc` (minus `"body"`) and `detail[0].msg` (stripping `Value error, `), so the hook emits pydantic-style `msg` text for the common codes (`Field required`, `String should have at least N characters`, `String should have at most N characters`, `value is not a valid email address: ...`, `Input should be ...`, `Input should be greater than or equal to N`). A table test covers each. Objects are non-strict (extra keys ignored, like pydantic); coercions only where the app sends strings (query params).
11. **Handler** (read batch, then write batch).
12. **After response**: `ctx.defer(promise)` (wraps `waitUntil`) for queue sends and `auth_failures` writes.

Non-standard bodies kept for parity: slowapi-style 429 `{"error":"Rate limit exceeded: 10 per 1 minute"}` with `Retry-After`; per-user 429 `{"detail":"Slow down - try again in a little while."}`; change-email's string 422.
`/docs`, `/redoc`, `/openapi.json` are not served (gaps G1 option 1; README updated).

### AuthedBatch (typed, so a handler cannot skip the session check)

```ts
const [me, rows, counts] = await c.var.authed.read(q.listWorkouts(uid, since), q.countX(uid));
// AuthedBatch.read prepends:
//   SELECT u.id,u.email,u.role,u.is_active,u.is_verified,u.token_version,s.revoked_at
//   FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?1 AND s.user_id=?2
// and throws 401 before returning any handler rows if the session is missing/revoked,
// the user is inactive, or token_version != jwt.ver.
```
`authed.write(...stmts)` prepends a guard statement too, and every write statement in that batch is predicated on
`EXISTS(SELECT 1 FROM sessions WHERE id=?sid AND revoked_at IS NULL)`, so a write racing a logout cannot land.
A handler with a read phase and a write phase spends 2 round trips; a pure write (no read needed) spends 1.
The raw `env.DB` is not reachable from modules (the lint above).

---

## 6. Auth design

### Passwords
- Format `pbkdf2-sha256$v=1$i=100000$<salt b64url 16B>$<dk b64url 32B>`; input is `HMAC-SHA256(PEPPER, password)` (so a D1 dump alone cannot be brute-forced). Verify parses `i`, so iterations can change without a migration (rehash on login when below current).
- **Cost, honestly**: 100k iterations is about 200k SHA-256 compressions: realistically **10-25 ms CPU** on Cloudflare hardware. That is likely over the Free 10 ms limit. Gate **G-1** measures `cpuTime` from `wrangler tail` on staging for signup/login/change/reset/recover in week 1.
- If p99 is over 10 ms on Free, the answer is **`PLAN=paid`** ($5/month), which the owner should expect before real users arrive. Iterations are **never** lowered. (Free-plan enforcement tolerates occasional overruns, which keeps staging/dev usable, but the design does not rely on it.)
- Unknown-email login runs PBKDF2 against a per-isolate dummy hash (timing parity).

### Tokens
- **Access JWT**: HS256, header `{alg:"HS256",typ:"JWT",kid}`, claims identical to today (`sub,type,ver,sid,jti,iss,aud,iat,exp`), 15 min. `JWT_KEYS` holds a key ring; sign with `current`, verify with the `kid` named in the header. Rotation: add a new key, make it current, remove the old one after 15 min. HS256 because only this Worker signs and verifies.
- **MFA challenge JWT**: same keys, `type:"mfa"`, 5 min.
- **Refresh**: 64 random bytes base64url, stored as SHA-256 hex in `refresh_tokens(token_hash, session_id, replaced_by, used_at, expires_at)`. Rotation identical to auth.md §4: 30 s reuse grace returns the already-issued successor; reuse after grace burns the family (`sessions.revoked_at = now`). The rotation write is one batch guarded by `WHERE replaced_by IS NULL` with RETURNING; an empty RETURNING means a concurrent rotation won, so the code takes the grace path.
- **Sessions**: `sessions(id = family id, user_id, created_at, last_used_at, expires_at, revoked_at, user_agent, ip)`. `GET /v1/auth/sessions` lists rows directly; revoke = set `revoked_at`. Logout-all bumps `users.token_version` and revokes all sessions in one batch. `last_used_at` is written only on refresh, never per request.
- **rpID / origin**: unchanged from the spec: `rpID = hostname(FRONTEND_URL) = app.pacestreak.com`, origin `https://app.pacestreak.com`. (Parity; no undeclared change.)

### Cookies and CSRF
Exactly auth.md §1: `__Secure-refresh_token` (HttpOnly) and `__Secure-csrf_token`, `Path=/v1/auth`, `Domain=pacestreak.com`,
`SameSite=lax`, `Secure`, same Max-Age/`expires`; deletion emits matching attributes. `Set-Cookie` strings are built by hand for exact parity.
CSRF: constant-time compare (`crypto.subtle.timingSafeEqual`) of cookie and `X-CSRF-Token`; mismatch gives 403 `{"detail":"Invalid CSRF token"}`.

### TOTP, recovery codes, email codes, passkeys
- **TOTP**: SHA-1, 6 digits, 30 s, window ±1, `totp_last_used_step` replay guard; in-house over WebCrypto HMAC-SHA1. The secret is 20 random bytes, base32 for the URI, stored as `v1.<iv>.<ct>` AES-256-GCM under `DATA_KEY`. Provisioning URI format identical.
- **Recovery codes**: stored as `HMAC-SHA256(PEPPER, normalised code)`; redeem = one `UPDATE recovery_codes SET used_at=? WHERE user_id=? AND code_hmac=? AND used_at IS NULL RETURNING id` (indexed).
- **Email codes** (verify, reset, email change): 6 digits, `HMAC(PEPPER, purpose|user|code)`, new code invalidates prior ones, **attempt counter persisted** (5 attempts; intentional fix of the spec's open question 1).
- **Passkeys**: `@simplewebauthn/server` 14.0.3, `attestationType: 'none'`. Challenges in `webauthn_challenges`, consumed with `DELETE ... RETURNING`. Public keys are BLOBs. ES256 verify is about 0.3 ms.

### Turnstile
`fetch` siteverify with `AbortSignal.timeout(5000)`, `remoteip` from `CF-Connecting-IP`; fail-closed 503 and all texts as core.md §2.4. Dev/test use Cloudflare's documented test secret.

---

## 7. Rate limiting (no KV)

| Kind | Mechanism |
|---|---|
| Per-IP per-minute (signup 5, login 10, mfa 10, password-email 3, client-errors/habit/nutrition 30) | **Rate Limiting binding**, key `${route}:${ip}`. No storage writes. Counters are per-location and approximate; Turnstile is the real control on the auth/mailer routes |
| Per-user buckets (the 22 `enforce()` buckets, windows 60 s to 86,400 s) on write routes | `rate_counters(key PK, window_start INT, count INT)`. **Statement 0 of the guarded write batch**: `INSERT INTO rate_counters ... ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count+1 ELSE 1 END, window_start = excluded.window_start RETURNING count`. Every guarded write statement in the batch is predicated `AND (SELECT count FROM rate_counters WHERE key=?) <= :limit`. If RETURNING count > limit, the handler returns the per-user 429. Atomic: it cannot fail open, and a rejected call writes only the counter |
| `search` (60/60 s per user, read route) | Binding `RL_SEARCH` keyed by user id |
| `calendar_feed` (120 per hour per token) | **Same semantics as today**: a `rate_counters` row keyed `cal:<token_hash>` with a 3,600 s window, as statement 0 of the feed's read batch (the one write this read route makes; calendar clients poll rarely). The `.ics` is also cached for 5 min in the Cache API keyed by token hash, so repeated fetches cost nothing |

The daily cron deletes `rate_counters` rows whose window ended more than a day ago.

---

## 8. Caching

- **No user/auth cache.** The auth check rides in the handler's batch (one indexed PK lookup, sub-ms on the D1 side).
- **Cache API** (per colo, no write quota): Open Food Facts barcode results (24 h; negatives 1 h); `GET /health` (5 s); calendar `.ics` (5 min).
- **ETag / 304**: `GET /v1/workouts/changes`, `GET /v1/sync`-class reads and `GET /v1/me/stats` emit a weak ETag from `(sync_seq value seen, user_stats.version)`. The ETag inputs come back in the same batch as the auth row, so a 304 costs one round trip and no serialisation. (Additive: the browser handles `If-None-Match` transparently.)
- **Static catalogues** compiled into the bundle (exercise library with a precomputed fold index, achievement rules, quest pool, plan templates), built once per isolate.
- `Intl.DateTimeFormat` memoised per tz in a module-level `Map`.

---

## 9. Background work

### Lanes
1. **`ctx.defer` (`waitUntil`)**: shares the request's CPU and subrequest budget, so only bounded work: one `JOBS.send`/`sendBatch`, an `auth_failures` insert. It **never** sends push or email.
2. **Queue `pacestreak-jobs`**: messages `deliver{ids[]}`, `recompute{userId, full?}`, `rebuild-slice{userId, cursor}`, `job-slice{job, ids[]}`, `import-slice{jobId}`, `export-slice{jobId, part}`, `purge{userIds[]}`. The consumer routes by type. `budget.ts` packs work so one invocation stays under 40 subrequests and about 6 ms CPU on Free; leftover work is re-enqueued. DLQ `pacestreak-jobs-dlq` is inspected by `/v1/admin/metrics`.
3. **Cron dispatchers**: select ids (indexed, LIMIT 500), and if non-empty enqueue them packed (up to 50 ids per message) with `sendBatch`. **Empty selection means no enqueue.**

### Cron mapping (3 triggers; 2 spare)

| Trigger | Jobs (misc.md §4 numbering) |
|---|---|
| `*/5 * * * *` | 4 habit_snoozes; delivery retry sweep (`notifications` with `delivered_at IS NULL` older than 2 min, max 5 attempts) |
| `2,17,32,47 * * * *` (every 15 min) | Local-hour jobs, matched per zone in JS (§4) so +5:30/+5:45 zones work: 2 nudges, 3 habit_reminders, 5 habit_summary, 6 digest (local 9), 8 backup (local 9), 9 buddies (local 17). At minute 2 only (hourly): 1 stats refresh, 7 resolve_challenges, 12 error_alerts |
| `23 3 * * *` | 10 purge_deleted_accounts (D1 cascade in batches of 50 users, R2 `delete(keys ≤ 1000)`); 11 housekeeping (180-day notifications, trash, webauthn challenges, auth_failures/client_errors retention, stale `rate_counters`, expired sessions/refresh tokens, finished import/export jobs) |

Hour-matched jobs fire on every 15-min tick within the matching local hour, exactly as today's 5-min ticks did; the existing dedupe keys
(`risk:{chain}:{date}`, `habit:{id}:{date}`, `habit-summary:{date}`, `digest:{week}`, `backup:{period}`, `buddy-risk:...`) make sends exactly-once per local day/period.
The snooze dedupe key uses `toWire(due)` (any stable format is fine; there is no in-flight data). The spec's note about `sent_risk` letting a reminder fire later in the same hour is preserved as is (parity), with a test.

- **Overlap**: a D1 lease per trigger: `UPDATE job_leases SET until=?now+240000 WHERE name=? AND until<?now RETURNING 1`. Not acquired means skip (and no heartbeat, as today).
- **Heartbeat**: each dispatcher upserts `worker_heartbeats` name `scheduler` with the spec's report shape; `/health/worker` semantics unchanged (503 before first tick, stale after 15 min).
- **Idempotency**: every job and consumer is idempotent (dedupe-key UNIQUE with `ON CONFLICT DO NOTHING RETURNING`, `alerted_at`, `delivered_at`, job rows with `status`), so retries and redelivery are safe.
- **Notifications as outbox**: `notify()` inserts rows (with dedupe) in the caller's write batch and returns ids; the caller defers one `deliver{ids}` message. The consumer sends push/email and sets `delivered_at`.
- **Queue ops budget (Free, 10k ops/day ≈ 3,300 messages)**: empty dispatches cost nothing. At small scale the main costs are deliver/recompute messages, packed. When the DLQ or `/admin/metrics` shows over 60% of the daily quota, switch to `PLAN=paid`.
- **Recompute on the request path**: the synchronous `outcome` the app shows (level up, new badges, new records) is computed in-request from aggregates (≤ 3 ms target). A full rebuild runs only off-request as `rebuild-slice` messages.

---

## 10. Email transport

- `Mailer.send({to, subject, text, html?, headers?, attachments?})` never throws (logs `failed to send email`). Implementations:
  - `console`: dev/test; prints the exact `[email:console]` line that tests read codes from.
  - `brevo` (**Free default**): `POST https://api.brevo.com/v3/smtp/email`, `api-key` header, custom headers incl. `List-Unsubscribe`, `List-Unsubscribe-Post`, `Auto-Submitted`; attachments base64. Same vendor and account as today, so there is no new vendor and no cost change; SMTP credentials become an API key. Open/click tracking must be confirmed off for the API in Brevo settings (cutover checklist).
  - `cloudflare` (**for Paid**): `send_email` binding (`EMAIL`), domain onboarded with `wrangler email sending enable pacestreak.com`. Switch with `MAILER=cloudflare`, then retire Brevo.
- One subrequest per send; deliveries per message are capped by `budget.ts`.
- Templates: exact strings from core.md §6.2, with `{app_name}` set to **"PaceStreak"** (not the old default "PaceStreak API"; intentional change, §19).
- Backup attachment: built by an `export-slice` into STAGING; attached when ≤ the plan cap (2 MiB Free, 10 MiB Paid), otherwise the email carries the existing download text.

---

## 11. Push

- **Encryption**: RFC 8291 `aes128gcm`: ephemeral ECDH P-256, HKDF-SHA256 (auth secret, then CEK and nonce), AES-128-GCM, one record (`rs=4096`), padding delimiter `0x02`. **VAPID** RFC 8292: ES256 JWT `{aud: origin(endpoint), exp: now+12h, sub: VAPID_SUBJECT}`, header `Authorization: vapid t=..., k=...`, `TTL: 43200`. About 1 ms CPU per send; the VAPID JWT is cached per audience origin per invocation. Tested against the RFC 8291 appendix vectors.
- **New VAPID key pair** (no existing subscriptions). The public key is served on the existing route the app reads.
- **Status handling**: 404/410 delete the subscription; 2xx resets failures; anything else increments, deleting at 10. `AbortSignal.timeout(10000)`. `redirect: "manual"` (a redirect counts as failure).
- **SSRF guard (no DNS resolution)**, applied at subscribe time and again at send time:
  1. `https:` only; no username/password; port empty or 443.
  2. IP-literal host (v4, v6, bracketed): parsed in-house and allowed only if it is global unicast. Rejected: private (10/8, 172.16/12, 192.168/16), loopback, link-local (incl. 169.254.169.254), CGNAT 100.64/10, 0/8, multicast, broadcast, reserved 240/4, documentation ranges, benchmarking 198.18/15, IPv6 ULA fc00::/7, link-local fe80::/10, `::`, `::1`, v4-mapped/compat/NAT64 embedding a rejected v4. `https://8.8.8.8/push/abc` **stays allowed** (existing test kept).
  3. Hostname without a dot, `localhost`, `*.localhost`, `*.local`, `*.internal`, and **`pacestreak.com` / `*.pacestreak.com`** are rejected.
  4. Any other hostname must equal or be a subdomain of an entry in `PUSH_HOST_ALLOWLIST` (var). Unknown services get 422 on subscribe and are logged.
  Workers `fetch` cannot reach RFC 1918 space anyway; the guard keeps the test contract and blocks our own zone. Step 4 is an intentional change from "any public host" (§19); the existing tests for rejected hosts are kept.

---

## 12. R2 photos

> **Superseded (2026-10-20, CHANGES-FROM-PYTHON.md "Photos"):** the presigned flow below is gone. Uploads are one
> `PUT /v1/body-photos/{id}` whose bytes stream into the `PHOTOS` binding after a magic-byte check, and
> `GET /v1/body-photos/{id}` streams them back; there are no S3 keys, no `aws4fetch` and no R2 host in the app's CSP.

- `PHOTOS` binding: `head` (size check on complete), ranged `get` of the first 16 bytes (magic-byte check), `delete([... ≤ 1000])`.
- Presigned **PUT** (300 s, Content-Type signed) and **GET** (60 s, `response-content-type`, `response-cache-control=private, no-store`) via `aws4fetch` `AwsClient.sign(url, {aws:{signQuery:true}})` against `https://<R2_ACCOUNT_HOST>/pacestreak-photos/<key>`. Signing is local, about 0.2 ms, no subrequest.
- Wire flow unchanged: presign, then upload from the browser, then complete. The app's CSP already allows the R2 host in `connect-src` (verified), so `_headers` needs no change. The R2 bucket CORS policy allows PUT/GET from `https://app.pacestreak.com` only (and `http://localhost:5173` on the staging bucket).

---

## 13. Imports and exports under the CPU limit

The wire contract stays: one multipart POST returning counts; one GET returning a file.

**Imports** (activity GPX/FIT/CSV, lifting CSV Strong/Hevy/FitNotes, account JSON, habit zip):
1. The handler streams the multipart file part through an in-house streaming multipart reader (boundary scan over `ReadableStream` chunks; the size cap is enforced while streaming, giving the spec's 413).
2. **File ≤ `budget.inlineImportBytes`** (256 KiB Free; full spec caps on Paid): parse inline and return the exact old response. Covers almost every real CSV, single GPX and FIT activity on Free.
3. **Larger**: the stream goes to `STAGING.put("imports/<jobId>", stream)`; an `import_jobs` row is inserted; one `import-slice` message is sent. The handler returns **200 with the same shape, zero counts and `"queued": true`** (additive; the app ignores unknown keys). When the job finishes, a notification (kind `import_done`, category `account`) carries the final counts, and a full rebuild is enqueued. No polling loop in the handler, so there is no wall-time or partial-result risk.
4. **Slices** (each one queue invocation, ≤ ~6 ms CPU): read a byte range `STAGING.get(key, {range})`, feed a resumable reader, batch UPSERTs (dedupe via existing unique keys, 100 rows per `db.batch`), save `{offset, state}` on the job row, enqueue the next slice.
   - CSV: resumable at newline offsets (RFC 4180 quote state carried).
   - GPX: in-house streaming tag scanner for the elements needed (`trk`, `trkseg`, `trkpt`, `ele`, `time`, `name`, `type`); resumes at the last complete `</trk>` or `</trkpt>` offset with a compact partial-track summary in state. Any `<!DOCTYPE` or `<!ENTITY` aborts with "That GPX file could not be read." (defusedxml parity).
   - FIT: in-house record reader for the needed messages (file_id, session, lap, record). FIT is a record stream, so local definition messages carry over in the slice state. Tested against fixtures from `api/tests/fixtures` and fuzzed.
   - Account JSON: the exporter writes one top-level array element per line (still valid JSON). The importer splits large files on those line boundaries; small files use `JSON.parse`. A large hand-reformatted file gets 422 "That backup file could not be read." (intentional, §19).
5. Queue cost: a 15 MiB file at 256 KiB slices is about 60 messages (about 180 ops), bounded by the `import_file` 30/h user limit.

**Exports** (JSON, ICS, CSV zip): ≤ `budget.inlineExportRows` (2,000 rows Free) builds inline and streams the response. Larger: `export-slice` jobs write per-table parts to STAGING (≤ 2k rows each); the final slice zips them with `fflate` into `exports/<jobId>.zip`; the handler returns the same `Content-Disposition` by streaming the R2 object if ready, otherwise 200 JSON `{"queued": true}` and a notification with a download link (60 s presigned GET minted when the user opens it). Streaming an R2 body costs no CPU.

---

## 14. Observability

- Workers Logs (`observability.enabled`; Free: 200k events/day, 3-day retention). One structured line per request: `{rid, method, route (pattern, never the raw path), status, ms, d1_round_trips, d1_statements}`. Unhandled errors log the stack. Never log bodies, emails, codes or tokens (except the console mailer in dev/test).
- `X-Request-Id` = `cf-ray`.
- `POST /v1/client-errors`, `/v1/admin/client-errors` (GET, DELETE) and `/v1/admin/abuse` unchanged (D1, fingerprint upsert, MAX_GROUPS bound).
- Health: `GET /health` gives `{"status":"healthy"}` (no D1); `/health/ready` runs `SELECT 1`; `/health/worker` reports heartbeat age. Upptime adds `/health/worker`.
- `/v1/admin/metrics` adds: D1 database size, DLQ depth, queue messages today.
- Job 12 emails admins hourly. No third-party APM.

---

## 15. Testing

- **vitest 4.1.11 + `@cloudflare/vitest-pool-workers` 0.22.0**: tests run in workerd with real D1/R2/Queues/rate limits; `isolatedStorage: true` gives every test a fresh snapshot (this removes the `make test` truncation trap). `applyD1Migrations` in `setupFiles`. Queue consumers are tested via `createMessageBatch`/`getQueueResult`; cron via `createScheduledController`; outbound fetch (Turnstile, Brevo, OFF, push) via `fetchMock`, with no network in tests. `Ctx.clock` is injectable for deterministic time.
- **Porting the 285 pytest cases** (29 files): each file becomes `test/parity/<same name>.test.ts` (or sits next to its module), keeping snake_case names in `it()` titles. `scripts/test-parity.ts` (CI) diffs pytest names against TS names; every missing one needs a `// parity: dropped because ...` entry (Argon2/Fernet/RS256/Redis-specific) or a `changed: ...` test (§19). Fixtures port conftest: `signup()`, `login()`, `authed()`, soft WebAuthn authenticator, fake storage.
- **Round-trip budgets**: the counting D1 wrapper records round trips and statements; every route test asserts `roundTrips <= budget` (§17). A seeded heavy user (5 years, 3k workouts, 30k sets, 20 habits, 2k habit logs) runs the budget suite, so N+1 is caught by construction. The same counter feeds the production log line.
- **EXPLAIN QUERY PLAN lint** (§4).
- **CPU benches** (`vitest bench` in workerd): PBKDF2, recompute delta, snapshot on the heavy user, a 256 KiB import slice, push encrypt. CI fails if a median exceeds 0.6x its budget (CI hardware is noisier; staging `wrangler tail` cpuTime is the real gate).
- **Property tests** (fast-check): incremental aggregates == full replay; JS zone grouping == per-row `Intl` hour for every IANA zone at random instants incl. DST transitions; `pyRound`/`formatG` against a Python-generated table; IP-literal classifier against a table.
- **App contract tests** (CI checks out `PaceStreak/app` at its `main`): `scripts/extract-app-routes.ts` extracts every `api("...")` call site (method + normalised path) from `app/src` and asserts each is a registered Hono route. Response zod schemas are type-checked against `app/src/lib/types.ts` with `satisfies` compile tests. Golden responses for ~40 representative endpoints are recorded once from the old FastAPI suite before decommissioning and compared structurally (keys and types).
- **e2e**: the app's Playwright suite runs against `wrangler dev` of the new API in API CI (nightly) and once against staging before cutover.

---

## 16. CI/CD, deploy, retirement

- **GitHub Actions `ci.yml`** (PR and main): `pnpm install --frozen-lockfile` → `wrangler types --check` → `tsc --noEmit` → `biome ci` → module-dependency check → `vitest run` → test-parity → contract tests (app checkout) → benches (blocking on main) → `wrangler deploy --dry-run` + bundle size gate → `drizzle-kit check` + drift test → gitleaks. No secrets needed. Workflow changes are pushed over SSH (AGENTS.md: `GITHUB_TOKEN` cannot write workflows).
- **Deploy: Workers Builds** connected to `PaceStreak/api`: push to `main` deploys (consistent with the other projects). Build command `pnpm install --frozen-lockfile && pnpm test`; deploy command `pnpm wrangler d1 migrations apply pacestreak --remote && pnpm wrangler deploy`. Non-main branches upload preview versions with `--env staging`.
- **Custom domain cutover** (no 522 window, per AGENTS.md "Do not create DNS records ahead of deployments"):
  1. Deploy production Worker with `routes: []`, verify on the workers.dev URL with app e2e against staging.
  2. In the dashboard, remove the FastAPI Cloud custom domain and its DNS-only CNAME for `api`.
  3. Deploy with `custom_domain: true`: Wrangler creates the record attached to the live Worker.
  4. Verify after propagation (`/health`, `/health/worker`, signup with a real address). Rollback = `wrangler rollback`.
- `app/public/_headers` is unchanged (same API host, same R2 host). `web`/`blog` are untouched.
- **Retire after one clean week**: FastAPI Cloud app `pacestreak-api`; GitHub workflows `Worker tick`, `Migrate` and image publish; the GHCR image; `WORKER_ENV_JSON`; the Neon project; Upstash Redis; old RS256/VAPID/Fernet keys; Brevo SMTP credentials (replaced by an API key).
- **Docs**: update `infra/TOPOLOGY.md`, `RUNBOOK.md` (new failure modes: D1 overloaded, queue DLQ, CPU-limit exceeded), `DECISIONS.md`, root `AGENTS.md` "How production runs", `api/README.md`, `api/AGENTS.md`.
- **`/privacy`**: providers become Cloudflare (Workers, D1, R2, Queues, Turnstile) and Brevo; Google Cloud, FastAPI Cloud, Neon, Upstash and GitHub runners are removed. Backups: "D1 Time Travel keeps a **7-day** restore history" while on Free (30 days on Paid; update when switching). No off-host backups (declined by owner). This is material, so **bump `terms_version`** in the new config module.

---

## 17. Performance budget per endpoint class (enforced by tests; Free plan)

| Class | Examples | D1 round trips | CPU p99 | Subrequests |
|---|---|---|---|---|
| Health | `/health` | 0 | 0.3 ms | 0 |
| Auth-gated read | `/me/stats`, `/workouts/changes`, `/habits`, `/notifications` | **1** (auth + reads in one batch); 304 also 1 | 3 ms | 0 |
| Snapshot read | `/me/xp`, `/me/achievements`, `/me/review` | 1 | 5 ms | 0 |
| Simple write | habit log, kudos, comment, settings | 1 (no read needed) or 2 (read, then write incl. rate counter) | 3 ms | ≤ 1 (queue send) |
| Workout write + outcome | `PUT /workouts/{id}`, `/workouts/batch` (≤ 200 ops) | 2 (3 on constraint fallback) | 6 ms | 1 |
| Password routes | login, signup, change/reset/recover | 2 | PBKDF2 (G-1) + 1 ms | ≤ 2 |
| Search | `/search`, `/people` | 1 | 2 ms | 0 |
| Refresh | `/auth/refresh` | 2 | 1 ms | 0 |
| Import/export | small inline / large queued | 2-3 | 6 ms in handler; ≤ 6 ms per slice | R2 + queue |
| Cron dispatcher | each trigger | ≤ 1 per job | ≤ 6 ms | ≤ 12 |
| Queue consumer | deliver, recompute, slices | ≤ 3 per message | ≤ 6 ms | ≤ 40 |

Wall-clock target: p95 < 60 ms for auth-gated reads with Smart Placement (one D1 round trip from a co-located Worker). D1 location: **no hint** (Cloudflare picks it from where the database is created: create it from the owner's region). Read replication / Sessions API is **not** used: it would complicate read-your-writes after logout/revocation; revisit only with measured need.

---

## 18. Risks (ranked)

1. **PBKDF2 100k over 10 ms on Free** (likely). G-1 measures it in week 1; the remedy is Paid, never fewer iterations.
2. **Engine CPU on heavy users** (zod, JSON decode of D1 results, snapshot). Mitigation: aggregates, benches, slices; escape hatch `PLAN=paid`.
3. **Incremental aggregate drift** from full-history semantics (streak repairs, wagers, pauses, requirements history, record "cooled"/"flagged" rules). Mitigation: property tests and a nightly sampled full rebuild that compares and logs mismatches.
4. **Hand-written crypto** (push, JWT, TOTP): RFC vectors, plus a real browser subscription test on staging before cutover.
5. **In-house FIT/GPX readers**: fixtures from the old test suite plus fuzzing; only reached for files above the inline cap on Free.
6. **Queue ops (10k/day)** at moderate scale: packing and no empty enqueues; Paid lifts it.
7. **Brevo API** tracking defaults differ from SMTP: verify before cutover.
8. **Push allowlist** rejects an unknown push service: logged; the list is a var.
9. **Rate Limiting binding is per-location**: Turnstile remains the primary guard.
10. **D1 size** (500 MB per DB on Free, 10 GB on Paid): photos are in R2; watch `/admin/metrics`.
11. **`@simplewebauthn/server` dependencies** (`@peculiar/*`, `reflect-metadata`) on workerd without `nodejs_compat`: Phase 0 spike G-4.

---

## 19. Intentional behaviour changes (each with a `changed: ...` test)

1. Passwords PBKDF2 (peppered); recovery and email codes HMAC instead of Argon2.
2. Access tokens HS256 (`kid` ring) instead of RS256.
3. Email-code attempt counter persists.
4. Over-length input gives 422, not the old accidental 500.
5. Push: hostnames must match the push-service allowlist; `*.pacestreak.com` rejected. Public IP literals still allowed.
6. `/docs`, `/redoc`, `/openapi.json` not served.
7. Text search and name sorting are Unicode case- and accent-insensitive.
8. Email subjects/bodies say "PaceStreak", not "PaceStreak API".
9. Large imports/exports on Free: additive `"queued": true` plus a completion notification.
10. Timestamps are `toISOString()` (`Z`, ms) instead of Python isoformat (`+00:00`, µs).
11. Large account-JSON imports must keep the exporter's one-element-per-line layout.
12. Backup attachment cap is 2 MiB on Free (10 MiB on Paid).

---

## 20. Judge flaws and their resolution

| Flaw | Resolution |
|---|---|
| perf per-isolate 30 s auth cache; fold-auth fails open if forgotten | No cache. `AuthedBatch` always prepends the session check; raw DB is unreachable from modules (§5) |
| perf photo-upload proxy route (CSP claim) | Wrong: CSP already allows R2. Presign flow kept (§12) |
| perf/maint `send_email` as primary on Free | Brevo HTTP default on Free; Cloudflare on Paid (§10) |
| PBKDF2 CPU underestimates (5-8 ms, 3-6 ms) | Estimate 10-25 ms; G-1 gate (§6) |
| maint drop to 60k iterations | Never; Paid instead (§6) |
| rpID changed to pacestreak.com | Kept `app.pacestreak.com` (§6) |
| maint auth as a separate round trip | Auth is statement 0 of the handler batch (§5) |
| maint outbox one batch per op | One batch of LWW UPSERTs, per-op fallback only on constraint error (§4) |
| maint :02-only local-hour jobs | 15-minute trigger with per-zone matching (§9) |
| maint per-user limiter fails open | Counter inside the atomic batch with predicated writes (§7) |
| freetier D1 Time Travel 30 days on Free | 7 days on Free (§16) |
| freetier calendar_feed 2/60 s | Keeps 120/hour per token via `rate_counters` (§7) |
| freetier 25 s polling import handler | Removed: inline under cap, else queued with an additive flag (§13) |
| freetier stale/unmaintained libs, `x` ranges | saxes, @streamparser/json, @garmin/fitsdk dropped; exact pins ≥ 14 days old (§3) |
| `changes()` across batch statements unverified | Not used; explicit `EXISTS` predicates (§4) |
| perf apac location and read replication | No location hint; no replication (§17) |
| Push SSRF IP-literal test | Kept allowed via in-house global-unicast classifier; conflict with allowlist resolved by applying the allowlist to hostnames only (§11) |
| freetier tz_offsets stale across DST | Dropped; zones resolved by `Intl` at dispatch time (§4) |
| perf sync_seq per-user (contract risk) | Global counter kept: the app cursor is per device (verified) |
| perf byte-exact Python isoformat | Not reproduced; app parses with `Date` (§4, §19) |
| perf RateLimiter DO contradictions | No Durable Objects at all |
| maint @hono/zod-openapi on every route | Not used (§3) |
| stale vitest/pool pins; vitest 5 | vitest 4.1.11 + pool 0.22.0 (peer ^4.1) |

---

## 21. Phased build order (parallel agents)

Gates in Phase 0: **G-1** PBKDF2 cpuTime on staging; **G-2** drizzle + TS 7 type-check; **G-3** `AuthedBatch` predicate pattern and LWW UPSERT RETURNING behaviour on D1 (local and remote); **G-4** `@simplewebauthn/server` on workerd without `nodejs_compat`; **G-5** 422 message table vs pydantic.

- **Phase 0 (one agent, blocking)**: F0 scaffold/tooling/CI; F1 full Drizzle schema + `0000_init.sql`; F2 core pipeline (env, ctx, errors, CORS, version, validation hook, AuthedBatch, counting D1, budget, time helpers); F3 test harness and fixtures. F1-F3 can be split across 2-3 agents once F0 lands.
- **Phase 1 (parallel, after Phase 0)**: crypto; ratelimit+turnstile; mailer+templates; push+SSRF; R2 presign; jobs framework; heavy parsers; catalogues.
- **Phase 2**: auth (needs crypto, ratelimit, mailer); notifications (needs mailer, push, jobs); ops+admin shell.
- **Phase 3 (parallel)**: game engine first publishes interfaces (`applyWorkoutDelta`, `applyHabitDelta`, `outcomeFor`, `enqueueRebuild`, `snapshot`) as stubs on day 1; then profile/account, training, habits/insights, nutrition, social/groups/search, trash (last; needs training/habits/nutrition).
- **Phase 4**: the 12 jobs; contract tests and golden comparisons; benches on the heavy user; docs, `/privacy`, cutover and retirement.

`WORKPLAN.json` holds the units with their dependencies and acceptance criteria.

---

## 22. Decisions needing the owner

1. **Plan: Free now, Paid ($5/month) before real users.** PBKDF2 at the platform maximum very likely exceeds 10 ms CPU per login/signup. The design keeps full strength and switches with `PLAN=paid`. Confirm that moving to Paid once G-1 confirms the overrun is acceptable. The alternative, weaker hashing, is not offered.
2. **Email: keep Brevo (HTTP API) on Free, move to Cloudflare Email Service on Paid.** No new vendor and no cost now. Confirm the switch to Cloudflare Email Service when Paid is enabled (3,000 mails/month included, then retire Brevo).

Everything else above is decided and defaulted.
