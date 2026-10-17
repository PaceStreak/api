# Owner decisions for the TypeScript rewrite

Recorded 2026-10-17. These **override** anything in `DESIGN.md`,
`proposals/` or `spec/` that disagrees. `spec/` describes the old Python
service and is a feature list, not a constraint: the rewrite is a new project.

## Context

- PaceStreak has **no users and no data**. It is an open-source portfolio
  project. Nothing has to stay compatible with the Python API's storage:
  no Argon2 or Fernet compatibility, no Neon data migration, no existing
  sessions.
- Code quality and performance come first. The code must never be the
  bottleneck. Being on a cheap plan is never a reason to cut quality.

## Decisions

| Topic | Decision |
| --- | --- |
| Framework | Hono on Cloudflare Workers, TypeScript, Drizzle ORM, Zod. |
| Database | **D1**, location hint **`apac`**. |
| Workers plan | **Paid ($5/month)**. Design for its limits. Don't contort the code to fit the free plan's 10 ms CPU limit. `PLAN`-based branching to fit the free plan is unnecessary; drop it. |
| Passwords | PBKDF2-SHA256 via WebCrypto at 100,000 iterations (the Workers cap) plus a pepper, in a self-describing hash format. |
| Email | **Cloudflare Email Service** (`send_email` binding). Drop Brevo. Keep a `console` transport for dev and tests. The owner onboards `pacestreak.com` for sending in the dashboard; document the steps in the cutover unit. |
| Location | Branch **`next`** of `PaceStreak/api`. `main` keeps the Python service until cutover. |
| Autonomy | Unattended sessions **write code, run tests, commit and push `next` only**. No deploys, no Cloudflare resource creation, no merge to `main`, no DNS changes. |
| Old bugs | **Fix** bugs found in the Python behaviour (for example, the email-code attempt counter that is never saved), add a test, and list each one in `docs/rewrite/CHANGES-FROM-PYTHON.md`. |
| API contract | **May change where it is clearly better.** Update `../app` (`PaceStreak/app`) in a matching change on an `api-next` branch there, keep the app's unit and e2e tests passing, and record each contract change in `CHANGES-FROM-PYTHON.md`. Prefer keeping the contract when the gain is small. |
| Tooling | **pnpm** and **TypeScript 7**, as in the design. Fall back to 5.9 only if Phase 0 check G-2 fails, and record why. |
| Tests | Each unit is done only when its ported tests pass. The CI name-diff check against the 285 pytest cases stays. |
| Commits | Conventional commits as `AlzyWelzy <welzyalzy@gmail.com>`. **Never credit an AI tool** (no `Co-Authored-By`, no "Generated with"). Never commit secrets: the repo is public. |
