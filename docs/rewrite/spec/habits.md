# Spec: habits, habit routines, journal/insights, coach

Source: `api/app/habits/{router,models,service,engine,actions,catalog,importer,routines}.py`,
`api/app/insights/{router,engine,models}.py`, `api/app/coach/router.py`.
Mounted via `app/v1/router.py` under `/v1` (order: habits, habit-routines, insights, training/habits(`/me`), …, coach).
Every `/v1/*` response carries header `PaceStreak-Version` (global middleware).
"Auth" = `get_current_user` (session cookie / bearer; see auth spec). All IDs are UUIDs; a malformed UUID or date path param → FastAPI 422 validation error (`{"detail":[...]}` pydantic shape).
Error body for HTTPException: `{"detail": "<message>"}`.
Global: `IntegrityError` anywhere → 409 `{"detail":"That was saved twice at once. Try again."}`; unhandled → 500 `{"detail":"Something went wrong on our side. Try again in a moment."}`.

Note on 422 code: `HTTP_422_UNPROCESSABLE_CONTENT` = 422.

---

## 1. Routes (24)

### 1.1 Habits — prefix `/v1/habits`

Shared helpers:
- `_context(user)`: profile = `get_profile(user.id)`; `today = local_today(profile.timezone)` (unknown tz → UTC); `sheltered = paused_days(all StreakPause rows of user)` (each span = starts_on..min(ends_on, starts_on+83 days), inclusive; `PAUSE_MAX_DAYS=84`).
- `_own(habit_id)`: load Habit by PK; missing or `user_id != user.id` → **404 "Not found"**.
- `_one(habit, days=0)`: rebuild all views (`habit_views(..., include_archived=True)`), pick the habit → `habit_summary`. If `days>0`, add `days` (logs with `day >= today - days`, ascending by day: `{date, amount, note}`) and `weeks` (`weeks_payload(chain, 26)`). If not found → 404 "Not found".
- `recompute(db, user_id, notify)` = game engine recompute (XP, stats, badges, notifications when `notify=True`). Out of scope here but **every mutating habit route calls it** (see table). It takes `pg_advisory_xact_lock(hashtext(user_id))` — Postgres-only.

| # | Method | Path | Auth | Rate limit | Status | Notes |
|---|---|---|---|---|---|---|
| 1 | GET | `/v1/habits/catalog` | **none** | – | 200 | Header `Cache-Control: public, max-age=3600`. Body `{categories:{id:label}, templates:[Template...]}` |
| 2 | GET | `/v1/habits?archived=bool(false)` | user | – | 200 | list of HabitSummary |
| 3 | POST | `/v1/habits` | user | – | **201** | body HabitIn; returns HabitSummary |
| 4 | POST | `/v1/habits/import` | user | Redis `enforce("import_habits", user.id, 20, 3600)` → 429 | 200 | multipart: `file` (required), `dry_run` form bool default false |
| 5 | PUT | `/v1/habits/order` | user | – | **204** | body `{ids: UUID[] (max 90)}` |
| 6 | GET | `/v1/habits/{id}/stats?weeks=int(26, 4..52)` | user | – | 200 | |
| 7 | GET | `/v1/habits/{id}?days=int(365, 7..730)` | user | – | 200 | HabitSummary + `days` + `weeks` |
| 8 | PATCH | `/v1/habits/{id}` | user | – | 200 | body HabitIn (partial) |
| 9 | POST | `/v1/habits/{id}/archive` | user | – | 200 | |
| 10 | POST | `/v1/habits/{id}/pause` | user | – | 200 | body `{start?: date, until?: date}` |
| 11 | POST | `/v1/habits/{id}/resume` | user | – | 200 | no body |
| 12 | POST | `/v1/habits/{id}/unarchive` | user | – | 200 | |
| 13 | DELETE | `/v1/habits/{id}` | user | – | 200 | `{trash_id}` |
| 14 | PUT | `/v1/habits/{id}/days/{day}` | user | – | 200 | body DayIn |
| 15 | POST | `/v1/habits/{id}/days/{day}/add` | user | – | 200 | body AddIn |
| 16 | PUT | `/v1/habits/{id}/days` | user | – | 200 | body BulkIn |
| 17 | POST | `/v1/habits/{id}/snooze` | user | – | 200 | body `{minutes: int 15..240}` → `{snoozed_until: iso}` |
| 18 | DELETE | `/v1/habits/{id}/snooze` | user | – | **204** | |
| 19 | POST | `/v1/habits/{id}/action?a&u&d&e&s` | **none** (HMAC link) | slowapi `30/minute` per client IP (`get_remote_address`) | 200 | push-notification button |

Route ordering: `/catalog`, `/import`, `/order` are declared before `/{habit_id}`; with UUID typing they wouldn't match anyway, but keep static routes first in Hono.

#### Schemas

**HabitIn** (POST create & PATCH; all optional, `exclude_unset` semantics matter — "present with null" ≠ "absent"):

| field | type | constraint |
|---|---|---|
| template_id | str\|null | – (create: must exist in TEMPLATE_BY_ID else 404 "No such template"; PATCH: ignored/popped) |
| name | str\|null | len 1..60 |
| emoji | str\|null | len 1..8 (Python len = code points! not UTF-16 units) |
| category | str\|null | in HABIT_CATEGORIES else 422 ("unknown category", pydantic error) |
| kind | "check"\|"duration"\|"count"\|"quit"\|null | |
| unit | str\|null | max 20 |
| daily_goal | float\|null | >0, ≤100000 |
| weekly_target | int\|null | 1..7 |
| time_of_day | "morning"\|"afternoon"\|"evening"\|"anytime"\|null | |
| cue | str\|null | max 120 |
| why | str\|null | max 200 |
| total_goal | float\|null | >0, ≤10,000,000 |
| remind_hour | int\|null | 0..23 |
| days_mask | int\|null | 1..127 (Mon=bit0 … Sun=bit6) |

HABIT_CATEGORIES = health, fitness, learning, mind, social, productivity, money, home, creative, break, other.

**DayIn**: `amount: float 0..100000` (required), `note: str|null max 280` (presence matters).
**AddIn**: `amount: float >0..100000`, default 1.
**BulkIn**: `days: [{date: date, amount: float 0..100000}]`, length 1..61.
**PauseIn**: `start: date|null`, `until: date|null`.
**SnoozeIn**: `minutes: int 15..240`.
**OrderIn**: `ids: UUID[]` max length 90.

**HabitSummary** (response, from `habit_summary`):
```
id, name, emoji, category, kind, unit, daily_goal, weekly_target, time_of_day, cue, why,
total_goal, remind_hour, days_mask,
scheduled_today: bool  (days_mask null OR bit (today.weekday) set; Mon=0)
paused_from: iso|null, paused_until: iso|null,
paused: paused_from!=null && paused_from<=today && (paused_until==null || today<=paused_until)
snoozed_until: iso datetime|null (Python isoformat of tz-aware dt: "2026-10-17T12:34:56.123456+00:00")
template_id, started_on: iso, archived: bool, position: int,
today: {amount: float (by_day[today] or 0.0), done: today in done_days},
streak: {current, longest, this_week_days, this_week_target, needed, days_left, at_risk,
         freezes_available, consistency},
strength: int, total: float, clean_run: int|null, best_clean_run: int|null, last_slip: iso|null,
recent: [7 × {date, amount (0.0 default), note|null}]  oldest first, today-6..today
```
Number formatting hazard: Python serialises floats as `1.0`, JSON clients see `1`; JS `JSON.stringify(1.0)` → `1`. Fine. But `daily_goal` stored as float.

**weeks_payload cell**: `{week_start: iso, days, target, status, score}`; status ∈ kept|frozen|repaired|paused|missed|open; `score = round(min(min(1, days/target), requirement_ratio)*100)` (Python banker's rounding! see hazards).

#### Per-route logic

**2 list**: `habit_views(include_archived=archived)`, then filter `archived or archived_at is None` (i.e. `?archived=true` returns both live and archived). Order: `position ASC, created_at ASC`.

**3 create**:
1. count live habits (archived_at null); `>= 30` → **409** `"30 habits at once is the limit. Fewer, kept, beats more, dropped."`
2. If template_id: base = template fields (name, emoji, category, kind, unit, daily_goal, weekly_target, time_of_day, cue, total_goal). Unknown → **404 "No such template"**.
3. data = base ∪ explicitly-set body fields except template_id (explicit null overrides template value!).
4. `!data.name` → **422 "Give the habit a name"**.
5. kind = data.kind or "check". If kind ∈ {duration,count} and falsy daily_goal → daily_goal=1.
6. Row: name.strip(); emoji or "✨"; category or ("break" if quit else "other"); unit = (unit or "minutes") if duration else unit; daily_goal only for duration/count else null; weekly_target or 7; time_of_day or "anytime"; cue/why stripped → null if empty; total_goal only duration/count; remind_hour; days_mask (null if quit); template_id; started_on=today; position=count.
7. `_fit_schedule(explicit_target = "weekly_target" in data)` — note `data` includes template base, so a template always counts as explicit target.
8. insert, recompute(notify=False), commit, return `_one`.

**_fit_schedule(habit, explicit)**: quit → days_mask=null, return. days_mask null → return. planned = popcount(mask). If `!explicit || weekly_target > planned` → weekly_target = planned.

**4 import** (multipart):
1. rate limit (429 "Slow down - try again in a little while."; fails open on Redis error).
2. read up to 5MB+1 bytes; `parse(filename, bytes)`; HabitImportError → **422** with its message.
3. live habits (non-archived); `by_name` keyed by `name.casefold()` (JS: `toLowerCase()` is close but not identical — casefold maps ß→ss etc.).
4. new = parsed not in by_name; `len(live)+len(new) > 30` → **409** `"That would make more than 30 habits. Archive some first."`
5. preview per parsed habit (in parse order): `{name, days: count(d<=today), first: iso|null, last: iso|null, merge: bool}`.
6. dry_run → `{habits: preview, imported_days: 0}`.
7. Else for each parsed: days filtered `<= today`; skip if empty. If no existing: create Habit(name, kind = check if binary else count, daily_goal = null if binary else 1, weekly_target = min(7, max(1, round(len(days)/weeks))) where weeks = max(1, (last-first+1 days)/7) (float), started_on=first, position=len(live)+i; other fields default: emoji ✨, category other, time_of_day anytime). Insert logs only for days not already logged for that habit (never overwrite). `started_on = min(started_on, min(days))`. Count imported.
8. recompute(notify=False), commit → `{habits: preview, imported_days}`.

**5 order**: for index,id: if habit exists and owned → position=index (unknown/foreign ids silently skipped). No recompute. 204 empty.

**6 stats**: `_own` (404). cells = weeks_payload(chain, weeks); counted = status not in (open, paused); kept = status in (kept, frozen, repaired). Return `{weeks: cells, weeks_counted, weeks_kept, keep_rate: round(100*kept/counted) or 0}`.

**7 get**: `_one(days=days)` → summary + `days` (since today-days, inclusive) + `weeks` (26).

**8 PATCH**: `_own`. data = set fields minus template_id. If "kind" present and != habit.kind → **422** `"A habit's kind can't change, since its history means something different. Start a new one instead."` (note: `kind: null` present also differs → 422). For each key: if name and falsy → skip; strings stripped, empty → null; setattr (explicit null clears; **no not-null guard** — `emoji:null`, `time_of_day:null`, `weekly_target:null`, `category:null` would violate NOT NULL → IntegrityError → 409 "That was saved twice at once"; replicate or validate). Note PATCH doesn't enforce kind-based goal rules (can set daily_goal on a check habit). If "days_mask" in data → `_fit_schedule(explicit="weekly_target" in data)`; elif "weekly_target" in data → `_fit_schedule(explicit=True)`. Recompute(notify=False), commit, `_one`.

**9 archive**: `archived_at = archived_at or now`. Commit (no recompute!). `_one`.
**12 unarchive**: archived_at=null, commit (no recompute, no MAX_HABITS check). `_one`.

**10 pause**: start = body.start or today. Must satisfy `today-14 <= start <= today+60` else **422** "A pause can start up to 14 days back or 60 ahead.". `until < start` → 422 "It ends before it starts". `(until-start).days > 180` → 422 "Pause for six months at most; archive a habit you're done with.". Set `paused_from = max(start, habit.started_on)`, `paused_until = until`. recompute(notify=False).

**11 resume**: if paused_from != null: if `paused_from >= today` → both null; else `paused_until = today-1`. (If not paused, no-op but still recomputes.) recompute(notify=False).

**13 delete**: load all HabitLogs of habit; `put_in_trash(db, user.id, "habit", habit.id, f"{emoji} {name}", habit, {"habit_logs": logs})` (trash spec — serialises row + children for 30-day restore); delete habit (FK CASCADE deletes logs); recompute(notify=False); `{trash_id: str}`. Habit routines keep the id in their JSON; it drops out on read.

**_check_day(day, today)**: `day > today` → 422 "That day hasn't happened yet"; `day < today-60` → 422 "Days can be filled in up to 60 days back".

**14 PUT day** (idempotent):
- row = log(habit, day).
- `note_set = "note" in body` (key present in JSON, even null).
- note = note_set ? (strip(body.note or "") or null) : null.
- keep_note = !note_set && row && row.note.
- If amount <= 0 && !note && !keep_note → delete row if exists.
- Else upsert: create with amount if missing; row.amount = amount; if note_set → row.note = note; if amount>0 → started_on = min(started_on, day).
- recompute(**notify=True**), commit, `_one` (no days/weeks).

**15 POST add**: _check_day; row missing → create amount 0; `amount = min(100000, amount + body.amount)`; started_on = min(started_on, day) (always). recompute(notify=True).

**16 PUT days bulk**: duplicate date → 422 `"{date} appears twice"` (date iso); each _check_day (first failure wins; checks are interleaved with the dup check in list order). Fetch existing logs for those dates. For each: amount<=0 → if row && !row.note delete; elif row → amount=0; (no row → nothing). amount>0 → insert or update amount; started_on=min. recompute(notify=True).

**17 snooze**: `snoozed_until = utcnow + minutes`; commit; `{snoozed_until: isoformat}` (e.g. `2026-10-17T10:00:00.123456+00:00`). No recompute.
**18 unsnooze**: null; 204.

**19 action** (unauthenticated, signed):
- Query params: `a: str`, `u: UUID`, `d: date`, `e: int`, `s: str` — all required (missing → 422).
- `verify(u, habit_id, a, d.isoformat(), e, s)`: false → **403 "This link has expired"**. False when `a ∉ {done, snooze}` or `e < now_epoch` or HMAC mismatch.
- habit missing, `user_id != u`, or archived → 404 "Not found".
- a=="snooze": snoozed_until = now + 60 min; commit → `{snoozed_until}`.
- a=="done": goal = 1.0 if check else (daily_goal or 1). Row missing → insert amount=goal (user_id=u). Row exists and not is_done(kind, amount, daily_goal) → amount=goal. snoozed_until = null. recompute(u, notify=True). → `{done: true}`. Quirk: for **quit** habits "done" logs amount = goal (≥1) = a slip. Day is not range-checked and started_on is not moved.

**HMAC** (`actions.py`): secret = `sha256(b"habit-action:" + JWT_PRIVATE_KEY_PEM_utf8)` raw 32 bytes. message = `f"{user_id}:{habit_id}:{action}:{day}:{expires}"` (UUIDs lowercase hyphenated). sig = `hex(HMAC-SHA256(secret, message))[:40]`. Constant-time compare. Lifetime 18h. `action_url` = `{PUBLIC_API_URL.rstrip('/')}/v1/habits/{habit_id}/action?a={action}&u={user_id}&d={day}&e={expires}&s={sig}` (used by the worker's reminder push). JS: WebCrypto `crypto.subtle.importKey('raw', …, {name:'HMAC',hash:'SHA-256'})`; `timingSafeEqual` via `crypto.subtle.timingSafeEqual` (Workers) — must compare equal-length; Python compare_digest on unequal lengths returns false.

### 1.2 Habit routines — prefix `/v1/habit-routines`

MAX_ROUTINES=10, MAX_STEPS=20. Model: `habit_routines(id, user_id, name ≤60, emoji ≤8 default 🌅, time_of_day default morning (CHECK), habit_ids JSONB list[str], created_at…)`.

**RoutineIn**: `name: str 1..60` (required), `emoji: str 1..8 = "🌅"`, `time_of_day: morning|afternoon|evening|anytime = "morning"`, `habit_ids: UUID[] 1..20`.

Out: `{id, name, emoji, time_of_day, habit_ids: [ids that are currently live (owned, not archived)]}`.

| # | Method | Path | Auth | Status | Logic |
|---|---|---|---|---|---|
| 20 | GET | `/v1/habit-routines` | user | 200 | list ordered by created_at ASC, each filtered to live ids |
| 21 | POST | `/v1/habit-routines` | user | **201** | count ≥10 → 409 "10 routines is the limit"; `_fill`; insert |
| 22 | PUT | `/v1/habit-routines/{id}` | user | 200 | `_own` (404 "Not found"); `_fill`; full replace |
| 23 | DELETE | `/v1/habit-routines/{id}` | user | 200 | put_in_trash(kind "habit_routine", label `"{emoji} {name}"`); delete; `{trash_id}` |

`_fill`: live = set of str ids of owned non-archived habits; ids = de-duplicated (first occurrence order) str(UUID) of body.habit_ids; any not live → **404 "A habit in this routine doesn't exist"**; set name=name.strip(), emoji, time_of_day, habit_ids. (Name strip after validation: "   " passes min_length then saves as "".) No recompute.

### 1.3 Journal & insights — no prefix (`/v1/journal`, `/v1/insights`)

Model `journal_days(id, user_id, day DATE, mood SMALLINT null CHECK 1..5, note VARCHAR(1000) null, UNIQUE(user_id, day))`.

| # | Method | Path | Auth | Status | Logic |
|---|---|---|---|---|---|
| 24 | GET | `/v1/journal?days=int(366,1..1100)&q=str(≤60)` | user | 200 | since = today-(days-1); `day >= since` (no upper bound); if q: note ILIKE `%{q with % and _ removed}%`; order day ASC → `[{date, mood, note}]` |
| 25 | PUT | `/v1/journal/{day}` | user | 200 | body `{mood?: int 1..5, note?: str ≤1000}`; day ∉ [today-60, today] → 422 "Journal days are for today or the last 60 days"; note stripped→null; both null → delete row if any, **200 with body `null`**; else upsert, set both (mood null overwrites) → `{date,mood,note}` |
| 26 | DELETE | `/v1/journal/{day}` | user | 200 | not found → `{trash_id: null}`; else put_in_trash("journal", id, `"Journal, {iso}"`, row), delete → `{trash_id}`. No date-range check |
| 27 | GET | `/v1/insights` | user | 200 | see §2.4 → `{window_days: 90, insights:[Insight], coverage:{series_key: count}}` |

Insight JSON: `{driver, outcome, text, high, low, days_high, days_low, strength}`. `coverage` includes only keys that were ever touched (defaultdict — a key appears once any value was assigned; e.g. no readiness → no "sleep"/"energy" key).

### 1.4 Coach — `/v1/coach`

| # | Method | Path | Auth | Status |
|---|---|---|---|---|
| 28 | GET | `/v1/coach/today` | user | 200 → `{date: iso, notes: [{kind, tone, title, body}]}` |

Side effect: calls `game.service.snapshot(db, user.id)` then **commits** (snapshot may write — e.g. lazily creates profile/stats; check game spec). Logic §2.5.

**Total: 28 routes** (19 habits + 4 routines + 4 journal/insights + 1 coach).

---

## 2. Business logic

### 2.1 Habit engine (`engine.py`, pure)

- `is_done(kind, amount, goal)`: quit → amount<=0; check → amount>0; else amount >= (goal or 1).
- `done_days`: non-quit → logged days with started_on<=d<=today and is_done. Quit → every day started_on..today with `by_day.get(d,0) <= 0` (clean days; unlogged = clean).
- `scheduled(mask, day)`: mask null or `(mask >> weekday) & 1` (weekday Mon=0 — JS `getUTCDay()` is Sun=0: use `(getUTCDay()+6)%7`).
- `first_week_target(target, started_on, week, mask)`: if started_on is within [week, week+7): left = days started_on..week+6; possible = count scheduled; return `max(1, min(target, possible or 1))`. Else target. (Applies to every chain week; only the start week differs.)
- `pause_days(from, until, today)`: from null → ∅; end = min(until or today, today); days from..end inclusive (empty if from>end, i.e. future pause).
- `strength(weeks)`: values = `min(1, days/target)` for cells with status != paused and (status != open or days >= target). If none: last open cell → `round(min(1, days/target)*100)` else 0. Else EMA: score=values[0]; `score += 0.25*(v-score)`; `round(score*100)`.
- `view_habit`: done = done_days; chain = `compute_chain(done, today, week_starts_on, target_for=first_week_target(...), paused_days=paused)` (no repairs, no freezes-by-repair, no requirements, no wagers); strength; `total = round(sum(amount for d<=today if kind != quit), 2)` (includes days before started_on and amount 0 rows; quit → 0); today_amount = by_day[today] or 0.0. Quit only: last_slip = max day with amount>0 within [started_on, today]; clean_run = consecutive done days back from today (stop at started_on); best_clean_run = longest run started_on..today. Non-quit → all three null.
- paused set per habit = user StreakPause days ∪ habit's own pause_days.

### 2.2 compute_chain (from `app/game/streak.py`; shared with game spec)
Constants FREEZE_EVERY=4, FREEZE_CAP=2, LOOKBACK_WEEKS=260, PAUSE_MIN_DAYS=4.
- week_start(d, wso) = d - ((weekday - wso) mod 7).
- paused_weeks = weeks with ≥4 paused days.
- per_week = count distinct active days ≤ today per week.
- iterate w from max(min(per_week) or current_week, current_week - 259 weeks) to current_week:
  - target = max(1, target_for(w)); status: count>=target → kept; elif paused → paused; elif current → open; elif repaired → repaired; elif freezes>0 && run>0 → frozen (freezes--); else missed.
  - kept & not current: kept_toward_freeze++; at 4 → reset, freezes=min(2, +1).
  - kept/frozen/repaired: run++ (record run_started at 0→1); missed: run=0. longest=max.
- this_week = last cell; days_left = (week_end - today) + (0 if today active else 1); needed = 0 if paused or kept else max(0, target-days); at_risk = needed>0 && needed>=days_left; consistency = mean score of last 4 closed non-paused cells (round), paused_now = this week paused.
- Note: **the start week of a habit with no logs** → earliest = current_week; a habit started months ago with no done days only has the current week (weeks before first done day don't exist → no "missed"). Quit habits: done days from started_on, so earliest = week of started_on.

### 2.3 Importer (`importer.py`)
- MAX_BYTES 5 MiB ("That file is over 5 MB"); per-file MAX_HABITS 60 ("More than 60 habits in one file").
- Zip if filename endswith .zip (case-insens.) or data starts `PK`. BadZip → "That zip file can't be opened". Choose member named exactly `checkmarks.csv` (case-insens., full path), else any ending `checkmarks.csv`, else the sole .csv; else "Couldn't tell which file in the zip holds the history". Uncompressed size > 5MB → over 5 MB.
- Decode: utf-8-sig, then utf-16 (will usually *succeed* on even-length garbage!), then latin-1 (always succeeds). "That file isn't text" effectively unreachable.
- `csv.Sniffer().sniff(text[:4096], delimiters=",;\t")`, fallback excel (comma). Rows with all-blank cells dropped. <2 rows → "That file has no rows to import".
- Header match (strip+lower, first option in tuple order that exists): DATE (`date, day, entry_date, completed_at, completion_date, timestamp, time`) else "Couldn't find a date column. It needs a header named Date."; at least one ISO date in first 50 body rows else "Dates must be written year first, like 2026-09-30". NAME (`habit, habit_name, name, title, task, task_title, habit name`), VALUE (`value, amount, count, quantity, duration, minutes, progress`).
- ISO regex `^(\d{4})[-/](\d{2})[-/](\d{2})` on stripped text; invalid calendar date → null.
- Number: strip, `,`→`.`, Python float() (accepts "inf", "nan", "1e3", "1_000", leading/trailing ws). JS `Number()` differs (Number("") = 0!, "1_000" NaN, "nan" NaN). Must mimic: empty → null.
- Long: per row (skip if short), name = strip()[:60] (code points); skip no date/name; value col present & in row: number null or <=0 → skip row; amount=value else 1. Group by casefold(name), first spelling kept; sum amounts per day. binary = all values == 1.
- Wide: each non-date non-empty header column; values (date,num) pairs; loop_style = 2 in set and set ⊆ {-1,0,1,2,3} → only 2 → 1; else value>0 kept (last row wins per date). binary = loop_style or all ==1. name = header.strip()[:60].
- Drop habits with no days; none → "Nothing in that file was marked done".

### 2.4 Insights (`insights/engine.py` + `build_series`)
- Window: start = today-90, end = today-1 (inclusive, BETWEEN).
- Series: `sleep`, `energy` from Readiness(day); `sleep_hours` from BodyMetric.measured_on where sleep_hours not null (if multiple rows same day, last iterated wins — unordered query!); `mood` from JournalDay with mood not null; `trained`: if any non-deleted Workout ever (min local_date), every day from max(start, first) to end = 1.0/0.0; `habits`: live non-quit habits; done if `amount >= (daily_goal or 1)` (note: check habits with daily_goal null → amount>=1, differs subtly from is_done amount>0 for fractional); value = done_count/live_count where live = habits with started_on <= day, only days with live>0; `kcal`, `protein_g` = SUM per day of MealEntry.
- `find`: for each PAIR in order: days = intersection sorted; need ≥16. Binary driver: high = value>=0.5. Else threshold = statistics.median (mean of two middle for even n); hours → round(x*2)/2 (**Python round = banker's**); score → ceil. high = >= threshold. Both halves ≥8. hi/lo = mean. gap=|hi-lo|; grams/kcal with lo>0: skip if gap < max(min_gap, 0.1*lo); else skip if gap < min_gap. t = Welch (sample variance n-1; se==0 → inf if means differ else 0); skip |t|<2. strength = round(min(|t|,99), 2); high/low round(…,3).
- Sort by -strength (stable, so PAIRS order breaks ties), keep first per outcome, cap 6.
- SERIES: sleep_hours(sleep,hours,0), sleep(sleep rating,score,0.4), energy(score,0.4), mood(score,0.4), trained(training,binary,0.1), habits(habits done,rate,0.1), protein_g(protein,grams,10), kcal(calories,kcal,150).
- PAIRS: (sleep_hours,habits),(sleep_hours,trained),(sleep_hours,mood),(sleep,habits),(sleep,trained),(sleep,mood),(energy,trained),(trained,mood),(trained,protein_g),(trained,habits),(mood,habits),(habits,mood),(protein_g,mood).
- Text formatting (exact strings):
  - fmt: rate/binary → `f"{round(v*100)}%"`; score → `"{v:.1f}/5"`; hours → `"{v:.1f} h"`; grams → `"{round(v)} g"`; kcal → `"{round(v)} kcal"`; else `{v:g}`.
  - condition(high/low): binary → "days you trained"/"days you rested"; hours → `"days after {fmt}+ of sleep"`/"shorter nights"; rate → `"days with {fmt}+ of {label}"`/"other days"; score → `"days your {label} was {threshold:g}+"`/"other days"; else `"days with {fmt}+ {label}"`/"other days".
  - sentence: outcome binary → `"You trained on {hi} of {condHigh}, against {lo} of {condLow}."`; rate → `"You kept {hi} of your habits on {condHigh}, against {lo} on {condLow}."`; else `"Your {label} averaged {hi} on {condHigh}, against {lo} on {condLow}."`
  - `.1f` uses round-half-even on the binary value; JS `toFixed(1)` is close but not identical for some values; `round()` → banker's.

### 2.5 Coach (`/coach/today`)
snapshot (game) supplies: today, paused_today, chains (each with `.chain.name`, `.result` ChainResult), last_active, habits (list of (Habit, HabitView, logs)).
- paused_today → single note `{paused, rest, "Streaks are paused", "Nothing is counting down. Rest properly; the grid will be here."}`.
- Else notes = streak_notes + readiness_notes + habit_notes + food_notes; stable sort by rank; take 4; empty → `{start, info, "Nothing to flag", "Log a session, a meal or a check-in and this fills with feedback."}`.
- plural(n, w) = `"{n} {w}"` + ("" if n==1 else "s").
- streak_notes per chain (skip paused_now), name = chain.name or "Your streak":
  - needed<=0 → week_kept/praise/rank70: title `"{name}: week kept"`, body `"{days} of {target} done. Anything more is a bonus."`
  - at_risk → at_risk/nudge/10: `"{name} needs you today"`, `"{plural(needed,'more session')} with {plural(days_left,'day')} left. Today is the day that keeps the week."`
  - else on_pace/info/40: `"{name}: {days} of {target}"`, `"{plural(needed,'more')} to go, {plural(days_left,'day')} to do it."` (→ "2 mores")
  - idle (once, not per chain): last_active && (today-last_active).days >= 5 → idle/nudge/20 "It's been a few days", `"Last session {n} days ago. Something short counts: twenty minutes beats a perfect plan you don't start."`
- readiness (today's Readiness row): sleep<=2 or energy<=2 or soreness>=4 → go_easy/rest/15 title `"{reason}: go easy"` reason = "Short on sleep"|"Low on energy"|"Still sore" (that priority); body "Train lighter or make it mobility today. An easy day still counts; an injury costs weeks."; elif sleep>=4 && energy>=4 && soreness<=2 → go_hard/praise/45 "Good day to push" / "Slept well, fresh legs. If a hard session is on the plan, today suits it."
- habit_notes: short = views with this_week_days < this_week_target and not paused_now. tight = short with at_risk → habits_at_risk/nudge/25 `"{plural(n,'habit')} at risk this week"` / "Only just enough days left to keep them. Check Today for which."; else habits_open/info/60 `"{plural(n,'habit')} still open this week"` / "Plenty of time, but a tick today makes the end of the week easier."
- food_notes(yesterday MealEntry totals (each macro rounded 1dp), NutritionTarget): none → []. protein: target.protein_g && eaten<0.8*target → protein_low/nudge/35 "Protein ran short yesterday" / `"{eaten:g} g of {target:g} g. Front-load some at breakfast today."`. kcal: target.kcal → ratio<0.75 kcal_low/info/38 "Yesterday was well under target" / `"{kcal:g} of {t:g} kcal. Training on too little makes recovery harder; if you forgot to log, ignore this."`; >1.2 kcal_high/info/55 "Yesterday was over target" / `"{kcal:g} of {t:g} kcal. One day changes nothing; the weekly trend is what counts."`; else if no protein note → food_on_target/praise/65 "Food on target yesterday" / `"{kcal:g} kcal, {protein:g} g protein."`
- `:g` formatting: 6 significant digits, strips trailing zeros, exponent if exp < -4 or >= 6 (e.g. 1234567 → "1.23457e+06"). Implement a `fmtG` helper.

### 2.6 Catalog
11 categories (ordered dict), 68 templates (copy verbatim from `catalog.py` incl. emoji with VS16). Template JSON keys order: id, name, emoji, category, kind, blurb, unit, daily_goal, weekly_target, time_of_day, cue, total_goal. daily_goal values are Python ints in source (e.g. 6) → serialised as `6` (int), total_goal 6000.

---

## 3. Data access

| Table | Columns (relevant) | Used by |
|---|---|---|
| habits | id, user_id FK CASCADE (idx), name(60), emoji(8)='✨', category(16)='other', kind(10) CHECK, unit(20), daily_goal float, weekly_target smallint CHECK 1..7, time_of_day(10), cue(120), why(200), total_goal float, remind_hour smallint CHECK 0..23, template_id(40), started_on date, position smallint, archived_at tstz, snoozed_until tstz, days_mask smallint, paused_from date, paused_until date, created_at (Base) | all habit routes, routines (live ids), insights, coach (via snapshot) |
| habit_logs | id, habit_id FK CASCADE (idx), user_id FK CASCADE, day date, amount float, note(280); UNIQUE(habit_id, day); IDX(user_id, day) | habit routes, insights |
| habit_routines | id, user_id, name, emoji, time_of_day CHECK, habit_ids JSONB | routines |
| journal_days | id, user_id, day, mood, note(1000); UNIQUE(user_id, day) | journal, insights |
| streak_pauses | user_id, starts_on, ends_on | `_context` |
| profiles | timezone, week_starts_on | `_context` |
| readiness, body_metrics, workouts(local_date, deleted_at), meal_entries(day, kcal, protein_g), nutrition_targets | read-only | insights, coach |
| trash | via put_in_trash | delete habit/routine/journal |
| user_stats, xp, badges, notifications… | via recompute | every log write |

Query shapes:
- `habit_views`: `SELECT * FROM habits WHERE user_id=? [AND archived_at IS NULL] ORDER BY position, created_at`; then `SELECT habit_id, day, amount, note FROM habit_logs WHERE user_id=?` (**all logs ever**, unbounded) — grouped in memory.
- `_one` re-runs the full views for all habits to render one (N habit routes → each request does 2 full scans + recompute's own scans).
- count live: `SELECT count(*) FROM habits WHERE user_id=? AND archived_at IS NULL`.
- bulk: `habit_logs WHERE habit_id=? AND day IN (...)` (≤61 params — fine on D1's 100-param limit).
- reorder: N individual `db.get` (≤90 queries) — batch in D1.
- journal search: `note ILIKE '%q%'` → SQLite `LIKE` is case-insensitive for ASCII only; use `lower(note) LIKE lower(?)` + ESCAPE or keep stripping %/_.
- insights: `MIN(local_date)`, `BETWEEN`, `GROUP BY day SUM(kcal), SUM(protein_g)`, `habit_id IN (...)` (≤30).

---

## 4. Porting hazards

| Area | Python | JS/Workers replacement / note |
|---|---|---|
| Dates | `datetime.date`, `timedelta`, `zoneinfo` | Temporal polyfill `@js-temporal/polyfill` or `date-fns` + `date-fns-tz` (`@date-fns/tz`); `Intl.DateTimeFormat(tz)` works in Workers for local_today. Represent dates as `YYYY-MM-DD` strings, arithmetic in UTC epoch days. Weekday Mon=0 conversion. |
| Unknown tz | falls back to UTC | catch RangeError from Intl → UTC |
| Rounding | `round()` banker's (half-even) in score, strength, keep_rate, insights round, weekly_target import, `round(x*2)/2` | write `roundHalfEven(x, nd)`; Math.round differs at .5 (e.g. strength 62.5 → 62). Affects visible numbers. |
| Float formatting | `:g`, `.1f`, `isoformat()` with microseconds | custom `fmtG`; `toFixed` vs half-even on binary repr (Python formats the exact binary value, toFixed also does → mostly equal); datetime iso: Python `+00:00` with 6-digit µs (omitted if 0) vs JS `toISOString()` `Z` + ms. App parses with `Date` so either ok, but match to be safe. |
| statistics | `mean, median, variance` | hand-roll (sample variance n-1); `math.inf` → JSON? strength capped at 99 so inf never serialised. |
| casefold | `str.casefold()` | `toLowerCase()` (+ `normalize`) — approx; ß edge case |
| String lengths | Pydantic counts code points (emoji max 8, name 60, `[:60]` slices) | use `[...s].length` / `Array.from(s).slice(0,60)`; zod `.max()` counts UTF-16 units — **emoji like 🛏️ is 2 cps but 3 units**; family emoji may exceed. Use a custom refine. |
| CSV | `csv.Sniffer`, `csv.reader` | `papaparse` (auto delimiter detection among `,;\t` via `delimitersToGuess`) — sniffer heuristics differ; quote handling ok. |
| Zip | `zipfile` | `fflate` (`unzipSync`, check `originalSize`) |
| Encoding | utf-8-sig/utf-16/latin-1 fallback | `TextDecoder('utf-8',{fatal:true})` strip BOM; then `TextDecoder('utf-16le')` (Python 'utf-16' honours BOM, default LE); then `latin1`. |
| Multipart | `UploadFile`, `Form` | Hono `c.req.parseBody()`; `dry_run` form bool parsing: pydantic accepts "true/false/1/0/yes/no/on/off" (case-insens.). |
| Query bools | `archived: bool` accepts same set | replicate |
| HMAC | `hmac`, `hashlib` | WebCrypto `crypto.subtle` (HMAC SHA-256, SHA-256 digest) |
| Rate limits | Redis INCR/EXPIRE (`enforce`, fail-open); slowapi in-memory/Redis per IP `30/minute` | Workers Rate Limiting binding, KV (eventually consistent), or a Durable Object; IP via `CF-Connecting-IP` |
| Advisory lock | `pg_advisory_xact_lock(hashtext(uid))` in recompute | D1 serialises writes per DB; use `db.batch` or a per-user DO if needed |
| JSONB | `habit_routines.habit_ids` | SQLite TEXT JSON (`text({mode:'json'})` in Drizzle) |
| UUID PKs | uuid type | TEXT; `crypto.randomUUID()`; Python `str(UUID)` lowercase — normalise input UUIDs to lowercase before compare/lookup (Python parses uppercase too). |
| tz-aware timestamps | `timestamptz` | store ISO text or epoch int |
| ILIKE | Postgres | SQLite LIKE (ASCII case-insensitive only; non-ASCII differs) |
| IntegrityError→409 | global middleware | catch D1 `UNIQUE constraint failed` / NOT NULL → same 409 body |
| Transactions | one session, flush, commit | D1 has no interactive transactions: compute then `db.batch([...])`; recompute must run on post-write state → build in-memory view or write then recompute in a second batch. |
| CPU | `habit_views` loads all logs; `compute_chain` up to 260 weeks × habits (≤30, + archived unlimited); quit done_days iterates every day since start; insights ~13 pairs × ≤90 days; import ≤5MB CSV parse | Workers free 10ms CPU / paid 30s: import of a 5MB CSV and multi-year quit habits could exceed 10ms on free plan. Index `habit_logs(user_id, day)`. |
| Background | none in scope directly; recompute(notify=True) sends push notifications (web-push) synchronously | `ctx.waitUntil` for push; web-push needs VAPID via WebCrypto (`@block65/webcrypto-web-push` or similar) |
| Filesystem | none | – |
| Settings | `jwt_private_key`, `public_api_url` | Worker secrets/vars; **the habit-action secret derives from the JWT PEM text exactly** — keep same PEM string (incl. newlines) or outstanding links (18h) break. |

Catalog endpoint is unauthenticated; ensure auth middleware doesn't wrap it. Action endpoint is unauthenticated and must bypass CSRF checks too (check CSRF spec: POST without session/header).

---

## 5. Tests

| File | Covers | Notable assertions |
|---|---|---|
| `tests/test_habits_life.py` | engine + lifecycle | `test_done_days_by_kind`; week-based streak, rest days free; `test_strength_dents_rather_than_resets`; `test_quit_habit_clean_runs` (clean_run/best/last_slip); XP cap per habit-week & per day (game); habit quest; catalog has no restrictive-eating templates; `test_habit_lifecycle` (create from template, set/add days, backfill limits, archive/unarchive, delete→trash); `test_habit_stats_counts_kept_weeks_and_keep_rate`; quit habit privacy/badge names; `test_habit_day_note_is_kept_unless_cleared` (note presence semantics); whole-life streak counts any habit; export/import; reminder fires at chosen hour until done (worker + action link) |
| `tests/test_habit_schedule.py` | days_mask/pause | `scheduled`; first week counts only planned days left; pause_days stop at today; picking days sets target (`_fit_schedule`); quit habit has no schedule; pause/resume; pause limits (14 back/60 ahead/180 days/until<start) |
| `tests/test_insights.py` | insights engine, journal, routines, importer | real pattern vs noise; ≥8 days per side; one insight per outcome; journal round trip + search (`q`) + privacy; insights endpoint from logged data; `test_habit_routine_orders_live_habits` (archived drop out, dedupe); Loop zip counts only manual ticks (value 2); long CSV + rejects ambiguous `03/04/2026` dates; import merges, creates, never overwrites (dry_run) |
| `tests/test_habits.py` | mostly `/me` (training/habits, smart reminder hour) — out of scope | |
| `tests/test_nutrition.py::test_coach_flags_low_readiness_and_short_protein` | coach | go_easy + protein_low notes |
| `tests/test_qol.py::test_meal_food_recipe_journal_and_routine_restore` | trash restore of journal & habit routine | |
| `tests/test_social_plans.py` "coach" tests | a *different* coach (social coaching) — not this router | |

---

## Open questions
1. PATCH with explicit null on NOT NULL columns (emoji, weekly_target, time_of_day, category, name is skipped) currently yields 409 via IntegrityError — preserve or validate?
2. Action "done" on a quit habit logs a slip — intended? (Worker probably doesn't send action buttons for quit habits; verify in worker spec.)
3. `snapshot()` in coach commits — what does it write (game spec)?
4. `insights` `sleep_hours` with multiple BodyMetric rows per day: nondeterministic pick; choose latest by created_at?
5. CSV sniffer parity: accept small divergences or port a sniffer?
