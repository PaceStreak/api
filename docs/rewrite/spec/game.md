# PaceStreak API spec: `app/game/*`

Source files: `router.py` (585), `service.py` (1007), `streak.py` (317), `xp.py` (122), `levels.py` (57), `achievements.py` (345), `quests.py` (185), `records.py` (112), `leaderboards.py` (146), `recap.py` (134), `review.py` (178), `monthly.py` (115), `reminders.py` (43), `joint.py` (74), `models.py` (139). Shared helpers in `app/common/time.py`, `app/training/pauses.py`.

Mounting: `app/v1/router.py` includes `game.router` (prefix `/me`) and `game.leaderboards` (prefix `/leaderboards`). The whole v1 router is mounted at `/v1`.

Auth: every route uses `get_current_user` (Bearer JWT access token with `sub` and `sid`). Missing or bad token gives 401 `{"detail":"Invalid authentication credentials"}`.
Rate limits: **none** of these routes has a slowapi decorator or an `enforce()` call.
Errors use the FastAPI shape `{"detail": "<string>"}`. Pydantic or query validation errors use 422 `{"detail":[{type,loc,msg,input,...}]}`.

---

## 1. Routes (12)

| # | Method | Path | Status | Writes |
|---|---|---|---|---|
| 1 | GET | `/v1/me/stats` | 200 | can create the profile and the default chain (via snapshot), then commits |
| 2 | POST | `/v1/me/wager` | 201 | inserts `streak_wagers`, runs `recompute(notify=False)` |
| 3 | DELETE | `/v1/me/wager/{week}` | 204 | deletes `streak_wagers` (no recompute) |
| 4 | GET | `/v1/me/recap/month` | 200 | snapshot side effects only |
| 5 | GET | `/v1/me/recap` | 200 | snapshot side effects only |
| 6 | GET | `/v1/me/review` | 200 | snapshot side effects only |
| 7 | GET | `/v1/me/records/history` | 200 | snapshot side effects only |
| 8 | GET | `/v1/me/xp` | 200 | snapshot side effects only |
| 9 | GET | `/v1/me/records` | 200 | none (reads the projection) |
| 10 | GET | `/v1/me/achievements` | 200 | snapshot side effects only |
| 11 | GET | `/v1/me/progress` | 200 | snapshot side effects only |
| 12 | GET | `/v1/leaderboards/{board}` | 200 | `get_profile` can create the profile, but nothing commits it |

"Snapshot side effects" means `get_profile` inserts the Profile on first use (`avatar_hue = randint(0,359)`), and `get_chains` inserts the default chain `{name:"Everything", disciplines:[], target_history:[{"from":"2000-01-03","target":3}], position:0}` when the user has no unarchived chain. Every `/me` read handler calls `db.commit()` after the snapshot, so these inserts persist.

Route order matters: `/recap/month` is declared before `/recap`, and `/records/history` before `/records`. Hono needs the same order, or exact paths.

### 1.1 GET /v1/me/stats
Response (all from `snapshot`):
```
today: ISO date (user local)
week_starts_on: int 0..6 (0=Mon)
gamification_enabled: bool
level: {level, title, total_xp, into_level, level_span, to_next}
xp: {total, season, by_source:{source:int}}
season: {id:"YYYY-Qn", starts_on, ends_on}          (from the user's local today)
chains: [chain_payload]                               (main chain first)
repair_available: !repair_used_this_month
paused_today: bool
pauses: [pause_payload] for the last 12 pauses, ordered by starts_on asc
training_days: profile.training_days (passthrough)
heatmap: [{date, level 1..4, sessions, disciplines: sorted[]}]
totals: {sessions, active_days, hours: round1, distance_km: round1, tonnage_kg: round0, records: rewarded_prs, disciplines, exercises}
last_active: ISO|null
quests: null if gamification off, else {week_start, xp_each:15, paused: no QuestWeek for this week, items:[{id,title,description,goal,progress:min(p,goal),done:p>=goal}], completed_total: sum over all weeks of done quests}
life: null if profile.life_target falsy, else {target, current, longest, this_week_days, needed, days_left, freezes_available, weeks: weeks_payload(life,26)}
habits: {count, done_today: habits with today in done_days, kept_this_week: chain.this_week_days >= chain.this_week_target}
pr_streak: {current, longest, this_block_has_pr, block_ends ISO}   (always present after snapshot)
wager: wager_state (below)
```
`chain_payload(view, 26)`: `{id, name, disciplines, target (chain.target column), current, longest, freezes_available, this_week_days, this_week_target, days_left, needed, at_risk, will_freeze, repairable_week|null, run_started|null, consistency, consistency_12, consistency_52, paused_now, requirements:[{disciplines: sorted, days, done}], weeks: weeks_payload}`.
`weeks_payload(r, n)`: the last n cells, oldest first: `{week_start, days, target, status, score}`.
`pause_payload`: `{id, starts_on, ends_on|null, effective_end, reason, note, active, upcoming: starts_on>today}`.

**wager_state(snap)** (main chain = `chains[0]`):
- `this_week = week_start(today, wso)`, `next_week = this_week + 7`.
- `won` = `main.result.wagers_won`. `this_cell = main.result.weeks[-1]`. `target_for = target_resolver(main.chain.target_history)`.
- `entry(week)`: null if there is no wager that week. Otherwise `{week_start, days, done: this_cell.days if week==this_week else null, status}`. Status: `"won"` if week∈won, or if (week==this_week and this_cell.days >= w.days); else `"open"` if week >= this_week; else `"lost"`.
- `blocked(week)`, first match wins:
  1. any wager with the same `YYYY-MM` as `week` → "One wager a month."
  2. `target_for(week)+1 > 7` → "Your target is already every day."
  3. week==this_week and this_cell.days>0 → "Wagers are made before the week's first session."
  4. week==this_week and this_cell.status=="paused" → "Not during a pause."
- Returns `{current: entry(this), next: entry(next), last: entry(latest wager with week_start<this_week)|null, options:[{week:"this"|"next", week_start, days: min(7,target_for(week)+1), blocked: null if (no wager that week AND blocked()==null) else (blocked() or "Already made.")}], freezes_available: main.result.freezes_available}`.

### 1.2 POST /v1/me/wager
Body `{week: "this"|"next"}` (Literal; anything else gives 422). Snapshot, then pick the option. If `blocked`, return 409 with that message. Insert `StreakWager(user_id, week_start, days)`, flush, `recompute(notify=False)`, commit, then return 201 with `wager_state` from a fresh snapshot. Unique `(user_id, week_start)`.

### 1.3 DELETE /v1/me/wager/{week}
`week`: ISO date path param (invalid gives 422). If `week < this_week`, or `week == this_week and main.this_week_days > 0`, return 409 "That wager is already under way". Otherwise `DELETE WHERE user_id AND week_start=week`, which is idempotent and returns 204 even when no row matched. No recompute (UserStats is left stale until the next write or worker tick).

### 1.4 GET /v1/me/recap/month
Query `month`: optional, regex `^\d{4}-(0[1-9]|1[0-2])$`. Default: if `today.day > 7`, this month; else last month (`today.replace(day=1)-1`). String comparison: `month > today "YYYY-MM"` gives 422 "That month has not started". Then `build_month`, and None gives 404 "Nothing logged that month".
`build_month`:
- `first..last` month bounds.
- Sets query: WorkoutSet⋈Workout, user, not deleted, completed, kind!='warmup', local_date<=last, weight_kg>0, reps>0.
- Sessions query: Workout.local_date between first and last (not deleted). If it returns nothing, the result is None.
- For each set `value = e1rm(kg,reps) or 0`. Days before `first` feed `before[ex]=max`. Otherwise `during[ex]=max` and `days[ex].add(day)`.
- lifts: exercises sorted by `(-len(days), id)`, top 5: `{exercise_id, name (exercise_meta), sessions: len(days), best_e1rm: round1, previous_best: round1|null (null if 0/missing), change_pct: round((now-then)/then*100,1)|null}`.
- `prs` = rewarded events with first<=day<=last. `weeks` = main cells where `first <= ws+6 and ws <= last`.
- Response: `{month, starts_on, ends_on, complete: last<today, sessions: len(sessions), active_days: distinct, weeks_kept: status=="kept" count, weeks: count status!="open", records: len(prs), lifts, steadiest: lifts[0].name if lifts[0].sessions>1 else null, pr_streak: snap.pr_streak.current or 0}`.

### 1.5 GET /v1/me/recap
Query `week`: optional ISO date (any day in the week). Default `last_closed_week = week_start(today)-7`. If `target > today` (raw date, before normalising), return 422 "That week has not started". Then `build_recap`, commit, and None gives 404 "Nothing to recap for that week".
`build_recap(week)`: normalise `week = week_start(week, wso)`, `end = week+6`. `cell` = main cell for the week, `previous` = cell for week-7. Workouts in [week,end] (discipline, local_date). If there is no cell and no workouts, return None.
Response: `{week_start, week_end, status: cell.status or "missed", verdict: VERDICTS[status], days: cell.days or len(distinct dates), target: cell.target or main.chain.target, sessions: len(workouts), trained_on: sorted distinct ISO, disciplines: [{id, name: DISCIPLINE_NAMES.get(d, d.title()), sessions}] by Counter.most_common, previous_days: previous.days|null, streak: main.current, longest, freezes_available, records: [{label, day}] rewarded events in week, badges: [{id,title,tier}] (only if gamification on; UserAchievement unlocked_on in week, unknown ids skipped), this_week_target}`.
VERDICTS: kept "Week kept.", frozen "A freeze covered it.", repaired "Repaired.", paused "Paused. Rest up, the streak will wait.", missed "Missed. It happens, and this week is a fresh one.", open "Still open.".
`digest_lines(recap)` (used by the worker): title `"Your week: " + verdict.split('.')[0]`, body lines: `"{sessions} session{s} on {days} day{s} against a target of {target}. {verdict}"`, `"Streak: {n} week{s}."`, optionally `"{n} new personal record{s}."` and `"{n} new badge{s}."`, joined by `\n`.

### 1.6 GET /v1/me/review
Query `year`: int 2000..2100, optional. `wanted = year or today.year`. If `build_year` returns None and no year was given, it retries `wanted-1`. None gives 404 "Nothing logged that year".
`build_year(year)`: `start=Jan1`, `end=min(Dec31,today)`. If `start>today`, return None. Workouts in range (discipline, local_date). None found gives None.
- `days` = sorted distinct dates. `weeks` = main cells with `week_start.year==year and status!="open"`, so a week belongs to the year it starts in. `kept` = counts (kept/frozen/repaired). `scored` = status!="paused".
- `longest_streak` = max(cell.run) over those weeks.
- `best_month` = Counter(month).most_common(1). Ties go to the first inserted, which is the earliest month because days are sorted. `favourite_weekday` works the same way over `weekday()` (Mon=0).
- `records` = rewarded events in year. `top` = sort by gain_pct desc (stable), first 5.
- badges as in the recap, over [start,end]. `milestones` = `main.milestones_hit` with week.year==year.
Response: `{year, complete: end==Dec31, first_day, days_trained, sessions, weeks_kept, weeks_closed, weeks_paused, consistency: round(mean score over scored)|0, longest_streak, best_month:{month: full name, days}, favourite_weekday: name, months:[{month: 3-letter, days}]x12, disciplines: [...] like the recap, records_count, top_records:[{label, gain_pct, day}], badges, milestones:[{weeks, week_start}]}`.

### 1.7 GET /v1/me/records/history
Query `key` (required, max_length 100). `record_history(snap,key)`: if `snap.bests[key]` is missing, 404 "No such record". `events` = all events (rewarded or not) with that key, chronological.
`points`: if there are events, the first point is `{value: events[0].previous, day: null, kind:"first"}` (no workout_id key). Then one per event: `{value, day, kind: "flagged" if flagged else "record", gain_pct, workout_id}`. If there are no events: `[{value: best.value, day: best.day, kind:"first", workout_id}]`.
Response `{key, kind, subject (partition on first ':'), label, current: best.value, since: best.day, points}`.

### 1.8 GET /v1/me/xp
`{level, by_source, season_xp, recent: top 40 items by day desc (stable sort; ties keep generation order) [{source, amount, date}], weekly: sorted((week_start_iso, sum)) last 26, as an array of [string, int] pairs}`.

### 1.9 GET /v1/me/records
Reads `personal_records` for the user, ordered by `achieved_on desc` (tie order unspecified). Names come from the library plus the user's custom exercises.
`out(r)`: `{key, kind, subject, label, value, previous, gain_pct, date, workout_id: str|null, flagged, rewarded}`.
Response `{current: rows where is_current, recent: rows where previous is not null, first 30}`. No snapshot, so this is stale until a recompute.

### 1.10 GET /v1/me/achievements
Snapshot, then `held` = the user's UserAchievement rows. `by_rule[aid][tier or "single"] = unlocked_on ISO`.
`population = count(profiles where onboarded_at not null) or 1`. `counts` groups all user_achievements by (achievement_id, tier), across every user, not only onboarded ones.
For each rule in RULES order: `secret = hidden and not unlocked`, `tiers = [bronze,silver,gold] if tiered else ["single"]`.
`{id, title: "Hidden" if secret, description: "Keep training - some things are found, not chased." if secret, category, hidden, secret, tiered, unit, thresholds: [] if secret else list, tier_names, unlocked: {tier: date}, progress: null if secret else {value: round1, next: first threshold > value | null, max: last threshold}, rarity: {tier: round(count/population*100, 1)}}`.
Response `{achievements: [...], unlocked_count: len(held)}`.

### 1.11 GET /v1/me/progress
Query `weeks` int 4..104, default 12. `first = this_week - (weeks-1)*7`.
- Workouts (not deleted, local_date>=first) with `w.sets` loaded through the relationship. **Includes local_date > today** (future-dated). Each is bucketed by week_start, and a workout outside the series is skipped.
- Per bucket: sessions, distinct active days, `minutes += duration_sec//60` (integer division per workout), `distance_km += distance_m/1000`, by_discipline counts, feel and effort lists (truthy only, so 0 is excluded). Sets: skip `!completed` or `kind=="warmup"`. `sets+=1`. `tonnage += weight*reps` if both are truthy. Muscles: primary +1, secondary +0.5, into muscle_week if `local_date >= today-6` and into muscle_4w if `>= today-27`. These two windows apply to every set in the series, even across week buckets.
- weekly item: `{week_start, sessions, active_days, minutes, distance_km: round2, tonnage_kg: round0, sets, by_discipline:{}, feel: round(mean,1)|null, effort: round(mean,1)|null, target: main cell.target|null, status: main cell.status|null}`.
- muscles: for every m in MUSCLES (library dict order): `{id, name, last_7_days: round1, weekly_avg_4w: round(x/4,1)}`.
- body: union of BodyMetric.measured_on>=first and WeighIn per-day `avg(weight_kg)` grouped by local_date>=first, sorted: `{date, weight_kg: round2|null, body_fat_pct, waist_cm, resting_hr, sleep_hours}`.

### 1.12 GET /v1/leaderboards/{board}
- `board` ∈ {consistency→user_stats.consistency, streak→current_streak, season_xp, season_prs, life_streak}. Anything else gives 404 "No such board". This check runs before the profile check.
- Query `scope` regex `^(global|following|group|similar)$`, default global. `group_id` UUID optional (bad UUID gives 422).
- `me = get_profile`. If `!me.social_allowed(utc year)`, return 403 "Leaderboards are not available". `social_allowed` means birth_year set and age >= SOCIAL_MIN_AGE, not suspended, deletion not scheduled, and onboarded.
- Conditions: `social_ok_clause()` (SQL twin), `gamification_enabled = true`, not blocked in either direction (`blocks` table). For `season*` boards add `user_stats.season_id = season_id(UTC today)`. Note this uses the UTC date, not the user's local one.
  - global: `leaderboard_opt_in`.
  - similar: `mine = my user_stats.weekly_days_4w or 0.0`. Condition `leaderboard_opt_in AND weekly_days_4w BETWEEN mine-1.0 AND mine+1.0`.
  - following: `user_id == me OR user_id IN (follows where follower=me and status='accepted')`, AND `can_see_clause(me)` (self, or social_ok + not blocked + (public or (followers and accepted follow))).
  - group: missing group_id gives 422 "group_id is required". If the caller is not a group member, 404 "Not found". Members of the group, and `visibility != 'private'`.
- SQL: subquery `ranked = SELECT profile.user_id, col AS value, RANK() OVER (ORDER BY col DESC) AS rank FROM profiles JOIN user_stats ... WHERE conds`. Rows: `SELECT profile, user_stats, value, rank FROM profiles JOIN ranked JOIN user_stats ORDER BY rank, handle LIMIT 50`. `me` = the same query filtered to the caller. `participants` = count(*) of ranked. Users without a user_stats row are excluded (inner join).
- Row: `person(p, s, value=, rank=, me=bool)` = `{id, handle, display_name, avatar_hue, visibility, official: is_official, level (only if gamification), current_streak, value, rank, me}`.
- Response `{board, scope, participants, opted_in: me.leaderboard_opt_in, rows, me: row|null}`.
- Note: the caller can be excluded from their own global board (when not opted in, or with gamification off). `me` is then null.

---

## 2. Business logic

### 2.1 Time helpers (`app/common/time.py`)
- `local_today(tz)` = now in the IANA zone. An unknown zone falls back to UTC.
- `week_start(d, wso) = d - ((d.weekday() - wso) % 7)` with Mon=0. JS `getUTCDay()` is Sun=0, so convert with `(getUTCDay()+6)%7`.
- `month_key` = "YYYY-MM". `season_id(d)` = `"{year}-Q{(m-1)//3+1}"`. `season_bounds` gives the first day of the quarter through its last day.
- All dates are calendar dates. Represent them as `YYYY-MM-DD` strings or UTC-midnight epoch day numbers in TS, and never with local-time `Date`.

### 2.2 Streak engine: `compute_chain` (pure)
Constants: FREEZE_EVERY=4, FREEZE_CAP=2, LOOKBACK_WEEKS=260, REPAIR_WINDOW_WEEKS=2, MILESTONES=(4,8,12,26,52,104,156), PAUSE_MIN_DAYS=4.
Inputs: active days, today, wso, target_for(week), repaired week starts, repair_available, paused_days, requirements_for, day_disciplines, wagers {week:days}.
1. `paused_weeks` = weeks with >= 4 distinct paused days.
2. `per_week` = distinct active days <= today, per week.
3. `earliest = max(min(per_week) or current_week, current_week - 259 weeks)`.
4. Iterate w from earliest to current_week inclusive:
   - `count`, `target = max(1, target_for(w))`, `reqs = requirements_for(w)`. `ratio = min over reqs with days>0 of min(1, req_days/days)`, default 1.0. `req_days` = days in [w, w+6] that are <= today and whose discipline set intersects req.disciplines.
   - status: `count>=target && ratio>=1` → kept; elif paused → paused; elif current → open; elif in repaired → repaired; elif `freezes>0 && run>0` → frozen (freezes--); else missed.
   - if kept and not current: `kept_toward_freeze++`; when it reaches 4, reset it to 0 and `freezes=min(2,freezes+1)`. Then if w has a wager and `count >= wager.days`, append to wagers_won and `freezes=min(2,freezes+1)`. Wagers on the current week are never "won" here (the router handles the current week separately).
   - kept/frozen/repaired: if run==0 then run_started=w. `run++`. If run∈MILESTONES, append (run,w). missed: run=0, run_started=null. paused and open: no change.
   - `longest=max(longest,run)`. Cell = (w, count, target, status, run, ratio).
5. `days_left = (week_end - today).days + (0 if trained today else 1)`.
6. `progress` = [(req, req_days(current_week, req))]. `shortfall = max(target-days, sum(max(0, req.days-done)))`. `needed = 0` if paused or kept, else `max(0, shortfall)`. `at_risk = needed>0 && needed>=days_left`. `will_freeze = needed>days_left && freezes>0 && run>0`.
7. `repairable` (only if repair_available): among the last 2 closed cells, the newest with status missed.
8. `closed_cells` = cells[:-1] excluding paused. consistency = mean score of the last 4, consistency_12 of the last 12, consistency_52 of the last 52. Each is `round(sum/len)`, or 0 when empty.
9. `score = round(min(min(1, days/target), ratio)*100)`. **Python `round` is banker's rounding.**

`target_resolver(history, default=3)`: points sorted by `from`. Weeks before the first point use the first target. No points means 3.
`requirements_resolver`: weeks before the first point have [].

### 2.3 Snapshot (`service.snapshot`)
Loads: profile, chains (unarchived, ordered by position, created_at), workouts (non-deleted: id, discipline, local_date, started_at, duration_sec, distance_m, effort, source), sets (joined, completed, kind!='warmup': workout_id, exercise_id, weight_kg, reps, rpe, kind, duration_sec, local_date, source), custom_exercises, streak_repairs, streak_pauses (by starts_on), streak_wagers (by week_start), habit views (`app.habits.service.habit_views`, out of scope), rest_days, weigh_ins (local_date, moment), body metric and weigh-in day union count, kudos count (`Kudos.user_id`), group_members count, challenge_participants completed count, user_achievements (tier, unlocked_on).

- repair_used = any repair whose month == month_key(today).
- `sheltered` = union of pause spans' days. A span's effective end is `min(ends_on, starts_on+83)`, and an open span runs to that cap.
- Per chain: `allowed` = chain.disciplines (empty means all). Active = local_dates of matching workouts. day_disciplines only when requirements_history is non-empty. Wagers are applied to the first chain only. Repairs are filtered by chain_id.
- Life chain if `profile.life_target`: days = all workouts plus done_days of non-"quit" habits. The target is constant. Paused days apply. No repairs or wagers.
- `days` (DayActivity): per local_date <= today: sessions = count. `detailed` = any workout with sets>0 or duration_sec or distance_m.
- Records observations, per set:
  - `exercise_meta`: custom ids (`custom-` prefix) map to the custom exercise (name, pattern, load_type), or ("Deleted exercise","other","weight") if it is missing. Library ids map to the library entry. Unknown ids map to (id,"other","weight").
  - weight>0 and reps and load_type∈{weight, weighted_bw}: tonnage += w*reps. If e1rm>0, observation `e1rm:{ex}` = round(e1rm,2).
  - elif reps and load_type∈{bodyweight, weighted_bw}: `reps:{ex}` = reps.
  - elif duration_sec and load_type=="time": `hold:{ex}` = duration.
  - rpe_sets counts rpe in [5,10]. push_sets counts pattern∈{push_h,push_v}, and elif pull_sets counts pattern∈{pull_h,pull_v}.
  - rewardable = source != "import".
- Per workout: distance_km and hours totals. `local_hour` of started_at in the tz: early if <7, late if >=21. For discipline∈ENDURANCE{run,ride,swim,walk,row} with distance>0: `distance:{disc}` = round(distance_m,1). For a run with duration: pace = sec/km. If pace >= 150, add `pace_{5k|10k|half|marathon}:run` for each band with distance_m >= 5000/10000/21097/42195, value round(pace,1), lower is better.
- `detect(observations)` (records.py): keep the best per (key, day) (strictly better replaces). Sort by (day, key). The first observation per key sets the best and emits no event. A strictly better value later emits an event with gain% = (new-old)/old*100 for higher-is-better or (old-new)/old*100 for lower, 0 if old==0. flagged = gain > 15.0. cooled = no previous rewarded event for that key, or >= 7 days since it. rewarded = rewardable && !flagged && cooled. gain_pct is round(gain,2). The best is updated even when flagged.
- `e1rm(w, r)`: 0 if r<=0, w<=0 or r>12. w if r==1, else w*(1+r/30) (Epley).
- `pr_streak = compute_pr_streak(rewarded days, today)`: blocks are 28 days anchored on 2024-01-01, `block = floor((d-anchor)/28)`. Use floor division, because negative values are possible before 2024. longest = longest run of consecutive blocks. current counts back from the current block if it has a PR, else from now-1. `block_ends = block_start(now+1)-1`.
- Achievement Context: gap_return = max(gap-1) between consecutive sorted active dates. restful_run = best run of closed main cells with status kept and days <= target+2 (any other cell resets it). repaired_then_kept = a closed cell repaired followed by exactly 4 closed cells, all kept. distinct_patterns excludes "other". kept_weeks counts main cells with status kept, **including the open current week if it is kept**. longest_streak = max longest over all chains. Habit fields come from the habit views (best done_days for non-quit, all kept weeks, categories with any done day, best_clean_run for quit habits). pr_streak = longest.
- Quests: `first_seen[ex]` = earliest set date. Facts per week: days, patterns (from sets), rpe count (any non-null rpe, no range check here, unlike the achievement), short = workouts with 0 < duration_sec <= 1200, new = number of exercises first seen that week, rest_days count (rest_days table), waking weigh days = distinct dates with moment=="waking", habits_total/kept = per habit cell, non-paused, kept if status kept or (open and days>=target). `quest_start` = min main cell week (or today). `first_habit` = min habit.started_on. Weeks from quest_start through today. Paused main weeks are skipped.
  - `quests_for(week, weighs = first_weigh < week, has_habits = first_habit < week)`: pool = POOL minus morning_weigh if !weighs, minus habit_week if !has_habits, keeping POOL order. `seed = toordinal(week)//7`. Python toordinal: 0001-01-01 = 1. In JS use `Math.floor(Date.UTC(y,m,d)/864e5) + 719163`. Then `i=seed`, and loop: `q = pool[(i*5+seed) % len]`, add it if not already picked, `i++`, until 3 are picked.
  - progress: early_week = any active day < week+3. balanced = push + pull + legs ({squat,hinge,lunge}). rpe, short_counts, new_exercise, rest_day, morning_weigh are the raw counts. habit_week = total>0 && kept>=total.
  - POOL (id, title, description, goal), in order: early_week "Early start" "Train in the first three days of the week." 1; balanced "Balanced week" "A push, a pull and a leg movement this week." 3; rpe "Honest effort" "Rate how hard 8 working sets were (RPE)." 8; short_counts "A short one counts" "Log a session of 20 minutes or less." 1; new_exercise "Something new" "Try an exercise you've never logged." 1; rest_day "Rest on purpose" "Log a rest day. Recovery is training." 1; morning_weigh "Same time, every time" "Weigh in after waking on 5 days." 5; habit_week "Every habit, kept" "Keep the weekly target on all your habits." 1.
- XP (`compute_xp` plus `habit_xp` plus quests). Item order matters for `/me/xp` "recent" ties: training items per week (the dict insertion order of `by_week`, which follows days order, which follows the insertion order of workout rows, which is DB order), then kept_week, milestone, pr, achievement, then habit items, then quest items.
  - training_day: per week, days sorted. Index < target+1 pays 20, else 5. `second_session` +5 if sessions>1. `detail` +5 if detailed. target_for = the main chain resolver (raw, without the max(1) clamp).
  - kept_week 50, paid on ws+6, for main cells with status kept, including the current week if kept.
  - milestone: {4:100, 8:150, 12:250, 26:500, 52:1000, 104:1500, 156:2000}, paid on week+6.
  - pr 25 per rewarded event. achievement: tier None/bronze 50, silver 100, gold 200, paid on unlocked_on.
  - habit_xp: for non-quit habits, per week, the first `weekly_target` sorted done days pay 5 each into per_day. For all habits, a kept cell with ws+6 < today pays `habit_week` 10. `habit_day` = min(20, per_day sum).
  - quest: 15 each per done quest, paid on min(ws+6, today).
  - summarise: total; season = items whose season_id(day) == season_id(today); by_source.
- Levels: `xp_for_level(n) = round(80 * n**1.6)` (banker's rounding; `n**1.6` is a float, so ties are unlikely). `level_for_xp`: accumulate until total < acc. Titles: >=50 Veteran, >=35 Seasoned, >=20 Committed, >=10 Consistent, >=5 Regular, else Novice. `level_progress` = {level, title, total_xp, into_level, level_span, to_next}.
- Heatmap: the last 371 days through today. score += (duration_sec or 1800)/60 * (1 + ((effort or 5)-5)/10). Level 1 if <30, 2 if <60, 3 if <90, else 4.
- names: also filled for e1rm/reps/hold best subjects not seen in sets.
- `paused_today` = any span active today.

### 2.4 `recompute(db, user_id, notify=True, workout_id=None)`
Called from training, profile, habits, account, trash, admin, cli, the worker, and here (wager). Steps:
1. `SELECT pg_advisory_xact_lock(hashtext(user_id))` serialises recomputes per user.
2. Snapshot, then `_learn_reminder_hour`: workouts with source=='app', not deleted, started_at >= now-60d. Local hours go through `learn_reminder_hour(hours, quiet_start, quiet_end)`: needs >= 6 sessions, takes the modal hour (ties go to the lowest hour), reminder = (usual-1)%24, and returns None if that hour is in quiet hours (wrapping window; start==end means none). Sets `profile.learned_reminder_hour` if it changed. `reminder_hour(mode, fixed, learned)` returns learned if mode=='smart' and learned is not None, else fixed (used elsewhere).
3. Load the previous UserStats and the existing (key, achieved_on) record pairs.
4. Badges: for each rule and each tier reached that is not held: if single (tier NULL), `INSERT ... ON CONFLICT (user_id, achievement_id) WHERE tier IS NULL DO NOTHING RETURNING id`, skipping it on conflict. Else a plain insert (unique (user,aid,tier)). `unlocked_on = today`, `evidence = {"value": round(value,1)}`. Badges are never revoked. new_badges entries are `{id, title, tier, tier_name (tier_names[index] if present), hidden, description}`. If there are any, flush and re-snapshot (achievements pay XP).
5. personal_records: delete all for the user. Insert one `is_current=true` row per best (value, achieved_on, workout_id). Insert one row per event unless (key, day) equals a current best. Flush. For bests that have an event that day, `UPDATE ... SET previous, gain_pct, flagged, rewarded WHERE user, key, is_current`.
6. new_records = rewarded events whose (key, day) was not in the previous records, and (workout_id is None or event.workout_id == workout_id): `{key, label, value, previous, gain_pct}`.
7. UserStats upsert (`ON CONFLICT (user_id) DO UPDATE`): computed_at=utcnow, computed_for=today, total_xp, level, season_id, season_xp, current_streak, longest_streak, consistency, this_week_days, this_week_target, recent_weeks (the last 26 statuses as JSON), life_streak, weekly_days_4w = round(mean days of the last 4 closed non-paused cells (divisor max(1,n)), 2), sessions, active_days, season_prs (rewarded with season==today's), total_prs, last_active.
8. leveled = new level if > previous (default 1). milestone = the first (length, week) in milestones_hit with previous_streak < length <= current and week >= today-13.
9. If notify:
   - per badge (only when gamified): `emit_event(profile,"achievement", f"{id}:{tier}", today, {id,title,tier,tier_name})` and `notify(kind="achievement", category="achievements", title="Unlocked: {tier_name or title}", body=description, url="/achievements", dedupe_key="achievement:{id}:{tier}")`. The tier is rendered as Python `None` text, so the key is literally `"...:None"` for single badges. Keep that exact string so dedupe stays stable.
   - per new record (even with gamification off): `emit_event("pr", f"{key}:{day}", {label,key,value,gain_pct}, workout_id=workout_id)`.
   - level up and gamified: event "level" `level:{n}` {level,title}, and a notification kind level_up with title "Level {n} - {title}", body "Consistency, compounding.", url "/profile", dedupe `level:{n}`.
   - milestone: event "streak" `streak:{chain.id}:{m}:{run_started}` {weeks:m}, and a notification kind streak_milestone with title "{m}-week streak", body "{m} weeks of showing up on '{chain.name}'.", url "/", dedupe `milestone:{chain.id}:{m}:{run_started}`.
10. Returns Outcome `{level, title, total_xp, xp_gained: max(0, total-prev_xp), leveled_up_to, new_achievements (empty if not gamified), new_records, streak:{current, this_week_days, target, milestone}}`. `notification_ids` is stripped in `public()`. Callers send the pushes.

### 2.5 Achievements (RULES, in order)
id | title | category | value | thresholds | flags
---|---|---|---|---|---
first_session | First log | milestone | sessions | 1 |
first_kept_week | Week one | milestone | kept_weeks | 1 |
showing_up | Showing up | consistency | active_days | 10/50/150 | unit days
unbroken | Unbroken | consistency | longest_streak | 4/12/26 | weeks
year_of_the_chain | A year of weeks | consistency | longest_streak | 52 | weeks
rest_is_training | Rest is training | consistency | restful_run | 8 | weeks
explorer | Explorer | collection | distinct_exercises | 10/25/50 | exercises
movement_master | Movement master | collection | distinct_patterns | 6/9/12 | patterns
multi_sport | Multi-sport | collection | distinct_disciplines | 2/4/6 | disciplines
tonnage | Heavy lifting | volume | tonnage_kg | 25000/100000/500000 | kg; tier_names Moved a piano / Moved a rhino / Moved a bus
distance | Long way round | volume | distance_km | 42.2/500/2000 | km; tier_names A marathon, eventually / Across a country / Across a continent
time_well_spent | Time well spent | volume | hours | 10/100/500 | hours
first_pr | New best | pr | rewarded_prs | 1 |
pr_collector | Getting better | pr | rewarded_prs | 10/25/50 | records
always_improving | Always improving | pr | pr_streak | 3/6/13 | blocks
honest_logger | Honest logger | consistency | rpe_sets | 50/200/500 | sets
sixty_six | Sixty-six days | consistency | habit_best_days | 66 |
habit_keeper | Habit keeper | consistency | habit_kept_weeks | 10/50/150 | habit weeks
well_rounded | Well rounded | collection | habit_categories | 3 |
held_the_line | Held the line | consistency | habit_best_clean | 30 |
measured | Measured | consistency | body_metric_days | 10 | days
cheerleader | Cheerleader | social | kudos_given | 10 | kudos
crew | Crew | social | groups_joined | 1 |
finisher | Finisher | social | challenges_finished | 1 |
welcome_back | Welcome back | hidden | longest_gap_return | 14 | hidden
balanced | Balanced | hidden | min/max*100 of push/pull if push+pull>=40 and min>0, else 0 | 75 | hidden
early_bird | Early bird | hidden | early_sessions | 5 | hidden
night_owl | Night owl | hidden | late_sessions | 5 | hidden
second_chance | Second chance | hidden | repaired_then_kept?1:0 | 1 | hidden

Copy the description strings verbatim from `achievements.py`. They are user-facing and also used as notification bodies. Tiered means exactly 3 thresholds. `reached` returns every tier with value >= threshold. `progress.value = round(v,1)`.

### 2.6 Joint streaks (`joint.py`; used by `social/buddies.py` and `groups/router.py`)
`joint_streak(members: list[list[status]], threshold, max_weeks=None)`: depth = max len, capped at `max(1, max_weeks)`. For back = depth-1 down to 0: statuses = each member's `m[len-1-back]` when back < len. counted = non-paused. kept = count in {kept, frozen, repaired}. Status: no counted → paused; `kept >= threshold*len(counted) - 1e-9` → kept; back==0 → open; else missed. Run and longest are computed over kept (++) and missed (reset); paused and open leave them unchanged. Returns `{current, longest, weeks:[{status, kept, counted}]}`. The input comes from `user_stats.recent_weeks`.

### 2.7 Worker interplay (in `app/worker.py`, outside this scope but it depends on it)
- Nightly or tick recompute: user_stats rows with `computed_for < current_date + 1`, ordered by computed_at. Skipped when `computed_for >= local_today(tz)`. Otherwise `recompute(notify=False)`.
- Weekly digest: `build_recap(last_week)` and `digest_lines`, then notify kind weekly_digest, category digest, url `/recap?week=...`, dedupe `digest:{week}`.

---

## 3. Data access

Table | Used by | Shape
---|---|---
profiles | everything | by user_id (inserted if missing); count onboarded (achievements); leaderboard join and filters (birth_year, social_suspended_at, deletion_scheduled_at, onboarded_at, gamification_enabled, leaderboard_opt_in, visibility, handle)
streak_chains | snapshot | user, archived=false, ORDER BY position, created_at; insert default
workouts | snapshot, recap, review, monthly, progress, reminder | user AND deleted_at IS NULL [AND local_date range] [AND source='app' AND started_at>=]
workout_sets | snapshot (join), monthly (join), progress (relationship) | user, completed, kind!='warmup', weight>0, reps>0
custom_exercises | snapshot, records, progress, monthly | by user
streak_repairs, streak_pauses, streak_wagers | snapshot | by user, ordered
streak_wagers | wager POST/DELETE | insert; delete by (user, week_start)
rest_days | snapshot | `SELECT day WHERE user`
weigh_ins | snapshot, progress | (local_date, moment); `AVG(weight_kg) GROUP BY local_date`
body_metrics | snapshot (UNION count), progress | by user, measured_on>=
kudos, group_members, challenge_participants | snapshot counts | COUNT
user_achievements | snapshot, recompute, recap, review, achievements | by user; GROUP BY achievement_id, tier COUNT (global); insert with partial-index ON CONFLICT
personal_records | recompute (DELETE + INSERT + UPDATE), /records | ORDER BY achieved_on DESC
user_stats | recompute upsert, leaderboards, worker, buddies/groups | upsert on user_id; RANK() window
follows, blocks, group_members | leaderboards | EXISTS / IN subqueries
habits and habit logs | via `habit_views` (out of scope) |
activity events, notifications | via `emit_event`, `notify` (out of scope) |

Columns: `user_stats` (unique user_id, computed_at timestamptz, computed_for date, total_xp, level, season_id varchar8, season_xp, current_streak, longest_streak, consistency, this_week_days, this_week_target default 3, weekly_days_4w float, life_streak, sessions, active_days, season_prs, total_prs, last_active date, recent_weeks JSONB). `user_achievements` (user_id, achievement_id varchar40, tier varchar8 null, unlocked_on date, evidence JSONB; unique (user,aid,tier); partial unique (user,aid) WHERE tier IS NULL; index on aid). `personal_records` (user_id, key varchar100, value float, previous, gain_pct, achieved_on date, workout_id uuid null, flagged, rewarded, is_current; index (user,key)). `streak_wagers` (user_id, week_start date, days smallint; unique (user, week_start)). All of them have an id PK from Base (UUID), plus presumably created_at; check Base.

---

## 4. Porting hazards (Workers/D1)

Hazard | Detail | TS replacement
---|---|---
`pg_advisory_xact_lock(hashtext())` | Per-user serialisation of recompute | D1 has no locks. Options: a Durable Object per user, or make it idempotent (UserStats compare-and-swap on computed_at, plus notification dedupe_key unique constraints, which already exist)
`INSERT ... ON CONFLICT ... WHERE tier IS NULL` (partial index) | SQLite supports partial unique indexes and `ON CONFLICT(cols) WHERE ... DO NOTHING` upsert targets | keep it. Note that SQLite also treats NULLs as distinct in UNIQUE
`RANK() OVER` | SQLite >= 3.25 supports it, and D1 does | Drizzle `sql` template
JSONB `recent_weeks`, `evidence` | | TEXT JSON with Drizzle `text({mode:'json'})`
`func.avg`, UNION subquery count, `current_date + 1` (worker) | fine in SQLite; `current_date` is UTC in both |
DB transactions | the whole recompute (delete, insert records, upsert stats, events, notifications) runs in one transaction | D1 has no interactive transactions. Use `db.batch([...])` for the write phase (atomic), with all computation done in JS first
Python `round()` | banker's rounding (half to even), and `round(x, n)` works on the binary double | write `pyRound(x, n)`. Half-even on the exact double; port CPython's algorithm (e.g. with `toPrecision(17)` checks). It affects score, consistency, rarity, gain_pct, e1rm rounding, xp_for_level, and JSON output values
Python int vs float JSON | `round(x)` returns an int (serialised `12`). `round(x,1)` returns a float (`12.0` serialised as `12.0`) | JS `JSON.stringify` prints `12`. The React client is fine with this. Tests comparing raw JSON text are not affected
`date.toordinal()`, `weekday()` | quest seed, week_start | epoch-day helpers (`+719163`)
`zoneinfo` local dates and hours | local_today, started_at local hour | `Intl.DateTimeFormat(..., {timeZone})` (built into Workers), or `@date-fns/tz`. An invalid tz must fall back to UTC
Counter.most_common tie order | insertion order (stable sort by count desc) | build with a Map, then a stable `Array.sort` (JS sort is stable)
`str.title()` fallback for discipline names | `d.title()` | capitalise each word after non-letters
`d.strftime("%Y-%m")` | string compare for month | ISO slice
`Literal`, `Query(pattern=)`, `ge/le` validation | errors shaped as 422 FastAPI detail arrays | zod plus `@hono/zod-validator` with a custom hook that emits a FastAPI-shaped 422
CPU: snapshot is O(history) and runs twice when badges unlock; every `/me/*` read recomputes everything | Workers have a 10 ms CPU limit on the free plan, 30 s on paid. Heavy users (5 years: thousands of workouts, tens of thousands of sets) | ensure the paid plan, or cache the snapshot. The 260-week loop is cheap; loading sets dominates
Lazy creation of profile and default chain on read | | replicate (insert-if-missing)
`random.randint` for avatar_hue | | `crypto.getRandomValues`
slowapi / Redis | not used in this scope |
Background tasks / filesystem | none in scope. Notifications and push are delegated |
`UUID(best.workout_id)` | string round-trip | keep as text
Float accumulation | tonnage, distance sums in Python float order match JS doubles if summed in the same order |
SQLite `deleted_at IS NULL`, booleans as 0/1 | Drizzle `integer({mode:'boolean'})` |
Leaderboard `season_id(utcnow().date())` | UTC, not local | keep it as is

---

## 5. Tests covering this area

File | Notable tests and assertions
---|---
tests/test_engine.py | the current week never breaks a streak; a missed week breaks it without a freeze; a freeze is earned every 4 kept weeks and spent automatically; repair counts a missed week; repairable is offered only when available; PR detection flags a >15% jump and respects the 7-day cooldown; XP does not reward training every day; XP ignores load; the level curve is monotonic; long-window consistency ignores the open week
tests/test_engagement.py | a kept wager earns a freeze and a lost one costs nothing; quests are the same three for everyone and weigh-ins need history; quest progress reads the week; paused weeks offer no quests; the PR streak counts blocks and the open block never breaks it; `test_wager_rules` (default options days==4, POST 201 with current.status=="open", a second in the same month gives 409, DELETE 204, a wager after a session gives 409); stats carry quests (3 items) and pr_streak, and quests is null with gamification off; monthly recap (lifts[0].name=="Back squat", no "tonnage"/"volume" in the body, 2099-01 gives 422, 2001-01 gives 404); the similar leaderboard
tests/test_features.py | pause semantics in compute_chain (neither breaks nor extends, never spends or earns a freeze, a short pause does not shelter, a kept week inside a pause stays kept, a paused current week is not at risk); the recap reports attendance and not volume; year review and record history
tests/test_buddies.py | joint_streak: freezes and repairs carry over; a paused member sits the week out; buddy and group streak endpoints
tests/test_habits_life.py | habit XP caps (per habit week and per day); the habit quest only appears for people with habits; whole-life streak; habit stats
tests/test_social.py | `test_groups_challenges_and_leaderboards`: streak board rows == [] when nobody is opted in; season_xp after opt-in; consistency with scope=group; an unknown board `bodyweight` gives 404
tests/test_training.py | stats streak and records; chain target change and repair rules; chain requirements validate and report progress
tests/test_habits.py | smart reminder mode exposure; monthly goal
tests/test_admin_merge.py | touches recompute/user_stats

## Open questions
1. Is per-user serialisation needed (a Durable Object), or are notification dedupe keys enough?
2. Does anything client-side depend on float formatting (`12.0` vs `12`) or on `weekly` being a tuple array? The client reads `[week, xp]` pairs, so this should be fine.
3. Workers plan CPU budget: should the snapshot be cached, given that every `/me/*` GET replays all of history?
4. `habit_views` and `emit_event`/`notify` semantics are specified elsewhere and must match.
