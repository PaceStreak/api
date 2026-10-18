# Changes from the Python service

Each entry: what changed, why, and the test that covers it.

| Area | Change | Why | Test |
| --- | --- | --- | --- |
| Email | App name in templates is "PaceStreak" (was "PaceStreak API") | Old default leaked the service name | test/lib/mailer.test.ts |
| Email | A CR/LF in any header refuses the send | Header injection | test/lib/mailer.test.ts |
| Photos | WebP needs `RIFF....WEBP`; PNG checks full 8-byte signature | Python accepted any RIFF (WAV/AVI) as WebP | test/lib/r2.test.ts |
| Rate limits | Fixed windows aligned to the window length | slowapi semantics; Python `enforce()` started at first hit | test/lib/ratelimit.test.ts |
| Worker health | Stale after 900 s (was 360 s) | Cron ticks every 15 min on Workers | test/jobs/leases-heartbeat.test.ts |
| Auth | Email-code attempts are saved; the fifth miss locks the code | Python raised before committing, so the 5-attempt cap never applied | test/parity/test_auth.test.ts (`changed: email code attempts are saved`) |
| Auth | Clearing cookies keeps `Secure` (and `HttpOnly` on the refresh cookie) | Browsers ignore a `__Secure-` Set-Cookie without `Secure`, so Python's logout never removed the production cookies | test/parity/test_auth.test.ts (`logout clears both cookies`) |
| Auth | `GET /v1/auth/sessions` `created_at` is the sign-in time | Python showed the newest rotated token's time | test/parity/test_auth.test.ts |
| Auth | A refresh within the 30 s grace rotates from the session's live tip, without Python's 5-hop chain walk | Same outcome for the reload race; one indexed read | test/parity/test_auth.test.ts (`a_reload_race_...`) |
| Auth | Refresh of an expired token or an inactive user writes nothing (Python revoked the presented token) | The token cannot be used either way | test/parity/test_auth.test.ts |
| Auth | Recovery and email codes are HMAC(PEPPER) bound to the user id; passwords PBKDF2; TOTP secrets AES-GCM with the user id as AAD | No data to keep; DESIGN §19 items 1-2 | test/lib/crypto.test.ts, test/parity/test_auth.test.ts |
| Auth | `auth_failures.email_hash` is HMAC under PEPPER (was keyed from the RS256 private key) | No RSA key any more | test/parity/test_auth.test.ts (`recover ...`) |
| Health | `/health/ready` reports `checks: {database}` only (no `cache` key) | There is no Redis; readiness still means "D1 answers" | test/ops-admin.test.ts (`ready runs SELECT 1 ...`) |
| Health | `/health` is served from the colo Cache API for 5 s (`Cache-Control: public, max-age=5`) | Monitor bursts cost nothing; the body never changes | test/ops-admin.test.ts (`health_returns_healthy ...`) |
| Ops | `DELETE /v1/admin/client-errors/{id}` with a malformed id is 404 (Python: 500 from the UUID cast) | A bad id is simply not found | test/ops-admin.test.ts (`groups repeats ...`) |
| Ops | The MAX_GROUPS check and the fingerprint upsert are one statement | Python's check-then-insert could overshoot 1000 under concurrency | test/ops-admin.test.ts (`stops taking new groups ...`) |
| Admin | `GET /v1/admin/users?q=` treats `%` and `_` literally | Python passed them through as LIKE wildcards | test/ops-admin.test.ts (`lists and searches users ...`) |
| Admin | Every admin write batch re-checks the actor's role; a role lost between read and write is the gate's 404 | Closes a demotion race between the read and the commit | test/ops-admin.test.ts (`a role lost after the read cannot write`) |
| Admin | Body/param 422s on admin routes can come before the role 404 (the role is checked on the handler's D1 read, after validation) | Keeps one round trip per request; only a hidden route's field shapes leak, never data | - |
| Admin | `GET /v1/admin/metrics` adds `database: {size_bytes}` (D1 `meta.size_after`). DLQ depth and queue counts are not exposed | Workers has no in-Worker API for queue depth; it needs the Cloudflare API and a token the service does not hold | test/ops-admin.test.ts (`metrics ...`) |
| Admin | Merge is ONE atomic D1 batch over the generated FK list: per column `UPDATE OR IGNORE`, then `DELETE` of the leftover (colliding) rows, since D1 has no savepoints; then a `recompute` message with `full: true` instead of an inline recompute; the audit row gets `moved` in a second small write | Same outcome as Python's savepoint retry (destination wins), no per-row round trips, no request-time rebuild | test/parity/test_admin_merge.test.ts |
| Admin | Merge never moves `sessions` (so refresh tokens stay with the source and are deleted with it) | New table; sign-in material must not follow the data, as in Python | test/parity/test_admin_merge.test.ts |
| Operator | `python -m app.cli` is `pnpm admin create-admin\|set-password\|set-role`, printing SQL for `wrangler d1 execute`; `recompute-all` is gone (rebuilds are queue messages) | No database connection from a laptop; same 16-character password rule | test/parity/test_ops.test.ts (`cli_refuses_short_passwords`) |
