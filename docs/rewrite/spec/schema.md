# PaceStreak API: database schema and Postgres-to-D1 port map

Scope: `api/alembic/versions/*` (32 revisions, head `4d85086e4198`) and every SQLAlchemy model
(`app/models.py` imports 13 model modules). This area owns **no HTTP routes**; section 1 lists the
tables each feature area's routes touch so the route-level specs can cross-reference.

Sources read in full: `app/database.py`, `app/{auth,profile,account,ops,insights,trash,training,game,social,groups,notifications,habits,nutrition}/models.py`,
every `alembic/versions/*.py` upgrade body, plus every Postgres-specific call site in `app/`
(grep for `postgresql`, `on_conflict`, `returning`, `ilike`, `like`, `func.*`, `over`, `text(`, `begin_nested`, `IntegrityError`, `order_by`).

---

## 0. Migration chain (oldest to newest)

| # | Revision | What it does |
|---|---|---|
| 1 | 9d3f1a6c1b0e initial_schema | users, refresh_tokens, one_time_tokens, recovery_codes; PG enums `userrole(admin,user)`, `tokenpurpose(email_verify,password_reset)` |
| 2 | fd264d571db7 product_schema | `CREATE SEQUENCE sync_seq`; `ALTER TYPE userrole ADD VALUE 'moderator'`; ~25 product tables |
| 3 | 8a26a9caf99a pauses_calendar_official | streak_pauses; profiles.is_official, calendar_token_hash (unique), calendar_token_created_at |
| 4 | d32eee1ab7f7 group_mute | group_members.muted |
| 5 | e03b42a37539 passkeys | passkeys, webauthn_challenges |
| 6 | 0e6f4859a121 worker_heartbeat | worker_heartbeats |
| 7 | 5997e8235479 chain_requirements | streak_chains.requirements_history |
| 8 | 623a0a3291a4 travel_pause_reason | ck_pause_reason adds 'travel' |
| 9 | d0a8e2c8eeb2 tags_and_gear | gear; workouts.tags, workouts.gear_id (FK SET NULL) |
| 10 | 5a1672dfb2ff training_plans | training_plans |
| 11 | cb87a2c62f07 buddies_and_group_streaks | buddy_pairs; groups.streak_threshold; user_stats.recent_weeks |
| 12 | 1ad8602d62b0 terms_version… | client_errors, auth_failures; profiles.accepted_terms_version; users.pending_email; `ALTER TYPE tokenpurpose ADD VALUE 'email_change'`; data: `UPDATE profiles SET accepted_terms_version='2026-09-25' WHERE accepted_terms_at IS NOT NULL` |
| 13 | 3f4a7935ba10 smart_reminders… | monthly_goals, rest_days; profiles.reminder_mode, learned_reminder_hour |
| 14 | 3e88450d5f24 supersets_and_splits | workout_sets.superset; workouts.splits |
| 15 | 679c7c30b47f plan_challenges… | group_announcements; challenges.plan; training_plans.challenge_id (SET NULL), assigned_by (SET NULL); ck_challenge_kind adds 'plan_sessions' |
| 16 | 24078d2082de plan_repeat | training_plans.repeat |
| 17 | 02c71d3228fb weigh_ins | weigh_ins; data: copies body_metrics.weight_kg into weigh_ins (`gen_random_uuid()`, `(measured_on + time '12:00') AT TIME ZONE tz`), then drops body_metrics.weight_kg |
| 18 | 0f73caa084e4 gyms_notes_goals_wagers | exercise_notes, gyms, streak_wagers, weight_goals; user_stats.weekly_days_4w; workouts.gym_id (SET NULL) |
| 19 | ddeaee734635 blocks_readiness… | readiness, training_blocks, week_reflections; profiles.max_hr; workouts soreness/pump/avg_hr/max_hr/hr_zones + 2 checks |
| 20 | 3917c22fc2ea habits | habits, habit_logs; profiles.life_target; user_stats.life_streak |
| 21 | 7ee5ccff69ad tape_measurements… | body_photos (with `data` bytea); body_metrics 8 tape columns |
| 22 | a1c9f3e5d7b2 favourite_disciplines | profiles.favourite_disciplines `varchar[]` default `'{}'` |
| 23 | b7a4e1c9d3f8 achievement_single_badge_unique | partial unique index `uq_user_achievement_single (user_id, achievement_id) WHERE tier IS NULL` |
| 24 | 8bc1bac793d0 body_photos_move_to_r2 | `DELETE FROM body_photos`; add object_key (unique); drop data |
| 25 | 7b8994223e1a one_time_tokens_become_otp_codes | one_time_tokens.attempts; token_hash index becomes NON-unique |
| 26 | efd5b34d8cfc nutrition | foods, nutrition_targets, meal_entries |
| 27 | 733e0613ae72 journal_recipes_habit_routines | habit_routines, journal_days, recipes |
| 28 | 1cd8cec54e6a trash_snooze… | trash_items; habits.snoozed_until; notification_preferences.habit_summary_hour, backup_attachment |
| 29 | d1e511ad69b6 habit_schedule_and_pause | habits.days_mask, paused_from, paused_until |
| 30 | ada4ee634382 backup_frequency_and_quiet_days | notification_preferences.backup_frequency; profiles.quiet_days |
| 31 | 147e798f8e56 kudos_reactions | kudos.reaction |
| 32 | 4d85086e4198 client_error_alerts | client_errors.alerted_at |

For D1: **squash all of this into one initial migration** (below). The two data migrations (#12, #17) and #24's delete are history; only needed if importing a live Postgres dump. A one-off Neon-to-D1 data copy is an open question (section 6).

---

## 1. Final schema (Postgres as deployed) with a SQLite/D1 translation

### 1.1 Conventions that apply to every table

Every model inherits `app/database.py:31-38` `Base`:

| Column | Postgres | Default | SQLite/D1 | Drizzle (`drizzle-orm/sqlite-core`) |
|---|---|---|---|---|
| `id` | `uuid` PK | Python `uuid.uuid7()` (app-side; **client-supplied** for workouts, weigh_ins, meal_entries, body_photos, and restored trash rows) | `TEXT PRIMARY KEY` (lowercase canonical 36-char form) | `text('id').primaryKey().$defaultFn(() => uuidv7())` (npm `uuidv7` or `uuid@>=10` `v7`) |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | server | `TEXT NOT NULL` | `$defaultFn(nowIso)` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()`, ORM `onupdate=now()` | server + ORM | `TEXT NOT NULL` | `$defaultFn(nowIso).$onUpdateFn(nowIso)` |

Type mapping used below:

| Postgres / SQLAlchemy | SQLite/D1 storage | Notes |
|---|---|---|
| `uuid` | TEXT | Keep lowercase-hyphenated; `buddy_pairs` CHECK `user_a < user_b` relies on ordering (PG uuid byte order == lowercase hex string order). |
| `timestamptz` | TEXT ISO-8601 UTC, fixed format e.g. `2026-10-17T09:30:00.123456+00:00` | Must be one fixed width/format so `<`/`ORDER BY` on TEXT is chronological. Python serialises as `isoformat()` ⇒ `+00:00` suffix with microseconds when non-zero; reproduce that on output. Alternative INTEGER epoch-µs (see section 6). |
| `date` | TEXT `YYYY-MM-DD` | Lexicographic == chronological. |
| `varchar(n)` / `String(n)` | TEXT (+ optional `CHECK(length(col) <= n)`) | PG **rejects** over-length (DataError ⇒ 500). SQLite does not enforce; validation must happen in zod. |
| `text` | TEXT | |
| `smallint` / `integer` / `bigint` | INTEGER | PG range-checks smallint (±32767) and int4; SQLite doesn't. |
| `double precision` (`Float`) | REAL | Same IEEE-754 double. |
| `boolean` | INTEGER 0/1 | Drizzle `integer({mode:'boolean'})`. Raw SQL must compare `= 1`, not `IS TRUE`. |
| `jsonb` | TEXT (JSON) | Drizzle `text({mode:'json'}).$type<…>()`. JSONB re-orders keys (shorter keys first, then bytewise) and drops duplicate keys; TEXT preserves insertion order. Response key order for `data`, `evidence`, `channels`, `jobs`, `snapshot`, `payload`, `meta`, `detail` will differ (harmless for JSON clients). |
| `varchar[]` (`ARRAY(String)`) | TEXT (JSON array) | Only `profiles.favourite_disciplines`. |
| `bytea` (`LargeBinary`) | BLOB | Only `passkeys.public_key`. Drizzle `blob({mode:'buffer'})` ⇒ use Uint8Array. |
| PG enum `userrole`, `tokenpurpose` | TEXT + CHECK | |
| sequence `sync_seq` | see 2.1 | |

`ix_<table>_<col>` names come from `index=True`; unique `index=True, unique=True` columns are unique indexes.

### 1.2 SQLite DDL (final state, equivalent to Postgres head)

Defaults marked `-- app` are ORM/Python-side in the original (no DB default in Postgres); keeping them as DB defaults in SQLite is harmless. Every table has the three Base columns; they are written once as `{BASE}`:

```
id TEXT PRIMARY KEY NOT NULL,
created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),  -- prefer app-side value (µs precision)
updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
```

Run `PRAGMA foreign_keys = ON` (D1 enforces FKs by default). Order of creation respects FKs.

```sql
-- ===== auth =====
CREATE TABLE users (
  {BASE},
  email TEXT NOT NULL,                              -- varchar(320)
  hashed_password TEXT NOT NULL,                    -- varchar(512)
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','moderator','user')),  -- PG enum userrole
  is_active INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 0,
  is_verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  password_changed_at TEXT,
  pending_email TEXT,                               -- varchar(320)
  totp_secret TEXT,                                 -- varchar(512), Fernet ciphertext
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_confirmed_at TEXT,
  totp_last_used_step INTEGER
);
CREATE UNIQUE INDEX ix_users_email ON users(email);

CREATE TABLE refresh_tokens (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,                         -- varchar(64), sha256 hex
  family_id TEXT NOT NULL,                          -- uuid, = JWT "sid"
  parent_id TEXT REFERENCES refresh_tokens(id),     -- NO ACTION (no ondelete)
  replaced_by TEXT,                                 -- uuid, no FK
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT,                                  -- varchar(400)
  ip_address TEXT,                                  -- varchar(45)
  last_used_at TEXT
);
CREATE INDEX ix_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE UNIQUE INDEX ix_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX ix_refresh_tokens_family_id ON refresh_tokens(family_id);

CREATE TABLE one_time_tokens (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verify','password_reset','email_change')), -- PG enum tokenpurpose
  token_hash TEXT NOT NULL,                         -- varchar(64); NOT unique since 7b8994223e1a
  expires_at TEXT NOT NULL,
  used_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_one_time_tokens_user_id ON one_time_tokens(user_id);
CREATE INDEX ix_one_time_tokens_token_hash ON one_time_tokens(token_hash);

CREATE TABLE recovery_codes (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,                          -- varchar(512), slow password hash
  used_at TEXT
);
CREATE INDEX ix_recovery_codes_user_id ON recovery_codes(user_id);

CREATE TABLE passkeys (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,               -- varchar(1400), base64url
  public_key BLOB NOT NULL,                         -- bytea (COSE key)
  sign_count INTEGER NOT NULL DEFAULT 0,            -- bigint
  transports TEXT NOT NULL DEFAULT '[]',            -- jsonb list[str]  -- app
  backed_up INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,                               -- varchar(60)
  last_used_at TEXT
);
CREATE INDEX ix_passkeys_user_id ON passkeys(user_id);

CREATE TABLE webauthn_challenges (
  {BASE},
  challenge TEXT NOT NULL UNIQUE,                   -- varchar(128), base64url
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,  -- NULL for usernameless sign-in
  purpose TEXT NOT NULL,                            -- varchar(12)
  expires_at TEXT NOT NULL
);

-- ===== profile =====
CREATE TABLE profiles (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  handle TEXT,                                      -- varchar(30), unique
  display_name TEXT,                                -- varchar(50)
  is_official INTEGER NOT NULL DEFAULT 0,
  calendar_token_hash TEXT,                         -- varchar(64)
  calendar_token_created_at TEXT,
  bio TEXT,                                         -- varchar(160)
  avatar_hue INTEGER NOT NULL DEFAULT 78,           -- smallint  -- app
  timezone TEXT NOT NULL DEFAULT 'UTC',             -- varchar(64) IANA  -- app
  week_starts_on INTEGER NOT NULL DEFAULT 0 CHECK (week_starts_on BETWEEN 0 AND 6),  -- 0=Mon
  weight_unit TEXT NOT NULL DEFAULT 'kg' CHECK (weight_unit IN ('kg','lb')),
  distance_unit TEXT NOT NULL DEFAULT 'km' CHECK (distance_unit IN ('km','mi')),
  training_days INTEGER,                            -- bitmask bit0=Mon
  max_hr INTEGER,
  life_target INTEGER,
  favourite_disciplines TEXT NOT NULL DEFAULT '[]', -- PG varchar[] default '{}'
  birth_year INTEGER,
  accepted_terms_at TEXT,
  accepted_terms_version TEXT,                      -- varchar(20)
  onboarded_at TEXT,
  visibility TEXT NOT NULL DEFAULT 'followers' CHECK (visibility IN ('private','followers','public')),
  sharing_paused INTEGER NOT NULL DEFAULT 0,
  gamification_enabled INTEGER NOT NULL DEFAULT 1,
  leaderboard_opt_in INTEGER NOT NULL DEFAULT 0,
  social_suspended_at TEXT,
  deletion_scheduled_at TEXT,
  reminder_hour INTEGER NOT NULL DEFAULT 18 CHECK (reminder_hour BETWEEN 0 AND 23),
  reminder_mode TEXT NOT NULL DEFAULT 'fixed',      -- varchar(5): 'fixed'|'smart' (no CHECK)
  learned_reminder_hour INTEGER,
  quiet_start INTEGER NOT NULL DEFAULT 22,
  quiet_end INTEGER NOT NULL DEFAULT 7,
  quiet_days INTEGER                                -- bitmask bit0=Mon
);
CREATE UNIQUE INDEX ix_profiles_user_id ON profiles(user_id);
CREATE UNIQUE INDEX ix_profiles_handle ON profiles(handle);
CREATE UNIQUE INDEX uq_profiles_calendar_token_hash ON profiles(calendar_token_hash);

-- ===== account / ops =====
CREATE TABLE security_events (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                               -- varchar(40)
  ip_address TEXT, user_agent TEXT,
  meta TEXT                                         -- jsonb dict|null
);
CREATE INDEX ix_security_events_user ON security_events(user_id, created_at);

CREATE TABLE audit_log (
  {BASE},
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,                             -- varchar(40)
  target_type TEXT,                                 -- varchar(20)
  target_id TEXT,                                   -- varchar(64)
  detail TEXT                                       -- jsonb
);
CREATE INDEX ix_audit_log_created ON audit_log(created_at);

CREATE TABLE worker_heartbeats (
  {BASE},
  name TEXT NOT NULL UNIQUE,                        -- varchar(40)
  last_tick_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  jobs TEXT NOT NULL DEFAULT '{}',                  -- jsonb {"job":{"result":n}|{"error":"Name"}}
  failing_ticks INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE client_errors (
  {BASE},
  fingerprint TEXT NOT NULL UNIQUE,                 -- varchar(64)
  message TEXT NOT NULL,                            -- varchar(500)
  stack TEXT,                                       -- varchar(4000)
  path TEXT,                                        -- varchar(300)
  release TEXT,                                     -- varchar(40)
  user_agent TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  alerted_at TEXT
);

CREATE TABLE auth_failures (
  {BASE},
  kind TEXT NOT NULL,                               -- varchar(12)
  ip_address TEXT,
  email_hash TEXT,                                  -- varchar(64) keyed hash
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX ix_auth_failures_created ON auth_failures(created_at);
CREATE INDEX ix_auth_failures_ip_address ON auth_failures(ip_address);
CREATE INDEX ix_auth_failures_email_hash ON auth_failures(email_hash);
CREATE INDEX ix_auth_failures_user_id ON auth_failures(user_id);

-- ===== training =====
CREATE TABLE gear (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                               -- varchar(60)
  kind TEXT NOT NULL DEFAULT 'shoes' CHECK (kind IN ('shoes','bike','other')),
  default_for TEXT NOT NULL DEFAULT '[]',           -- jsonb list[str] disciplines
  limit_m REAL CHECK (limit_m IS NULL OR limit_m > 0),
  initial_m REAL NOT NULL DEFAULT 0,
  retired_at TEXT,
  note TEXT                                         -- varchar(200)
);
CREATE INDEX ix_gear_user_id ON gear(user_id);

CREATE TABLE gyms (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                               -- varchar(60)
  equipment TEXT NOT NULL DEFAULT '[]',             -- jsonb list[str]
  plates_kg TEXT NOT NULL DEFAULT '[]',             -- jsonb list[float]
  bar_kg REAL NOT NULL DEFAULT 20,
  is_default INTEGER NOT NULL DEFAULT 0             -- server_default false
);
CREATE INDEX ix_gyms_user_id ON gyms(user_id);

CREATE TABLE workouts (
  {BASE},                                           -- id is client-chosen
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  discipline TEXT NOT NULL,                         -- varchar(20)
  title TEXT,                                       -- varchar(80)
  notes TEXT,                                       -- varchar(1000)
  started_at TEXT NOT NULL,
  local_date TEXT NOT NULL,                         -- date, user's tz at write time (stored, not derived)
  duration_sec INTEGER CHECK (duration_sec IS NULL OR duration_sec >= 0),
  distance_m REAL CHECK (distance_m IS NULL OR distance_m >= 0),
  elevation_m REAL,
  effort INTEGER CHECK (effort IS NULL OR effort BETWEEN 1 AND 10),
  feel INTEGER CHECK (feel IS NULL OR feel BETWEEN 1 AND 5),
  soreness INTEGER CHECK (soreness IS NULL OR soreness BETWEEN 0 AND 3),
  pump INTEGER CHECK (pump IS NULL OR pump BETWEEN 0 AND 2),
  avg_hr INTEGER, max_hr INTEGER,
  hr_zones TEXT NOT NULL DEFAULT '[]',              -- jsonb list[int] (5 zones, seconds)
  routine_id TEXT,                                  -- uuid, NO FK
  tags TEXT NOT NULL DEFAULT '[]',                  -- jsonb list[str]
  splits TEXT NOT NULL DEFAULT '[]',                -- jsonb [{"m":1000,"sec":312}]
  gear_id TEXT REFERENCES gear(id) ON DELETE SET NULL,
  gym_id TEXT REFERENCES gyms(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'app',               -- varchar(10): 'app'|'import'
  client_updated_at TEXT NOT NULL,                  -- LWW comparator
  deleted_at TEXT,                                  -- soft delete
  seq INTEGER NOT NULL                              -- PG: DEFAULT nextval('sync_seq'); see 2.1
);
CREATE INDEX ix_workouts_user_id ON workouts(user_id);
CREATE INDEX ix_workouts_user_date ON workouts(user_id, local_date);
CREATE INDEX ix_workouts_user_seq ON workouts(user_id, seq);
CREATE INDEX ix_workouts_gear_id ON workouts(gear_id);
CREATE INDEX ix_workouts_gym_id ON workouts(gym_id);

CREATE TABLE workout_sets (
  {BASE},
  workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- denormalised
  exercise_id TEXT NOT NULL,                        -- varchar(80); library id or "custom:<uuid>" (CUSTOM_PREFIX)
  position INTEGER NOT NULL,                        -- smallint
  set_index INTEGER NOT NULL,                       -- smallint
  superset INTEGER,
  kind TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work','warmup','drop','failure')),
  weight_kg REAL CHECK (weight_kg IS NULL OR weight_kg >= 0),
  reps INTEGER CHECK (reps IS NULL OR reps >= 0),
  rpe REAL CHECK (rpe IS NULL OR rpe BETWEEN 1 AND 10),
  duration_sec INTEGER,
  distance_m REAL,
  completed INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_workout_sets_workout_id ON workout_sets(workout_id);
CREATE INDEX ix_workout_sets_user_exercise ON workout_sets(user_id, exercise_id);
-- ORM relationship: Workout.sets ordered by (position, set_index), cascade delete-orphan, lazy=selectin.

CREATE TABLE custom_exercises (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                               -- varchar(60)
  pattern TEXT NOT NULL,                            -- varchar(20)
  equipment TEXT NOT NULL,                          -- varchar(20)
  "primary" TEXT NOT NULL DEFAULT '[]',             -- jsonb list[str]  (PRIMARY is a keyword: quote it)
  secondary TEXT NOT NULL DEFAULT '[]',
  load_type TEXT NOT NULL DEFAULT 'weight',         -- varchar(12)
  rest_sec INTEGER NOT NULL DEFAULT 90,
  unilateral INTEGER NOT NULL DEFAULT 0,
  cue TEXT,                                         -- varchar(200)
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_custom_exercises_user_id ON custom_exercises(user_id);

CREATE TABLE routines (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                               -- varchar(60)
  discipline TEXT NOT NULL DEFAULT 'strength',
  notes TEXT,                                       -- varchar(500)
  items TEXT NOT NULL DEFAULT '[]',                 -- jsonb list[dict], read/written whole
  position INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);
CREATE INDEX ix_routines_user_id ON routines(user_id);

CREATE TABLE body_metrics (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  measured_on TEXT NOT NULL,
  body_fat_pct REAL, waist_cm REAL, resting_hr INTEGER, sleep_hours REAL,
  note TEXT,                                        -- varchar(200)
  neck_cm REAL, shoulders_cm REAL, chest_cm REAL, arm_cm REAL,
  forearm_cm REAL, hips_cm REAL, thigh_cm REAL, calf_cm REAL,
  CONSTRAINT uq_body_metric_day UNIQUE (user_id, measured_on)
);
CREATE INDEX ix_body_metrics_user_id ON body_metrics(user_id);

CREATE TABLE body_photos (
  {BASE},                                           -- id client-chosen
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  taken_on TEXT NOT NULL,
  pose TEXT NOT NULL,                               -- varchar(8): front|side|back (no CHECK)
  content_type TEXT NOT NULL,                       -- varchar(32)
  object_key TEXT NOT NULL UNIQUE,                  -- varchar(255), R2 key
  size INTEGER NOT NULL
);
CREATE INDEX ix_body_photos_user_id ON body_photos(user_id);
-- constants: MAX_BODY_PHOTOS=500, MAX_BODY_PHOTO_BYTES=2 MiB, PHOTO_POSES=(front,side,back)

CREATE TABLE weigh_ins (
  {BASE},                                           -- id client-chosen
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weighed_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  moment TEXT NOT NULL CHECK (moment IN ('waking','pre_workout','post_workout','bedtime','other')),
  weight_kg REAL NOT NULL,
  note TEXT                                         -- varchar(200)
);
CREATE INDEX ix_weigh_ins_user_day ON weigh_ins(user_id, local_date);

CREATE TABLE streak_chains (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                               -- varchar(40)
  disciplines TEXT NOT NULL DEFAULT '[]',           -- [] = all count
  target_history TEXT NOT NULL DEFAULT '[]',        -- [{"from":"YYYY-MM-DD","target":n}] asc; current = last, default 3
  requirements_history TEXT NOT NULL DEFAULT '[]',  -- [{"from":..,"requirements":[{"disciplines":[..],"days":n}]}]
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_streak_chains_user_id ON streak_chains(user_id);

CREATE TABLE streak_repairs (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain_id TEXT NOT NULL REFERENCES streak_chains(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  month TEXT NOT NULL,                              -- "YYYY-MM"
  CONSTRAINT uq_repair_chain_week UNIQUE (chain_id, week_start),
  CONSTRAINT uq_repair_user_month UNIQUE (user_id, month)   -- one repair per person per calendar month
);
CREATE INDEX ix_streak_repairs_user_id ON streak_repairs(user_id);

CREATE TABLE streak_pauses (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_on TEXT NOT NULL,
  ends_on TEXT,                                     -- inclusive; NULL = open
  reason TEXT NOT NULL DEFAULT 'injury' CHECK (reason IN ('injury','illness','travel','life','other')),
  note TEXT,                                        -- varchar(280)
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX ix_streak_pauses_user_start ON streak_pauses(user_id, starts_on);

CREATE TABLE training_blocks (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  weeks INTEGER NOT NULL CHECK (weeks BETWEEN 3 AND 8),
  rir_start INTEGER NOT NULL DEFAULT 3,
  rir_end INTEGER NOT NULL DEFAULT 1,
  ended_at TEXT,
  CHECK (rir_start BETWEEN 0 AND 5 AND rir_end BETWEEN 0 AND 5)
);
CREATE INDEX ix_training_blocks_user_id ON training_blocks(user_id);

CREATE TABLE readiness (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  sleep INTEGER NOT NULL, energy INTEGER NOT NULL, soreness INTEGER NOT NULL,
  CONSTRAINT uq_readiness_day UNIQUE (user_id, day),
  CHECK (sleep BETWEEN 1 AND 5 AND energy BETWEEN 1 AND 5 AND soreness BETWEEN 1 AND 5)
);
CREATE INDEX ix_readiness_user_id ON readiness(user_id);

CREATE TABLE week_reflections (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  went_well TEXT, change TEXT,                      -- varchar(500) each
  CONSTRAINT uq_reflection_week UNIQUE (user_id, week_start)
);
CREATE INDEX ix_week_reflections_user_id ON week_reflections(user_id);

CREATE TABLE exercise_notes (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL,                        -- varchar(60) (note: sets use 80)
  note TEXT NOT NULL,                               -- varchar(500)
  CONSTRAINT uq_exercise_note UNIQUE (user_id, exercise_id)
);
CREATE INDEX ix_exercise_notes_user_id ON exercise_notes(user_id);

CREATE TABLE weight_goals (
  {BASE},
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  target_kg REAL NOT NULL, start_kg REAL NOT NULL,
  milestone_kg REAL NOT NULL DEFAULT 2,
  set_on TEXT NOT NULL
);

-- training_plans references challenges, so create groups/challenges first (see below), then:
CREATE TABLE training_plans (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                               -- varchar(60)
  description TEXT,                                 -- varchar(500)
  template_id TEXT,                                 -- varchar(40)
  weeks TEXT NOT NULL DEFAULT '[]',                 -- jsonb list[list[{day,discipline,title,minutes,distance_km,routine_id,note}]]
  started_on TEXT,                                  -- week-start date of week one
  challenge_id TEXT REFERENCES challenges(id) ON DELETE SET NULL,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  finished_at TEXT,
  repeat INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_training_plans_user_id ON training_plans(user_id);
CREATE INDEX ix_training_plans_challenge_id ON training_plans(challenge_id);

CREATE TABLE monthly_goals (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                              -- "YYYY-MM"
  days INTEGER NOT NULL CHECK (days BETWEEN 1 AND 31),
  CONSTRAINT uq_monthly_goal UNIQUE (user_id, month)
);
CREATE INDEX ix_monthly_goals_user_id ON monthly_goals(user_id);

CREATE TABLE rest_days (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'rest' CHECK (kind IN ('rest','sleep','mobility','sick')),
  note TEXT,                                        -- varchar(200)
  CONSTRAINT uq_rest_day UNIQUE (user_id, day)
);
CREATE INDEX ix_rest_days_user_id ON rest_days(user_id);

-- ===== game =====
CREATE TABLE user_stats (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  computed_at TEXT NOT NULL,
  computed_for TEXT NOT NULL,                       -- user's local date when computed
  total_xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 1,
  season_id TEXT NOT NULL,                          -- varchar(8) "2026-Q4"
  season_xp INTEGER NOT NULL DEFAULT 0,
  current_streak INTEGER NOT NULL DEFAULT 0, longest_streak INTEGER NOT NULL DEFAULT 0,
  consistency INTEGER NOT NULL DEFAULT 0,
  this_week_days INTEGER NOT NULL DEFAULT 0, this_week_target INTEGER NOT NULL DEFAULT 3,
  weekly_days_4w REAL NOT NULL DEFAULT 0,
  life_streak INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0, active_days INTEGER NOT NULL DEFAULT 0,
  season_prs INTEGER NOT NULL DEFAULT 0, total_prs INTEGER NOT NULL DEFAULT 0,
  last_active TEXT,
  recent_weeks TEXT NOT NULL DEFAULT '[]'           -- last 26 statuses: kept|frozen|paused|missed|open (+ repaired)
);
CREATE UNIQUE INDEX ix_user_stats_user_id ON user_stats(user_id);

CREATE TABLE user_achievements (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL,                     -- varchar(40)
  tier TEXT,                                        -- varchar(8); NULL for single badges
  unlocked_on TEXT NOT NULL,
  evidence TEXT,                                    -- jsonb {"value": n}
  CONSTRAINT uq_user_achievement_tier UNIQUE (user_id, achievement_id, tier)
);
CREATE INDEX ix_user_achievements_user_id ON user_achievements(user_id);
CREATE INDEX ix_user_achievements_achievement ON user_achievements(achievement_id);
CREATE UNIQUE INDEX uq_user_achievement_single ON user_achievements(user_id, achievement_id) WHERE tier IS NULL;  -- partial: SQLite supports

CREATE TABLE personal_records (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,                                -- varchar(100), e.g. "<metric>:<exercise_id>"
  value REAL NOT NULL, previous REAL, gain_pct REAL,
  achieved_on TEXT NOT NULL,
  workout_id TEXT,                                  -- uuid, NO FK
  flagged INTEGER NOT NULL DEFAULT 0,
  rewarded INTEGER NOT NULL DEFAULT 0,
  is_current INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_personal_records_user_id ON personal_records(user_id);
CREATE INDEX ix_personal_records_user_key ON personal_records(user_id, key);

CREATE TABLE streak_wagers (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  days INTEGER NOT NULL,
  CONSTRAINT uq_streak_wager_week UNIQUE (user_id, week_start)
);
CREATE INDEX ix_streak_wagers_user_id ON streak_wagers(user_id);

-- ===== social =====
CREATE TABLE follows (
  {BASE},
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
  accepted_at TEXT,
  CONSTRAINT uq_follow_pair UNIQUE (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX ix_follows_follower_id ON follows(follower_id);
CREATE INDEX ix_follows_followee ON follows(followee_id, status);

CREATE TABLE blocks (
  {BASE},
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT uq_block_pair UNIQUE (blocker_id, blocked_id)
);
CREATE INDEX ix_blocks_blocker_id ON blocks(blocker_id);
CREATE INDEX ix_blocks_blocked_id ON blocks(blocked_id);

CREATE TABLE activity_events (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                               -- varchar(20): workout|pr|streak|achievement|level|challenge
  ref_key TEXT NOT NULL,                            -- varchar(120); code truncates [:120]
  data TEXT NOT NULL DEFAULT '{}',                  -- jsonb snapshot for the card
  occurred_on TEXT NOT NULL,
  workout_id TEXT,                                  -- uuid, NO FK
  hidden_at TEXT,
  CONSTRAINT uq_activity_ref UNIQUE (user_id, kind, ref_key)
);
CREATE INDEX ix_activity_events_user_id ON activity_events(user_id);
CREATE INDEX ix_activity_events_workout_id ON activity_events(workout_id);
CREATE INDEX ix_activity_feed ON activity_events(user_id, created_at);

CREATE TABLE kudos (
  {BASE},
  event_id TEXT NOT NULL REFERENCES activity_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction TEXT NOT NULL DEFAULT 'kudos',           -- varchar(10): kudos|fire|strong|star|heart (no CHECK)
  CONSTRAINT uq_kudos_pair UNIQUE (event_id, user_id)
);
CREATE INDEX ix_kudos_event_id ON kudos(event_id);
CREATE INDEX ix_kudos_user_id ON kudos(user_id);

CREATE TABLE comments (
  {BASE},
  event_id TEXT NOT NULL REFERENCES activity_events(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,                               -- varchar(280)
  hidden_at TEXT
);
CREATE INDEX ix_comments_author_id ON comments(author_id);
CREATE INDEX ix_comments_event ON comments(event_id, created_at);

CREATE TABLE reports (
  {BASE},
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('user','comment','event','group','challenge')),
  target_id TEXT NOT NULL,                          -- varchar(64)
  reason TEXT NOT NULL,                             -- varchar(20)
  detail TEXT,                                      -- varchar(500)
  snapshot TEXT,                                    -- jsonb
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  resolution TEXT                                   -- varchar(200)
);
CREATE INDEX ix_reports_reporter_id ON reports(reporter_id);
CREATE INDEX ix_reports_status ON reports(status, created_at);

CREATE TABLE buddy_pairs (
  {BASE},
  user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,                       -- uuid, NO FK
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','ended')),
  started_at TEXT, ended_at TEXT,
  CONSTRAINT uq_buddy_pair UNIQUE (user_a, user_b),
  CHECK (user_a < user_b)                           -- string compare; requires lowercase canonical uuids
);
CREATE INDEX ix_buddy_pairs_user_a ON buddy_pairs(user_a);
CREATE INDEX ix_buddy_pairs_user_b ON buddy_pairs(user_b);

-- ===== groups =====
CREATE TABLE groups (
  {BASE},
  name TEXT NOT NULL,                               -- varchar(60)
  description TEXT,                                 -- varchar(280)
  kind TEXT NOT NULL DEFAULT 'crew' CHECK (kind IN ('crew','coaching')),
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL,                        -- varchar(16); 8 chars from "abcdefghjkmnpqrstuvwxyz23456789"
  avatar_hue INTEGER NOT NULL DEFAULT 200,
  hidden_at TEXT,
  streak_threshold INTEGER NOT NULL DEFAULT 75      -- % of members
);
CREATE UNIQUE INDEX ix_groups_invite_code ON groups(invite_code);
CREATE INDEX ix_groups_owner_id ON groups(owner_id);

CREATE TABLE group_members (
  {BASE},
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','coach','member')),
  shares_with_coach INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT uq_group_member UNIQUE (group_id, user_id)
);
CREATE INDEX ix_group_members_group_id ON group_members(group_id);
CREATE INDEX ix_group_members_user_id ON group_members(user_id);

CREATE TABLE challenges (
  {BASE},
  title TEXT NOT NULL,                              -- varchar(60)
  description TEXT,                                 -- varchar(280)
  kind TEXT NOT NULL DEFAULT 'active_days' CHECK (kind IN ('active_days','weekly_target','plan_sessions')),
  target INTEGER,
  disciplines TEXT NOT NULL DEFAULT '[]',
  starts_on TEXT NOT NULL, ends_on TEXT NOT NULL,
  creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL,
  resolved_at TEXT, hidden_at TEXT,
  plan TEXT,                                        -- jsonb shareable plan (routines embedded) for plan_sessions
  CHECK (ends_on >= starts_on)
);
CREATE INDEX ix_challenges_creator_id ON challenges(creator_id);
CREATE INDEX ix_challenges_group_id ON challenges(group_id);
CREATE UNIQUE INDEX ix_challenges_invite_code ON challenges(invite_code);

CREATE TABLE challenge_participants (
  {BASE},
  challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  final_score INTEGER, final_rank INTEGER,
  completed INTEGER NOT NULL DEFAULT 0,
  left_at TEXT,
  CONSTRAINT uq_challenge_participant UNIQUE (challenge_id, user_id)
);
CREATE INDEX ix_challenge_participants_challenge_id ON challenge_participants(challenge_id);
CREATE INDEX ix_challenge_participants_user_id ON challenge_participants(user_id);

CREATE TABLE group_announcements (
  {BASE},
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,                               -- varchar(500)
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_group_announcements_group_id ON group_announcements(group_id);

-- ===== notifications =====
CREATE TABLE notifications (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                               -- varchar(30)
  category TEXT NOT NULL,                           -- varchar(20)
  title TEXT NOT NULL,                              -- varchar(120)
  body TEXT,                                        -- varchar(400)
  url TEXT,                                         -- varchar(200)
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  data TEXT,                                        -- jsonb
  dedupe_key TEXT,                                  -- varchar(120)
  read_at TEXT,
  CONSTRAINT uq_notification_dedupe UNIQUE (user_id, dedupe_key)   -- NULL keys never collide (same in SQLite)
);
CREATE INDEX ix_notifications_inbox ON notifications(user_id, created_at);

CREATE TABLE notification_preferences (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channels TEXT NOT NULL DEFAULT '{}',              -- jsonb {"category":{"push":bool,"email":bool}}
  habit_summary_hour INTEGER,
  backup_attachment INTEGER NOT NULL DEFAULT 0,
  backup_frequency TEXT NOT NULL DEFAULT 'monthly'  -- 'monthly'|'weekly' (no CHECK)
);
CREATE UNIQUE INDEX ix_notification_preferences_user_id ON notification_preferences(user_id);

CREATE TABLE push_subscriptions (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,                    -- text
  p256dh TEXT NOT NULL,                             -- varchar(200)
  auth TEXT NOT NULL,                               -- varchar(100)
  user_agent TEXT,
  last_success_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_push_subscriptions_user_id ON push_subscriptions(user_id);

-- ===== habits =====
CREATE TABLE habits (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                               -- varchar(60)
  emoji TEXT NOT NULL DEFAULT '✨',                 -- varchar(8) (PG counts characters; SQLite length() too)
  category TEXT NOT NULL DEFAULT 'other',           -- varchar(16), enum in code only
  kind TEXT NOT NULL DEFAULT 'check' CHECK (kind IN ('check','duration','count','quit')),
  unit TEXT,                                        -- varchar(20)
  daily_goal REAL,
  weekly_target INTEGER NOT NULL DEFAULT 7 CHECK (weekly_target BETWEEN 1 AND 7),
  time_of_day TEXT NOT NULL DEFAULT 'anytime',      -- varchar(10) (no CHECK on habits)
  cue TEXT,                                         -- varchar(120)
  why TEXT,                                         -- varchar(200)
  total_goal REAL,
  remind_hour INTEGER CHECK (remind_hour IS NULL OR remind_hour BETWEEN 0 AND 23),
  template_id TEXT,                                 -- varchar(40)
  started_on TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  snoozed_until TEXT,
  days_mask INTEGER,                                -- bit0=Mon..bit6=Sun; NULL = any day
  paused_from TEXT, paused_until TEXT
);
CREATE INDEX ix_habits_user_id ON habits(user_id);

CREATE TABLE habit_logs (
  {BASE},
  habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  amount REAL NOT NULL,                             -- 1 for check, minutes, count, or slips for quit
  note TEXT,                                        -- varchar(280)
  CONSTRAINT uq_habit_log_day UNIQUE (habit_id, day)
);
CREATE INDEX ix_habit_logs_habit_id ON habit_logs(habit_id);
CREATE INDEX ix_habit_logs_user_day ON habit_logs(user_id, day);

CREATE TABLE habit_routines (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🌅',
  time_of_day TEXT NOT NULL DEFAULT 'morning' CHECK (time_of_day IN ('morning','afternoon','evening','anytime')),
  habit_ids TEXT NOT NULL                           -- jsonb list[str uuid], no default
);
CREATE INDEX ix_habit_routines_user_id ON habit_routines(user_id);

-- ===== nutrition =====
CREATE TABLE foods (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                               -- varchar(120)
  brand TEXT,                                       -- varchar(120)
  barcode TEXT,                                     -- varchar(32)
  serving_label TEXT,                               -- varchar(40)
  kcal REAL NOT NULL,
  protein_g REAL NOT NULL DEFAULT 0, carbs_g REAL NOT NULL DEFAULT 0, fat_g REAL NOT NULL DEFAULT 0,
  CONSTRAINT uq_food_barcode UNIQUE (user_id, barcode)
);
CREATE INDEX ix_foods_user_id ON foods(user_id);

CREATE TABLE meal_entries (
  {BASE},                                           -- id client-chosen
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  meal TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
  name TEXT NOT NULL,                               -- varchar(120)
  food_id TEXT REFERENCES foods(id) ON DELETE SET NULL,
  servings REAL NOT NULL DEFAULT 1,
  kcal REAL NOT NULL,
  protein_g REAL NOT NULL DEFAULT 0, carbs_g REAL NOT NULL DEFAULT 0, fat_g REAL NOT NULL DEFAULT 0
);
CREATE INDEX ix_meal_entries_user_day ON meal_entries(user_id, day);

CREATE TABLE nutrition_targets (
  {BASE},
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  kcal REAL, protein_g REAL, carbs_g REAL, fat_g REAL
);

CREATE TABLE recipes (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                               -- varchar(120)
  serves REAL NOT NULL DEFAULT 1,
  items TEXT NOT NULL,                              -- jsonb [{"food_id","name","servings"}]
  kcal REAL NOT NULL,
  protein_g REAL NOT NULL DEFAULT 0, carbs_g REAL NOT NULL DEFAULT 0, fat_g REAL NOT NULL DEFAULT 0
);
CREATE INDEX ix_recipes_user_id ON recipes(user_id);

-- ===== insights / trash =====
CREATE TABLE journal_days (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  mood INTEGER CHECK (mood IS NULL OR mood BETWEEN 1 AND 5),
  note TEXT,                                        -- varchar(1000)
  CONSTRAINT uq_journal_day UNIQUE (user_id, day)
);
CREATE INDEX ix_journal_days_user_id ON journal_days(user_id);

CREATE TABLE trash_items (
  {BASE},
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                               -- varchar(16): habit|meal|food|recipe|journal|habit_routine|workout
  item_id TEXT NOT NULL,                            -- uuid, NO FK
  label TEXT NOT NULL,                              -- varchar(160)
  payload TEXT NOT NULL,                            -- jsonb {"row":{...},"children":{"habit_logs":[...]}}; {} for workouts
  deleted_at TEXT NOT NULL,
  purge_after TEXT NOT NULL
);
CREATE INDEX ix_trash_user_deleted ON trash_items(user_id, deleted_at);

-- ===== sync sequence emulation (see 2.1) =====
CREATE TABLE sync_seq (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
INSERT INTO sync_seq VALUES (1, 0);
```

Table count: **60** tables + the `sync_seq` sequence.

### 1.3 FK summary (ondelete)

| Behaviour | Columns |
|---|---|
| CASCADE from `users` | every `user_id` above except auth_failures; plus follows.follower_id/followee_id, blocks.blocker_id/blocked_id, comments.author_id, reports.reporter_id, buddy_pairs.user_a/user_b, groups.owner_id, challenges.creator_id, webauthn_challenges.user_id |
| SET NULL to `users` | audit_log.actor_id, auth_failures.user_id, reports.reported_user_id, reports.resolved_by, notifications.actor_id, training_plans.assigned_by, group_announcements.author_id |
| CASCADE other | workout_sets.workout_id, streak_repairs.chain_id, kudos.event_id, comments.event_id, group_members.group_id, challenges.group_id, challenge_participants.challenge_id, group_announcements.group_id, habit_logs.habit_id |
| SET NULL other | workouts.gear_id, workouts.gym_id, training_plans.challenge_id, meal_entries.food_id |
| NO ACTION | refresh_tokens.parent_id → refresh_tokens.id |
| Not FKs (bare uuid) | workouts.routine_id, personal_records.workout_id, activity_events.workout_id, buddy_pairs.requested_by, trash_items.item_id, refresh_tokens.replaced_by, refresh_tokens.family_id |

Python-side relationships: `User.refresh_tokens` (cascade all, delete-orphan), `Workout.sets` (cascade all, delete-orphan, order_by position,set_index, eager selectin). In Drizzle, replicate with explicit `relations()` and always load sets ordered by `(position, set_index)`.

---

## 2. Postgres-specific features used in `app/` and their D1 equivalents

| # | Feature | file:line | What it does | SQLite/D1 equivalent |
|---|---|---|---|---|
| 1 | `CREATE SEQUENCE sync_seq`; `Workout.seq` `server_default=nextval('sync_seq')` | training/models.py:27, :118-120; migration fd264d571db7 | Strictly increasing global cursor for `/sync` | See 2.1. |
| 2 | Explicit `workout.seq = sync_seq.next_value()` on every write | training/router.py:218, :277, :1126, :1281; trash/router.py:82 | Bumps cursor on update/delete/restore | Same function `nextSeq()` from 2.1, in the same `db.batch()` as the write. |
| 3 | `GET` sync: `WHERE user_id=? AND seq > since ORDER BY seq` | training/router.py:333-345 | cursor = last row's seq or `since` | Identical SQL. |
| 4 | PG enums `userrole`, `tokenpurpose` (+ `ALTER TYPE ... ADD VALUE`) | auth/models.py:226-235, :323-330 | | TEXT + CHECK (1.2). |
| 5 | `JSONB` columns (26 columns) | all models | | TEXT JSON; no JSON operators are used in any query (no `->`, `@>`, `?`), all filtering on JSON is done in Python, so no SQL change needed. |
| 6 | `ARRAY(String)` default `'{}'` | profile/models.py:89-91 | | TEXT JSON array default `'[]'`. |
| 7 | `timestamptz` + `server_default now()` + `onupdate now()` | database.py:35-38 | PG `now()` = **transaction start time**: every row inserted/updated in one transaction gets the same timestamp | App-side ISO string. Note ordering by `created_at` (activity feed, comments, notifications inbox, meal entries, trash, etc.) ties within a transaction in PG and are broken arbitrarily; in TS give each row its own `Date.now()` value or tie-break by id (uuid7 is time-ordered). |
| 8 | `INSERT ... ON CONFLICT DO UPDATE` (constraint name) | training/habits.py:100 (`uq_monthly_goal`), :171 (`uq_rest_day` + `RETURNING RestDay`); social/service.py:114 (`uq_activity_ref`, set data) | upsert | SQLite needs a **column list** target: `ON CONFLICT(user_id, month)`, `ON CONFLICT(user_id, day)`, `ON CONFLICT(user_id, kind, ref_key)`. Drizzle: `.onConflictDoUpdate({target:[t.userId,t.month], set:{...}})`. |
| 9 | `ON CONFLICT (cols) DO UPDATE` with `excluded.*` | worker.py:736-752 (worker_heartbeats; `failing_ticks = failing_ticks+1` or 0, `updated_at = now()`); ops/router.py:69-77 (client_errors: `count=count+1`, last_seen, path/user_agent/release from excluded); notifications/router.py:170 (prefs), :221 (push_subscriptions by endpoint: moves endpoint to the new user), :303 (unsubscribe channels); game/service.py:825 (user_stats by user_id) | | SQLite supports `excluded.` (Drizzle `sql\`excluded.col\``). |
| 10 | `ON CONFLICT DO NOTHING` + `RETURNING id` | notifications/service.py:91-92 (`uq_notification_dedupe`; returns None if duplicate ⇒ no push/email) | Dedupe of scheduled nudges | `INSERT ... ON CONFLICT(user_id, dedupe_key) DO NOTHING RETURNING id` works in SQLite ≥3.35 (D1 OK). Returns zero rows on conflict. |
| 11 | `ON CONFLICT (user_id, achievement_id) WHERE tier IS NULL DO NOTHING RETURNING id` against **partial unique index** | game/service.py:684-705; index game/models.py:84-90, migration b7a4e1c9d3f8 | Race-safe single badge | SQLite supports partial indexes and upsert targets with a WHERE: `ON CONFLICT(user_id, achievement_id) WHERE tier IS NULL DO NOTHING RETURNING id`. Drizzle: `.onConflictDoNothing({target:[...], where: isNull(t.tier)})`. |
| 12 | Upserts do **not** fire ORM `onupdate` | all `on_conflict_do_update` sites above | `updated_at` is NOT bumped by these upserts except worker heartbeat (explicit) | Don't add `updated_at` to the `set` (to stay 1:1) — or do; nothing reads it for these tables. |
| 13 | `DELETE ... RETURNING` | auth/passkeys.py:124-132 | Consume WebAuthn challenge atomically (delete-and-return) | `DELETE FROM webauthn_challenges WHERE challenge=? AND purpose=? RETURNING user_id, expires_at` (SQLite supports). |
| 14 | `pg_advisory_xact_lock(hashtext(user_id))` | game/service.py:654 | Serialises concurrent `recompute()` per user for the whole transaction | **No equivalent in D1** (no session, no multi-statement transactions across awaits). Options: (a) a per-user Durable Object that runs recompute (strongest, matches semantics); (b) optimistic: compute, then commit in one `db.batch()` guarded by `UPDATE user_stats ... WHERE user_id=? AND computed_at = :prev` and retry/skip notifications if 0 rows; (c) accept the race but rely on dedupe keys/unique constraints for notifications. Test `test_recompute_is_serialized_across_concurrent_calls` asserts only one level-up notification after two concurrent recomputes. |
| 15 | `func.rank().over(order_by=value DESC)` window function | game/leaderboards.py:118-133 | Leaderboard rank (ties share rank), then `ORDER BY rank, handle LIMIT 50`; plus the caller's own row and `count(*)` | SQLite ≥3.25 supports `RANK() OVER (ORDER BY ...)` — same SQL. Mind NULL ordering of `handle` (#20). |
| 16 | `func.timezone(Profile.timezone, now())` + `extract(hour ...) = col` | worker.py:59-62, used at :106 (streak nudges, reminder hour or learned hour via CASE), :208, :326 (09:00 local jobs: digest/backup), :498 (`Habit.remind_hour`), :575 (`habit_summary_hour`) | Select users whose **local** hour equals X, in SQL | SQLite has no tz database. Do it in JS: `SELECT DISTINCT timezone FROM profiles`, compute each zone's current local hour with `Intl.DateTimeFormat(…,{timeZone, hour:'numeric', hourCycle:'h23'})`, then query `WHERE timezone IN (zones whose hour == h)` (for the CASE/column cases group zones by hour and add `AND col = ?` per hour group, or fetch candidates and filter in JS). PG `timezone()` with an unknown zone name raises; the app validates tz on input (`is_valid_timezone`). |
| 17 | `func.current_date() + literal_column('1')` | worker.py:74 | `computed_for < CURRENT_DATE + 1` (UTC date of DB session), ORDER BY computed_at LIMIT 500 | `computed_for < date('now','+1 day')`. Note: as written it selects essentially every row (computed_for ≤ today UTC); the per-row local-date check happens in Python after. |
| 18 | `func.date_trunc('week', User.created_at)` GROUP BY / ORDER BY | admin/router.py:448-454 | Signups per ISO week (Monday start, UTC), last 12 weeks; output `w.date().isoformat()` | `date(created_at, 'weekday 0', '-6 days')` gives the Monday (as `YYYY-MM-DD`; for a Monday input, `weekday 0` jumps to next Sunday then −6 = same Monday). Compute on the UTC part of the stored string. |
| 19 | `ILIKE` | admin/router.py:235 (email/handle, `%q%`, no escaping); social/router.py:131-143 (handle prefix `term%` with `%` stripped and `_` escaped `\_`, display_name `%term%` unescaped); nutrition/router.py:282, insights/router.py:54 (`%`/`_` stripped); search/router.py:29-33 + :66,:86,:108,:128,:147,:165 (backslash-escaped `\\`,`\%`,`\_`) | Case-insensitive, Unicode-aware match; PG `LIKE` default escape char is `\` | SQLite `LIKE` is case-insensitive **for ASCII only** and has **no default escape** ⇒ add `ESCAPE '\'` everywhere the pattern contains `\` escapes (search, social). For full Unicode case-folding use `lower(col) LIKE lower(?)` (SQLite `lower()` is ASCII-only too), or store a JS-`toLocaleLowerCase()` shadow column, or filter in JS. Gap: names like "Ärger"/"ÄRGER" match in PG, not in SQLite. |
| 20 | `LIKE '%:{exercise_id}'` (case-sensitive in PG) | training/router.py:563 | PR rows for one exercise | SQLite `LIKE` is case-**insensitive** by default; exercise ids are lowercase slugs/uuids so practically identical. Safer: `substr(key, -length(?)) = ?` or `key GLOB '*:' || ?`. `_` in an id is a wildcard in both. |
| 21 | `func.lower(Routine.name) == key` | training/plans.py:610 | Case-insensitive routine name match on plan import | SQLite `lower()` is ASCII-only; Python `.lower()` side is Unicode. Compare in JS or accept ASCII-only. |
| 22 | `func.length(Profile.handle)` ORDER BY | social/router.py:143 | Shortest handle first | SQLite `length()` counts characters for TEXT: same. NULL handles: PG ASC puts NULLs **last**, SQLite **first** ⇒ add `handle IS NULL,` before it (or `NULLS LAST`, supported in SQLite ≥3.30). |
| 23 | NULL ordering differences | training/plans.py:377 and groups/router.py:489 `TrainingPlan.started_on DESC` (nullable: PG puts NULLs **first** on DESC, SQLite **last**); social/router.py:387 `Follow.accepted_at DESC`; leaderboards.py:132 `Profile.handle` ASC | | Add explicit `NULLS FIRST/LAST` to match PG: DESC ⇒ `NULLS FIRST`, ASC ⇒ `NULLS LAST`. |
| 24 | Collation of text ORDER BY | `order_by(Group.name)` groups/router.py:142,:432; `Food.name` nutrition/router.py:283, search:148; `Recipe.name` nutrition:476, search:166; `CustomExercise.name` training/router.py:615; `Routine.position, Routine.name` :699; `Habit.name, HabitLog.day` account/router.py:782; `Profile.handle` leaderboards | PG uses the DB collation (Neon default `C.UTF-8`? or `en_US.UTF-8`: unknown, see open questions) | SQLite BINARY = byte order (uppercase before lowercase). If Neon is `en_US.UTF-8`, use `COLLATE NOCASE` or sort in JS with `localeCompare`. |
| 25 | `UNION` in a subquery + `count(*)` | game/service.py:382-386 | distinct days with body metric or weigh-in | Same SQL works in SQLite. |
| 26 | `db.begin_nested()` (SAVEPOINT) | training/router.py:417 (per-op isolation in the offline outbox flush: one failing op rolls back only itself); admin/merge.py:84, :95 | | D1 has no interactive transactions/savepoints from a Worker. Per-op: validate first, then write each op as its own `db.batch([...])` (batch is atomic); collect per-op errors. |
| 27 | `IntegrityError` ⇒ HTTP 409 `{"detail":"That was saved twice at once. Try again."}` | main.py:118-124 (global middleware); trash/router.py:106-112 (409 "Something already exists in its place") | | D1 throws `Error` with message containing `UNIQUE constraint failed` / `FOREIGN KEY constraint failed` / `CHECK constraint failed` / `NOT NULL constraint failed`. Map those to 409 in the Hono `onError`. Note PG `DataError` (varchar too long, smallint overflow) is NOT IntegrityError ⇒ 500 in Python. |
| 28 | Account merge via catalog introspection | admin/merge.py:30-42 (`pg_constraint`/`pg_class`/`pg_attribute`, `'users'::regclass`, `current_schema()`), :67-104 (`ctid`, per-row savepoints) | Finds every FK column referencing users and repoints/deletes | Use a **static list** of (table, column) FK-to-users pairs generated from the Drizzle schema (section 1.3, minus NOT_MOVED = refresh_tokens, one_time_tokens, passkeys, recovery_codes, webauthn_challenges), or `SELECT m.name, p."from" FROM sqlite_master m, pragma_foreign_key_list(m.name) p WHERE p."table"='users'` (check D1 allows it). Replace the update/savepoint/ctid dance with: `UPDATE OR IGNORE t SET c=:d WHERE c=:s; DELETE FROM t WHERE c=:s;` (collisions keep the destination's row, same as the original). Verify `OR IGNORE` covers CHECK failures (buddy_pairs `user_a < user_b`, follows not-self); if not, pre-delete rows that would violate. `ctid` ⇒ `rowid`. Self-link deletion step is plain SQL. All in one `db.batch()` for atomicity. |
| 29 | `text("SELECT 1")` health | ops/health.py:49 | DB liveness | `db.prepare('SELECT 1').first()`. |
| 30 | `rowcount` | auth/passkeys.py:381 (`DELETE ... expires_at < now()` sweep count); ops/router.py:114 | | D1 result `meta.changes`. |
| 31 | `func.now()` in WHERE | auth/passkeys.py:379 | | Bind JS `new Date().toISOString()`-formatted value (same format as stored). |
| 32 | `gen_random_uuid()`, `AT TIME ZONE`, `date + time` | migration 02c71d3228fb only | data backfill | Not needed at runtime. |
| 33 | `TRUNCATE ... RESTART IDENTITY CASCADE` | tests/conftest.py:52 | Test reset | `DELETE FROM` each table (FK order) or recreate the local D1 per test (Miniflare/vitest-pool-workers isolated storage). |
| 34 | asyncpg `statement_cache_size=0` (PgBouncer) | database.py:22-27 | | n/a. |

Not used anywhere in `app/`: `tsvector`/full-text search, `DISTINCT ON`, `FOR UPDATE`/`SKIP LOCKED`, `LATERAL`, CTEs, JSON operators, `generate_series`, `INTERVAL` arithmetic in SQL (all date math is in Python with bound params), `array_agg`, `string_agg`.

### 2.1 Emulating `sync_seq`

Semantics to keep: a value strictly greater than every previous one, assigned on insert **and** re-assigned on every update/soft-delete/restore of a workout (`/sync?since=N` returns `seq > N ORDER BY seq`). Only per-user monotonicity is observable (the query filters by user_id), but the Postgres value is global.

D1 serialises writes, so inside one `db.batch()`:

```sql
UPDATE sync_seq SET value = value + 1 WHERE id = 1 RETURNING value;   -- batch statement 1
-- statement 2 uses it:
INSERT INTO workouts (..., seq) VALUES (..., (SELECT value FROM sync_seq WHERE id = 1))
  ON CONFLICT(id) DO UPDATE SET ..., seq = (SELECT value FROM sync_seq WHERE id = 1);
```

For several workouts in one batch, increment once per row. Seed `sync_seq.value` with `MAX(workouts.seq)` when importing Postgres data. Values are JS numbers: safe to 2^53.

---

## 3. Data access shapes that matter for D1 performance

| Pattern | Where | D1 concern |
|---|---|---|
| Full replay of a user's history on every write: `snapshot()` loads all workouts+sets, chains, pauses, wagers, repairs, records, body days, social counts, then rewrites `personal_records` wholesale and upserts `user_stats` | game/service.py `snapshot`/`recompute` (~640-830) | Many round trips per request; CPU of replay grows with history. Batch reads with `db.batch()` of SELECTs; watch the Workers CPU limit (30 s paid / 10 ms free). |
| Worker batches of 500 users per job | worker.py `BATCH=500` | Move to Cron Triggers (`scheduled()`), paginate; respect D1 1000-queries-per-invocation limit (paid) / 50 subrequests free. |
| Leaderboard: window function over all opted-in profiles joined to user_stats, 3 queries | game/leaderboards.py | Fine on SQLite with indexes; add index on the ranked column if boards grow (`user_stats(season_xp)`, etc.). |
| Account merge touches ~55 tables | admin/merge.py | One `db.batch()` of ~120 statements; within D1 limits. |
| Export reads every private table for one user | account/router.py ~100-800 | Large responses; zip building is CPU (see other spec). |

---

## 4. Porting hazards (schema/DB layer)

| Hazard | Severity | Mitigation |
|---|---|---|
| Advisory lock serialising recompute (game/service.py:654) | High | Per-user Durable Object, or optimistic concurrency guard on `user_stats` (2 #14). |
| Savepoint-per-op outbox flush (training/router.py:417) | High | Validate-then-batch per op. |
| Local-hour selection in SQL with tz database (worker.py:59-62) | High | JS `Intl` computation of zones by hour (2 #16). |
| `sync_seq` global sequence | Medium | Counter row (2.1). |
| ILIKE Unicode case-insensitivity and backslash escapes | Medium | `ESCAPE '\'`; JS-side lowercasing or shadow columns. |
| NULL ordering (PG NULLs largest) | Medium | Explicit `NULLS FIRST/LAST` (2 #22-23). |
| Collation of ORDER BY name | Medium | Confirm Neon collation (`SHOW lc_collate`), then `COLLATE NOCASE` / JS sort. |
| Timestamp storage format and precision (µs in PG) | Medium | One fixed ISO format with µs, or INTEGER epoch-µs; format output exactly like Python `isoformat()` (`+00:00`, µs omitted when 0). |
| `now()` = transaction time (ties in created_at) | Low | Tie-break by uuid7 id. |
| varchar(n)/smallint limits enforced only in PG | Medium | zod `max()` on every field matching column length, or CHECK(length()). Over-length currently ⇒ 500 (DataError), so the TS port should treat it as 500 too only if strict parity with that bug is wanted. |
| JSONB key reordering in responses | Low | Ignore; document. |
| IntegrityError ⇒ 409 mapping | Medium | Map D1 constraint error messages in `onError`. |
| Catalog-driven merge (`pg_constraint`, `ctid`) | Medium | Static FK list + `UPDATE OR IGNORE`/`DELETE`. |
| `public_key` bytea | Low | BLOB / Uint8Array; base64url helpers (`@simplewebauthn/server` handles COSE). |
| Boolean as 0/1 in raw SQL (`is_(True)`) | Low | Use Drizzle boolean mode or `= 1`. |
| Python-side `uuid7()` and `uuid4()` (account/router.py:945 import ids) | Low | npm `uuidv7` / `crypto.randomUUID()`. |
| D1 per-row/statement limits (row ≤ 2 MB; bound params ≤ 100 per query) | Low-Med | `IN (...)` lists over 100 ids (e.g. `Profile.user_id.in_(followees)` as a literal list, group member lists) must be chunked or use subqueries. |
| `refresh_tokens.parent_id` NO ACTION FK | Low | Deleting a single token row with children fails in both DBs; cascade via users is fine (SQLite deletes cascaded rows together). Keep as is. |
| D1 FK enforcement | Low | On by default; `PRAGMA defer_foreign_keys = ON` during bulk import. |

Python libs touching the DB layer and JS replacements: SQLAlchemy 2 async + asyncpg ⇒ `drizzle-orm` (`drizzle-orm/d1`) + `drizzle-kit` for migrations (or `wrangler d1 migrations`); Alembic ⇒ `wrangler d1 migrations create/apply`; `uuid.uuid7` ⇒ `uuidv7`; `zoneinfo` ⇒ built-in `Intl` (or `@date-fns/tz` / `date-fns-tz`); Redis (rate limits, user cache, `worker:tick` NX lock, worker.py:690-694) ⇒ Workers KV is eventually consistent so use a Durable Object or Cloudflare Rate Limiting binding for counters and the tick lock (Cron Triggers don't overlap if the job finishes in time, so the lock can be dropped).

---

## 5. Tests covering this area

| Test file | Notable assertions relevant to schema/DB semantics |
|---|---|
| tests/conftest.py | Truncates `users, refresh_tokens, one_time_tokens, recovery_codes, webauthn_challenges, worker_heartbeats, client_errors, auth_failures RESTART IDENTITY CASCADE` (everything else cascades from users); flushes Redis. CI also runs `alembic upgrade head` and `alembic check` (models == migrations). |
| tests/test_training.py:121 `test_single_badge_cannot_be_awarded_twice_by_a_race` | Partial unique index + `ON CONFLICT DO NOTHING` ⇒ exactly one single-tier badge row. |
| tests/test_training.py:192 `test_recompute_is_serialized_across_concurrent_calls` | `asyncio.gather` two recomputes ⇒ one level-up notification (advisory lock). |
| tests/test_admin_merge.py:26 `test_merge_moves_data_drops_self_links_and_credentials`, :64 `test_merge_refuses_itself_and_the_acting_admin` | Merge moves owned rows, drops self follows/blocks/buddies, does not move credentials, collisions keep destination row. |
| tests/test_worker.py | Heartbeat upsert (`failing_ticks` increments then resets), local-hour selection of reminders/digests, purge of trash/notifications/challenges. |
| tests/test_social.py, test_buddies.py | uq_follow_pair, ck_follow_not_self, buddy `user_a < user_b` ordering, activity upsert on `uq_activity_ref`, kudos reaction default. |
| tests/test_habits.py, test_habits_life.py, test_habit_schedule.py | habit_logs uniqueness per day, days_mask, pauses, trash restore with children. |
| tests/test_qol.py | monthly goal / rest-day upserts (ON CONFLICT … RETURNING), search ILIKE escaping, trash 409. |
| tests/test_plans.py, test_social_plans.py | training_plans ordering by started_on DESC, plan import routine name `lower()` match, plan_sessions challenge. |
| tests/test_nutrition.py | foods `uq_food_barcode`, meal entries client ids, recipes JSON items. |
| tests/test_body_data.py, test_training_depth.py, test_readiness_blocks.py | weigh_ins moments CHECK, body_metrics per-day uniqueness, photos object_key, blocks weeks/RIR checks. |
| tests/test_ops.py, test_server_errors.py | client_errors fingerprint upsert (`count+1`), IntegrityError ⇒ 409 JSON, 500 JSON body with CORS. |
| tests/test_passkeys.py | challenge consumed once (DELETE … RETURNING), expired ⇒ 400 "This passkey request expired. Try again." |
| tests/test_auth.py | one_time_tokens newest-unused lookup by (user, purpose), attempts counter; refresh token family rotation. |
| tests/test_push_ssrf.py | push_subscriptions endpoint upsert only for public https hosts. |

---

## 6. Open questions

1. **Timestamp representation**: ISO TEXT with µs (sorts correctly only if every writer uses the identical format) vs INTEGER epoch-µs (safe sorting, needs formatting on every read). Python output is `isoformat()`: does the React app parse anything beyond `Date.parse`-compatible? (Needs an app-side check.)
2. **Data migration**: is there a live-data move from Neon to D1 (needs a converter for uuid/jsonb/array/bytea/timestamptz and `sync_seq` seeding), or a fresh start?
3. **Neon collation** (`SHOW lc_collate`) decides how name ORDER BYs must be reproduced.
4. **Recompute concurrency**: Durable Object per user (adds a binding and cost) vs optimistic guard: pick one before porting game/service.py.
5. **Unicode ILIKE parity**: is ASCII-only case-insensitivity acceptable for search over habit/food/journal text?
6. Should the TS port keep PG's over-length ⇒ 500 behaviour, or reject with 422 via zod (changes behaviour slightly; the app already limits input lengths)?
