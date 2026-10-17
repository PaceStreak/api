# Changes from the Python service

Each entry: what changed, why, and the test that covers it.

| Area | Change | Why | Test |
| --- | --- | --- | --- |
| Email | App name in templates is "PaceStreak" (was "PaceStreak API") | Old default leaked the service name | test/lib/mailer.test.ts |
| Email | A CR/LF in any header refuses the send | Header injection | test/lib/mailer.test.ts |
| Photos | WebP needs `RIFF....WEBP`; PNG checks full 8-byte signature | Python accepted any RIFF (WAV/AVI) as WebP | test/lib/r2.test.ts |
| Rate limits | Fixed windows aligned to the window length | slowapi semantics; Python `enforce()` started at first hit | test/lib/ratelimit.test.ts |
| Worker health | Stale after 900 s (was 360 s) | Cron ticks every 15 min on Workers | test/jobs/leases-heartbeat.test.ts |
