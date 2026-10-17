# Spec: training-b (library, catalog, plans, plan_templates, personal, race, habits)

Source: `api/app/training/{library,catalog,plans,plan_templates,personal,race,habits}.py`.
Mounted under `/v1` (`app/v1/router.py`). All routes below require auth
(`get_current_user` -> bearer/session; 401 otherwise) EXCEPT `GET /v1/library` and `GET /v1/plans/templates`, which are public. **No route in scope has a
rate limit, Turnstile, email, XP, notification, Redis or cache side effect.**
Every table row has base columns `id UUID (uuid7)`, `created_at`, `updated_at`
(server `now()`, `onupdate now()`).

Common helpers (from `app/common/time.py`, `app/profile/service.py`):
- `get_profile(db, user_id)` -> Profile (`timezone` IANA string, `week_starts_on` 0=Mon..6=Sun).
- `local_today(tz)` = current date in the IANA zone.
- `week_start(day, wso) = day - ((day.weekday() - wso) mod 7)` days; Python `%` is always non-negative.
- FastAPI validation errors are 422 with pydantic detail array; HTTPException errors are `{"detail": "<message>"}`.
- Path params typed `UUID` that don't parse -> 422; typed `date` -> 422 (ISO `YYYY-MM-DD`).

---

## 1. Routes

### 1a. Library (route lives in `training/router.py`, data in `library.py` + `catalog.py`)

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/library` | **Public (no auth)**; sets `Cache-Control: public, max-age=3600`. Returns `library_payload()`; static. (Route defined outside scope; listed because its payload is defined here.) |

`library_payload()`:
```
{ "version": 1,
  "disciplines": [{id,name,emoji,metrics:[...],verb}],   # 11, ordered as in DISCIPLINES
  "muscles": {key: label},  # 18 keys, insertion order
  "patterns": {key: label}, # 12
  "equipment": {key: label},# 8
  "exercises": [ {id,name,pattern,equipment,primary:[..],secondary:[..],load_type,rest_sec,cue,unilateral,aliases:[..],custom:false} ],
  "templates": [ {id,name,discipline,summary,items:[{exercise_id,sets,reps_min,reps_max,rest_sec,target_rpe:8,note:null}]} ] }
```
Exercise dict key order follows the dataclass: `id,name,pattern,equipment,primary,secondary,load_type,rest_sec,cue,unilateral,aliases,custom`. Exercises = the 84 hand-written in `library.py` followed by the 199 rows of `catalog.ROWS` (total ~283; verify count when porting). Catalog row columns: `id,name,pattern,equipment,primary(space-sep),secondary(space-sep),load_type,rest_sec,unilateral,cue,aliases(comma-sep, trimmed, empties dropped)`. Templates = 8 `TEMPLATES` + 16 `MORE_TEMPLATES` = 24. Template item `rest_sec` = explicit arg or the exercise's `rest_sec` (`rest or ...` – a 0 would fall back, none exist). `_item` raises KeyError at import time if an exercise id is unknown (startup integrity check; port as a build-time test).

Constants exported: `DISCIPLINE_IDS` {strength,run,ride,swim,walk,climb,row,hiit,yoga,sport,other}; `ENDURANCE` {run,ride,swim,walk,row}; `PUSH_PATTERNS` {push_h,push_v}; `PULL_PATTERNS` {pull_h,pull_v}; `LOAD_TYPES` (weight,bodyweight,weighted_bw,time); `CUSTOM_PREFIX="custom-"`; `EXERCISE_BY_ID`; `TEMPLATE_BY_ID`.

Porting: generate a static TS module (JSON) from Python once (`python -c "import json; from app.training.library import library_payload; print(json.dumps(library_payload(), ensure_ascii=False))"`) and diff it in a test. Emojis must survive (UTF-8, `ensure_ascii` irrelevant to JSON clients).

### 1b. Plans (`plans.py`, router prefix `/plans`)

Route declaration order matters (FastAPI matches in order): `GET /templates`, `GET ""`, `GET /active`, `POST ""`, `POST /race`, `GET /{id}/export`, `POST /import`, `GET /{id}`, `PUT /{id}`, `POST /{id}/start`, `POST /{id}/stop`, `DELETE /{id}`. `/{plan_id}` is UUID-typed, so `/templates` and `/active` would 422 not collide; in Hono register static paths first.

| Method | Path | Request | Success | Errors | Side effects |
|---|---|---|---|---|---|
| GET | `/v1/plans/templates` | – | 200 `[{id,name,summary,weeks_count,per_week,disciplines,equipment}]` (22 templates, PLAN_TEMPLATES order) | – | none. **Public: no auth dependency** (H1) |
| GET | `/v1/plans` | – | 200 `[summary]` ordered `created_at DESC` | – | For each plan runs `_finish_if_over` (may set `finished_at=now`), commits |
| GET | `/v1/plans/active` | – | 200 `plan_view` or `null` | – | picks `started_on IS NOT NULL AND finished_at IS NULL ORDER BY started_on DESC, id DESC LIMIT 1`; `_finish_if_over` then view (view computed even if it just finished), commit |
| POST | `/v1/plans` | `PlanCreate {template_id?: str, plan?: PlanIn}` | 201 `plan_view` (not started => `current_week:null,today:[],progress:null`) | 409 `"20 plans is the limit. Delete an old one first."` (count>=20); 404 `"No such template"`; 422 `"A session names a routine that isn't yours"`; 422 `"Choose a template or send a plan"` (neither, or empty template_id and no plan) | Inserts training_plans; template path may insert routines |
| POST | `/v1/plans/race` | `RaceIn {race: "5k"\|"10k"\|"half"\|"marathon", race_date: date, per_week: int=3 (3..5)}` | 201 `plan_view` | 409 limit (check_plan_room); 422 RacePlanError message | Inserts plan (name `[:60]`, fixed description, `template_id="race-<race>"`, `repeat=false`), `run_only` (stops other running plans by `started_on=NULL`), started_on=`first` |
| GET | `/v1/plans/{plan_id}/export` | – | 200 shareable dict | 404 `"Not found"` (missing or other user's) | none |
| POST | `/v1/plans/import` | `SharedPlan` | 201 `plan_view` | 409 limit; 422 `"at most 14 sessions a week"` (HTTPException, not pydantic) | `materialize`: inserts routines + plan |
| GET | `/v1/plans/{plan_id}` | – | 200 `plan_view` | 404 | `_finish_if_over`, commit |
| PUT | `/v1/plans/{plan_id}` | `PlanIn` | 200 `plan_view` | 404; 422 routine ownership | replaces name/description/weeks/repeat; does NOT touch started_on/finished_at |
| POST | `/v1/plans/{plan_id}/start` | `StartIn {when: "this"\|"next" = "this"}` (body required, `{}` ok) | 200 `plan_view` | 404 | `run_only(plan, week_start(today)+ (7d if next))`; sets finished_at NULL |
| POST | `/v1/plans/{plan_id}/stop` | – | 200 `plan_view` | 404 | started_on=NULL, finished_at=NULL |
| DELETE | `/v1/plans/{plan_id}` | – | 204 | 404 | delete row |

Schemas:

| Model | Field | Type / constraint |
|---|---|---|
| PlanSession | day | int 0..6 |
| | discipline | str in DISCIPLINE_IDS else 422 "unknown discipline" |
| | title | str len 1..80 |
| | minutes | int 1..600, nullable, default null |
| | distance_km | float >0..<=500, nullable |
| | routine_id | UUID nullable |
| | note | str <=200 nullable |
| PlanIn | name | str 1..60 (stored `.strip()`; NB length checked before strip) |
| | description | str<=500 nullable; stored stripped, `""`->null |
| | weeks | list[list[PlanSession]], 1..26 weeks; each week <=14 else 422 "at most 14 sessions a week"; each week **sorted by day** (stable) |
| | repeat | bool=false |
| PlanCreate | template_id, plan | both optional |
| SharedRoutine | name 1..60; discipline str="strength" (no validation; coerced to strength at materialize if unknown); notes<=500; items list[RoutineItem] <=40 |
| SharedSession | PlanSession + `routine: SharedRoutine?` |
| SharedPlan | format must match `^pacestreak-plan$`; version int ==1; name 1..60; description<=500; weeks 1..26 (no per-week size validator – checked in materialize); repeat=false |
| RoutineItem (schemas.py) | exercise_id 1..80; sets 1..20 =3; reps_min/reps_max 0..1000?; rest_sec 0..900?; target_rpe 1..10?; weight_kg 0..1000?; increment_kg >0..<=50?; note<=140? |

Stored session JSON (PlanSession `model_dump(mode="json")`): keys in order `day,discipline,title,minutes,distance_km,routine_id(str|null),note` – all keys always present (nulls included). Pydantic ignores unknown extra keys (default `extra=ignore`).

**summary** (`_summary`): `{id,name,description,template_id,weeks_count,sessions_count,started_on(iso|null),finished_at(iso datetime|null),active: started_on!=null && finished_at==null, repeat}`.

**plan_view**: summary + `weeks` (raw stored weeks when not started) + `challenge_id` + `assigned_by` (str|null) and:
- not started: `current_week:null, today:[], progress:null` (no `cycle` key).
- started: `weeks` = detailed weeks (each session = stored dict + `date` iso, `status`, `moved`), `current_week`, `today` (sessions in current week whose date == today), `progress {done,due,total}`, `cycle` (1-based lap).
- `finished_at` isoformat of tz-aware datetime: `2026-10-17T10:00:00.123456+00:00` (Python format; microseconds omitted if 0). Match exactly or confirm the app tolerates any ISO.

**shareable (export)**: `{format:"pacestreak-plan", version:1, name, description, weeks:[[{day,discipline,title,minutes,distance_km,note, routine?:{name,discipline,notes,items(filtered to built-in exercise ids)}}]], repeat}`. Routine looked up by `user_id == plan.user_id AND id IN ids`; a routine_id no longer existing => session without `routine`. `routine_id` is never exported.

### 1c. Personal (`personal.py`, no prefix)

| Method | Path | Request | Success | Errors | Side effects |
|---|---|---|---|---|---|
| GET | `/v1/gyms` | – | 200 `[gym]` order `is_default DESC, created_at ASC` | – | – |
| POST | `/v1/gyms` | GymIn | 201 gym | 409 `"10 gyms is the limit"` | insert; `is_default = body.is_default OR count==0`; if default, clear others |
| PUT | `/v1/gyms/{gym_id}` | GymIn (full replace) | 200 gym | 404 `"Not found"` | update all fields; if is_default, clear others. Setting is_default=false on the only default leaves none default |
| DELETE | `/v1/gyms/{gym_id}` | – | 204 | 404 | delete (no default reassignment) |
| GET | `/v1/exercise-notes` | – | 200 `{exercise_id: note}` (unordered) | – | – |
| PUT | `/v1/exercise-notes/{exercise_id}` | `{note: str<=500}` (required) | 200 `{exercise_id, note}` or `{exercise_id, note:null}` when stripped empty | 404 `"No such exercise"` | upsert / delete when empty |
| GET | `/v1/weight-goal` | – | 200 goal or `null` | – | – |
| PUT | `/v1/weight-goal` | `{target_kg: float >20..<=400, milestone_kg: float 0.5..20 =2}` | 200 goal | 409 `"Weigh in first, so the goal has somewhere to start"` | upsert: target=round(target,2), milestone as sent, start_kg=round(avg,2), set_on=today |
| DELETE | `/v1/weight-goal` | – | 204 (idempotent) | – | delete |
| GET | `/v1/blocks/active` | – | 200 block or `null` | – | – |
| POST | `/v1/blocks` | BlockIn | 201 block | 422 `"Reps in reserve should fall, not rise"` (rir_end>rir_start) | ends all live blocks (`ended_at=now`), inserts new |
| POST | `/v1/blocks/{block_id}/end` | – | 204 | 404 `"Not found"` | `ended_at = ended_at or now` |
| GET | `/v1/readiness?days=30` | days int (clamped 1..365; non-int -> 422) | 200 `[{date,sleep,energy,soreness}]` day ASC, `day >= today - days` | – | – |
| PUT | `/v1/readiness/{day}` | `{sleep,energy,soreness: int 1..5}` | 200 readiness | 422 `"Check-ins are for today or the last two days"` (outside [today-2, today]) | upsert on (user_id, day) |
| GET | `/v1/reflections` | – | 200 `[{week_start,went_well,change}]` week_start DESC (all, unbounded) | – | – |
| PUT | `/v1/reflections/{week}` | `{went_well?: str<=500, change?: str<=500}` | 200 reflection or `null` (both empty => delete) | 422 `"That week hasn't started"` (week_start(week) > today) | upsert keyed on normalised week_start |

Schemas:
- GymIn: `name` 1..60 (stored stripped); `equipment` list[str] <=20 items, each in EQUIPMENT keys else 422 `"unknown equipment: a, b"`, de-duplicated preserving order; `plates_kg` list[float] <=20, each `0 < p <= 50` else 422 `"plates are between 0 and 50 kg"`, normalised to `sorted(set(round(p,3)), desc)`; `bar_kg` float 0..50 =20; `is_default` bool=false.
- gym out: `{id,name,equipment,plates_kg,bar_kg,is_default}`.
- BlockIn: `name` 1..60 ="Training block" (stored stripped); `weeks` 3..8 =5; `rir_start` 0..5 =3; `rir_end` 0..5 =1; `when` "this"|"next" ="this".
- block out: `{id,name,starts_on,weeks,rir_start,rir_end,ended: ended_at!=null || (today-starts_on).days >= weeks*7, now: block_week|null}`.
- goal out: `{target_kg,start_kg,milestone_kg,set_on}`.

### 1d. Habits (`habits.py`, prefix `/me`)

| Method | Path | Request | Success | Errors | Side effects |
|---|---|---|---|---|---|
| GET | `/v1/me/monthly-goal?month=YYYY-MM` | month optional, regex `^\d{4}-(0[1-9]\|1[0-2])$` (422 otherwise); default = local today's `%Y-%m` | 200 goal view | 422 | – |
| PUT | `/v1/me/monthly-goal` | `{month: regex, days: int 1..31}` | 200 goal view | 422 `"<month> has <n> days"` ; 422 `"That month is over"` (last day < first of current month) | Postgres `INSERT ... ON CONFLICT ON CONSTRAINT uq_monthly_goal DO UPDATE SET days` |
| DELETE | `/v1/me/monthly-goal/{month}` | month **unvalidated** string | 204 (idempotent) | – | delete |
| GET | `/v1/me/rest-days?from=YYYY-MM-DD` | `from` optional date | 200 `[{day,kind,note}]` day ASC, `day >= from or today-365` (no upper bound) | 422 bad date | – |
| PUT | `/v1/me/rest-days/{day}` | `{kind: rest\|sleep\|mobility\|sick = rest, note?: str<=200}` (note stripped, ""->null; length checked before strip) | 200 `{day,kind,note}` | 422 `"Rest days can be logged up to 7 days ahead and a year back"` | upsert ON CONFLICT uq_rest_day ... RETURNING |
| DELETE | `/v1/me/rest-days/{day}` | – | 204 | – | delete |

Goal view: `{month, goal: int|null, done, days_in_month, days_left, reachable}`:
- `done` = `COUNT(DISTINCT workouts.local_date)` where user, `deleted_at IS NULL`, `local_date BETWEEN first AND min(last, today)` (all sources, not just app).
- `days_left` = 0 if today > last else `(last - max(today, first)).days + 1` (counts today).
- `reachable` = goal null OR done + days_left >= goal.

Route count in scope: plans 12, personal 16, habits 6 = **34** (+ `/v1/library` defined elsewhere).

---

## 2. Business logic

### 2a. match_week(sessions, ws, done[(date,discipline)], today)
1. Copy sessions. Pass 1 (in session order, already sorted by day): `date = ws + day`; if an exact `(date, discipline)` remains in `done`, remove first such occurrence, `status="done", moved=false`.
2. Pass 2 for unmatched sessions in order: first remaining entry with same discipline (any date in that week, including future/after) -> remove, `done, moved=true`. Otherwise `moved=false`, status `today` if date==today, `upcoming` if date>today, else `skipped`.
`done` list order = DB row order (unordered SELECT!) – affects which entry is consumed only when duplicates; result equivalent because matching is by value. Fine.

### 2b. plan_view (started)
- `index = (week_start(today, wso) - started_on).days // 7` (floor division; negative when started "next" week).
- `cycle_start`: L = len(weeks) or 1. If not repeat or index<L (incl. negative): base = started_on; else base = started_on + 7*(index - index%L) days.
- `end = base + 7*len(weeks) - 1`; logged = workouts (user, not deleted, `local_date` in [base, min(end,today)]; `source=='app'` only when `app_only` (group challenges)). Bucket each by `base + 7*floor((d-base).days/7)`.
- For each week i: ws = base+7i. If ws > today: all sessions `upcoming, moved:false, date`. Else match_week; count `due` += status != upcoming (done, today, skipped all count), `done` += status==done.
- `index -= (base - started_on).days // 7`; `current = index if 0 <= index < len(weeks) else null`.
- `today` = sessions in detailed[current] with date == today iso.
- `progress = {done, due, total: total sessions}`; `cycle = (base-started_on).days // (7*len(weeks)) + 1` if weeks else 1.
- NB: buckets keyed by `base`, but plan_view with `ws` loop uses `logged.get(ws)`; bucket math lines up because both start at base.
- **Week start change hazard**: if user changes `week_starts_on` after start, `week_start(today)` no longer aligned to started_on; floor division handles it; preserve exact arithmetic.

### 2c. _finish_if_over
If started, not finished, not repeat, and `index >= len(weeks)` -> `finished_at = utcnow()`. Called on GET list/active/one (GETs write!). Not called on start/stop/put/create.

### 2d. run_only(plan, starts)
All other plans of same user with started_on NOT NULL and finished_at NULL get `started_on=NULL` (finished_at untouched). Then plan.started_on=starts, finished_at=NULL. No DB uniqueness; concurrent starts can leave two running (active picks latest).

### 2e. _from_template (POST /plans with template_id)
For each session, pop `routine_template`; if it's in TEMPLATE_BY_ID: per request cache by template id; look up oldest routine of user with exact `name == rt.name` (`ORDER BY created_at, id LIMIT 1`); else insert `Routine(user_id,name,discipline,notes=summary,items=rt.items)` and flush. Set `routine_id`. Session validated via PlanSession and dumped (fills nulls). Plan: name/description(summary)/template_id from template, `repeat=false`.
Template `_check_routines` is skipped. Note template weeks are not re-sorted (already ordered).

### 2f. materialize(shared, **fields) (import; also used by groups)
- Any week > 14 -> 422 HTTPException `"at most 14 sessions a week"`.
- Per week sorted by `day` (stable). Data = session dumped json excluding `routine`, `routine_id` (so imported `routine_id` is dropped).
- If routine embedded: key = `name.lower()` (Python lower: Unicode-aware; JS `toLowerCase` close; SQL `func.lower` – SQLite `lower()` is ASCII-only! H3). Reuse oldest routine with `lower(name)==key`, else create with discipline coerced to strength if unknown, items filtered to built-in exercise ids, `model_dump()` (non-json mode: includes all RoutineItem fields incl. nulls).
- Plan: name stripped, description stripped/null, `repeat = shared.repeat and "challenge_id" not in fields`, extra fields (`challenge_id`, `assigned_by`). Flush, caller commits.

### 2g. _check_routines
Set of non-null routine_ids; `SELECT id FROM routines WHERE user_id=? AND id IN (...)`; any missing -> 422.

### 2h. GET /plans/templates
`per_week = max(len(w))`; `disciplines = sorted(set of discipline)`; `equipment = sorted(set(EXERCISE_BY_ID[item].equipment for every routine_template item) - {"bodyweight"})`.

### 2i. Plan templates (plan_templates.py) – 22 static templates
IDs in order: plan-two-a-week, plan-run-from-zero, plan-5k-to-10k, plan-strength-foundations, plan-five-by-five, plan-gym-first-month, plan-ppl-three, plan-ppl-six, plan-upper-lower, plan-dumbbells-home, plan-kettlebell, plan-calisthenics, plan-glutes-legs, plan-hybrid, plan-conditioning, plan-core, plan-ride-base, plan-swim-laps, plan-row-base, plan-mobility, plan-walking, plan-comeback.
Generated with helpers: `_runwalk(run,walk,reps)` title `f"Run {run:g} min / walk {walk:g} min, x{reps}"` (`:g` -> `1.5`, `1`, `2`), minutes `round(10 + reps*(run+walk))` (banker's rounding!); `_week(days,*s)` = `{"day": d} | s` (day key first). Best port: dump `PLAN_TEMPLATES` to JSON from Python and ship as static data (H2), rather than re-deriving.

### 2j. build_race_plan(race, race_date, today, wso, per_week) -> (first, weeks, name)
RaceSpec table:

| race | label | km | start_long | peak_long | taper_weeks | quality | min_weeks |
|---|---|---|---|---|---|---|---|
| 5k | 5 km | 5 | 25 | 50 | 1 | Intervals: 6 x 2 min a little faster, 2 min easy between | 4 |
| 10k | 10 km | 10 | 35 | 70 | 1 | Intervals: 5 x 4 min comfortably hard, 2 min easy between | 5 |
| half | half marathon | 21.1 | 50 | 120 | 2 | Tempo: 2 x 12 min comfortably hard, 3 min easy between | 8 |
| marathon | marathon | 42.2 | 70 | 180 | 2 | Tempo: 3 x 12 min at goal effort, 3 min easy between | 12 |

MAX_WEEKS=25. days: 3->(1,3,5), 4->(0,2,4,6), 5->(0,1,3,4,6).
Errors (order): unknown race "Choose 5 km, 10 km, half marathon or marathon"; per_week "Three, four or five runs a week"; `race_date <= today` "The race has to be in the future"; `weeks_to_race = (race_week-first)/7 + 1 < min_weeks` -> `"A {label} plan needs at least {min} weeks; that race is sooner"`; if > 25: `first = race_week - 24 weeks`, weeks_to_race=25.
Build: `build_weeks = weeks_to_race - taper - 1`; `base_weeks = max(1, round(build_weeks*0.45))`; `long_min=float(start_long)`, `peak=start_long`. For i in range(build_weeks): `cutback=(i+1)%4==0`; `long_now=round(long_min*(0.8 if cutback else 1))`; peak=max; `easy=clamp(round(long_now*0.55),20,60)`; sessions = easy runs for days[:-1] (`title "Easy run, {easy} min"`, note EASY = "Easy: you could talk in sentences. Slower is fine."); if `i>=base_weeks and not cutback and len>=2`: sessions[1] = quality (title quality[:80], minutes easy+10, note "10 min easy to warm up and cool down. Hard, not all out."); append long run `"Long run, {long_now} min"` + `" (lighter week)"` if cutback, note EASY. Then if not cutback and `(i+2)%4 != 0`: `long_min = min(peak_long, long_min*1.1)` (float carried).
Taper t: share = 0.7 if t==0 and taper==2 else 0.55; long=round(peak*share); easy=max(20, round(long*0.5)) (no 60 cap); easy runs + long run note "Tapering: less running so you arrive fresh. Resist adding more."
Race week: `race_day=(race_date-race_week).days`; up to 2 easy 20-min runs on days d < race_day-1 (note "A few relaxed strides at the end. Save the legs."), then `{day:race_day, discipline:run, title:"Race day: {label}", distance_km, note:"Start slower than feels right. Enjoy it."}` (no `minutes` key – but plan stores raw dicts here, not PlanSession-dumped, so missing keys stay missing!). Recovery week: walk on days[1] 30 min "Recovery walk, 30 min" note "Moving helps sore legs recover. No running needed yet."; run on days[-1] "Easy run, 20 min" note "Only if everything feels fine. Otherwise walk, or rest.".
Name: `label` capitalised first char + `" on " + "%-d %b"` e.g. "10 km on 5 Dec", "Half marathon on 3 Mar". `%b` English abbreviated month (C locale). Truncated to 60.
Race plan sessions lack `routine_id`/`distance_km`/`minutes` keys variously – JSON shape differs from PlanSession dumps; preserve.

### 2k. block_week(block, today)
`index = floor((today - starts_on).days / 7)`; null if index<0, index>=weeks, or ended_at set. working = weeks-1; deload = index==working; rir = deload ? max(rir_start+1, 4) : (working==1 ? rir_start : round(rir_start - (rir_start-rir_end)/(working-1)*index)) (banker's rounding). Output `{week:index+1, weeks, deload, rir}`. (working==1 impossible since weeks>=3; keep.)
Block start: `week_start(today, wso) + (7 if when=="next")`. Active: live blocks (ended_at NULL) by starts_on DESC, first whose `ended` false (block starting next week counts: ended false, now null).

### 2l. Weight goal start
`AVG(weigh_ins.weight_kg) WHERE user AND local_date > today-7` (last 7 days incl today). NULL -> 409.

### 2m. Exercise-note known check
Built-in id OK; `custom-<uuid>` whose CustomExercise belongs to user OK (invalid uuid -> 404); else 404. Note: exercise_id column is String(60) – long ids would DB-error (500).

### 2n. Habits
`_bounds("YYYY-MM")` -> first, last day of month. Rest day window: `today-365 <= day <= today+7`. Monthly goal past check: `last < first-of-current-month`.

---

## 3. Data access

| Table | Ops | Query shapes |
|---|---|---|
| training_plans (user_id, name≤60, description≤500, template_id≤40, weeks JSONB, started_on date, challenge_id FK challenges SET NULL, assigned_by FK users SET NULL, finished_at tstz, repeat bool) | CRUD | count by user; list by user ORDER created_at DESC; active filter + ORDER started_on DESC,id DESC LIMIT 1; others running for run_only; get by PK |
| routines (in other spec) | select/insert | `id IN (...) AND user_id`; `name = ? ORDER BY created_at,id LIMIT 1`; `lower(name)=?` |
| workouts | read | `(local_date, discipline)` by user, `deleted_at IS NULL`, date range, optional `source='app'`; `COUNT(DISTINCT local_date)` |
| gyms (equipment JSONB, plates_kg JSONB, bar_kg float, is_default) | CRUD | count; order is_default DESC, created_at; bulk `UPDATE ... SET is_default=false WHERE user AND id != ?` |
| exercise_notes (uq user_id+exercise_id) | CRUD | |
| custom_exercises | get by PK | |
| weight_goals (user_id UNIQUE) | upsert/delete | |
| weigh_ins | AVG | |
| training_blocks (ck weeks 3..8, rir 0..5, ended_at) | | live by user ORDER starts_on DESC |
| readiness (uq user+day, ck 1..5) | upsert | day >= since ORDER day |
| week_reflections (uq user+week_start) | upsert/delete | ORDER week_start DESC |
| monthly_goals (uq_monthly_goal user+month, ck days 1..31) | ON CONFLICT upsert | |
| rest_days (uq_rest_day user+day, ck kind) | ON CONFLICT upsert RETURNING | day >= start ORDER day |
| profiles | read via get_profile | |

All FKs to users `ON DELETE CASCADE`. In D1 enable `PRAGMA foreign_keys` (D1 enforces by default) and keep check constraints.

---

## 4. Porting hazards (Workers/D1)

| # | Hazard | Detail / JS replacement |
|---|---|---|
| H1 | `GET /plans/templates` has **no auth dependency** | Actually public. Keep it unauthenticated to be 1:1. (Correction to table above: auth NOT required.) |
| H2 | Python `round()` is banker's rounding (half-to-even) | Used in race plans (`round(long_min*…)`, `round(build_weeks*0.45)`, easy), block RIR, `_runwalk` minutes, weight goal `round(x,2)`, plates `round(p,3)`. Implement `roundHalfEven(x, nd)`; JS `Math.round` differs at .5 (e.g. round(2.5)=2). For float round(x,2) Python uses correctly-rounded decimal repr – use a decimal approach. Ship plan templates + library as pre-generated JSON to avoid re-deriving. |
| H3 | Floor division / modulo on negatives | `//7` and `% 7`, `index % length` – use `Math.floor` and `((a%n)+n)%n`. |
| H4 | Postgres-only SQL | `INSERT ... ON CONFLICT ON CONSTRAINT name` -> SQLite `ON CONFLICT(user_id, month) DO UPDATE` (Drizzle `onConflictDoUpdate({target:[...]})`); `RETURNING` supported in D1. `func.lower` – SQLite lower() is ASCII-only; do case-fold in JS or store a normalised column. `COUNT(DISTINCT)` and `AVG` fine. |
| H5 | JSONB columns (weeks, equipment, plates_kg, routine items) | `text` with `mode:'json'` in Drizzle. Key order must be preserved as stored (Python dicts keep insertion order; JSONB does NOT – Postgres JSONB reorders keys by length then bytes on read!). So current responses emit JSONB-normalised key order; the React app shouldn't care. |
| H6 | Dates & timezones | `local_today(tz)` -> `Intl.DateTimeFormat('en-CA',{timeZone})` or Temporal polyfill (`@js-temporal/polyfill`) / `date-fns-tz`. Use plain `YYYY-MM-DD` strings + UTC-day arithmetic for date math. `weekday()` Mon=0 vs JS `getUTCDay()` Sun=0. |
| H7 | strftime `%-d %b` | English month abbreviations array; no locale. |
| H8 | Float formatting `:g` | `1.5`->"1.5", `1.0`->"1" – String(Number) matches for these values. |
| H9 | Datetime serialisation | `finished_at`/`ended_at` isoformat `+00:00` with microseconds; JS `toISOString()` gives `Z` and ms. Decide; app parsing tolerant? verify in ../app. |
| H10 | UUIDv7 ids | `uuidv7` npm package (or `uuid@10` `v7`). |
| H11 | GET handlers write (finish plans) | fine in D1; batch updates. |
| H12 | Pydantic validation semantics | Use zod: strings length checked before strip; float fields accept ints; int fields reject floats with fraction (pydantic v2 lax: `3.0` accepted as int, "3" accepted). 422 body shape `{"detail":[...]}` – app may display `detail` strings; HTTPException 422 bodies are `{"detail":"msg"}`. |
| H13 | Unicode lower | `str.lower()` vs `toLowerCase()` nearly identical. |
| H14 | Concurrency | No transactions spanning reads (count then insert) – same race in D1; acceptable. D1 has no interactive transactions: use `db.batch()` for run_only + insert, materialize (routines must be inserted before plan – generate ids client-side). |
| H15 | CPU | Trivial; the static library JSON (~100-150KB) should be a precomputed constant, maybe with ETag. |
| H16 | Shared internals | `plan_view`, `materialize`, `run_only`, `check_plan_room`, `shareable`, `template_shared` are used by `app/groups/router.py` (challenges, coach suggestions; `app_only=True`); `block_week` likely by Today/insights; `CUSTOM_PREFIX`/`EXERCISE_BY_ID` widely. Port as a module. |
| – | No Redis, emails, background tasks, filesystem, external HTTP in scope. |

---

## 5. Tests

| File | Covers | Notable assertions |
|---|---|---|
| tests/test_plans.py | match_week unit tests; templates create routines & start; one plan at a time; logging completes sessions; privacy (404 other user) and validation; repeating plan loops and never finishes; repeat survives export/import; routine items keep weight_kg; template reuses oldest of several same-named routines | creating same template twice doesn't duplicate routines; start `this` -> `current_week==0`; `/plans/active` returns it |
| tests/test_readiness_blocks.py | build_race_plan (12 weeks for 10k 11 weeks out, race day=Sat day 5, long-run growth <=~12%, cutback week 4, no intervals in base, taper, recovery walk, name "10 km on…"); refusals ("at least 12 weeks", "future", 50-weeks-away -> 26 weeks starting later); block_week RIR `[3,2,2,1,4]`; race endpoint starts plan; blocks/readiness/reflections endpoint flow | |
| tests/test_habits.py | monthly goal counts distinct days; rest days private & never count toward streak | |
| tests/test_exercise_catalog.py | ids/names unique; every exercise uses known MUSCLES/PATTERNS/EQUIPMENT/LOAD_TYPES; every plan template can be created & started and links routines; every starter routine can be added | |
| tests/test_social_plans.py | plan challenges (materialize with challenge_id, app_only scoring), coach-suggested plans (assigned_by), joining with same-named routines | |
| tests/test_training_depth.py | `test_plans_round_trip_as_files` (export -> import) | |
| tests/test_training.py, test_engagement.py, test_insights.py | incidental use of library/gyms/notes | |
