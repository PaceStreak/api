# Spec: nutrition, notifications, admin, worker

Source: `api/app/nutrition/*`, `api/app/notifications/*`, `api/app/admin/*`, `api/app/worker.py`.
Every router is mounted under `/v1` (via `app/v1/router.py`). Errors are FastAPI's `{"detail": "<message>"}`; Pydantic validation failures are 422 with FastAPI's `detail: [{loc,msg,type,...}]` array. "Auth" = `get_current_user` (session cookie / bearer; 401 if absent, as defined elsewhere). Datetimes are emitted with Python `.isoformat()` (e.g. `2026-10-17T09:00:00.123456+00:00`: microseconds, `+00:00` offset, not `Z`). Dates are `YYYY-MM-DD`.

Not in scope but under `/v1/admin`: `/admin/client-errors`, `/admin/abuse` live in another router (ops), referenced by tests/test_prelaunch.py.

---

## 1. Nutrition (`/v1/nutrition`), 17 routes

Constants: `MAX_FOODS=500`, `MAX_RECIPES=200`, `MAX_BACKDATE_DAYS=60`, `MACROS=(kcal, protein_g, carbs_g, fat_g)`, `BARCODE=^\d{8,14}$`. "today" = `local_today(profile.timezone)` (profile from `get_profile`, which presumably creates/returns profile).

All routes require auth. Ownership failures always 404 `"Not found"` (never 403).

### Schemas

| Schema | Field | Type | Constraints / default |
|---|---|---|---|
| FoodIn | name | str | 1..120 chars (stripped on save, but length checked pre-strip) |
| | brand | str? | max 120, default null |
| | barcode | str? | regex `^\d{8,14}$`, default null |
| | serving_label | str? | max 40 |
| | kcal | float | 0..10000, required |
| | protein_g / carbs_g / fat_g | float | 0..1000, default 0 |
| EntryIn | date | date | required |
| | meal | enum breakfast/lunch/dinner/snack | required |
| | food_id / recipe_id | uuid? | null |
| | servings | float | >0, <=50, default 1 |
| | name | str? | max 120 |
| | kcal | float? | 0..20000 |
| | protein_g/carbs_g/fat_g | float? | 0..2000 |
| RecipeItemIn | food_id | uuid | required; servings float >0 <=50 default 1 |
| RecipeIn | name | str 1..120; serves float >0 <=50 default 1; items list 1..40 |
| TargetIn | kcal float? 500..10000; protein_g? 0..1000; carbs_g? 0..2000; fat_g? 0..1000 |
| CopyIn | from_date date; to_date date; meal enum? |

Outputs:
- FoodOut `{id,name,brand,barcode,serving_label,kcal,protein_g,carbs_g,fat_g}`
- EntryOut `{id,date,meal,name,food_id|null,servings,kcal,protein_g,carbs_g,fat_g}`
- TargetOut `{kcal,protein_g,carbs_g,fat_g}` (each nullable) or `null`
- RecipeOut `{id,name,serves,items:[{food_id,name,servings}],kcal,protein_g,carbs_g,fat_g}`

`_check_day(day, today)`: `day > today` -> 422 "That day hasn't happened yet"; `day < today-60d` -> 422 "Meals can be backdated up to 60 days".

### Routes

| # | Method | Path | Status | Behaviour |
|---|---|---|---|---|
| 1 | GET | /v1/nutrition/days/{day} | 200 | `day` is a path date (invalid -> 422). Entries for user+day ordered by `created_at` asc. Returns `{date, entries:[EntryOut], totals:{4 macros, each round(sum,1)}, target: TargetOut|null}`. No day-range check. |
| 2 | GET | /v1/nutrition/history?days=30 | 200 | days int 1..365. `since = today-(days-1)`. `SELECT day, SUM(kcal),SUM(protein_g),SUM(carbs_g),SUM(fat_g) WHERE user AND day>=since GROUP BY day ORDER BY day`. List of `{date, kcal..fat_g (round 1)}`. Only days with entries; no upper bound (future days impossible anyway). |
| 3 | PUT | /v1/nutrition/entries/{entry_id} | 200 | Client-chosen UUID; upsert. `_check_day(body.date)` first. Values: if `recipe_id` -> own recipe (404) -> name=recipe.name, macros = round(recipe.macro*servings,1). elif `food_id` -> own food (404) -> same with food. else requires non-blank `name` and `kcal` not null else 422 "A name and calories, or a saved food"; name stripped, macros = body value or 0 (not rounded). Then existing entry with other user_id -> 404. Create if missing. Sets day, meal, food_id (=body.food_id, so recipe entries have food_id null; recipe_id is NOT stored), servings. Returns EntryOut. Note: recipe_id checked before food_id (recipe wins if both). |
| 4 | DELETE | /v1/nutrition/entries/{entry_id} | 200 | Idempotent: missing or not own -> `{"trash_id": null}`. Else `put_in_trash(db,user,"meal",id,name,entry)` then delete -> `{"trash_id": "<uuid>"}`. |
| 5 | POST | /v1/nutrition/copy | 201 | `_check_day(to_date)` only (from_date unchecked). Select user's entries on from_date (optionally meal), ordered created_at; insert copies with new server ids, same meal/name/food_id/servings/macros. Returns list EntryOut (may be `[]`). No dedupe: copying twice duplicates. |
| 6 | GET | /v1/nutrition/foods?q= | 200 | q max 60. If q truthy: strip `%` and `_` from q, `name ILIKE %q%` (case-insensitive). ORDER BY name (Postgres collation; port: `ORDER BY name` in SQLite is binary; consider `COLLATE NOCASE`? Postgres default en_US.UTF-8 collation is case-insensitive-ish; verify). List FoodOut. |
| 7 | GET | /v1/nutrition/recent | 200 | Entries with `day >= today-30` ordered created_at DESC. Key = (food_id,name) if food_id else (None,name). Count per key; `latest` = first seen (most recent). Rank by -count, stable sort preserves first-seen (recency) order among ties (Python dict insertion order = most recent first). Top 20. Each: `{name, food_id|null, times, kcal..fat_g = round(e.macro / max(e.servings,0.01), 1)}` (per-serving from latest entry). |
| 8 | POST | /v1/nutrition/foods | 201 | count >= 500 -> 409 "500 saved foods is the limit". barcode present and already saved by user -> 409 "That barcode is already saved". Insert (name stripped). FoodOut. DB unique (user_id, barcode). |
| 9 | PUT | /v1/nutrition/foods/{food_id} | 200 | own food (404). If body.barcode and differs from current and another of user's foods has it -> 409 same message. Full replace of all FoodIn fields (null barcode clears). FoodOut. Does NOT touch meal entries or recipes (snapshots). |
| 10 | DELETE | /v1/nutrition/foods/{food_id} | 200 | own food (404). Trash kind "food", delete. meal_entries.food_id FK ON DELETE SET NULL. `{trash_id}`. Recipes keep food_id strings in JSON items (dangling). |
| 11 | GET | /v1/nutrition/barcode/{code} | 200/404/422/503 | Rate limit slowapi `30/minute` per remote IP (`get_remote_address`, Redis storage); 429 on excess. Regex mismatch -> 422 "Not a product barcode". Saved food with that barcode -> `{"source":"saved","food":FoodOut}`. Else `fetch(code)`: LookupUnavailable -> 503 "Barcode lookup is unavailable right now"; None -> 404 "Product not found"; else `{"source":"openfoodfacts","food":{name,brand,serving_label,kcal,protein_g,carbs_g,fat_g,barcode}}` (no id). Nothing saved. |
| 12 | GET | /v1/nutrition/target | 200 | TargetOut or `null`. |
| 13 | PUT | /v1/nutrition/target | 200 | If all 4 null: delete target if any, return `null`. Else upsert; all 4 fields overwritten (nulls clear individually). TargetOut. |
| 14 | GET | /v1/nutrition/recipes | 200 | ORDER BY name. List RecipeOut. |
| 15 | POST | /v1/nutrition/recipes | 201 | count >= 200 -> 409 "200 recipes is the limit". `_fill_recipe`; RecipeOut. |
| 16 | PUT | /v1/nutrition/recipes/{recipe_id} | 200 | own recipe 404; `_fill_recipe`; RecipeOut. |
| 17 | DELETE | /v1/nutrition/recipes/{recipe_id} | 200 | own 404; trash kind "recipe"; delete; `{trash_id}`. |
| 18 | GET | /v1/nutrition/expenditure | 200 | See algorithm. |

(That is 18 routes; count includes expenditure.)

`_fill_recipe`: `ids = set(item.food_id)`; load user's foods in ids; if count differs -> 404 "A food in this recipe isn't saved" (duplicates in items are fine). name stripped; serves; items = `[{"food_id": str, "name": food.name, "servings": s}]` in body order (duplicates kept); each macro = `round(sum(food.macro * s) / serves, 1)`.

Rounding: Python `round()` is banker's rounding (half-to-even) on binary floats. JS `Math.round` is half-up. Implement `pyRound(x, n)` to match (e.g. round(0.25,1)=0.2, round(2.5)=2). Matters for totals, recipe macros, expenditure, suggestion kcal (`round(kcal/10)*10`).

### Expenditure algorithm (`expenditure.py`)

Constants: KCAL_PER_KG=7700, WINDOW_DAYS=28, MIN_FOOD_DAYS=14, MIN_WEIGH_DAYS=8, MIN_SPAN_DAYS=14, FLOOR_KCAL=1200, MAX_DEFICIT=750, LOSE_RATE=0.005, GAIN_RATE=0.0025, MAINTAIN_BAND_KG=1.0.

Route: `end = today - 1`, `start = end - 27`. `intake = {day: SUM(kcal)}` for meal_entries with day BETWEEN start AND end. `weights = {local_date: AVG(weight_kg)}` from `weigh_ins` (training module) in the same window. `goal = weight_goals.target_kg` for user (nullable).

`estimate(intake, weights, end)`:
1. food_days=len(intake), weigh_days=len(weights), span = (max date - min date) days (0 if none).
2. If food_days<14 or weigh_days<8 or span<14 -> `{status:"not_enough", food_days, weigh_days, rest null}`.
3. `per_day` = OLS slope of points `(x=(d-end).days (<=0), y=kg)` sorted by date: `sum((x-mx)(y-my))/sum((x-mx)^2)`, 0 if denominator 0.
4. avg_intake = mean(intake values); tdee = avg_intake - per_day*7700.
5. If not 1000<=tdee<=6000 -> status "inconsistent" (counts only).
6. latest = mean of weights with (end-d).days < 7 if any, else weight at max date.
7. ok: tdee=round(tdee), avg_intake=round(avg), trend_kg_per_week=round(per_day*7,2), trend_kg=round(latest,1), confidence="good" if food_days>=21 and weigh_days>=12 else "low".

`suggest(est, target_kg)`: null unless status ok. If target null or |target - trend_kg| <= 1.0 -> `{goal:"maintain", kcal: tdee, rate_kg_per_week: 0.0}`. If target<trend: rate=-0.005*trend_kg; kcal=max(1200, tdee-750, tdee + rate*7700/7); goal lose. Else rate=0.0025*trend_kg; kcal=tdee+rate*7700/7; goal gain. kcal=round(kcal/10)*10; rate_kg_per_week=round((kcal-tdee)*7/7700, 2).

Response: `{"window_days":28, "status", "food_days", "weigh_days", "tdee", "avg_intake", "trend_kg_per_week", "trend_kg", "confidence", "suggestion": {...}|null}` (key order from dataclass). Note: maintain's `rate_kg_per_week` is `0.0` -> JSON `0.0`; JS will emit `0` (equivalent numerically).

### Barcode lookup (`lookup.py`)

- `FOOD_LOOKUP_URL` default `https://world.openfoodfacts.org/api/v2/product/{barcode}.json`; empty -> LookupUnavailable (503).
- Redis key `food:{barcode}`: cached JSON; `{}` cached means not found (returns None). Hit TTL 30 days, miss TTL 1 day. Redis errors ignored (cache bypass).
- HTTP GET, timeout 5s, query `fields=product_name,brands,nutriments,serving_quantity,serving_size`, header `User-Agent: PaceStreak/1.0 (hello@pacestreak.com)`. 404 -> not found (cached as miss). Other non-2xx, network error, JSON error -> LookupUnavailable (not cached). If `status == 1` parse `product`, else None.
- `parse_product`: `_number(v)` = float(v) or None, and None if negative. name = trimmed product_name; empty -> None. If `serving_quantity` truthy (non-zero) and `nutriments["energy-kcal_serving"]` is a number -> suffix `_serving`, label = `serving_size` or `f"{serving:g} g"`, truncated 40. Elif `energy-kcal_100g` number -> `_100g`, label "100 g". Else None. Output name[:120], brand = first comma part of `brands` trimmed or null, and kcal/proteins/carbohydrates/fat with suffix, each `round(_number or 0, 1)`. `float("12.5")` strings accepted; Python float also accepts "inf"/"nan" (edge). `%g` formatting: 30.0 -> "30", 12.5 -> "12.5".

### Tables
`foods`(id, user_id FK cascade, name, brand, barcode, serving_label, kcal, protein_g, carbs_g, fat_g, created_at, updated_at; UNIQUE(user_id,barcode)), `meal_entries`(… day DATE, meal CHECK IN 4, food_id FK SET NULL, servings, macros; idx(user_id,day)), `nutrition_targets`(user_id UNIQUE, 4 nullable floats), `recipes`(name, serves, items JSONB, macros). Plus `weigh_ins`, `weight_goals`, `profiles`, `trash_items` (via `put_in_trash`). Base presumably provides id/created_at/updated_at.

---

## 2. Notifications (`/v1/notifications`), 11 routes

### Categories (order matters for GET preferences)

| id | label | push default | email default | locked |
|---|---|---|---|---|
| streak_risk | Streak at risk | T | F | |
| reminder | Training reminders | F | F | |
| habits | Habit reminders | T | F | |
| digest | Weekly summary | F | T | |
| achievements | Achievements and records | F | F | |
| social | Follows, kudos and comments | T | F | |
| groups | Groups and challenges | T | F | |
| backup | Monthly backup | F | F | |
| security | Security | T | T | yes |

`channels_for(prefs, cat)`: unknown cat -> base push F/email F. Locked -> `{push: bool(chosen.push ?? base.push), email: true}`. Else each channel = stored ?? default. NUDGE_CATEGORIES = {streak_risk, reminder, habits}.

### Routes

| Method | Path | Auth | Request | Response | Notes |
|---|---|---|---|---|---|
| GET | /v1/notifications | yes | `before` datetime? (ISO), `limit` 1..100 default 30 | `{items:[{id,kind,category,title,body,url,read(bool),created_at,actor:{handle,display_name,avatar_hue}|null}], next: created_at iso of last item | null}` | `LEFT JOIN profiles ON profiles.user_id = actor_id`, `WHERE user_id=me [AND created_at < before] ORDER BY created_at DESC LIMIT limit+1`. Cursor is created_at (ties across page boundary can be skipped; preserve). |
| GET | /v1/notifications/unread-count | yes | | `{unread:int}` | count read_at IS NULL |
| POST | /v1/notifications/read | yes | `{ids?: uuid[] max 200}` | `{ok:true}` | Sets read_at=now on own unread; ids empty/null = all. |
| GET | /v1/notifications/preferences | yes | | `{habit_summary_hour:int|null, backup_attachment:bool, backup_frequency:"monthly"|"weekly", categories:[{id,label,locked,push,email}], push_available:bool}` | Defaults when no row: null/false/"monthly". push_available = VAPID key configured. |
| PUT | /v1/notifications/preferences | yes | `{channels?: {cat:{chan:bool}}, habit_summary_hour?: int 0..23 or null, backup_attachment?: bool, backup_frequency?: "monthly"|"weekly"}` | same as GET | channels merged per cat/channel into stored; unknown or locked categories ignored; only `push`/`email` keys kept, coerced bool. Note `dict[str,dict[str,bool]]` Pydantic lax bool: accepts true/false, 0/1, "true"/"false"/"yes"/"no"/"on"/"off"/"1"/"0"... else 422. `habit_summary_hour` applied only if key present in JSON (explicit null clears; absent keeps). backup_attachment/backup_frequency: null = keep. Upsert (`INSERT ... ON CONFLICT(user_id) DO UPDATE`), new row gets channels `{}` unless set. If no updates, no write. |
| GET | /v1/notifications/push/public-key | **no** | | `{public_key}` | 404 "Push is not configured on this server" if no VAPID key. Key = base64url(no padding) of uncompressed P-256 public point (65 bytes). |
| POST | /v1/notifications/push/subscribe | yes | `{endpoint: str 10..2000 matching ^https://, keys: {str:str}}` | 201 `{ok:true}` | 404 if push not configured; missing/empty p256dh or auth, or len p256dh>200, auth>100 -> 422 "Malformed subscription"; `is_safe_public_url` false -> 422 "Unusable push endpoint"; user has >=20 subs -> 409 "Too many devices subscribed" (counted before upsert, so re-subscribing an existing endpoint at 20 still 409). Upsert on endpoint UNIQUE: sets user_id (moves between accounts), p256dh, auth, user_agent (header truncated 400, "" if missing), failures=0. |
| POST | /v1/notifications/push/unsubscribe | yes | `{endpoint: str max 2000}` | `{ok:true}` | Deletes own sub with that endpoint if any. |
| POST | /v1/notifications/push/test | yes | | `{ok:true}` | Redis rate limit `limit:push-test:{user_id}` 5 per 600s (INCR, EXPIRE on first; Redis error = allow) -> 429 "Slow down - try again in a little while.". Creates notification kind test, category security, title "Notifications are working", body "This is what a PaceStreak nudge looks like.", url "/settings/notifications"; commit; background deliver. |
| POST | /v1/notifications/unsubscribe | **no** | `{u: uuid, c: str, s: str max 64}` | `{detail: "Done - no more '<label>' emails."}` | c unknown or locked -> 400 "Invalid link"; signature mismatch -> 400 "Invalid link". Sets channels[c].email=false (merge), upsert. No user-exists check (FK violation -> 500 for nonexistent user with valid sig; unreachable without the key). |
| POST | /v1/notifications/unsubscribe/one-click | **no** | query `u`,`c`,`s` (max 64); body ignored (form `List-Unsubscribe=One-Click`) | same | Hidden from OpenAPI. Same logic. Missing query param -> 422. |

CSRF: auth layer presumably requires a CSRF header for cookie-authenticated unsafe methods (see `app/auth/router.CSRF_HEADER`); unauthenticated unsubscribe endpoints must stay reachable from a mail client with no header - check the middleware's exemption logic in the auth spec.

### Unsubscribe signing
- secret = SHA256(`b"unsubscribe:" + JWT_PRIVATE_KEY (PEM text, utf-8)`) raw 32 bytes.
- sig = HMAC-SHA256(secret, `"{uuid}:{category}"`).hexdigest()[:32] (lowercase hex). uuid in canonical lowercase hyphenated form. Compare constant-time.
- Link: `{FRONTEND_URL}/unsubscribe?u={uid}&c={cat}&s={sig}`; one-click: `{PUBLIC_API_URL rstrip /}/v1/notifications/unsubscribe/one-click?u=..&c=..&s=..`.
- Headers on non-security emails: `List-Unsubscribe: <one_click>, <link>`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- Port: WebCrypto `crypto.subtle.importKey('raw', sha256bytes, {name:'HMAC',hash:'SHA-256'})`. Must use the same JWT private key PEM string byte-for-byte (old emailed links keep working).

### notify() (service)
`INSERT INTO notifications (...) ON CONFLICT ON CONSTRAINT uq_notification_dedupe DO NOTHING RETURNING id`; title[:120], body[:400] (if body truthy else null). Returns id or None. Note: unique(user_id, dedupe_key); NULL dedupe_key never conflicts (Postgres and SQLite agree on NULLs distinct). D1: `INSERT ... ON CONFLICT(user_id, dedupe_key) DO NOTHING RETURNING id` works in SQLite >=3.35. Python slicing counts code points; JS `.slice` counts UTF-16 units - use `Array.from(s).slice(0,n).join('')` for emoji titles.

### deliver(ids) (after response / after each worker job)
For each notification (fresh session, errors per note logged and swallowed, one commit at end):
1. channels = channels_for(user prefs, category).
2. If `data.group_id` set and the user's `group_members.muted` for that group is true -> skip all channels (inbox only).
3. profile = user's profile.
4. Push if: channels.push AND vapid key AND (category=="security" OR not in quiet hours) AND not quiet day. Quiet hours: local hour h (profile tz); start==end -> never; start>end (wrap) -> h>=start or h<end; else start<=h<end. Quiet day: category in NUDGE set and bit `weekday()` (Mon=0) of profile.quiet_days set. Note security bypasses quiet hours but quiet_day only applies to nudges anyway.
   - payload JSON: `{"title","body": body or "", "url": url or "/", "tag": kind, "id", "actions": data.actions[:2] or []}` (Python json.dumps: `", "` and `": "` separators; whitespace irrelevant to the SW).
   - For each sub: webpush with VAPID (claims sub = `VAPID_SUBJECT` default `mailto:hello@pacestreak.com`; pywebpush sets `aud` = endpoint origin, `exp` = now+12h), TTL 43200, timeout 10s, encoding aes128gcm (pywebpush default). Status 404/410 -> delete sub. 2xx -> last_success_at=now, failures=0. Else (incl. 0 transport error) failures += 1; >=10 -> delete.
   - Sequential per subscription, each in a thread.
5. Email if channels.email AND not quiet day (quiet hours do NOT apply to email): user exists, is_active, and (is_verified or category security). Headers = list_headers unless security. Body = `_email_body`: lines `[body or title, ""]`, if url: `Open PaceStreak: {FRONTEND_URL}{url}`, ""; if not security: `---`, `You get these because '{label}' email is on.`, `Turn it off: {unsubscribe_link}`; joined with `\n`. If `data.export_attachment`: `export_attachment(db,user_id)` (app/account/backup, zip) -> attached and body prefixed with fixed paragraph ("Your PaceStreak data for this month is attached as a zip: ... journal.\n\n"). `send_email(to, subject=title, body, headers, attachments=)`.

### VAPID key
- `VAPID_PRIVATE_KEY_PEM` env (literal `\n` sequences replaced with newlines) else file `VAPID_PRIVATE_KEY_PATH` (`./keys/vapid_private.pem`). Python writes the env PEM to a temp 0600 file because pywebpush wants a path - drop on Workers; import PEM (PKCS8 or SEC1 "EC PRIVATE KEY"! - `make vapid` probably produces one of these; WebCrypto only imports PKCS8, so convert SEC1 at deploy or parse it) into WebCrypto ECDSA P-256.
- Public key derivation: export JWK, build `0x04||x||y`, base64url no pad. Must be identical to current so existing browser subscriptions stay valid (applicationServerKey must not change).

### Tables
`notifications`(id, user_id FK cascade, kind≤30, category≤20, title≤120, body≤400, url≤200, actor_id FK SET NULL, data JSONB, dedupe_key≤120, read_at, created_at; UNIQUE(user_id,dedupe_key), idx(user_id,created_at)), `notification_preferences`(user_id UNIQUE, channels JSONB default {}, habit_summary_hour smallint, backup_attachment bool default false, backup_frequency varchar(8) default 'monthly'), `push_subscriptions`(user_id, endpoint TEXT UNIQUE, p256dh, auth, user_agent, last_success_at, failures int default 0). Reads `profiles`, `users`, `group_members`.

---

## 3. Admin (`/v1/admin`), 9 routes

Role gate: `require_moderator` (role in moderator/admin) and `require_admin` (role == admin). **Failure returns 404 "Not found"** (hides the admin surface), not 403. Unauthenticated -> 401 from get_current_user.

`audit(db, actor, action, target_type, target_id, detail)` inserts `audit_log` (append-only).

`_who(p)`: `{id, handle, display_name, email: null (u never passed in reports), suspended: bool(social_suspended_at)}`, null if no profile.

| Method | Path | Gate | Request | Response / behaviour |
|---|---|---|---|---|
| GET | /v1/admin/reports?status=open | mod | `status` regex `^(open|actioned|dismissed)$` default open | Up to 200 reports with that status ORDER BY created_at DESC. Each `{id,target_type,target_id,reason,detail,snapshot,status,created_at,resolution,reporter:_who,reported:_who|null,prior_actioned:int}`. prior_actioned = count of reports with status actioned grouped by reported_user_id, for ids among reporters ∪ reported (keyed by reported_user_id). |
| POST | /v1/admin/reports/{report_id}/resolve | mod | `{action: dismiss|hide_content|suspend_user|hide_and_suspend, note?: str ≤200}` | 404 if missing. hide (hide_content/hide_and_suspend and target_type != "user"): model by target_type (comment->comments, event->activity_events, group->groups, challenge->challenges; any other type -> KeyError -> 500), set `hidden_at=now` if found. suspend (suspend_user/hide_and_suspend and reported_user_id): profile.social_suspended_at=now, leaderboard_opt_in=false. status = dismissed if dismiss else actioned (even when nothing actually hidden); resolved_by, resolved_at, resolution = note or action. Siblings: other open reports with same target_type+target_id get same status/resolver/time, resolution `"grouped with {report.id}"`. If reported_user_id and (hidden or suspended): notify reported user kind "moderation", category security, title "Some of your content was removed" if hidden else "Your social features are paused", body "A moderator reviewed a report. Your training log is unaffected and still yours to use and export.", url "/settings/privacy". Audit action `report.{action}`, target (target_type, target_id), detail `{report, note, grouped:n}`. Commit; background deliver. Returns `{status, grouped}`. |
| GET | /v1/admin/users?q= | mod | q ≤100 | `users LEFT JOIN profiles`, if q: term `%{q.strip().lower()}%`, `email ILIKE term OR handle ILIKE term` (q's %/_ NOT escaped). ORDER BY users.created_at DESC LIMIT 100. Each `{id,email,handle,display_name,role,is_active,is_verified,created_at,social_suspended,official,deletion_scheduled_at|null,reports: count of all reports against user}`. |
| PATCH | /v1/admin/users/{user_id} | mod | `{role?: user|moderator|admin, social_suspended?: bool, is_active?: bool}` | 404 if user missing. role or is_active set by non-admin -> 403 "Admins only". Self with role set or is_active false -> 409 "Not on your own account". role -> set. social_suspended -> profile (if exists) social_suspended_at = now or null; true also leaderboard_opt_in=false; changes recorded only if profile exists. is_active -> set; false -> `revoke_all_sessions(db,target)`. Audit "user.update" ("user", id, changes). Commit; then `finish_revoke_all(user_id)` **always** (cache/session invalidation, auth module). Returns `{ok:true, **changes}`. |
| POST | /v1/admin/users/{user_id}/official | admin | `{official: bool, handle?: str ≤31}` | 404 if no profile or profile.onboarded_at null. If handle given: `_check_handle(handle, allow_reserved=official)` (profile module; raises its own 422s) then `_handle_taken` -> 409 "That handle is taken". If revoking, no handle, and current handle `is_reserved` -> 409 "This account holds a reserved handle; give it an ordinary one to revoke". Set is_official, handle; when revoking and display_name `mentions_brand` -> display_name=null. Audit "user.official" detail `{before:{official,handle}, after:{...}}`. Returns `{official, handle}`. |
| POST | /v1/admin/users/{user_id}/merge | admin | `{into: uuid, confirm_email: str 3..320, keep_source_profile: bool=false}` | user_id==into -> 422 "Pick two different accounts"; user_id==admin -> 409 "Sign in as another admin to merge this account away"; either missing -> 404; `confirm_email.strip().lower() != source.email.lower()` -> 422 "Type the source account's email to confirm". `merge_accounts`; audit "user.merge" target ("user", into) detail `{source, source_email, moved}`; commit; `game.service.recompute(db, into, notify=False)`; commit; `auth.cache.invalidate_user` for both ids (Redis). Returns `{merged_into, moved:{table:count}}`. Order of checks matters (422 self before 409 admin before 404). |
| GET | /v1/admin/audit | mod | | Last 200 audit_log rows DESC, LEFT JOIN actor profile: `{id,action,target_type,target_id,detail,created_at,actor: handle|null}`. |
| GET | /v1/admin/metrics | mod | | `today = UTC date`. `{users: count users, onboarded: profiles with onboarded_at, active_1d/7d/30d: user_stats.last_active >= today-N, sessions_7d: workouts deleted_at null and local_date >= today-7, open_reports, suspended: profiles social_suspended_at not null, signups_by_week: [{week: date iso, count}], worker: worker_state()}`. signups: `date_trunc('week', users.created_at)` (ISO Monday, in DB session tz - UTC) over last 12 weeks (created_at >= now-84d), ordered. worker_state: `{status:"never_ran", last_tick_at:null}` or `{status: ok|stale, last_tick_at, age_seconds, duration_ms, failing_ticks, jobs}` from worker_heartbeats name "scheduler". |

(8 routes listed + metrics = 8 in this router; count: reports, resolve, users, patch user, official, merge, audit, metrics = 8.)

### merge_accounts algorithm (Postgres-catalog driven - **biggest porting hazard**)
1. Discover every FK column referencing `users` via `pg_constraint/pg_class/pg_attribute` in current schema, ordered by table, column.
2. NOT_MOVED tables skipped: refresh_tokens, one_time_tokens, passkeys, recovery_codes, webauthn_challenges (they get cascaded away with source).
3. keep_source_profile: delete dest's rows in `profiles`, `user_stats` first.
4. For each table (excluding NOT_MOVED): if ≥2 user-FK columns, for each ordered pair (a,b), a≠b: `DELETE WHERE a=:s AND b=:d` (drops would-be self-links, both directions).
5. For each column: try bulk `UPDATE t SET c=:d WHERE c=:s` inside SAVEPOINT; on IntegrityError rollback and go row-by-row by `ctid`: each update in savepoint; on IntegrityError delete that row (destination wins).
6. `DELETE FROM users WHERE id=:s` (cascades remaining, incl. credentials).
7. Return `{table: moved}` for moved>0, sorted by table name.
Note: `audit_log.actor_id` etc. if FK to users are moved too. Port options for D1: `PRAGMA foreign_key_list(<table>)` over `sqlite_master` tables (D1 supports PRAGMA table_list/foreign_key_list), `rowid` instead of ctid, and no SAVEPOINT in D1 batch -> emulate: per-row `UPDATE OR IGNORE` then `DELETE WHERE c=:s` (rows left after OR IGNORE are the colliding ones) - this is equivalent and transaction-free; wrap all in one `db.batch()` for atomicity. Beware tables WITHOUT ROWID. Also CHECK-constraint failures (e.g. self-follow CHECK) are IntegrityErrors in PG - `OR IGNORE` covers CHECK? No: SQLite `OR IGNORE` does not ignore CHECK violations in all versions (it does: IGNORE applies to UNIQUE, NOT NULL, CHECK, PRIMARY KEY; not FOREIGN KEY). FK violation impossible here since dest exists.

---

## 4. Worker (`app/worker.py`)

Today: `python -m app.worker --once` run by GitHub Actions cron every 5 min (`Worker tick` workflow); long-running mode sleeps `WORKER_INTERVAL_SECONDS` (default 120). Port: Cloudflare Cron Trigger (`*/5 * * * *` or tighter) calling `tick()` in `scheduled()`.

### tick()
1. Lock: Redis `SET worker:tick 1 NX EX max(30, interval-5)`; not acquired -> return (no heartbeat). Redis error -> proceed. Port: D1 lease row / Durable Object, or rely on single cron (Workers cron can overlap if a run exceeds the interval).
2. Jobs in order; each in try/except; list results -> `deliver(ids)` immediately then replaced by count. Report `{name:{result:int}}` or `{name:{error: ExceptionClassName}}`.
3. `record_heartbeat(report, duration_ms)`: upsert `worker_heartbeats` name "scheduler": last_tick_at=now, duration_ms, jobs=report, failing_ticks = failing_ticks+1 if any error else 0 (insert value 1/0), updated_at=now. Errors swallowed.

### Hour matching
`_local_hour_is(col)` = SQL `EXTRACT(hour FROM timezone(profile.timezone, now())) = col` - **Postgres tz database in SQL**. D1 has no tz support: fetch candidates and filter in JS with `Intl.DateTimeFormat(tz,{hour:'numeric',hourCycle:'h23'})`. Since ticks run every 5 min (or 2), each job fires every tick within the matching hour; idempotency is entirely via dedupe keys. Candidate sets are capped (5000 / BATCH*10=5000) - keep caps but apply after tz filter or prefilter by a precomputed UTC offset.

### Jobs

| # | name | Selection | Action | Dedupe / idempotency |
|---|---|---|---|---|
| 1 | stats `refresh_stale_stats` | `user_stats JOIN profiles WHERE computed_for < current_date + 1 ORDER BY computed_at LIMIT 500` (current_date in DB tz=UTC) | For each where `computed_for < local_today(tz)`: `recompute(user, notify=False)`, commit (own session each). Returns count (int). | Recompute is idempotent. Note filter `< current_date+1` i.e. `<= UTC today` — rows already computed for UTC today but local date ahead still pass; rows with computed_for = UTC tomorrow (users ahead of UTC) are excluded until UTC catches up... reproduce exactly. |
| 2 | nudges `streak_nudges` | profiles JOIN users: onboarded, not scheduled for deletion, active, local hour == (reminder_mode=='smart' AND learned_reminder_hour not null ? learned_reminder_hour : reminder_hour), LIMIT 5000 | `snapshot(user)` (game service). If `paused_today` skip. For each chain view: skip unless `at_risk` and not (current==0 and this_week_days==0). end weekday name = WEEKDAYS[(week_start(today, week_starts_on).weekday()+6)%7] (day before week start). Body variants: will_freeze / needed>days_left (out of reach) / default (see text in source lines 140-155; "session"/"sessions" by needed==1). Title `"Your {current}-week streak needs {needed} more"` if current else `"'{chain}' needs {needed} more this week"`. kind/category streak_risk, url "/". If none sent: main=chains[0]; planned = training_days bitmask (Mon=bit0) or (null and main.needed>0); if planned and no `snap.days` entry for today -> reminder kind/category "reminder", title "Training today?", body "{this_week_days} of {this_week_target} this week. Ten seconds to log it.", url "/log". | `risk:{chain_id}:{today}`; `reminder:{today}` (local date). `sent_risk` true only if insert wasn't deduped -> after first tick, risk dedupes so `sent_risk` false and the reminder branch may fire later in the same hour! (behaviour to preserve or flag). |
| 3 | habits `habit_reminders` | habits JOIN profiles JOIN users LEFT JOIN prefs: remind_hour not null, not archived, kind != 'quit', onboarded, no deletion, active, prefs.habit_summary_hour IS NULL (also true with no prefs row), local hour == remind_hour, LIMIT 5000 | Skip if `_habit_off_today` (not `scheduled(days_mask, today)` or habit paused_from<=today<=paused_until(open-ended)), or any StreakPause active today, or done today (`habit_logs` amount for today and `is_done(kind, amount, daily_goal)`). `_remind`: title `"{emoji} {name}".strip()`, body `cue + ". "` (if cue) + (`"Today's goal: {goal:g} {unit}."` for duration/count with daily_goal, else "One tap when it's done."), url `/habits/{id}`, data.actions [done "Done", snooze "In 1 hour"] with `action_url(user, habit, action, day)` signed URLs (habits module). kind habit_reminder, category habits. Single commit at end. | `habit:{habit_id}:{today}` |
| 4 | habit_snoozes `snoozed_reminders` | habits JOIN profiles JOIN users: snoozed_until not null and <= now, active, no deletion, LIMIT 5000 | Clear snoozed_until (always, committed). Skip archived/quit/off-today/paused/done. Else `_remind`. | `habit-snooze:{habit_id}:{due.isoformat()}` (Python isoformat of tz-aware UTC datetime incl. microseconds and `+00:00` - must match format exactly only for in-flight duplicates; any stable format fine after cutover) |
| 5 | habit_summary | profiles JOIN users JOIN prefs: habit_summary_hour not null, onboarded, no deletion, active, local hour == habit_summary_hour, LIMIT 5000 | Skip if paused. Habits: own, not archived, kind!='quit', started_on<=today. Open = not off today and not done. n>0 -> title `"{n} habit(s) still open today"` (`habit` if 1), body "A few minutes now keeps the week on track.", url "/habits", kind habit_summary, cat habits. | `habit-summary:{today}` |
| 6 | digest `weekly_digest` | onboarded/no deletion/active, local hour 9, LIMIT 5000 | If local weekday == week_starts_on: last_week = week_start(today)-7; snapshot; `build_recap(db,snap,last_week)` (game.recap) None -> skip; `digest_lines(recap)` -> title, body; kind weekly_digest, cat digest, url `/recap?week={last_week}`. | `digest:{last_week}` |
| 7 | challenges `resolve_challenges` | `groups.router.resolve_finished(db, utcnow().date())` | returns notification ids | inside groups module |
| 8 | backup `monthly_backup` | profiles JOIN users JOIN prefs (inner: no prefs row = never): onboarded/no deletion/active, local hour 9, LIMIT 5000 | channels_for(prefs,"backup") neither push nor email -> skip. weekly: weekday==week_starts_on; monthly: local day==1. period = ISO `%G-W%V` (e.g. 2026-W42) or `%Y-%m`. Title `"Your {weekly|monthly} PaceStreak backup"`. Body: attach and email -> "A new {week|month}, and a copy of everything you've logged." else "A new {week|month}. Download a copy of everything you've logged - one tap, and it's yours to keep.". url `/settings/data?backup=1`; data `{"export_attachment": true}` iff attach and email on. kind monthly_backup, cat backup. | `backup:{period}` |
| 9 | buddies `buddy_nudges` | all `buddy_pairs` status active; profiles & user_stats of both sides | For each direction (helper,buddy): need both profiles and buddy stats with non-empty `recent_weeks`; helper's local hour == 17; `recent_weeks[-1] == "open"`; buddy today/week via buddy tz & week_starts_on; days_left = (week+6 - today)+1; needed = this_week_target - this_week_days; require `0 < needed <= days_left <= 2`. Notify helper: kind buddy_at_risk, cat social, title `"@{handle} needs {needed} more this week"`, body "Your buddy streak rides on it. A quick word of encouragement goes a long way.", url "/buddies", actor buddy. No onboarded/active/deletion filter here. Single commit. | `buddy-risk:{pair_id}:{buddy_id}:{week}` |
| 10 | purge `purge_deleted_accounts` | profiles where deletion_scheduled_at < now | Collect body_photos.object_key for those users; `DELETE users` each (FK cascade); commit; then `storage.delete_objects(keys)` (R2). Returns count. | Naturally idempotent; R2 failure after commit leaks objects (existing behaviour). D1: requires `PRAGMA foreign_keys=ON` semantics (D1 enforces FKs by default) and every FK must have ON DELETE CASCADE in the SQLite schema. Use R2 binding `bucket.delete(keys)` (max 1000 per call). |
| 11 | housekeeping | | Delete notifications created >180 days ago; trash_items purge_after < now; webauthn_challenges expires_at < now; `ops.service.sweep`: auth_failures created_at < now-RETENTION, client_errors last_seen < now-RETENTION. Returns None -> result 0. | idempotent |
| 12 | error_alerts | Redis `SET worker:error-alert 1 NX EX 3600`; not acquired -> 0; Redis error -> proceed | client_errors with alerted_at null and first_seen >= now-1d, ORDER BY count DESC LIMIT 20. None -> 0. Email every active admin: subject `"PaceStreak: {n} new app error(s)"`, body `"{n} new kind(s) of error in the app since the last alert:\n\n" + lines + "\n\nDetails: Admin > Ops in the app."`, line `"- {message[:200]}\n  at {path or '?'} - {count} time(s), first {first_seen:%Y-%m-%d %H:%M} UTC"`. Set alerted_at=now. Note: the Redis gate is taken even when there are no new errors (so at most one check per hour). | alerted_at |

Each list-returning job's ids are delivered (push/email) right after that job.

Timezone helpers: `local_now(tz) = utcnow().astimezone(ZoneInfo(tz))` (`zone()` may fall back for invalid tz - see app/common/time.py). `week_start(day, wso) = day - ((day.weekday() - wso) % 7)` with Monday=0 (JS `getUTCDay()` is Sunday=0 - convert: `(d+6)%7`). `quiet_days` and `training_days` bitmasks use Monday=bit0.

---

## 5. Porting hazards

| Area | Python / PG feature | Workers/D1 replacement |
|---|---|---|
| Web push | `pywebpush` (+ `py_vapid`, `http_ece`, `cryptography`) | No Node-crypto-free mature lib guaranteed; options: `@block65/webcrypto-web-push`, `web-push-browser`, or hand-roll RFC 8291 aes128gcm + RFC 8292 VAPID JWT (ES256) with WebCrypto (`ECDH`, `HKDF`, `AES-GCM`). `web-push` (npm) needs Node `crypto`/`https` - works only partly under `nodejs_compat`; avoid. |
| VAPID key | PEM file / env, temp file | Secret `VAPID_PRIVATE_KEY_PEM`; WebCrypto importKey pkcs8 (convert SEC1 EC key once with openssl `pkcs8 -topk8 -nocrypt`). Keep same key. |
| SSRF guard | `socket.getaddrinfo` + `ipaddress.is_global` | No DNS resolver in Workers. Use DoH (`fetch('https://cloudflare-dns.com/dns-query?name=..&type=A/AAAA', accept application/dns-json)`) + `ipaddr.js` (npm) range check replicating `is_global` (exclude private, loopback, link-local, CGNAT 100.64/10, reserved, unspecified, multicast, 192.0.0/24, 198.18/15, docs ranges, IPv6 ULA/fe80/::ffff mapped etc.). Workers fetch can't reach private networks anyway, so risk is lower, but tests (test_push_ssrf.py) assert rejection of internal literals - keep literal checks at minimum. Or allowlist known push-service hosts (fcm.googleapis.com, *.push.apple.com, updates.push.services.mozilla.com, *.notify.windows.com) - behaviour change, flag. |
| Background tasks | FastAPI BackgroundTasks for deliver | `c.executionCtx.waitUntil(deliver(...))` (30s wall limit after response on paid; CPU limits). |
| Push fan-out | thread per send | `Promise.all` with care; subrequest limit 50 (free) / 1000 (paid) per invocation - worker tick fans out pushes+emails for many users: batch or move to Queues. |
| Rate limits | slowapi `30/minute` per IP (Redis), custom `enforce` (Redis INCR/EXPIRE) | Workers Rate Limiting binding, or D1/KV counters; KV is eventually consistent. IP from `CF-Connecting-IP`. |
| Barcode cache | Redis GET/SET EX | KV (`expirationTtl`) or Cache API. |
| Worker locks | Redis SET NX EX | D1 lease row (`UPDATE ... WHERE expires < now RETURNING`) or Durable Object; Cron Triggers rarely overlap but can. |
| `auth.cache.invalidate_user`, `finish_revoke_all` | Redis | whatever the auth port uses (KV). |
| Timezones in SQL | `timezone(tz, now())`, `EXTRACT(hour)`, `current_date` | JS `Intl.DateTimeFormat` per row; prefilter cheaply (e.g. store/compute offsets) since 5000-row scans each tick across 5 jobs is CPU-heavy on Workers (each Intl formatter ~ms; cache formatters per tz). |
| `date_trunc('week', ...)` | PG | compute in JS or SQLite `date(created_at, 'weekday 0', '-6 days')` (Monday start). |
| ILIKE | PG case-insensitive (Unicode) | SQLite `LIKE` is ASCII-case-insensitive only; lower() also ASCII-only. Non-ASCII food names/handles differ - acceptable or use JS filtering. |
| JSONB | channels, data, items, jobs, detail, snapshot | TEXT JSON with Drizzle `mode:'json'`; merge in JS. |
| `INSERT ... ON CONFLICT ON CONSTRAINT name` | | SQLite needs conflict target columns: `ON CONFLICT(user_id, dedupe_key) DO NOTHING`. |
| merge_accounts | pg_catalog introspection, SAVEPOINT, ctid | `PRAGMA foreign_key_list`, rowid, `UPDATE OR IGNORE` + delete leftovers; one `batch()`. D1 has no interactive transactions. |
| Multi-statement transactions | SQLAlchemy session commit semantics (e.g. resolve, merge, put_preferences) | `db.batch([...])` is atomic; read-then-write races acceptable as today? (PG default READ COMMITTED too). |
| Floats/round | Python banker's round, `%g`, float parse of strings | custom `pyRound`; `%g` -> `Number(x).toString()` mostly equal (differs for ≥1e6 / 6 significant digits: `%g` gives `1e+06`, 6 sig figs). Implement `formatG`. |
| ISO week `%G-W%V` | strftime | `date-fns` `getISOWeekYear`/`getISOWeek` or hand-rolled. |
| ISO datetimes | `+00:00`, microseconds | Frontend parses with Date; format differences fine, but pagination `before` cursor must round-trip with stored precision (store ISO strings with ms or µs consistently; text comparison in SQLite requires uniform format). |
| Email attachments | `account.backup.export_attachment` zip | `fflate` (npm) for zip; mail sender (Brevo SMTP -> use Brevo HTTP API or `worker-mailer`, since raw SMTP from Workers needs `cloudflare:sockets`). |
| R2 deletes in purge | boto3 S3 | R2 binding `bucket.delete([...])`. |
| CPU | expenditure regression trivial; worker loops with per-row queries (N+1: `_paused`, `_done_today`, snapshot per profile) | Workers CPU limit (30s default paid, 10ms free!). Free plan cron CPU 10ms is impossible for this tick - needs paid Workers or chunking via Queues. |
| Webpush outgoing TTL/timeout | timeout 10s per send | `AbortSignal.timeout(10000)`. |
| httpx to OFF | 5s timeout, UA header | `fetch` + `AbortSignal.timeout(5000)`. |
| Pydantic lax coercion | e.g. "1" -> bool, int strings to floats, extra fields ignored | Zod with `z.coerce`/preprocess to mirror; extra keys ignored (not strict). |

---

## 6. Tests

| File | Covers | Notable assertions |
|---|---|---|
| tests/test_nutrition.py | entries round trip, totals, target; privacy + validation (other user's entry 404, future day 422, missing kcal 422); copy breakfast; barcode saved-first then OFF (monkeypatched fetch), 503 when unavailable; `parse_product` parametrized (serving vs 100g, no name/energy -> None); coach readiness/protein (other module) | |
| tests/test_push_ssrf.py | `is_safe_public_url` rejects 127.0.0.1, 10.x, 169.254.169.254, localhost, ::1, http://, etc.; allows a public literal; `/v1/notifications/push/subscribe` with internal endpoint -> 422 | |
| tests/test_admin_merge.py | merge moves data, drops self-links (follows/buddies between the two) and credentials (sessions/passkeys not moved); refuses merging into itself (422) and merging away the acting admin (409) | |
| tests/test_worker.py | streak-risk nudge fires once at reminder hour (dedupe on second tick); none outside hour; digest quiet without history; health endpoints; failing job recorded in heartbeat with error class name and failing_ticks increments; monthly backup opt-in and only on the 1st; weekly backup on first day of week; `_quiet_day` holds nudges back from push and email; smart reminders at learned hour; new app errors email admins once | |
| tests/test_social.py | preferences: security email can't be disabled; unsubscribe bad sig 400, good 200; muting a group keeps inbox entries (no push); admin reports queue 404 for non-mod, resolve, audit, users?q=, moderator cannot set role (403) | |
| tests/test_ops.py | `list_headers` One-Click header; POST to one-click path with form body 200; forged signature 400 | |
| tests/test_qol.py | habit_summary_hour set/clear (explicit null), habit summary job, backup attachment email via deliver with zip (send_email monkeypatched), channels merge (digest off doesn't reset backup) | |
| tests/test_features.py | `/admin/users/{id}/official`: non-admin 404, grant reserved handle, revoke requires ordinary handle 409, audit entry | |
| tests/test_buddies.py | buddy nudge lands in inbox (`/v1/notifications`) | |
| tests/test_prelaunch.py | `/v1/admin/client-errors`, `/v1/admin/abuse` (other router) | |
