# Training (part A): port spec for Hono + Workers + D1

Scope: `app/training/{router,models,schemas,importers,lifting_import,photos,gear,pauses}.py`.
Mounted under `/v1` (`app/v1/router.py`: training_router has no prefix; gear_router prefix `/gear`; photos_router prefix `/body-photos`).

## 0. Cross-cutting conventions

| Item | Behaviour |
|---|---|
| Auth | Every route except `GET /v1/library` uses `get_current_user` (session cookie / bearer; 401 if absent). |
| Rate limiter `enforce(bucket, user_id, limit, window_s)` | Redis fixed window: key `limit:{bucket}:{user_id}`, `INCR`, `EXPIRE window` when count==1, 429 `"Slow down - try again in a little while."` when count>limit. **Fails open** on Redis error. Port: KV is not atomic; use a Durable Object counter or D1 row `UPSERT ... count=count+1 RETURNING`. |
| Errors | FastAPI shape `{"detail": "<message>"}`; Pydantic validation -> 422 `{"detail":[{loc,msg,type,...}]}` (the app may read `detail`; keep list shape for schema errors). Status 422 is `HTTP_422_UNPROCESSABLE_CONTENT`. |
| Ownership | Foreign id -> **404 "Not found"** (never 403), except body photos (409 "Pick another id"). |
| Base columns (all tables) | `id` UUID PK default **uuid7** (time-ordered; ordering by id not used here but `created_at` is), `created_at timestamptz default now()`, `updated_at timestamptz` (onupdate now). Port: generate uuid7 in JS (`uuidv7` npm), set updated_at manually on every UPDATE. |
| Dates | `datetime` serialised ISO-8601 with offset (Pydantic: `2026-10-17T10:00:00Z`/`+00:00` style; `.isoformat()` paths emit `+00:00`). `date` -> `YYYY-MM-DD`. |
| Timezone | `zone(tz)` = IANA ZoneInfo, falls back to UTC on bad name. `local_date(dt,tz)` = naive->UTC then convert to tz date. `local_today(tz)`. `week_start(day, wso)` = `day - ((weekday(day) - wso) % 7)` with Monday=0. `month_key` = `YYYY-MM`. Port: `Intl.DateTimeFormat` or `@date-fns/tz` / `Temporal` polyfill (`temporal-polyfill`). |
| `recompute(db, user_id, workout_id?, notify?)` / `snapshot` / `chain_payload` / `pause_payload` | From `app/game/service.py` (out of scope - other spec). Returns `outcome` with `.public()` and `.notification_ids`. |
| `deliver(notification_ids)` | Run as FastAPI **BackgroundTask** after response (web push). Port: `c.executionCtx.waitUntil(...)`. |
| `emit_event(db, profile, "workout", str(id), local_date, data, workout_id=)` | social feed event (app/social/service.py; out of scope). Note docstring says imports never post to feed - import path does not call it. |
| `sync_seq` | One Postgres SEQUENCE shared by every synced row; `workouts.seq` default `nextval`, bumped explicitly on update/delete. Port hazard: D1 has no sequences - keep a `sync_seq` counter table and `UPDATE sync_seq SET v=v+1 RETURNING v` inside the same batch, or use a monotonic per-user counter (cursor values only compared per user; must be strictly increasing). |

## 1. Routes

### 1.1 Library

| Method/path | Auth | Notes |
|---|---|---|
| GET `/v1/library` | none | Returns `library_payload()` (static catalogue from `library.py`, out of scope). Header `Cache-Control: public, max-age=3600`. |

### 1.2 Workouts

**WorkoutIn** (request body)

| Field | Type | Constraint / default |
|---|---|---|
| discipline | str | must be in `DISCIPLINE_IDS` ("unknown discipline") |
| title | str? | max 80; stripped, empty -> null |
| notes | str? | max 1000; stripped, empty -> null |
| started_at | datetime | must be tz-aware ("timestamps must carry a timezone offset") |
| duration_sec | int? | 0..172800 |
| distance_m | float? | 0..1_000_000 |
| elevation_m | float? | 0..20_000 |
| effort | int? | 1..10 |
| feel | int? | 1..5 |
| routine_id | UUID? | not ownership-checked for storage (stored raw); only used to bump routine.last_used_at where owned |
| tags | list[str] | max 20 items (pre-clean); non-str dropped; `clean_tags` |
| gear_id, gym_id | UUID? | silently nulled if missing/foreign |
| soreness | int? | 0..3 |
| pump | int? | 0..2 |
| avg_hr, max_hr | int? | 30..240 |
| hr_zones | list[int] | max 5; stored `[max(0,int(z)) for z][:5]` |
| splits | list[SplitIn] | max 500; SplitIn `{m:int 1..1000, sec:int 0..86400}` |
| client_updated_at | datetime | tz-aware required |
| sets | list[SetIn] | max 400 |

**SetIn**: `exercise_id` str 1..80; `position` int 0..200; `set_index` 0..100; `superset` int? 0..50 default null; `kind` in work|warmup|drop|failure default work; `weight_kg` float? 0..2000; `reps` int? 0..1000; `rpe` float? 1..10; `duration_sec` int? 0..86400; `distance_m` float? 0..1e6; `completed` bool default true.

`clean_tags(values)`: for each: `strip()`, `lstrip('#')`, lowercase, replace runs of `[^a-z0-9-]+` with `-`, strip `-` both ends, truncate 24; keep non-empty, dedupe preserving order; return first 8.

**WorkoutOut**: `id, discipline, title, notes, started_at, local_date, duration_sec, distance_m, elevation_m, effort, feel, routine_id, tags, gear_id, gym_id, soreness, pump, avg_hr, max_hr, hr_zones, splits, source, client_updated_at, deleted_at, seq, sets[]` where set = `{exercise_id, position, set_index, superset, kind, weight_kg, reps, rpe, duration_sec, distance_m, completed}` ordered by `(position, set_index)`.

| Method/path | Rate limit | Query/body | Response | Errors / side effects |
|---|---|---|---|---|
| GET `/v1/workouts` | - | `before` datetime?, `limit` int 1..100 default 30, `discipline` str?, `start` date?, `end` date? | `WorkoutOut[]` | WHERE user, deleted_at IS NULL, started_at < before, discipline =, local_date >= start, <= end; ORDER started_at DESC LIMIT. |
| GET `/v1/workouts/changes` | - | `since` int >=0 default 0, `limit` 1..500 default 200 | `{workouts: WorkoutOut[], cursor: int, more: bool}` | WHERE user AND seq > since ORDER seq LIMIT limit+1 (includes tombstones). `cursor` = last row's seq or `since` if empty. Must be declared before `/workouts/{id}`. |
| GET `/v1/workouts/{workout_id}` | - | UUID path (422 if not uuid) | `WorkoutOut` | 404 "Not found" if missing/foreign/deleted. |
| PUT `/v1/workouts/{workout_id}` | `workout-write` 240/3600 | WorkoutIn | `{workout, created, applied, outcome}` 200 | see `_apply_put`. If applied: `recompute(workout_id=)` (notify default), emit feed event, commit, background `deliver`. `outcome` null when not applied. |
| DELETE `/v1/workouts/{workout_id}` | - | query `client_updated_at` datetime? (default now) | `{applied, outcome}` 200 | `_apply_delete`; if applied `recompute(notify=False)`. Never 404 - foreign/missing -> applied:false. |
| POST `/v1/workouts/batch` | `workout-write` 240/3600 | `{ops: BatchOp[] max 200}`; BatchOp `{op: "put"\|"delete", id: UUID, workout?: WorkoutIn, client_updated_at: datetime}` | `{results: [...], outcome}` | Each op in a SAVEPOINT; HTTPException -> `{id, ok:false, status, detail}`; put -> `{id, ok:true, applied, created, workout}`; delete -> `{id, ok:true, applied}`. put without workout -> 422 "put needs a workout" (per-op). Pydantic validation errors on any op fail the whole request 422 (body-level). If any applied: recompute once with `workout_id` = the touched one if exactly one put applied else null; emit event for every applied put; commit; background deliver. Note: applied deletes contribute to `any(applied)` but not to `touched`. |
| POST `/v1/workouts/import` | `import_file` 30/3600 | multipart: `file` (required), `discipline` str?, `unit` str? | see §2.5 | 422 "Unknown discipline" if discipline not in DISCIPLINE_BY_ID; 422 "Unit is kg or lb"; parse errors -> 422 with message. Reads at most MAX_BYTES+1 bytes. |

`_apply_put(user, profile, id, body)`:
1. `now=utcnow()`. `started_at > now+10min` -> 422 "Session starts in the future". `started_at < now-30d` -> 422 "Sessions older than 30 days go through import".
2. Exercise ids: valid = library ids (`EXERCISE_BY_ID`) ∪ `custom-<uuid>` owned by user (unparseable custom uuids -> all customs treated unknown). Unknown -> 422 `"Unknown exercise: {sorted(unknown)[0]}"`. Archived customs still valid.
3. gear/gym: lookup by id; keep only if owned, else null (no error).
4. Load workout. Foreign -> 404 "Not found". Existing and `existing.client_updated_at >= body.client_updated_at` -> return (workout, created=false, applied=false) with NO writes.
5. New: insert with given id. Existing: `seq = nextval`; if it was soft-deleted, `DELETE FROM trash_items WHERE user_id, kind='workout', item_id=id`.
6. Overwrite all fields; `local_date = local_date(started_at, profile.timezone)`; `deleted_at=null`; `source` untouched (default "app" for new; an imported row edited keeps "import"); `splits = [{"m","sec"}]`.
7. Sets: delete-orphan replace - delete all existing workout_sets, insert new rows with `user_id` + SetIn fields.
8. If routine_id: `UPDATE routines SET last_used_at=now WHERE id=routine_id AND user_id=user`.
9. flush; return `seq` refreshed.

`_apply_delete(user, id, at)`: missing/foreign -> false. `workout.client_updated_at > at` -> false (note strict `>`; put uses `>=`). If not already deleted: `put_in_trash(user, "workout", id, label)` with label `"{title or discipline.title()}, {local_date ISO}"` (Python `str.title()` - e.g. "strength" -> "Strength"). Set `deleted_at=now`, `client_updated_at=at`, `seq=nextval`; `DELETE FROM activity_events WHERE workout_id=id`. true.

Feed event data (`_workout_event_data`): `{discipline, verb: DISCIPLINE.verb or "Trained", title, duration_sec, distance_m, elevation_m, set_count: count(completed && kind!='warmup'), exercises: first 4 distinct non-warmup exercise ids (in set order) mapped to names (library name or custom name, else the id), exercise_count, feel}`.

### 1.3 Exercise history

| Method/path | Query | Response | Logic |
|---|---|---|---|
| GET `/v1/exercises/last` | `ids` str (max_length 2000, required) | `{[exercise_id]: {date, sets:[{kind, weight_kg, reps, rpe, duration_sec}]}}` | split on ",", drop empties, first 40. Per id: latest non-deleted workout (by started_at DESC) of user having a completed set of that exercise; then ALL sets (completed or not, warmups included) of that exercise in that workout ORDER set_index. Missing ids omitted. N+1 queries (2 per id). |
| GET `/v1/exercises/{exercise_id}/history` | `limit` 1..200 default 30 | `{exercise_id, sessions:[{workout_id, date, sets[], best_e1rm, volume_kg, top_weight_kg}], records:[{key, value, previous, gain_pct, date, current, flagged}]}` | Join sets×workouts: set.user_id=user, exercise, workout not deleted, set.completed; ORDER started_at DESC, set_index. Group by workout preserving order. For non-warmup sets with truthy weight and reps: volume += w*r, top=max, best_e1rm=max(round(e1rm(w,r),1)) (`app.game.records.e1rm`, other spec). Initial `best_e1rm` is int 0 (JSON `0`), volume/top `0.0`. Sessions truncated to limit AFTER fetching all rows. Records: `personal_records WHERE user AND key LIKE '%:{exercise_id}' ORDER achieved_on DESC` (unescaped LIKE - `%`/`_` in id are wildcards; SQLite LIKE is case-insensitive for ASCII vs PG case-sensitive -> use `GLOB` or `substr`-based compare to preserve). |

### 1.4 Custom exercises

**CustomExerciseIn**: `name` 1..60; `pattern` in PATTERNS; `equipment` in EQUIPMENT; `primary`/`secondary` list max 6, each in MUSCLES ("unknown muscles: a, b"), deduped order-preserving; `load_type` in LOAD_TYPES default "weight"; `rest_sec` 0..900 default 90; `unilateral` default false; `cue` max 200 (not stripped).

Output `_custom_out`: `{id:"custom-<uuid>", name, pattern, equipment, primary, secondary, load_type, rest_sec, unilateral, cue, archived, custom:true, aliases:[]}`.

| Method/path | Status | Logic |
|---|---|---|
| GET `/v1/exercises/custom` | 200 | all user's (incl. archived) ORDER name (PG collation order! SQLite BINARY differs for case - consider `COLLATE NOCASE`? PG default collation en_US.UTF-8 is case-insensitive-ish; verify DB collation). |
| POST `/v1/exercises/custom` | 201 | count >= 300 -> 409 "That is a lot of custom exercises". Insert. |
| PUT `/v1/exercises/custom/{exercise_id}` | 200 | `_own_custom`: strip `custom-` prefix (removeprefix - also accepts bare uuid), parse UUID else 404; foreign -> 404. Overwrite all fields (archived untouched). |
| DELETE `/v1/exercises/custom/{exercise_id}` | 204 | If any workout_sets row (any user, unfiltered, includes soft-deleted workouts) has `exercise_id = "custom-<id>"` -> set archived=true; else hard delete. |

### 1.5 Routines

**RoutineIn**: `name` 1..60; `discipline` default "strength" in DISCIPLINE_IDS; `notes` max 500; `items` max 40 of RoutineItem; `position` int default 0 (unbounded).
**RoutineItem**: `exercise_id` 1..80; `sets` 1..20 default 3; `reps_min`,`reps_max` 0..1000?; `rest_sec` 0..900?; `target_rpe` 1..10?; `weight_kg` 0..1000?; `increment_kg` (0,50]?; `note` max 140. Stored as JSON via `model_dump(mode="json")` (all keys present, nulls included).

Output: `{id, name, discipline, notes, items, position, last_used_at ISO|null, updated_at ISO|null}`.

| Method/path | Status | Logic |
|---|---|---|
| GET `/v1/routines` | 200 | ORDER position, name |
| POST `/v1/routines` | 201 | validate item exercise ids (422 "Unknown exercise: x") BEFORE count; count>=100 -> 409 "Routine limit reached". |
| POST `/v1/routines/from-template/{template_id}` | 201 | `TEMPLATE_BY_ID` miss -> 404 "No such template". name/discipline/notes=summary/items from template; no limit check. |
| PUT `/v1/routines/{routine_id}` | 200 | own (404) then validate items; overwrite all fields (incl. position). |
| DELETE `/v1/routines/{routine_id}` | 204 | own (404); hard delete. |

### 1.6 Body metrics (private)

**BodyMetricIn** (all optional, default null): `body_fat_pct` 1..75; `waist_cm` (0,400]; `resting_hr` int 20..250; `sleep_hours` 0..24; `note` max 200; `neck_cm, shoulders_cm, chest_cm, arm_cm, forearm_cm, hips_cm, thigh_cm, calf_cm` (0,400].
Output: `{date, body_fat_pct, resting_hr, sleep_hours, neck_cm, shoulders_cm, chest_cm, waist_cm, arm_cm, forearm_cm, hips_cm, thigh_cm, calf_cm, note}` (METRIC_FIELDS order).

| Method/path | Status | Logic |
|---|---|---|
| GET `/v1/body-metrics?days=1..3650 (365)` | 200 | measured_on >= local_today - days, ORDER measured_on |
| PUT `/v1/body-metrics/{day}` | 200 | day > local_today -> 422 "That day has not happened yet"; all fields null -> 422 "Nothing to record". Upsert on (user, measured_on) (unique); overwrite ALL fields (unsent -> null). flush; `recompute(notify=True)`; commit. |
| DELETE `/v1/body-metrics/{day}` | 204 | delete by user+day, idempotent. |

### 1.7 Weigh-ins (private)

**WeighInIn**: `weighed_at` datetime; `moment` in waking|pre_workout|post_workout|bedtime|other; `weight_kg` (0,700]; `note` max 200.
Output: `{id, weighed_at ISO, date (local_date), moment, weight_kg, note}`.

| Method/path | Status | Logic |
|---|---|---|
| GET `/v1/weigh-ins?days=1..3650 (365)` | 200 | local_date >= local_today - days ORDER weighed_at |
| PUT `/v1/weigh-ins/{weigh_in_id}` | 200 | naive -> 422 "Time needs a timezone"; > now+10m -> 422 "That time has not happened yet"; < now-30d -> 422 "Weigh-ins can be backdated up to 30 days". Foreign id -> 404. Upsert by client id; `weight_kg=round(x,2)` (Python banker's rounding on float repr - use same `round` semantics; differences only at exact .xx5 binary edges). `recompute(notify=True)`. |
| DELETE `/v1/weigh-ins/{weigh_in_id}` | 204 | delete where user+id, idempotent. |

### 1.8 Chains (streaks)

**RequirementIn**: `disciplines` list 1..11 items of DISCIPLINE_IDS -> **sorted** dedupe; `days` 1..7.
**ChainIn**: `name` 1..40; `disciplines` max 11, known, dedupe order-preserving; `target` 1..7 default 3; `requirements` max 3.
**ChainPatch**: all optional: `name` 1..40, `disciplines` max 11, `target` 1..7, `requirements` max 3, `position` int.
`check_requirements(reqs, target, disciplines)`: sum(days) > target -> "The requirements add up to more days than the weekly target. Raise the target or ask for fewer days."; if disciplines non-empty, any req discipline not in chain -> "not counted by this streak: a, b" (sorted). Raised as 422 with that message.

`StreakChain.target` = last `target_history` entry's target or 3; `requirements` = last requirements_history entry's list or [].

| Method/path | Status | Logic |
|---|---|---|
| GET `/v1/chains` | 200 | `snap=snapshot(user)`; commit (snapshot may write); `{chains: [chain_payload(v, weeks=52)], repair_available: !snap.repair_used_this_month}` |
| POST `/v1/chains` | 201 `{id}` | `get_chains(profile)` (non-archived; may lazily create default "Everything") len>=6 -> 409 "Six chains is the limit"; check_requirements -> 422. `target_history=[{"from":"2000-01-03","target":t}]`; `requirements_history=[{"from": this_week ISO, "requirements":[...]}]` if any else []; `position = max(positions)+1`. No recompute. |
| PATCH `/v1/chains/{chain_id}` | 200 `{id}` | `_own_chain`: missing/foreign/**archived** -> 404. Apply name/disciplines/position. If requirements|target|disciplines sent: validate (reqs default = current requirements, target default = current, disciplines = updated chain.disciplines) -> 422. target changed -> `set_chain_target(chain, t, this_week)`; requirements changed (dict list !=) -> `set_chain_requirements(chain, new, this_week)` (profile/service.py, other spec). `recompute(notify=False)`. |
| DELETE `/v1/chains/{chain_id}` | 204 | own; if active chains <= 1 -> 409 "You need at least one streak"; `archived=true`. No recompute. |
| POST `/v1/chains/{chain_id}/repair` | 200 `{outcome}` | body `{week_start: date}`. `snapshot`; view for chain; if none or `view.result.repairable_week != week_start` -> 409 "That week cannot be repaired - one repair a month, for a missed week in the last two." Insert streak_repairs(user, chain, week_start, month=month_key(snap.today)); unique (chain,week) and (user,month) -> IntegrityError would 500 (race only). recompute(notify=False). |

### 1.9 Pauses

**PauseIn**: `starts_on` date; `ends_on` date? (inclusive; null = open); `reason` injury|illness|travel|life|other default injury; `note` max 280 (stored stripped, empty -> null).
Constants: PAUSE_MAX_DAYS 84, BACKDATE 14, LEAD 30, BUDGET_DAYS 120, BUDGET_WINDOW 365.

| Method/path | Status | Rate | Logic |
|---|---|---|---|
| GET `/v1/pauses` | 200 | - | `{pauses: [pause_payload(p, today)] ORDER starts_on, budget: {days_used, days_allowed:120}}`; commits. |
| POST `/v1/pauses` | 201 | `pause` 20/86400 | `validate(new, existing, today)` -> 409 with message. insert; recompute(notify=False); return `pause_payload(pause, today)` (has `active`, `id`, `ends_on`, `reason`...; defined in game/service). |
| POST `/v1/pauses/{pause_id}/end` | 200 | - | own (404). `effective_end < today` -> 409 "That pause has already ended". `end_date_for`: starts_on >= today -> delete row; else `ends_on = min(today-1, effective_end)`. recompute; commit; return pause state (same as GET). |
| DELETE `/v1/pauses/{pause_id}` | 204 | - | own (404). If `starts_on <= today` AND created_at < now-24h -> 409 "A pause that has started can be ended, not deleted". delete; recompute(notify=False). |

Pure rules (`pauses.py`):
- `effective_end = ends_on is None ? starts_on+83d : min(ends_on, starts_on+83d)`.
- `days()` = every date starts_on..effective_end inclusive. `overlaps`: `a.start <= b.eff_end && b.start <= a.eff_end`.
- `days_used(spans, today)` = |union of days| with d >= today-364 (future planned days counted).
- `validate`: start < today-14 -> "A pause can start at most 14 days ago."; start > today+30 -> "A pause can be planned at most 30 days ahead."; ends_on < starts_on -> "A pause cannot end before it starts."; (end-start)+1 > 84 -> "One pause can last at most 12 weeks."; overlap any -> "That overlaps a pause you already have."; days_used(existing+new) > 120 -> "Pauses are limited to 120 days a year. Set an end date, or end an earlier pause sooner." (checks in this order).

### 1.10 Gear (`/v1/gear`)

**GearIn**: `name` 1..60 (stored stripped); `kind` shoes|bike|other default shoes; `default_for` list max 11 known disciplines deduped; `limit_km` (0,100000]?; `initial_km` 0..100000 default 0; `note` max 200 (stripped, empty->null).
**GearPatch**: all optional; `limit_km` and `note` applied only if present in JSON (`model_fields_set`) - explicit `null` clears; others applied only when non-null; `retired` bool.

Output: `{id, name, kind, default_for, limit_km: round(limit_m/1000,1)|null, initial_km: round(initial_m/1000,1), distance_m: round(initial_m+logged,1), sessions, last_used: ISO date|null, worn: round(total/limit_m,3)|null, retired: bool, retired_at: ISO|null, note}`.
Usage: `SELECT gear_id, COALESCE(SUM(distance_m),0), COUNT(*), MAX(local_date) FROM workouts WHERE user_id=? AND deleted_at IS NULL AND gear_id IS NOT NULL GROUP BY gear_id`.

| Method/path | Status | Logic |
|---|---|---|
| GET `/v1/gear` | 200 | ORDER `(retired_at IS NOT NULL)`, created_at (active first). |
| POST `/v1/gear` | 201 | count >= 30 -> 409 "30 items is the limit. Delete a retired one first."; `limit_m = limit_km*1000 if truthy`; `initial_m = initial_km*1000`; insert; `_claim_defaults`; returns with usage None (0, 0, null). |
| PATCH `/v1/gear/{gear_id}` | 200 | own (404). Apply; `retired:true` -> retired_at=now (re-sets timestamp even if already retired), false -> null; if retired after apply -> default_for=[]; `_claim_defaults`; return with fresh usage. |
| DELETE `/v1/gear/{gear_id}` | 204 | own; delete; FK `ON DELETE SET NULL` nulls workouts.gear_id (D1: needs `PRAGMA foreign_keys=ON` - D1 enforces FKs by default - and FK declared; else explicit UPDATE). |

`_claim_defaults(gear)`: if gear.default_for non-empty, for each other gear of user remove disciplines in gear.default_for.

### 1.11 Body photos (`/v1/body-photos`, R2 presigned)

ALLOWED_TYPES magic: `image/jpeg`->`FF D8 FF`, `image/webp`->`RIFF`, `image/png`->`89 50 4E 47`. Key: `body-photos/{user_id}/{photo_id}`. MAX 500 photos, 2 MiB each. **PhotoIn** `{date, pose: front|side|back, content_type: str}`.
`_check`: content_type not allowed -> 415 "Send a JPEG, WebP or PNG"; `date > local_today + 1 day` -> 422 "That day has not happened yet"; existing foreign -> 409 "Pick another id".
Output `{id, date, pose, size}`.

| Method/path | Status | Rate | Logic |
|---|---|---|---|
| GET `/v1/body-photos` | 200 | - | ORDER taken_on DESC, created_at DESC. |
| GET `/v1/body-photos/{photo_id}` | 200 `{url, expires_in:60}` | - | 404 if not owner. Presigned GET 60s with `ResponseCacheControl=private, no-store` and ResponseContentType = content_type (check storage.py). |
| POST `/v1/body-photos/{photo_id}/upload` | 200 `{upload_url, expires_in:300}` | `body-photo` 60/3600 | `_check`; new id and count>=500 -> 409 "You have 500 photos backed up. Delete some old ones first."; presigned PUT 300s signing Content-Type; StorageUnavailable -> 503 "Photo backup is temporarily unavailable". No DB write. |
| POST `/v1/body-photos/{photo_id}/upload/complete` | 200 | - | `_check`; `verify_upload`: HEAD (missing -> 400 "Upload it first"); size > 2 MiB -> delete obj, 413 "That photo is too large"; ranged GET first len(magic) bytes, mismatch -> delete, 415 "Not the image type it claims". Upsert row (taken_on, pose, content_type, size, object_key). |
| DELETE `/v1/body-photos/{photo_id}` | 204 | - | not owner -> 204 silently; delete row, commit, then delete R2 object. |
| DELETE `/v1/body-photos` | 204 | - | delete all rows, then batch delete R2 keys. |

Port: native R2 binding gives head/get(range)/delete; presigned URLs still need S3 SigV4 -> `aws4fetch` (`AwsClient.sign` with `X-Amz-Expires`, `signQuery:true`). Keep the R2 S3 credentials as Worker secrets.

## 2. Import algorithms

### 2.1 Dispatch (`POST /v1/workouts/import`)
1. enforce; validate discipline; `data = read(MAX_BYTES+1)` (15 MiB+1); load profile; validate unit.
2. If filename lower endswith `.csv` AND `is_lifting_csv(data)` -> lifting path (§2.6) with `unit or profile.weight_unit`.
3. Else `parse(filename, data, profile.timezone, discipline)`: >15 MiB -> "That file is larger than 15 MB."; empty -> "That file is empty."; `sniff`: name `.fit` or `data[8:12]==".FIT"` -> fit; `.gpx` or `b"<gpx"` in first 2048 bytes -> gpx; `.csv` -> csv; else "Upload a .gpx, .fit or .csv file.". >5000 sessions -> "One upload can hold at most 5000 sessions.".
4. `max_hr = profile.max_hr or (220-(now.year-birth_year) if birth_year)`.
5. For sessions sorted by started_at: `check(session, now)` -> problem `"Session on {started_at.date() ISO} {reason}."` (date in the session's own offset). Reasons: "starts in the future" (>now+10m), "is dated before 1990", "has an implausible duration" (not 0..172800), "has an implausible distance" (not 0..1e6).
6. id = **uuid5**(NS `6f1c2a52-6b8e-4c0e-9d7e-3a1f5b8c9e01`, `"{user_id}:{discipline}:{started_at.astimezone(UTC).isoformat()}"`). The isoformat string must match Python exactly: `2026-05-01T07:00:00+00:00`, microseconds `.ffffff` only if non-zero (6 digits). Port with `uuid` npm `v5`.
7. Duplicate if any non-deleted workout of user (ANY discipline) with started_at within ±3 min (BETWEEN inclusive) OR existing row by id not deleted -> `duplicates++`.
8. Else upsert (reviving soft-deleted row with new seq; note trash item NOT removed here): fields from session, `hr_zones = zone_seconds(hr_samples, max_hr)` if both else [], `source="import"`, `client_updated_at=now`, `sets=[]`, routine/gear/gym/tags unchanged for revived row (new row defaults: tags [], gear null). flush per session.
9. If imported>0 `recompute(notify=False)`. No feed event, no deliver.
Response: `{format: "gpx"|"fit"|"csv", found: len(sessions), imported, duplicates, problems: first 50, more_problems: max(0, n-50)}`.

### 2.2 GPX (`defusedxml.ElementTree`)
- Parse failure -> "That GPX file could not be read."; root local-name != "gpx" -> "That isn't a GPX file." Namespaces ignored (match by local name after `}`).
- Per `trk` (1-based index): points from `trkseg/trkpt`: lat/lon float attrs, `ele` text float or null, `time` via `_iso` (`Z`->`+00:00`, Python `fromisoformat`; naive -> UTC). HR: first descendant (incl. self, depth-first) whose local name is `hr` -> `int(float(text))`, sample only if time present. Any TypeError/ValueError skips the point entirely.
- No timed points -> problem "Track {i} has no timestamps, so it can't be dated."
- distance = sum haversine over consecutive points (R=6_371_000). track_points = (cumulative distance, time) for timed points.
- Elevation gain: `pending=max(0,pending+(b-a))`; when pending >= 3.0: climb += pending, pending=0.
- start/end = first/last timed point; duration = max(0, int(seconds)).
- discipline = form discipline or `discipline_for(<type>, default=_guess_from_speed)`: kmh<6.5 walk, <17 run, else ride; no dist/dur -> other.
- Session: duration or null if 0; distance round(,1) or null if 0; elevation round(climb,1) if any elevations else null; title `<name>`[:80] or null; splits = km_splits; avg/max = hr_summary.
- No sessions and no problems -> "The file has no tracks."
- Port: `fast-xml-parser` or `@xmldom/xmldom` (no DTD/entity expansion: reject `<!DOCTYPE`/`<!ENTITY` explicitly to mirror defusedxml, test `test_gpx_entity_expansion_is_refused`). `fromisoformat` parity: Python 3.11+ accepts many ISO variants; write a strict ISO parser.

### 2.3 FIT (`fitdecode`)
- Iterate data frames. `record`: timestamp + heart_rate -> beats; timestamp + distance -> records (naive -> UTC).
- `session`: start_time required else problem "A session in the file has no start time."; elapsed = `total_timer_time or total_elapsed_time`; window = [start, start+elapsed+60s]; HR from beats in window via hr_summary, overridden by `avg_heart_rate`/`max_heart_rate` fields if truthy; discipline = form or `discipline_for(sub_sport, sport)` (fitdecode yields enum strings like "running", "trail_running", "generic"). duration int(elapsed) or null; distance float or null if falsy; elevation total_ascent or null; splits from records in window. Records/beats must precede the session message (FIT writes session at end - standard).
- FitError: if no sessions -> "That FIT file could not be read."; else problem "The file ended early; sessions before that point were read." No sessions & no problems -> "The file has no sessions in it."
- CRC errors in fitdecode default to raising (check_crc) -> FitError.
- Port: `fit-file-parser` (npm, pure JS; options `mode:'list'`, `speedUnit:'m/s'`, `lengthUnit:'m'`, `elapsedRecordField`) or `@garmin/fitsdk` (official Garmin JS SDK, ESM, works in Workers). Prefer `@garmin/fitsdk` (`Decoder`, `Stream.fromByteArray`) - sport/subSport come as camelCase strings ("trailRunning"), so normalise camelCase -> snake_case before `discipline_for`. Verify field units (distance m, timer time s) and that timestamps are Date (UTC).

### 2.4 Generic CSV
- Decode `utf-8-sig` (strip BOM; invalid -> "CSV files need to be UTF-8."). Comma only. Headers normalised `strip().lower()`, spaces and `-` -> `_`. No header -> "That CSV file has no header row."; no date alias -> "The CSV needs a 'date' column."
- Column aliases (first non-empty wins, in order):

| field | aliases |
|---|---|
| date | date, started_at, start, start_time, activity_date, datetime |
| discipline | discipline, type, activity_type, sport, activity |
| duration | duration, elapsed_time, moving_time, time |
| duration_min | duration_min, duration_minutes, minutes |
| distance_km | distance_km, km, distance |
| distance_mi | distance_mi, miles |
| distance_m | distance_m, metres, meters |
| elevation_m | elevation_m, elevation, elevation_gain, ascent |
| title | title, name, activity_name |
| notes | notes, description, comment |
| effort | effort, rpe |
| feel | feel |

- Per row (line starts 2): if `line-1 > 5000` -> raise whole-file error. `_number`: remove all `,` then float (Python float accepts "1e3", " inf", "nan", "1_000"!). `_duration`: with ":" split floats, left-pad to 3, h*3600+m*60+s int; else int(float). duration_min * 60 fallback. distance precedence: m, then km*1000 overrides, then mi*1609.344 overrides. effort int if 1..10 else null; feel int if 1..5 else null. title[:80], notes[:1000].
- `_when(value, tz)`: try `fromisoformat` (Z->+00:00); on fail date(value[:10]) at 12:00; if len(value) <= 10 -> force 12:00 local; naive -> tz.
- Any ValueError/KeyError -> "Row {line} could not be read." Python's csv DictReader: short rows yield None values (`_pick` handles), extra values go under key None.
- Port: `papaparse` (handles quotes/newlines in fields; Python `csv` quirks: `\r\n`, quoted). Note `float("nan")` passes in Python -> check() comparisons with NaN all False -> NaN distance would be stored! Mirror or document.

### 2.5 Shared helpers
- `discipline_for(*names, default="other")`: first name whose `strip().lower()`, `-`/space -> `_` is in ALIASES (table in importers.py lines 37-91, copy verbatim).
- `hr_summary(samples)`: keep 30<=bpm<=240, sort by (time,bpm); none -> (null,null); one -> (b,b); else time-weighted: dt=clamp(t2-t1, 0, 30s), weighted += b1*dt; avg = round(weighted/total) if total else round(mean). Python `round` is banker's (round half to even) - port with a half-even helper.
- `zone_seconds(samples, max_hr)`: same filter/sort; per pair dt clamp 0..30; share=b1/max_hr; zone = count(floors<=share)-1 with floors (0.5,0.6,0.7,0.8,0.9); zone>=0 -> out[zone] += round(dt) (half-even).
- `km_splits(track)`: drop null; <2 pts or span<100m -> []. mark=base+1000; for consecutive pairs, while `d1 >= mark > d0` and len<500: frac=(mark-d0)/(d1-d0) (0 if d1<=d0), cross=t0+(t1-t0)*frac, push {m:1000, sec: round(cross-last_cross)}, last=cross, mark+=1000. remainder = last_d - (mark-1000); if >=50 push {m: round(remainder), sec: round(last_t - last_cross)}. Note: timedelta*float in Python rounds to microseconds.

### 2.6 Lifting CSV (Strong / Hevy / FitNotes)
- `is_lifting_csv`: first 4096 bytes decoded utf-8-sig ignore errors; first line; delimiter `;` if count(';')>count(',') on header line; `detect(headers)`.
- `_norm(h)` = lowercase, `[^a-z0-9]+` -> `_`, strip `_`. `detect`: {exercise_name,set_order} ⊆ h -> strong; {exercise_title,set_index} ⊆ h and start_time -> hevy; exercise & category & (weight_kgs|weight_lbs) -> fitnotes.
- `parse_lifting(data, tz, unit)`: utf-8-sig; delimiter from first 4096 chars of whole text (count of ; vs , - differs from is_lifting_csv's header-only heuristic); unknown format -> "That isn't a Strong, Hevy or FitNotes export." ; no header -> "That CSV file has no header row."; line > 100000 -> "One upload can hold at most 100000 rows.". LB=0.45359237.
- `_num`: strip; if exactly one "," and no "." -> comma is decimal; else remove commas; empty/invalid -> null. `_int` = round(n) half-even. `_duration`: `[\d:.]+` with ":" -> h:m:s; else regex `(\d+(?:\.\d+)?)\s*([hms])` sum; else _num int.
- `_when(value,tz,fmt)`: Hevy format `%d %b %Y, %H:%M` (English month abbrev, case-insensitive in strptime) when matches `^\d{1,2} \w{3} \d{4},`; else ISO/date logic as §2.4.
- `_kind`: w/warmup/warm_up/warm-up -> warmup; d/dropset/drop_set/drop -> drop; f/failure -> failure; else work.
- Strong: key=started (date col); set: weight*to_kg (to_kg LB if unit=="lb"), reps, rpe, seconds, distance*1000 if truthy; title=workout_name, notes=workout_notes, duration=_duration(duration).
- Hevy: weight_kg if present non-empty else weight_lbs*LB; distance_km else distance_miles*1.609344 (km), *1000; superset_id+1; duration = end-start seconds (>0) else null; end parse ValueError -> null.
- FitNotes: date[:10] at 12:00 local, key=day; weight_kgs else weight_lbs*LB; distance*factor(distance_unit: km 1000, m 1, mi/miles 1609.344, ft 0.3048, default 1000); time via _duration; no title/notes.
- Row errors (KeyError/ValueError) -> "Row {line} has a date or number that couldn't be read."; empty name -> "Row {line} has no exercise name."; weight not 0..1000 -> "Row {line} has an implausible weight."; reps not 0..1000 -> "...implausible number of reps."; rpe outside 1..10 -> null.
- Session created on first row of key: title strip[:80], notes strip[:2000], duration if <=172800. Max 400 sets/session (extra silently dropped). set_index = per-session per-name counter. Sessions sorted by started_at.

Router `_import_lifting`: size > 15 MiB -> 422; LiftingFormatError -> 422; >5000 sessions -> 422. Exercise resolution per distinct raw name (cached): `match_exercise(name, library)` else existing custom by `name.strip().lower()[:60]` else create custom (limit: existing customs + created >= 300 -> **409** "This file has more new exercises than your custom-exercise limit (300)." - raised mid-loop, rolls back whole request) with `guess_pattern`, secondary [], load_type weight, rest 90, unilateral false, cue "Imported - edit it to set the muscles and cue." Session skip: started_at > now+10m or year<1990 -> "Session on {date} has an impossible date.". id = uuid5(NS, `"{user}:strength:{utc iso}"`). Duplicate: existing non-deleted by id OR non-deleted **strength** workout within ±3 min. Sets: `position` = first-seen order of exercise in session; kind sanitised; weight round(,3); completed true. Workout: discipline strength, distance/elevation null, source import, client_updated_at now, other fields (effort, feel, splits, hr...) untouched/defaults. Response adds `sets` (count) and `new_exercises` (names, first 50).

`match_exercise` / `split_name` / `_strip_equipment` / `guess_pattern`: copy verbatim (lifting_import.py 302-472). Key = lowercase, non-alnum -> space, collapse. Index over library `name` + `aliases`. Order: whole key hit -> bracket-swapped "(tag) base" hit -> equipment-aware stem search (stems: base, SYNONYMS[base] stripped, singular synonyms); variants: "{prefix equipment} stem" (smith -> "smith machine"), stem, SYNONYMS.get(stem,""); when equipment known, only hits with same equipment (else None). `_strip_equipment` iterates EQUIPMENT_WORDS by length DESC (stable sort on dict insertion order for ties) using `\b` regex; drops FILLER words. `guess_pattern` substring test on `f"{base} "`.

## 3. Tables

| Table | Columns (beyond id/created_at/updated_at) | Indexes / constraints | Postgres-only bits |
|---|---|---|---|
| workouts | user_id FK cascade, discipline varchar20, title80, notes1000, started_at tstz, local_date date, duration_sec int, distance_m float, elevation_m float, effort/feel/soreness/pump/avg_hr/max_hr smallint, hr_zones JSONB default [], routine_id uuid (no FK), tags JSONB, splits JSONB, gear_id FK gear SET NULL, gym_id FK gyms SET NULL, source varchar10 default 'app', client_updated_at tstz, deleted_at tstz, seq bigint default nextval(sync_seq) | ix (user_id,local_date), (user_id,seq), user_id, gear_id, gym_id; CHECKs effort 1-10, feel 1-5, duration>=0, distance>=0, soreness 0-3, pump 0-2 | JSONB, sequence, timestamptz. In SQLite store timestamps as ISO UTC text with fixed format (lexical comparisons for `<`, BETWEEN must be consistent) or epoch ms integer. |
| workout_sets | workout_id FK cascade, user_id FK, exercise_id80, position, set_index, superset smallint, kind8 default work, weight_kg, reps, rpe, duration_sec, distance_m, completed bool | ix workout_id, (user_id, exercise_id); CHECK kind/reps/weight/rpe | |
| custom_exercises | user_id, name60, pattern20, equipment20, primary JSONB, secondary JSONB, load_type12, rest_sec, unilateral, cue200, archived | ix user_id | `primary` is a reserved word in SQLite too - quote it. |
| routines | user_id, name60, discipline20, notes500, items JSONB, position int, last_used_at | ix user_id | |
| body_metrics | user_id, measured_on date, 13 metric cols, note | UNIQUE(user_id, measured_on) | |
| body_photos | user_id, taken_on, pose8, content_type32, object_key255 UNIQUE, size | | |
| weigh_ins | user_id, weighed_at, local_date, moment16, weight_kg, note | CHECK moment; ix (user_id, local_date) | |
| streak_chains | user_id, name40, disciplines JSONB, target_history JSONB, requirements_history JSONB, position, archived | | |
| streak_repairs | user_id, chain_id FK cascade, week_start, month7 | UNIQUE(chain_id,week_start), UNIQUE(user_id,month) | |
| streak_pauses | user_id, starts_on, ends_on?, reason10, note280 | CHECK reason, CHECK ends_on>=starts_on; ix (user_id, starts_on) | |
| gear | user_id, name60, kind10, default_for JSONB, limit_m float, initial_m float, retired_at, note200 | CHECK kind, limit_m>0 | |
| Also touched | trash_items (delete on revive; insert via put_in_trash), activity_events (delete by workout_id; insert via emit_event), profiles (timezone, week_starts_on, weight_unit, max_hr, birth_year), personal_records (history read), gyms (ownership lookup) | | |

Other models defined in models.py but used elsewhere (other specs): training_blocks, readiness, week_reflections, gyms, exercise_notes, weight_goals, training_plans (FK challenges, users), monthly_goals, rest_days. CHECKs: block weeks 3-8, rir 0-5; readiness 1-5; monthly_goal days 1-31; rest_day kind in rest|sleep|mobility|sick; UNIQUEs (user,day), (user,week_start), (user,exercise_id), weight_goals user_id unique, (user,month).

## 4. Porting hazards

| Hazard | Detail | Replacement |
|---|---|---|
| FIT parsing | `fitdecode` (Python) | `@garmin/fitsdk` (official) or `fit-file-parser`; normalise sport enum names to snake_case; reproduce FitError -> partial-results semantics (SDK returns `errors[]`). |
| XML (GPX) safety | `defusedxml` | `fast-xml-parser` (`processEntities:false`, reject DOCTYPE) or `@xmldom/xmldom` + manual DOCTYPE rejection. Namespace-agnostic local-name matching. |
| CSV | stdlib `csv` | `papaparse` (sync string parse). Mirror `DictReader` None-for-missing semantics and delimiter heuristics. |
| uuid5 import ids | deterministic id must equal Python's for re-import idempotency against data migrated from PG | `uuid` npm `v5(name, NS)`; exact Python `isoformat()` string (+00:00, micros only when non-zero). |
| uuid7 PKs | `uuid.uuid7` | `uuidv7` npm or `uuid@10+` `v7`. |
| `sync_seq` sequence | PG sequence shared across tables | D1 counter table updated in the same `db.batch()`; strictly increasing. |
| SAVEPOINT per batch op | `db.begin_nested()` | D1 has no interactive transactions / savepoints. Validate each op fully in JS first, then build statements; apply per-op `batch()` (each batch is atomic) and do recompute afterwards. Lose cross-op atomicity (acceptable since ops are independent). |
| Transactions generally | flush + recompute + commit in one tx | D1 `batch()` only; recompute reads must see the writes -> write first then recompute then write results. |
| Rate limit | Redis INCR/EXPIRE, fail-open | Durable Object or D1 counter; KV is eventually consistent. |
| BackgroundTasks `deliver` | after response | `executionCtx.waitUntil`. |
| R2 | boto3 presign + head/range get/delete in thread | `aws4fetch` for presigned PUT/GET (signed `response-cache-control`, content-type); R2 binding for `head`, `get(key,{range:{offset:0,length:n}})`, `delete([...])`. |
| File upload size | `file.read(MAX_BYTES+1)` | Workers request body limit 100 MB (free/pro) fine; but parsing 15 MB GPX/FIT and up to 5000 sessions with per-session DB queries (2 SELECT + upsert each) is CPU/subrequest heavy: free plan 10 ms CPU, paid 30 s default; D1 queries per invocation limited (1000 on paid / 50 free). **5000 sessions x ~3 queries exceeds limits** - batch: preload user's workout started_at ranges + ids in one query, dedupe in memory, then insert via chunked `batch()`. Same for lifting import (custom exercise creation). |
| JSONB | hr_zones, tags, splits, items, primary/secondary, default_for, histories | SQLite TEXT with `json` mode in Drizzle (`text(..., {mode:'json'})`). |
| timestamptz comparisons | `started_at < before`, `BETWEEN ±3min`, `seq > since` | store UTC ISO with fixed millisecond/microsecond width, or integer epoch ms; precision: PG keeps microseconds; client_updated_at LWW compares `>=` - microsecond precision matters if clients send micros. Use integer microseconds or fixed-width text. |
| LIKE `%:{id}` | personal_records history | SQLite LIKE is ASCII case-insensitive; use `substr(key, -len) = ':'||id` or GLOB. |
| ORDER BY name | custom exercises, routines | collation differences PG vs SQLite BINARY. |
| Python `round` | half-to-even, plus float formatting | implement `roundHalfEven(x, nd)`; Python round on floats uses correctly-rounded decimal repr - for ndigits use `Number(x.toFixed())` carefully. |
| Python float() leniency | accepts "nan", "inf", "1_000", whitespace | decide; tests don't cover. |
| `str.title()` in trash label | "strength" -> "Strength", "e_bike"? -> "E_Bike" | implement Python title semantics (capitalise after non-letter). |
| N+1 in `/exercises/last` | up to 80 queries | single query with window function (SQLite supports `ROW_NUMBER()`). |
| CPU | haversine over large GPX, km_splits, regex matching per name over ~library | fine on paid plan; may exceed 10 ms free-tier CPU. |
| Workout relationship `delete-orphan` | replace sets | explicit `DELETE FROM workout_sets WHERE workout_id=?` then inserts. |
| FK ON DELETE SET NULL / CASCADE | gear/gym delete, workout delete | D1 enforces FKs (`foreign_keys` on by default); declare in schema. |
| No filesystem | none used (photos via R2) | - |

## 5. Tests covering this area

| File | Tests / notable assertions |
|---|---|
| tests/test_training.py | foreign workout PUT/GET -> 404; unknown exercise & +1 day -> 422; changes feed includes tombstone with deleted_at and cursor delta; batch `[ok True, False]`, outcome non-null, list len 1; stats/records + `/exercises/{id}/history` 2 sessions + `/exercises/last` weight 104; chains: default "Everything", create 201, patch target 4, order preserved, repair with no missed week 409; custom exercise + routine + body metrics; weigh-ins several/day private & owned; export/import roundtrip; chain requirements validate & progress; tags normalised & private; gear mileage follows log; foreign gear dropped not linked; export carries tags/gear. |
| tests/test_lifting_import.py | Strong grouping/name mapping/unknown -> custom; Strong lb conversion; Hevy set types, supersets (+1), duration; FitNotes per-day in lb; plain activity CSV uses old importer. |
| tests/test_features.py | pause pure rules, budget bound, ending; pause lifecycle (201, active, overlap 409, end -> ends_on = today-1); pauses private; GPX parser; **GPX entity expansion refused**; CSV units/durations/bad rows; import endpoint idempotent & `source=import`. |
| tests/test_training_depth.py | km_splits interpolation + remainder; sparse samples; too short -> []; GPX import splits; supersets & splits survive client edit. |
| tests/test_readiness_blocks.py | GPX heart rate & zones; imported run carries hr zones. |
| tests/test_body_data.py | photo backup: upload URL, complete 200, retry replaces, other user 404 on GET and 409 on upload/complete, wrong magic 415 and object removed; (uses `fake_storage` fixture). |
| tests/test_qol.py | deleted workout restores and syncs; re-saving workout clears trash entry. |
| tests/test_engine.py | repair counts missed week; repairable week offered only when available (game engine). |
| tests/conftest.py | fixtures (`client`, `person`, `bearer`, `fake_storage`). |

## Open questions
1. Must import ids (uuid5) stay byte-identical to PG-era rows? (Yes if data migrates - then match Python isoformat exactly.)
2. Timestamp storage format in D1 (epoch micros vs ISO text) - affects LWW `>=`, `BETWEEN`, ordering.
3. Batch op atomicity without savepoints - acceptable to apply each op as its own D1 batch?
4. Large imports vs Workers CPU/subrequest limits - which plan? May need Queues for 5000-session files (but response is synchronous today; app expects counts in the response).
5. FIT library choice must yield same sport strings, same `total_timer_time` fallback and partial-read semantics.
6. Rate limiter backend (DO vs D1).
