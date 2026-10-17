# Spec: account / trash / profile (incl. export, import, iCal, deletion, reserved handles)

Source files (read in full): `app/account/{router,service,calendar,backup,models}.py`,
`app/trash/{router,service,models}.py`, `app/profile/{router,service,models,reserved}.py`.
All routers are included into `app/v1/router.py`, mounted at `/v1`.

Conventions used below:
- "auth" = `get_current_user` (bearer or session cookie; may be a cached, transient User).
  "auth-db" = `get_current_db_user` (re-reads User from DB; needed for `hashed_password`).
- Errors are FastAPI `HTTPException` → body `{"detail": "<message>"}`. Pydantic body
  validation errors → 422 with FastAPI's `{"detail":[{type,loc,msg,input,...}]}` list format.
- Rate limit `enforce(bucket, subject, limit, window_s)`: Redis fixed window, key
  `limit:{bucket}:{subject}`, `INCR`, `EXPIRE` set only when count==1; count>limit → 429
  `"Slow down - try again in a little while."`. **Fails open** on Redis error.
- `get_profile(user_id)` **lazily creates** the profile row (avatar_hue = random int 0..359,
  all other defaults) on every route that calls it, including GETs. `get_chains` lazily creates
  the default chain `{"name":"Everything","disciplines":[],"target_history":[{"from":"2000-01-03","target":3}],"position":0}`.
- Timestamps serialised with Python `isoformat()` → `2026-10-17T09:12:33.123456+00:00`
  (microseconds, `+00:00` not `Z`; microseconds omitted when 0). Dates `YYYY-MM-DD`.
  **Port must reproduce this format** (JS `toISOString()` gives `...123Z`).

---

## 1. Routes (17)

| # | Method | Path | Auth | Rate limit | Success |
|---|---|---|---|---|---|
| 1 | GET | `/v1/me` | auth | – | 200 |
| 2 | POST | `/v1/me/onboarding` | auth | – | 200 |
| 3 | POST | `/v1/me/terms` | auth | – | 200 |
| 4 | PATCH | `/v1/me/profile` | auth | – | 200 |
| 5 | GET | `/v1/handles/{handle}` | auth | – | 200 |
| 6 | GET | `/v1/me/export?format=json\|csv\|ics` | auth | `export`, user.id, 20/3600s | 200 file |
| 7 | POST | `/v1/me/import` (multipart `file`) | auth | `import`, user.id, 5/3600s | 200 |
| 8 | POST | `/v1/me/delete` | **auth-db** | – | 200 |
| 9 | POST | `/v1/me/delete/cancel` | auth | – | 200 |
| 10 | GET | `/v1/me/security-events` | auth | – | 200 |
| 11 | GET | `/v1/me/calendar` | auth | – | 200 |
| 12 | POST | `/v1/me/calendar` | auth | `calendar_rotate`, user.id, 10/3600s | **201** |
| 13 | DELETE | `/v1/me/calendar` | auth | – | 204 |
| 14 | GET | `/v1/calendar/{token}.ics` | **none** (token is credential) | `calendar_feed`, sha256(token)[:16], 120/3600s | 200 |
| 15 | GET | `/v1/trash` | auth | – | 200 |
| 16 | POST | `/v1/trash/{trash_id}/restore` | auth | – | 200 |
| 17 | DELETE | `/v1/trash/{trash_id}` | auth | – | 204 |
| 18 | DELETE | `/v1/trash` | auth | – | 204 |

(18 rows; route 14 is `include_in_schema=False`.)

### 1. GET /v1/me
Response:
```json
{ "user": {"id","email","is_verified","role" (enum value string),"totp_enabled"},
  "profile": ProfileOut,
  "needs_onboarding": onboarded_at is null,
  "needs_terms": onboarded_at != null && accepted_terms_version != settings.terms_version,
  "terms_version": settings.terms_version  (default "2026-10-02"),
  "social_allowed": profile.social_allowed(utc year),
  "min_age": 13, "social_min_age": 16,
  "unread_notifications": count(notifications where user_id and read_at is null),
  "follow_requests": count(follows where followee_id=user and status='pending'),
  "push_public_key": vapid_public_key() (from notifications module) }
```
Side effects: may create profile (commit).

**ProfileOut** (`profile_out`) keys, in order: handle, display_name, official (=is_official), bio,
avatar_hue, timezone, week_starts_on, weight_unit, distance_unit, training_days, max_hr,
life_target, favourite_disciplines, onboarded_at (iso|null), birth_year, onboarded (bool),
visibility, sharing_paused, gamification_enabled, leaderboard_opt_in, social_suspended
(=social_suspended_at != null), deletion_scheduled_at (iso|null), reminder_hour, reminder_mode,
learned_reminder_hour, quiet_start, quiet_end, quiet_days.

**social_allowed(year)**: birth_year != null && year-birth_year >= 16 && social_suspended_at null
&& deletion_scheduled_at null && onboarded_at != null.

### 2. POST /v1/me/onboarding
Body `OnboardingIn`:
| field | type | constraint | default |
|---|---|---|---|
| handle | str | len 3..31 | required |
| display_name | str? | max 50 | null |
| birth_year | int | 1900..2100 | required |
| accept_terms | bool | | required |
| timezone | str | | "UTC" |
| week_starts_on | int | 0..6 | 0 |
| weight_unit | str | `^(kg\|lb)$` | "kg" |
| distance_unit | str | `^(km\|mi)$` | "km" |
| weekly_target | int | 1..7 | 3 |
| visibility | str | `^(private\|followers\|public)$` | "followers" |

Order of checks:
1. `!accept_terms` → 422 "Please accept the terms"
2. `utcYear - birth_year < 13` → 403 "PaceStreak is for people aged 13 and over."
3. timezone not in IANA set (`zoneinfo.available_timezones()`) → 422 "Unknown timezone"
4. `_check_handle` (see §2) → 422 / 409 "That handle is reserved"
5. handle held by another user → 409 "That handle is taken"
6. get_profile; `check_display_name` → 409 "Display names can't use the PaceStreak name" (if name non-empty, not official, mentions_brand)
Writes: handle, display_name = trimmed or null, birth_year, accepted_terms_at=now,
accepted_terms_version=settings.terms_version, timezone, week_starts_on, units,
visibility = body.visibility if age>=16 else "private", onboarded_at = existing or now.
Main chain (chains[0]) `target_history` **replaced** with `[{"from":"2000-01-03","target":weekly_target}]`.
Then `recompute(db, user, notify=False)` (game engine, out of scope). Response `{"profile": ProfileOut}`.
Note: does NOT record a security event; re-onboarding allowed (no guard).

### 3. POST /v1/me/terms
Body `{version: str max 20}`. version != settings.terms_version → 409 "The terms changed again. Reload and review them."
Writes accepted_terms_at=now, accepted_terms_version; security event `terms_accepted` meta `{"version": ...}`.
Response `{"accepted": terms_version}`.

### 4. PATCH /v1/me/profile
Body `ProfilePatch`, all optional, **exclude_unset semantics** (absent ≠ null):
| field | constraint |
|---|---|
| handle | str max 31 |
| display_name | str max 50, stripped (validator runs after length check) |
| bio | str max 160, stripped |
| avatar_hue | 0..359 |
| timezone | str |
| week_starts_on | 0..6 |
| weight_unit | `^(kg\|lb)$` |
| distance_unit | `^(km\|mi)$` |
| training_days | 0..127 |
| max_hr | 100..230 |
| life_target | 1..7 |
| favourite_disciplines | list[str], max 20 items (items not validated) |
| visibility | `^(private\|followers\|public)$` |
| sharing_paused, gamification_enabled, leaderboard_opt_in | bool |
| reminder_hour, quiet_start, quiet_end | 0..23 |
| reminder_mode | `^(fixed\|smart)$` |
| quiet_days | 0..127 |
| weekly_target | 1..7 |

Logic, in order:
1. if handle present and non-null: `_check_handle` (422/409 reserved), taken → 409 "That handle is taken"; set profile.handle (**before** later checks can fail, but rollback on error since no commit). handle:null is dropped silently.
2. if "timezone" present and not valid (null → "" → invalid) → 422 "Unknown timezone".
3. visibility in (followers, public) and !social_allowed → 403 "Sharing is not available on this account."
4. leaderboard_opt_in truthy and !social_allowed → 403 "Leaderboards are not available on this account."
5. gamification_enabled === false → set leaderboard_opt_in=false and drop it from data.
6. "display_name" present → check_display_name → 409.
7. weekly_target popped; every remaining key set on profile as-is (**including explicit nulls**, e.g. `{"timezone":null}` fails at 2 but `{"reminder_hour":null}` would write NULL into a NOT NULL column → DB IntegrityError → 500 — hazard/quirk). display_name/bio: empty string → null.
8. if weekly_target != null: main chain; this_week = week_start(local_today(tz), week_starts_on) (using the possibly-updated tz/week start); if target != main.target → `set_chain_target(main, target, this_week iso)`: keep history entries with `from < this_week` (string compare), append `{"from": this_week, "target": target}`.
9. recompute(notify=False) if weekly_target given or "week_starts_on" or "timezone" in data.
Response `{"profile": ProfileOut}`.

### 5. GET /v1/handles/{handle}
`_check_handle(handle)`; on HTTPException return `{"handle": <raw input>, "available": false, "reason": err.detail}` (200).
Otherwise `{"handle": clean, "available": !taken, "reason": "Taken" | null}`. Taken excludes the caller's own profile.

### 6. GET /v1/me/export
Query `format` default "json", pattern `^(json|csv|ics)$` (else 422 validation). Rate limit first, then
security event `data_exported` meta `{"format": format}` (recorded before building; committed).
`stamp` = UTC `YYYY-MM-DD`. All responses `Cache-Control: private, no-store`,
`Content-Disposition: attachment; filename="pacestreak-{stamp}.{json|ics|zip}"`.
- **json**: `json.dumps(build_export(), indent=2, ensure_ascii=False)` → `application/json`. See §2 for document.
- **ics**: `build_calendar("PaceStreak training", workouts, pauses)` (no planned-days event) → `text/calendar; charset=utf-8`.
- **csv**: ZIP (DEFLATE) `application/zip` with entries in this order:
  `workouts.csv`, `sets.csv`, `body_metrics.csv`, `weigh_ins.csv`, `meals.csv`, `journal.csv`, `habit_days.csv`, `photos/...`, `README.txt`. CSV via Python `csv.writer` (dialect excel: `,`, `"` quoting minimal, line terminator `\r\n`; None → empty; bool → `True`/`False`; dates/datetimes `str()` i.e. `2026-10-17` and `2026-10-17 09:00:00+00:00` (space separator!) except where `.isoformat()` is explicit).
  | file | header | rows / source |
  |---|---|---|
  | workouts.csv | id,date,started_at,discipline,title,duration_sec,distance_m,elevation_m,effort,feel,notes,tags,source | non-deleted workouts by started_at; started_at isoformat; tags joined by space |
  | sets.csv | workout_id,date,exercise_id,exercise,position,set,kind,weight_kg,reps,rpe,duration_sec,distance_m,completed | per workout, `w.sets` (relationship order — check model `order_by`); exercise = name from library or custom, else id |
  | body_metrics.csv | date, *METRIC_FIELDS | unordered |
  | weigh_ins.csv | weighed_at,date,moment,weight_kg,note | order weighed_at; weighed_at via str() |
  | meals.csv | date,meal,name,servings,kcal,protein_g,carbs_g,fat_g | order day, created_at |
  | journal.csv | date,mood,note | order day |
  | habit_days.csv | habit,kind,unit,date,amount,note | habits JOIN habit_logs, order habit.name, day |
  | photos/`{taken_on}_{pose}_{id}.{ext}` | binary from object storage (R2) `storage.get_object(object_key)`; ext png/webp else jpg | order taken_on |
  | README.txt | fixed text (copy exactly from router.py L806-810) | |

### 7. POST /v1/me/import
Multipart form, field `file` (required). Rate limit first.
- read up to 25 MiB+1; > 25*1024*1024 → 413 "That file is too large"
- JSON parse fail → 422 "Not a JSON file"; not object or `format != "pacestreak-export"` → 422 "Not a PaceStreak export"
- `len(workouts) > 25000` → 413 "Too many sessions in one file"
- version field is ignored.
Response `{"imported": int, "skipped": int}` (counts workouts only). Full algorithm §2. Ends with `recompute(notify=False)`. No security event.

### 8. POST /v1/me/delete
Body `{password: str 1..256}`. verify_password (argon2/bcrypt – see auth spec) fails → 403 "Incorrect password".
Note: passkey-only/no-password accounts? (open question: hashed_password may be null.)
Sets `deletion_scheduled_at = now + settings.deletion_grace_days (30) days`; security event `deletion_scheduled`;
`notify(kind="deletion_scheduled", category="security", title="Your PaceStreak account is scheduled for deletion",
body=f"Everything will be deleted on {when:%d %B %Y}. Sign in before then to cancel."` (e.g. "16 November 2026", zero-padded day, English month), url="/settings/data")`;
`revoke_all_sessions(db,user)`; commit; `finish_revoke_all(user.id)` (Redis/cache cleanup); `deliver([nid])` (push/email, after commit).
Response `{"deletion_scheduled_at": iso}`. Cancellation: user signs in again (login path, out of scope) then calls #9.

### 9. POST /v1/me/delete/cancel
Not scheduled → `{"cancelled": false}`. Else null it, security event `deletion_cancelled`, `{"cancelled": true}`.

### 10. GET /v1/me/security-events
Last 100 by created_at DESC. Each: `{id, kind, label: LABELS.get(kind, kind), ip_address, user_agent, meta, created_at}`.
LABELS (exact): login "Signed in", logout_all "Signed out everywhere", password_changed "Password changed",
password_reset "Password reset by email", totp_enabled "Two-factor turned on", totp_disabled "Two-factor turned off",
recovery_codes_regenerated "Recovery codes replaced", session_revoked "A session was signed out",
email_verified "Email address confirmed", deletion_scheduled "Account deletion scheduled",
deletion_cancelled "Account deletion cancelled", data_exported "Data exported", signup "Account created",
password_recovered "Password set with a recovery code", email_change_requested "Email change requested",
email_changed "Email address changed", terms_accepted "Terms accepted", passkey_added "Passkey added",
passkey_removed "Passkey removed". (calendar_feed_* have no label → kind echoed.)

### 11. GET /v1/me/calendar
`{"enabled": calendar_token_hash != null, "created_at": iso|null}`.

### 12. POST /v1/me/calendar (201)
token = `secrets.token_urlsafe(32)` (32 random bytes → base64url no padding, 43 chars). Store `sha256(token).hexdigest()` and created_at=now.
Security event `calendar_feed_rotated` if one existed else `calendar_feed_created`.
Response `{"url": f"{public_api_url.rstrip('/')}/v1/calendar/{token}.ics", "created_at": iso}`.

### 13. DELETE /v1/me/calendar (204)
If set: null both columns, security event `calendar_feed_revoked`. Always 204 (empty body).

### 14. GET /v1/calendar/{token}.ics (public)
- `len(token)` not in 20..100 → 404 "Not found" (before rate limit).
- rate limit keyed on `sha256(token)[:16]` (120/h).
- profile by `calendar_token_hash = sha256(token)`; 404 "Not found" if none, user missing, `!user.is_active`, or deletion scheduled.
- workouts: user, deleted_at null, `started_at >= now - 400 days`, order started_at. pauses: all of user's.
- anchor = Monday of local today (`today - weekday`) in profile.timezone — **always Monday, ignores week_starts_on**.
- body = build_calendar("PaceStreak training", workouts, pauses, profile.training_days, anchor).
- Headers: `Content-Type: text/calendar; charset=utf-8`, `Cache-Control: private, max-age=900`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`.
- Path match: Starlette route `/calendar/{token}.ics`; token param cannot contain `/`.

### 15. GET /v1/trash
Items `user_id=me AND purge_after > now` order deleted_at DESC limit 500. Each `{id, kind, item_id, label, deleted_at, purge_after}`.

### 16. POST /v1/trash/{trash_id}/restore
trash_id UUID path (invalid → 422). Not found / not owner → 404 "Not found".
- kind `workout`: Workout by item_id; missing or other owner → 410 "That session can no longer be restored". Set deleted_at=null, client_updated_at=now, `seq = nextval(sync_seq)` (Postgres sequence!).
- other kinds: model from MODELS {habit, meal→MealEntry, food, recipe, journal→JournalDay, habit_routine→HabitRoutine}; model or payload.row missing → 410 "That can no longer be restored".
  - habit with row.archived_at null: if live (non-archived) habits count >= 30 → 409 "30 habits at once is the limit. Archive one first."
  - insert `rebuild(model,row)` and each child in payload.children (only `habit_logs` → HabitLog recognised; unknown names ignored).
- flush; IntegrityError (PK/unique clash) → rollback, 409 "Something already exists in its place" (nothing changed).
- delete trash row; if kind in {habit, workout} → recompute(notify=False). Commit.
Response `{"kind", "item_id"}`.

### 17. DELETE /v1/trash/{trash_id} → 404 if not own; delete row; 204.
### 18. DELETE /v1/trash → delete all user's trash rows (incl. expired); 204.

---

## 2. Business logic

### Handle validation `_check_handle(handle, allow_reserved=False)`
`h = handle.strip().lower().lstrip("@")` (lstrip removes all leading `@`). Must match `^[a-z0-9_]{3,30}$` else 422
"Handles are 3-30 characters: lowercase letters, numbers and underscores." Then `is_reserved(h)` → 409 "That handle is reserved".
(Python `strip()` strips Unicode whitespace; `lower()` is Unicode — regex rejects non-ASCII anyway.)

### Reserved handles (`app/profile/reserved.py`) — copy RESERVED/CONTAINS/AFFIXES/TOKENS verbatim.
```
CONF_L = {0:o,1:l,3:e,4:a,5:s,7:t,$:s,@:a,|:l}; CONF_I = same but 1→i, |→i
core(text,t) = lower(text).translate(t) keeping only chars where str.isalpha()  (Unicode alpha!)
mentions_brand(text) = any("pacestreak" in core(text,t) for t in [CONF_L, CONF_I])
matches(h,t): core in RESERVED || any CONTAINS word in core || core startswith/endswith any AFFIX
              || any nonempty word of re.split(r"[_0-9]+", h.translate(t)) in TOKENS
is_reserved(h): h=lower(h); h in RESERVED || matches(h,CONF_L) || matches(h,CONF_I)
```
Note the TOKENS split runs on the translated (not lowercased-again) handle, so digits that are confusables
are already letters (`adm1n` → `admln`/`admin`). JS: `isalpha` → `/\p{L}/u` (Python isalpha = Unicode categories Lm/Lt/Lu/Ll/Lo; `\p{L}` matches). Translation must be per-character map.
Display names: `check_display_name(name, profile)`: name truthy, !is_official, mentions_brand → 409.
Admin route `/v1/admin/users/{id}/official` (out of scope) uses `_check_handle(allow_reserved=True)` presumably.

### Export document (`build_export`), EXPORT_VERSION = 3
Top-level key order: format "pacestreak-export", version 3, exported_at (now iso), account {email, created_at, email_verified, two_factor},
profile (ProfileOut + accepted_terms_at), chains [{id,name,disciplines,target_history,requirements_history}] (active only, via get_chains),
repairs [{chain_id, week_start, month}], pauses [{starts_on, ends_on|null, reason, note}], custom_exercises [{id: exercise_id, name, pattern, equipment, primary, secondary, load_type, rest_sec, unilateral, cue, archived}],
workouts (non-deleted, by started_at) [{id, discipline, title, notes, started_at, local_date, duration_sec, distance_m, elevation_m, effort, feel, routine_id, tags, splits, gear_id, gym_id, soreness, pump, avg_hr, max_hr, hr_zones, source, sets:[{exercise_id, position, set_index, superset, kind, weight_kg, reps, rpe, duration_sec, distance_m, completed}]}],
monthly_goals [{month, days}], rest_days [{day, kind, note}], gear [{id,name,kind,default_for,limit_km (limit_m/1000|null),initial_km (initial_m/1000),retired_at,note}],
gyms [{id,name,equipment,plates_kg,bar_kg,is_default}], exercise_notes [{exercise_id,note}], weight_goal {target_kg,start_kg,milestone_kg,set_on}|null (first row),
habits [{id,name,emoji,category,kind,unit,daily_goal,weekly_target,time_of_day,cue,why,total_goal,remind_hour,days_mask,paused_from,paused_until,template_id,started_on,archived_at, days:[{date,amount,note}]}] (N+1 query per habit),
training_blocks [{name,starts_on,weeks,rir_start,rir_end,ended_at}], readiness [{date,sleep,energy,soreness}], reflections [{week_start,went_well,change}],
streak_wagers [{week_start,days}], plans [{name,description,template_id,weeks,started_on,finished_at}], routines [{id,name,discipline,notes,items}],
body_metrics [{date, ...METRIC_FIELDS}], body_photos [{id,date,pose,size}], weigh_ins [{id,weighed_at,date,moment,weight_kg,note}],
meals [{id,date,meal,name,servings,kcal,protein_g,carbs_g,fat_g}], foods [{id,name,brand,barcode,serving_label,kcal,protein_g,carbs_g,fat_g}],
recipes [{id,name,serves,items,kcal,protein_g,carbs_g,fat_g}], journal [{date,mood,note}], habit_routines [{id,name,emoji,time_of_day,habit_ids}],
nutrition_target {kcal,protein_g,carbs_g,fat_g}|null, achievements [{id,tier,unlocked_on}], personal_records [{key,value,previous,date,current}],
social {following: [handle of accepted followees], followers: [handles], blocked: count, buddies [{handle,status,started_at,ended_at}], comments [{id,event_id,body,created_at}] (authored), groups [{name,role,joined_at,shares_with_coach}], challenges [{title,starts_on,ends_on,final_score,final_rank}]},
notification_preferences: prefs.channels or {}.
Unordered lists (no ORDER BY) → Postgres heap order; port should pick a stable order (e.g. created_at/id) — tests don't depend on it except where noted. Floats: Python prints `5.0` for 5000/1000; JSON from JS gives `5` (harmless for re-import).
Trash items, security events, sessions, notifications are NOT exported.

### Import algorithm (`import_data`) — idempotent, fill-gaps-never-overwrite
1. **custom_exercises**: existing by lower(name). Each item validated with `CustomExerciseIn` (training schemas); invalid skipped. No match → insert (new exercise_id minted by model default with CUSTOM_PREFIX). `id_map[str(item.id)] = match.exercise_id`.
2. **gear**: `GearIn` validated; match lower(name); new Gear: default_for=[], limit_m=limit_km*1000 or null, initial_m=initial_km*1000, note, retired_at=now if item.retired_at truthy. `gear_map[str(item.id)]=id`.
3. **gyms**: `GymIn`; match lower(name); insert with is_default=false. `gym_map`.
4. **workouts**: per item, in try: id=UUID(str(item.id)); discipline ∈ DISCIPLINE_IDS; started_at = `datetime.fromisoformat` and must be tz-aware; sets: exercise_id remapped via id_map, dropped silently if not in library and not startswith CUSTOM_PREFIX; each set `SetIn.model_validate` (failure → whole workout skipped). Any exception → skipped++.
   Existing Workout with that id: other owner → mint uuid4 and insert; own (including soft-deleted!) → skipped++.
   Insert: title `str[:80]` or null if falsy, notes `[:1000]`, local_date = local_date(started, profile.timezone), duration/distance/elevation/effort/feel raw from item (**unvalidated**), tags = clean_tags(strings only), splits = `_valid_splits` (list ≤500 entries each SplitIn-valid else []), gear_id/gym_id via maps (else null), `_checked_extras`: soreness int 0..3, pump 0..2, avg_hr/max_hr 30..240 (ints only, bool counts as int in Python!), hr_zones: list of ints ≥0 first 5 else []; source="import", client_updated_at=now, sets with user_id. imported++; flush each 500.
   Note: `seq` presumably set by model default from sync_seq.
5. **pauses**: held = existing spans. Each: Span(starts_on, ends_on?) parse; reason ∈ REASONS(injury,illness,travel,life,other) else "other"; skip if ends<starts or overlaps any held (overlap uses effective_end = min(ends, starts+PAUSE_MAX_DAYS-1)); insert ends_on = ends_on or effective_end; note `str[:280]` or null.
6. **body_metrics**: day=date(m.date), `BodyMetricIn` on other keys. If `m.weight_kg != null` → legacy weigh-in at local noon in profile tz, moment "other" (via WeighInIn validation; errors swallowed). If all metric values null → skip; insert only if no BodyMetric for that day.
7. **weigh_ins**: `WeighInIn`; skip naive weighed_at; keep original id unless it exists anywhere (any user). Dedupe key (local_date in profile tz, moment, round(weight,2)) against existing + already added; weight stored round 2.
8. **exercise_notes**: remap id; text `str.strip()[:500]`; insert if known exercise, non-empty, and no note yet for it.
9. **weight_goal**: only if dict and user has none: WeightGoalIn validated, start_kg=float(goal.start_kg), set_on date; errors swallowed.
10. **habits**: `HabitIn.model_validate({k: item.get(k) for HabitIn fields except template_id})`, started=date(started_on); skip invalid or empty name. Match lower(name); new: name strip, emoji or "✨", category or "other", kind or "check", unit, daily_goal only if kind in (duration,count), weekly_target or 7, time_of_day or "anytime", cue, why, total_goal, remind_hour, days_mask unless kind=="quit", paused_from/until lenient dates, started_on, archived_at=now if truthy. **No 30-live-habit cap on import.** Days: date+float(amount), skip if day exists or not 0<amount<=100000; note `[:280]` or null.
11. **readiness**: by day, ReadinessIn, fill gaps. **reflections**: by week_start, ReflectionIn, only if went_well or change truthy.
12. Not imported: training_blocks, streak_wagers, chains, repairs, monthly_goals, rest_days, routines, plans, meals, foods, recipes, journal, habit_routines, nutrition_target, achievements, PRs, social, prefs, body_photos, profile.
13. flush; recompute(notify=False); commit (single transaction).

### Trash (`app/trash/service.py`)
- RETENTION_DAYS=30. `put_in_trash(db,user_id,kind,item_id,label,row,children)` (called by habits, nutrition, insights, habits/routines, training routers): label[:160], payload `{"row": snapshot(row)|null, "children": {name: [snapshot]}}`, deleted_at=now, purge_after=now+30d. Caller deletes the rows in the same tx.
- `snapshot`: every mapped column → JSON; datetime/date → isoformat, UUID → str, others raw (arrays/JSON kept).
- `rebuild(model, data)`: for each current model column present in data: non-null DateTime → fromisoformat, Date → fromisoformat, Uuid → UUID; unknown keys dropped; missing columns take defaults. **Port: needs a per-table column-type map** (Drizzle `getTableColumns`).
- Workout payload is empty `{row:null, children:{}}`; restore just un-deletes. Re-saving a workout clears its trash entry (training router).
- Worker `housekeeping` deletes trash with purge_after < now.
- TRASH_KINDS = habit, meal, food, recipe, journal, habit_routine, workout. kind column String(16).

### iCalendar (`build_calendar`) — exact output
Lines joined with CRLF, each folded, trailing CRLF:
```
BEGIN:VCALENDAR / VERSION:2.0 / PRODID:-//PaceStreak//Calendar//EN / CALSCALE:GREGORIAN / METHOD:PUBLISH /
X-WR-CALNAME:{escape(name)} / REFRESH-INTERVAL;VALUE=DURATION:PT6H / X-PUBLISHED-TTL:PT6H
per workout: BEGIN:VEVENT, UID:{id}@pacestreak.com, DTSTAMP:{now}, DTSTART:{stamp(started_at)},
  DURATION:PT{max(1,(duration_sec or 1800)//60)}M, SUMMARY:{escape(summary)}, CATEGORIES:TRAINING, TRANSP:TRANSPARENT, END:VEVENT
per pause: UID:pause-{id}@pacestreak.com, DTSTAMP, DTSTART;VALUE=DATE:{starts YYYYMMDD},
  DTEND;VALUE=DATE:{effective_end+1d YYYYMMDD}, SUMMARY:Streak paused, TRANSP:TRANSPARENT
if training_days truthy (non-zero) and anchor: UID:planned-training@pacestreak.com, DTSTAMP,
  DTSTART;VALUE=DATE:{anchor}, RRULE:FREQ=WEEKLY;BYDAY={MO,TU,... for bits 0..6}, SUMMARY:Planned training day, TRANSP:TRANSPARENT
END:VCALENDAR
```
- stamp = UTC `%Y%m%dT%H%M%SZ`.
- summary = title or DISCIPLINE_NAMES[discipline] or `discipline.title()` (Python title-case); if distance_m truthy append ` · {distance_m/1000:.1f} km` (U+00B7, Python round-half-even on float formatting — JS `toFixed(1)` differs in edge cases).
- escape: `\`→`\\`, `;`→`\;`, `,`→`\,`, CRLF→`\n`, LF→`\n` (in that order).
- fold: char-by-char, first segment ≤75 UTF-8 bytes, subsequent ≤74 bytes (plus leading space = 75), joined `"\r\n "`; never split a code point (Python iterates code points; JS must iterate with `for..of`).
- `duration_sec//60` floor division.

### Backup attachment (`export_attachment`, used by notifications.deliver when note.data.export_attachment)
Compact `json.dumps(build_export, default=str, ensure_ascii=False)`, zipped (DEFLATE) as `pacestreak-export-{YYYY-MM}.json` (server local date `date.today()` – effectively UTC); zip name `.zip`; if > 10 MiB → None (email falls back to a link). Returns (filename, bytes, "application/zip"). Worker sends the monthly/weekly backup reminder with `dedupe_key=backup:{period}`.

### Security events (`account/service.py`)
`record(user_id, kind, request, meta)`: ip = first `X-Forwarded-For` entry stripped else request.client.host, truncated to 45; user_agent truncated to 400. (On Workers use `CF-Connecting-IP`? — behaviour change; keep XFF-first to match.)
`is_new_device`: no prior `login` event with identical user_agent (false if UA missing). `note_sign_in`: computes new_device & has_history before recording login; if both → notify kind `new_sign_in`, category security, title "New sign-in to your PaceStreak account", body `From {describe_agent(ua)}. If this was not you, change your password and sign out everywhere.`, url `/settings/security`. describe_agent: first match of browser (Edg/→Edge, OPR/→Opera, Firefox/, Chrome/, Safari/ else "a browser") and system (iPhone, iPad, Android, "Mac OS X"→macOS, Windows, CrOS→ChromeOS, Linux else "an unknown system"); null UA → "an unknown device". (Called from auth login – auth spec.)
AuditLog model (table audit_log: actor_id SET NULL, action ≤40, target_type ≤20, target_id ≤64, detail JSONB) lives here but is written by admin module.

### Deletion lifecycle
Schedule (#8) → sessions revoked → user logs in (login path cancels? No: login only allows sign-in; client shows banner, user calls #9). Worker `purge_deleted_accounts`: profiles with deletion_scheduled_at < now → `DELETE users` (FK cascades everywhere), then delete R2 objects of body photos. Many worker jobs skip profiles with deletion scheduled. Calendar feed 404s while scheduled. social_allowed false while scheduled.

---

## 3. Data access

| Table | Routes | Shape |
|---|---|---|
| profiles | all | select by user_id (lazy insert); select user_id by handle ≠ me; select by calendar_token_hash; updates |
| streak_chains | onboarding, patch, export | active chains by user order position, created_at; lazy insert; update target_history (JSON) |
| users | me (cached), delete (password), feed (is_active), backup | get by id |
| notifications | me | count unread |
| follows | me, export | count pending; follower_id=me OR followee_id=me |
| security_events | events, record, calendar, export, terms, delete | insert; last 100 desc; index (user_id, created_at) |
| trash_items | trash | list (user, purge_after>now) desc limit 500; get by id; delete; delete by user |
| habits, habit_logs, meal_entries, foods, recipes, journal_days, habit_routines | restore, export, import | insert with explicit ids; count live habits |
| workouts, workout_sets | export, import, feed, restore | by user non-deleted order started_at; get by id; insert; update deleted_at/seq |
| streak_pauses, streak_repairs, custom_exercises, gear, gyms, exercise_notes, weight_goals, body_metrics, body_photos, weigh_ins, readiness, week_reflections, training_blocks, training_plans, routines, monthly_goals, rest_days, streak_wagers, nutrition_targets, user_achievements, personal_records, blocks, buddy_pairs, comments, group_members+groups, challenge_participants+challenges, notification_preferences | export (most), import (subset) | select all by user |
| sessions etc. | delete | via auth.revoke_all_sessions |

---

## 4. Porting hazards (Workers / D1)

| Item | Python | JS replacement / note |
|---|---|---|
| ZIP (csv export, backup) | `zipfile` ZIP_DEFLATED | `fflate` (`zipSync`, level default) — pure JS, fast; or `@zip.js/zip.js`. CPU: large exports may hit Worker CPU limit (paid 30s default) |
| CSV | `csv.writer` | hand-roll RFC4180 or `papaparse` `unparse` (newline `\r\n`); match Python quoting (quote only if field has `,` `"` `\r` `\n`), None→"", True/False, `str(datetime)` space format |
| JSON pretty | `json.dumps(indent=2, ensure_ascii=False)` | `JSON.stringify(x,null,2)`; Python uses `", "`/`": "` with indent → same as JS with indent. Floats `5.0` vs `5` differ |
| SHA-256 | hashlib | `crypto.subtle.digest` (WebCrypto) |
| token_urlsafe(32) | secrets | `crypto.getRandomValues(32)` → base64url no padding |
| password verify (#8) | app.auth.security (argon2/bcrypt?) | see auth spec; argon2 in Workers needs `hash-wasm` (CPU heavy) |
| timezones | zoneinfo, available_timezones | `Intl.DateTimeFormat` + `Intl.supportedValuesOf('timeZone')` (set differs slightly from tzdata: aliases like `UTC`, `Etc/*`, `US/Eastern` may be missing → validation behaviour change; ship a static IANA list) ; local date via `@date-fns/tz` or `Temporal` polyfill |
| date formatting `%d %B %Y` | strftime | manual English month array |
| `datetime.fromisoformat` (import) | accepts many forms; tz-awareness check | write strict parser; JS `Date.parse` cannot tell naive vs aware — must regex for `Z`/`±HH:MM` |
| isoformat output | `+00:00`, microseconds | custom formatter; D1 stores text — store ISO strings with same format, compare lexicographically only if uniform |
| Postgres sequence `sync_seq.next_value()` (restore workout) | nextval | D1 has no sequences: counter table `UPDATE seq SET v=v+1 RETURNING v` |
| JSONB (payload, meta, target_history, splits, items) | JSONB | TEXT JSON (`text({mode:'json'})`) |
| ARRAY(String) favourite_disciplines, tags, default_for | PG array | JSON text |
| `ilike`/lower name matching | done in Python dicts | fine |
| IntegrityError on restore → 409 | flush/rollback | D1: run inserts in `db.batch()` (atomic); catch `SQLITE_CONSTRAINT` → 409. No interactive transactions in D1 — import/restore must be batched or tolerate partials |
| Import single transaction, up to 25k workouts + sets | flush per 500 | D1 limits: 100 bound params/stmt, ~1000 stmts/batch?, 30s CPU; need chunked multi-row inserts; atomicity lost across batches — **major hazard** |
| Upload 25 MiB multipart | UploadFile | `await c.req.formData()`; Workers request body limit 100 MB (free/pro) OK; JSON.parse of 25MB costs CPU/memory (128MB) |
| R2 object read for photos | app.storage (boto3 S3) | native R2 binding `env.BUCKET.get(key)` |
| Redis rate limits (`enforce`) | redis INCR/EXPIRE, fail-open | KV is not atomic; use Durable Object counter, or Workers Rate Limiting binding (approximate), or D1 table. Keep fail-open |
| `finish_revoke_all`, user cache | Redis | KV/DO per auth spec |
| `deliver()` after commit (push/email) | in-request await | `c.executionCtx.waitUntil(...)`; Web Push needs VAPID signing (`web-push` won't run; use `@block65/webcrypto-web-push` or hand-rolled) |
| `recompute()` game engine | heavy Python | out of scope but called by onboarding/patch/import/restore — CPU |
| N+1 queries in export (habit logs per habit) | | batch with `IN` |
| `random.randint` avatar hue | | `crypto.getRandomValues` / Math.random |
| `str.isalpha()` Unicode, `str.title()` | | `/\p{L}/u`; title-case function emulating Python (capitalise after non-letter) |
| `f"{x:.1f}"` | round-half-even on binary float | `toFixed(1)` mostly equal; edge cases rare |
| Python 3.14 syntax `except TypeError, ValueError:` | | n/a |
| Lazy profile creation on GET | write in GET | keep (INSERT OR IGNORE on unique user_id to avoid race) |
| Worker jobs: purge_deleted_accounts, trash purge, backup emails | GH Actions cron | Workers Cron Triggers; FK cascades need `PRAGMA foreign_keys=ON` (D1 enforces by default) and `ON DELETE CASCADE` in schema |
| Filesystem | none (BytesIO only) | – |

---

## 5. Tests covering this area

| File | Tests / notable assertions |
|---|---|
| tests/test_training.py | `test_me_reports_onboarding_needed`; `test_onboarding_refuses_under_thirteen` (403); `test_handles_are_unique_and_validated` (taken/"Bad Handle"/admin unavailable, free_one available); `test_export_and_import_roundtrip`; `test_weigh_ins_export_and_import_including_legacy_daily_weight`; `test_account_deletion_is_scheduled_and_cancellable` (after delete, old token → 401; re-login, `deletion_scheduled_at` set, cancel → `{"cancelled": true}`, security events include deletion_scheduled & login); `test_export_carries_tags_and_gear_and_import_restores_them`; `test_custom_exercise_routine_and_body_metrics` |
| tests/test_features.py | `test_import_endpoint_is_idempotent_and_marks_source`; `test_calendar_feed_lifecycle` (enabled false→create; feed 200, text/calendar, cache-control contains private, starts `BEGIN:VCALENDAR\r\n`; rotate → old 404, new 200; DELETE 204 → 404; events created/rotated/revoked); `test_ics_folding_and_escaping` (`escape("a,b;c\\d\ne") == "a\\,b\\;c\\\\d\\ne"`, folded parts ≤75 bytes); `test_brand_names_are_reserved_however_they_are_spelled` (pacestreak, real_pacestreak, pace_streak_hq, pac3streak unavailable; display_name "PaceStreak Team" → 409); `test_authority_handles_are_reserved_however_they_are_dressed_up` (positive & negative lists — port as unit test verbatim) |
| tests/test_qol.py | trash: `test_deleted_habit_comes_back_with_its_history`, `test_meal_food_recipe_journal_and_routine_restore`, `test_restore_refuses_a_clash_and_changes_nothing` (409, newer row kept, trash entry kept, DELETE 204 then empty), `test_deleted_workout_restores_and_syncs` (double delete → one entry; restore shows in changes feed with deleted_at null), `test_undo_by_resaving_a_workout_clears_its_trash_entry`; backup: `test_backup_attachment_is_opt_in_and_round_trips`, `test_backup_falls_back_to_a_link_when_too_big` |
| tests/test_engagement.py | `test_export_and_import_carry_gyms_notes_goal` |
| tests/test_habits_life.py | `test_habits_export_and_import` |
| tests/test_body_data.py | `test_tape_measurements_round_trip_and_export`, `test_photo_backup_is_owner_only_and_checked` (photos in csv zip) |
| tests/test_worker.py | `test_monthly_backup_reminder_is_opt_in_and_monthly`, `test_weekly_backup_arrives_on_the_first_day_of_the_week` |
| tests/test_social.py, test_nutrition.py, test_insights.py, test_habits.py, test_readiness_blocks.py, test_prelaunch.py, test_passkeys.py, conftest.py | use `/v1/me/profile`, `/v1/me/onboarding` (conftest `person()` helper onboards), `/v1/trash` incidentally |

---

## Open questions
1. `POST /me/delete` for accounts without a password (passkey-only?) — does `verify_password(pw, None)` return False (→ 403, can't delete)? Check auth spec.
2. PATCH with explicit null for NOT NULL columns (reminder_hour etc.) → 500 today; preserve or fix?
3. Unordered export sections: is any client/test order-sensitive? (Recommend ORDER BY rowid/created_at.)
4. Import atomicity on D1 (no multi-statement transactions beyond `batch`) — acceptable to lose all-or-nothing for 25k-workout files?
5. IP source on Workers: keep `X-Forwarded-For` first or switch to `CF-Connecting-IP` (FastAPI Cloud sets XFF)?
6. Timezone allow-list parity (`Intl.supportedValuesOf` vs Python tzdata incl. aliases).
