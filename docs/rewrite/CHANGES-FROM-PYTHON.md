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
