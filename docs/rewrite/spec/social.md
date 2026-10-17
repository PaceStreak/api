# Spec: social, buddies, groups/challenges, search

Source: `app/social/{models,service,router,buddies}.py`, `app/groups/{models,router}.py`, `app/search/router.py`.
Mounted in `app/v1/router.py` under `/v1` in order: social_router, buddies_router, groups_router, ..., search_router.
**57 routes** (social 23, buddies 6, groups+challenges 26, search 2).

## 0. Shared conventions

- **Auth**: every route depends on `get_current_user` (bearer or session cookie) and returns 401 without one. Exception: `GET /v1/encouragement/presets` has **no auth**.
- **Errors**: FastAPI shape `{"detail": "<message>"}`. Pydantic validation errors are 422 with FastAPI's list-shaped `detail`. Path UUID params that fail to parse also return 422.
- **Rate limit** `enforce(bucket, subject, limit, window_s)`: Redis fixed window, key `limit:{bucket}:{subject}`. INCR, then EXPIRE on the first hit. Over the limit returns **429 "Slow down - try again in a little while."** Fails open on a Redis error. The subject is the user id, except `announce`, which is keyed by **group id**.
- **require_social(user)** returns the caller's Profile or 403, checked in this order:
  1. `onboarded_at is None` → "Finish setting up your profile first"
  2. `!social_allowed(year)` → "Social features are not available"
  3. `!user.is_verified` → "Confirm your email address first"
  - `get_profile` itself can raise (probably 404 when there is no profile; see the profile spec).
- **social_allowed(year)**: `birth_year != null && year - birth_year >= 16 && social_suspended_at null && deletion_scheduled_at null && onboarded_at != null`. `year` is the UTC year of now. Its SQL twin is `social_ok_clause`.
- **not_blocked(viewer, X)**: NOT EXISTS a block row (viewer→X) or (X→viewer).
- **can_see_clause(viewer)** on a Profile row: `user_id = viewer OR (social_ok AND not_blocked AND (visibility='public' OR (visibility='followers' AND EXISTS accepted follow viewer→user)))`.
- **person(p, stats?, **extra)** returns `{id: user_id, handle, display_name, avatar_hue, visibility, official: is_official}`, plus extra keys merged last:
  - stats given and `gamification_enabled`: adds `level` and `current_streak`.
  - stats given otherwise: adds `current_streak` only.
  - A stats row of None (from an outer join) adds nothing.
- **_profile_by_handle(h)**: `handle == h.lower().lstrip('@')` (strips every leading @). Returns 404 "No such person" when missing or `onboarded_at` is null.
- **clean_text(s)** (used for comments, report detail, group and challenge name/description, announcements, assign note):
  1. NFKC.
  2. Drop every char whose Unicode category is Cc, Cf or Co, except `\n` and `\t`.
  3. Repeatedly replace `\n\n\n` with `\n\n`.
  4. `strip()` (Python strips Unicode whitespace).
  - JS: `s.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Co}]/gu, m => m==='\n'||m==='\t'?m:'')`, then a loop collapsing newlines, then `.trim()`. Check that the trim sets match: Python `str.strip()` strips `\x1c-\x1f` and `\x85`, which JS trim does not. Those are Cc and are already removed, so it is safe.
  - Validator idiom `clean_text(v) or None if v else v` means: a falsy input passes through unchanged (`""` stays `""`, None stays None); otherwise the cleaned value, or None if cleaning empties it. Note that min_length is checked **before** cleaning (Pydantic runs field constraints first, then the after-validator).
- **notify(...)**: `INSERT notifications ... ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`. Title is truncated to 120 chars and body to 400. A null dedupe_key never conflicts (Postgres NULLs are distinct, and SQLite behaves the same). `deliver([ids])` runs as a FastAPI BackgroundTask **after the response** (push/email; muted-group check uses `data.group_id`). On Workers use `ctx.waitUntil`.
- **Timestamps**: every model has `id` (uuid), `created_at` and `updated_at` from Base (assumed; verify `app/database.py`). Output uses Python `isoformat()` on tz-aware UTC, e.g. `2026-10-17T09:15:02.123456+00:00`; microseconds are omitted when zero. Dates are `YYYY-MM-DD`.

## 1. Tables (this area)

| Table | Columns (plus id, created_at, updated_at) | Constraints / indexes |
|---|---|---|
| follows | follower_id FK users CASCADE, followee_id FK CASCADE, status varchar(10) default 'pending', accepted_at tz | UNIQUE(follower_id, followee_id); CHECK status IN (pending, accepted); CHECK follower<>followee; ix(followee_id, status); ix follower_id |
| blocks | blocker_id, blocked_id (FK CASCADE) | UNIQUE(blocker, blocked) |
| activity_events | user_id FK CASCADE, kind varchar(20) (workout\|pr\|streak\|achievement\|level\|challenge), ref_key varchar(120), data JSONB default {}, occurred_on date, workout_id uuid null (indexed, no FK), hidden_at tz | UNIQUE(user_id, kind, ref_key); ix(user_id, created_at) |
| kudos | event_id FK activity_events CASCADE, user_id FK CASCADE, reaction varchar(10) default 'kudos' | UNIQUE(event_id, user_id). Reactions: kudos, fire, strong, star, heart |
| comments | event_id FK CASCADE, author_id FK CASCADE, body varchar(280), hidden_at | ix(event_id, created_at) |
| reports | reporter_id FK CASCADE, reported_user_id FK SET NULL, target_type varchar(10), target_id varchar(64), reason varchar(20), detail varchar(500), snapshot JSONB, status default 'open', resolved_by FK SET NULL, resolved_at, resolution varchar(200) | CHECK target_type IN (user, comment, event, group, challenge); CHECK status IN (open, actioned, dismissed); ix(status, created_at) |
| buddy_pairs | user_a, user_b FK CASCADE, requested_by uuid (no FK), status varchar(8) default pending, started_at, ended_at | UNIQUE(user_a, user_b); **CHECK user_a < user_b**; CHECK status IN (pending, active, ended) |
| groups | name varchar(60), description varchar(280), kind varchar(10) default crew (crew\|coaching), owner_id FK CASCADE, invite_code varchar(16) UNIQUE, avatar_hue smallint default 200, hidden_at, streak_threshold smallint default 75 | |
| group_members | group_id FK CASCADE, user_id FK CASCADE, role varchar(8) default member (owner\|admin\|coach\|member), shares_with_coach bool default false, muted bool default false | UNIQUE(group_id, user_id) |
| challenges | title varchar(60), description varchar(280), kind varchar(16) default active_days (active_days\|weekly_target\|plan_sessions), target int null, disciplines JSONB list default [], starts_on date, ends_on date, creator_id FK CASCADE, group_id FK groups CASCADE null, invite_code varchar(16) UNIQUE, resolved_at, hidden_at, plan JSONB null | CHECK ends_on >= starts_on |
| challenge_participants | challenge_id FK CASCADE, user_id FK CASCADE, final_score int, final_rank int, completed bool default false, left_at | UNIQUE(challenge_id, user_id) |
| group_announcements | group_id FK CASCADE, author_id FK users SET NULL, body varchar(500), pinned bool default false | |

Read but owned elsewhere: profiles, user_stats (level, current_streak, recent_weeks list, this_week_days, this_week_target, consistency, last_active), user_achievements, notifications, training_plans (challenge_id, assigned_by, started_on, finished_at), workouts (source, local_date, started_at, created_at, deleted_at, discipline, sets), habits, habit_logs, journal_days, foods, recipes, meal_entries, readiness, rest_days, weigh_ins.

**D1 must enforce FKs**: run `PRAGMA foreign_keys=ON` (D1 has it on by default). Behaviour relies on the CASCADEs: deleting an event removes its kudos and comments, and deleting a group removes its members, challenges and announcements.

## 2. Routes: social (`app/social/router.py`)

| # | Method + path | Gate | Rate limit | Request | Response | Errors |
|---|---|---|---|---|---|---|
| 1 | GET /v1/people/search | require_social | search 60/60s | query `q` str, 1..40 chars (before strip) | 200 `[person(p, stats)]`, at most 20 | 422 on q length |
| 2 | GET /v1/people/suggested | require_social | none | none | 200 `[person(p, stats)]`, at most 12, no ORDER BY (nondeterministic) | |
| 3 | GET /v1/people/{handle} | auth only | none | none | 200 profile view (below) | 404 "No such person" |
| 4 | GET /v1/people/{handle}/events | auth | none | query `before` datetime, optional | 200 feed page | 404 if !can_see |
| 5 | POST /v1/people/{handle}/follow | require_social | follow 60/3600s | none | 200 `{status: "accepted"\|"pending"}` | 422 "You cannot follow yourself"; 404 "No such person" (blocked, target not social, or target private) |
| 6 | DELETE /v1/people/{handle}/follow | auth | none | none | 204 | 404 handle |
| 7 | DELETE /v1/people/{handle}/follower | auth | none | none | 204 (deletes follow them→me, any status) | 404 handle |
| 8 | GET /v1/people/{handle}/followers | auth | none | none | 200 `[person]`, at most 200 | 404 if !can_see |
| 9 | GET /v1/people/{handle}/following | auth | none | none | same | same |
| 10 | GET /v1/me/follow-requests | auth | none | none | 200 `[person(p) + {request_id, requested_at}]` ordered by follow.created_at DESC; only followers that are social_ok | |
| 11 | POST /v1/me/follow-requests/{request_id:uuid}/{decision} | auth | none | decision must be accept or decline, else 404 "Not found" | 200 `{status: decision}` | 404 "Not found" when missing, not mine, or not pending |
| 12 | POST /v1/people/{handle}/block | auth | none | none | 204 | 422 "You cannot block yourself"; 404 |
| 13 | DELETE /v1/people/{handle}/block | auth | none | none | 204 | 404 |
| 14 | GET /v1/me/blocks | auth | none | none | 200 `[person(p)]` (no order) | |
| 15 | GET /v1/feed | auth (calls get_profile) | none | `before` datetime, optional | feed page | |
| 16 | POST /v1/events/{event_id}/kudos | require_social | kudos 300/3600s | optional JSON `{reaction: kudos\|fire\|strong\|star\|heart = "kudos"}`; a missing body means kudos | 200 `{kudos: total, kudoed: true, reactions: {r: n}, my_reaction}` | 422 bad reaction; 404 "Not found" if not visible |
| 17 | DELETE /v1/events/{event_id}/kudos | auth, **no visibility check** | none | none | 200 `{kudos, kudoed: false, reactions, my_reaction}`, defaulting to `{}`/null and overridden by the actual counts | |
| 18 | GET /v1/events/{event_id} | auth | none | none | event card + `kudos_by: [person]` | 404 |
| 19 | DELETE /v1/events/{event_id} | auth | none | none | 204, **hard delete** (cascade) | 404 if not mine |
| 20 | GET /v1/events/{event_id}/comments | auth | none | none | 200 `[{id, body, created_at, author: person, can_delete, mine}]` ordered by created_at ASC, at most 200 | 404 |
| 21 | POST /v1/events/{event_id}/comments | require_social | comment 30/3600s | `{body: str 1..280}`, cleaned; an empty result is a 422 ValueError "Say something" | 201 the comment, with can_delete and mine both true | 422; 404 |
| 22 | DELETE /v1/comments/{comment_id} | auth | none | none | 204 hard delete | 404 unless comment author or event owner |
| 23 | POST /v1/reports | auth (get_profile) | report 20/3600s | below | 201 `{detail: "Thanks - a moderator will look at it."}` | 404 "Not found" |

### Details

**1. People search**:
- `term = q.strip().lower().lstrip('@')`.
- Handle pattern: `term.replace('%','').replace('_','\_') + '%'`, a prefix ILIKE. Postgres' default LIKE escape is backslash, so for SQLite add `ESCAPE '\'`. A backslash in the term is not escaped.
- Display name: ILIKE `%term%` **unescaped** (a `%` or `_` in the term acts as a wildcard).
- Filters: not self, `visibility != 'private'`, social_ok, not_blocked.
- Order: `length(handle)` ASC (ties nondeterministic). Limit 20.
- An empty term after stripping (q = "@" or spaces) matches everyone.

**2. Suggested**: candidates are group-mates (anyone sharing a group, including the caller, who is excluded separately) or followees of my accepted followees. Excludes people I already follow with status accepted (pending ones can still appear), private accounts, non-social accounts and blocked pairs. Limit 12.

**3. View person**:
- If target ≠ me: 404 when the viewer is !social_allowed, either side has blocked the other, or the target is !social_allowed.
- `visible = me || can_see`. `relationship` (null for me) is `{following: status|null, follows_you: status|null, blocked: bool (me→them only)}`.
- `counts`: accepted followers and accepted following (raw counts, no block/social filter).
- Base response: `person(profile, stats) + {bio, me, visible, relationship, counts}`. When !visible it stops there.
- Otherwise it runs `snapshot(db, uid)` (game engine, **writes**, then commits). Badges: user_achievements ordered by unlocked_on DESC, limit 12. Adds:
  - `streak`: chain_payload(snap.chains[0]) filtered to the keys current, longest, this_week_days, this_week_target, weeks.
  - `heatmap: [{date, level}]`.
  - `totals: {sessions, active_days: len(snap.days)}`.
  - `achievements: [{id, title: RULE_BY_ID[id].title, tier, date}]`, skipping ids unknown to RULE_BY_ID, and **empty when gamification is disabled**.
  - `level`: snap.level, or null when gamification is off.
  - Note that person() may already have set `level` from stats. This later key overwrites it.

**4./15. Feed page `_feed_page(viewer, authors|None, before)`**:
- SELECT event and author profile, with correlated subqueries:
  - kudos_count: count of all kudos on the event.
  - comment_count: count of comments where `hidden_at` is null. **No block or social filter**, so this can differ from the list endpoint.
  - mine: count of the viewer's kudos.
- Filters: `hidden_at IS NULL`, `can_see_clause(viewer)` on the author.
  - authors given: `user_id IN authors`.
  - feed: `user_id = viewer OR user_id IN (accepted followees)`.
  - before: `created_at < before`.
- ORDER created_at DESC, LIMIT 26. `more = len > 25`; keep 25.
- Reactions come from a second query grouping (event_id, reaction) counts, plus a query for the viewer's own reaction.
- Item: `{id, kind, data, date: occurred_on, created_at, author: person(p) (no stats), kudos, comments, kudoed: bool, mine, reactions: {}, my_reaction: null|str}`.
- Page: `{events, next: last.created_at.isoformat() if more else null}`.
- `before` is parsed by FastAPI as a datetime (ISO 8601, a naive value is allowed; a naive value compared against timestamptz is read in the session TZ, UTC). The client passes back `next`. **D1: store created_at as a sortable ISO string or epoch ms and compare consistently. Ties on created_at can drop or duplicate rows across pages.**

**5. Follow**:
- If a row already exists (any status), return `{status: existing.status}` with no notification.
- Otherwise insert, with status accepted and accepted_at = now when the target is public, else pending.
- notify target:
  - kind `new_follower` or `follow_request`, category social.
  - title `"{display_name or '@'+handle} followed you"` or `"... wants to follow you"`.
  - url `/u/{me.handle}` or `/people?tab=requests`.
  - actor_id me, dedupe_key `follow:{me.id}`. This is per follower forever, so unfollowing and refollowing never notifies again, even when switching between request and follow.

**11. Answer a request**:
- accept: status accepted, accepted_at now. notify the follower with kind follow_accepted, title `"{display_name or '@'+(handle or '')} accepted your follow request"`, url `/u/{handle}`, dedupe `follow_accepted:{me.id}` (once per accepter, ever, across all followers... per recipient user_id, since the unique key is (user_id, dedupe_key)).
- decline: delete the row.
- Note on the order of checks: decision is validated before the UUID lookup, but a malformed UUID is a 422 from the path parser first.

**12. Block**:
- Insert a block if none exists.
- Delete follows in both directions.
- Update buddy_pairs for (sorted ids) where status ≠ ended to `status=ended, ended_at=now`.
- No notification. Note the **sorted UUID order**: Python sorts by the uuid int, which equals lowercase-hex string order. Store UUIDs as lowercase canonical text so this holds.
- Block does **not** require require_social. It also does not touch group membership or challenge rows.

**16. Kudos**:
- `visible_event` means `hidden_at` is null and can_see_clause holds on the author, else 404.
- An existing row has its reaction updated, with no notification.
- Otherwise insert. If the event is not mine, notify the author: kind kudos, title `"{name} gave you kudos"`, url `/feed/{event_id}`, dedupe `kudos:{event_id}:{me.id}`.
- Response: `{kudos: count(*), kudoed: true, reactions, my_reaction}`. The test expects `{"fire": 1}` and `"fire"` after the first reaction.
- The event-visibility check comes after the rate limit, and require_social comes before enforce. Order: require_social, enforce, visible.

**17. Delete kudos**: removes the viewer's kudos without checking visibility. The response merges the defaults `reactions:{}` and `my_reaction:null`, then any actual entry (the event's remaining counts; my_reaction null).

**18. Get event**:
- visible_event (404).
- Builds the viewer's whole main feed page (25 newest) and searches it for the event.
- If it isn't there, builds a fallback with `comments: 0` (**quirk: always 0**) and the plain kudos count.
- `kudos_by`: profiles joined to kudos on the event, where can_see_clause(viewer) holds for the kudo-giver, ordered by kudos.created_at DESC, limit 50, as person(p).

**20. List comments**: comment authors must be social_ok and not blocked with the viewer; `hidden_at` must be null. `can_delete = author == me || event.user_id == me`.

**21. Add comment**: insert and flush. If the event is not mine, notify the author: kind comment, title `"{name} commented"`, body `body[:140]` (Python slices by code point; JS must slice with `Array.from`), url `/feed/{event_id}`, **no dedupe**. `created_at` falls back to now when the ORM hasn't refreshed it.

**23. Report**:

`ReportIn`:

| Field | Type and constraint |
|---|---|
| target_type | regex `^(user\|comment\|event\|group\|challenge)$` |
| target_id | str 1..64 |
| reason | `^(spam\|harassment\|inappropriate\|impersonation\|self_harm\|other)$` |
| detail | str ≤ 500 or null |

Snapshot per target type:

| target_type | Lookup | reported_user_id | snapshot |
|---|---|---|---|
| user | by handle, so 404 when missing | the user | `{handle, display_name, bio}` |
| comment | by UUID; invalid UUID → 404 | author | `{body}` |
| event | by UUID | event user | `{kind, data}` |
| group | by UUID | owner | `{name, description}` |
| challenge | by UUID | creator | `{title, description}` |

- No visibility check: anyone can report any existing id.
- A missing target → 404 "Not found".
- detail is cleaned; an empty detail becomes null... (cleaned "" stays "", stored as ""). Precisely: `clean_text(detail) if detail else None`, so whitespace-only detail is stored as `""`.
- Report status defaults to open.

### Profile view: final response keys
`id, handle, display_name, avatar_hue, visibility, official, [level], [current_streak], bio, me, visible, relationship, counts` and, when visible, also `streak, heatmap, totals, achievements, level`.

## 3. Routes: buddies and encouragement (`app/social/buddies.py`)

Constants: `MAX_BUDDIES = 5`. PRESETS (ordered dict, the order matters for the presets list):

| id | text |
|---|---|
| you-got-this | You've got this. |
| one-more | One more session keeps it going. |
| proud | Proud of you for showing up. |
| rest-well | Rest well. The streak will wait. |
| lets-go | Training today too. Let's go. |
| welcome-back | Good to see you back. |

| Method + path | Gate | RL | Request | Response | Errors / side effects |
|---|---|---|---|---|---|
| GET /v1/buddies | require_social | none | none | `[pair_view]` of my pending and active pairs ordered by created_at; pairs whose other profile is missing are skipped | |
| POST /v1/buddies | require_social | buddy-invite 10/86400 | `{handle: str 1..31}` | **201** pair_view | 422 "You can't buddy up with yourself"; 403 "You can buddy up with people you follow or who follow you." (target !social, blocked either way, or no accepted follow in either direction); 409 "5 buddies at a time is the limit" (count of my pending+active ≥ 5); 409 "You're already buddies, or an invite is waiting"; 404 bad handle. Upsert pair (a, b = sorted): a new row, or reset an ended one to `requested_by=me, status=pending, started_at=null, ended_at=null`. notify them: kind buddy_invite, title `"@{me.handle} wants to be streak buddies"`, body "A week counts when you both keep yours. You'd see each other's weekly progress.", url /buddies, dedupe `buddy-invite:{pair.id}:{UTC date}` |
| POST /v1/buddies/{pair_id}/accept | require_social | none | none | 200 pair_view | 404 "Not found" (not a member); 409 "There's nothing to accept" (not pending, or I requested it); 409 "This invite is no longer available" (other !social or blocked). Sets active, started_at=now; notify other: kind buddy_accepted, title `"@{me.handle} is your streak buddy now"`, body "This week is your first together.", url /buddies, no dedupe |
| POST /v1/buddies/{pair_id}/end | auth only | none | none | 204 | 404. No-op if already ended; otherwise status=ended, ended_at=now. No notification |
| GET /v1/encouragement/presets | **none** | none | none | `[{id, text}]` | |
| POST /v1/people/{handle}/encourage | require_social | encourage 20/86400 (**after** preset validation) | `{preset: str ≤20}` | **202** `{sent: bool}` | 422 "Pick one of the messages" (unknown preset, checked before the RL); 404 handle; 403 "You can encourage people who follow you, your buddies and your groups." (self, them !social, blocked, or !may_encourage). notify: kind encouragement, title `"@{me.handle}: {text}"`, body null, url `/u/{me.handle}`, dedupe `encourage:{me.id}:{UTC date}` (once per sender→recipient per UTC day; a duplicate gives sent:false) |

**may_encourage(sender, recipient)**: the recipient has an accepted follow of the sender, OR the pair is an active buddy pair, OR the two share any group.

**pair_view(pair, me, them, stats)**:

```
{id, status, incoming: status==pending && requested_by != me, buddy: person(them, their_stats), started_at: iso|null}
```

If the status is active and both stats rows exist, it adds:
- `current`, `longest`, `weeks` (the last 12 statuses).
- `me: {days, target}` from my this_week_days and this_week_target.
- `them: {days, target, paused: theirs.recent_weeks[-1]=="paused"}`. When recent_weeks is empty this is "open", so paused is false.

These come from `joint_streak([mine.recent_weeks, theirs.recent_weeks], threshold=1.0, max_weeks=weeks_since(me, started_at))`.

`weeks_since`:
- today = local_today(my tz).
- start = week_start(local_date(started_at, tz) or today, my week_starts_on).
- Result: `(week_start(today) - start).days // 7 + 1`.

**joint_streak(members, threshold, max_weeks)** (pure, port verbatim):
- `depth = max(len)`. If max_weeks is given, `depth = min(depth, max(1, max_weeks))`.
- For `back` from depth-1 down to 0:
  - statuses = `m[len-1-back]` for each member with `back < len`.
  - `counted` = the statuses that are not paused; `kept` = the counted statuses in {kept, frozen, repaired}.
  - status: paused if nothing was counted; else kept if `kept >= threshold*len(counted) - 1e-9`; else open if back == 0; else missed.
- Run: a kept week increments run and updates longest; a missed week resets run to 0; paused and open weeks leave it alone.
- Result: `{current: run, longest, weeks}`.

## 4. Routes: groups, coaching, challenges, announcements (`app/groups/router.py`)

Constants: MAX_GROUPS=20 (owned), MAX_MEMBERS=200 (group members and challenge participants), MAX_CHALLENGE_DAYS=92, LATE_LOG_GRACE=3 days.

`invite_code()` returns 8 chars from `abcdefghjkmnpqrstuvwxyz23456789` using `secrets` (31-char alphabet; use crypto.getRandomValues with rejection sampling). No collision retry: a collision violates the unique constraint and gives a 500.

`_group_for_member`: 404 "Not found" when the group is missing, I'm not a member, or the group is hidden.

`_group_out(g, member, count)`:

```
{id, name, description, kind, avatar_hue, member_count, my_role, shares_with_coach (false if no member), muted, streak_threshold, invite_code: only when my role is owner or admin, else null}
```

| Method + path | Gate | RL | Request | Response | Errors / side effects |
|---|---|---|---|---|---|
| GET /v1/groups | auth | none | none | `[_group_out]` of my groups where hidden_at is null, ordered by name; count = all members | |
| POST /v1/groups | require_social | group-create 5/3600 | GroupIn `{name 2..60, description ≤280\|null, kind ^(crew\|coaching)$ = crew, avatar_hue 0..359\|null}`, name and description cleaned | 201 _group_out(count 1) | 409 "Group limit reached" (owned ≥ 20, **hidden groups included**). Inserts group (hue default 200) and an owner membership |
| POST /v1/groups/join | require_social | group-join 20/3600 | JoinIn `{code 4..16}`; lookup by `code.strip().lower()` | 200 `{id}` | 404 "That code does not match a group" (missing or hidden); already a member returns `{id}` with no notification; 409 "That group is full" (≥200). Inserts a member; notify owner: kind group_join, category **groups**, title `"{name} joined {group.name}"`, url `/groups/{id}`, data `{group_id}`, dedupe `group_join:{gid}:{uid}` |
| GET /v1/groups/{gid} | member | none | none | _group_out(count = the visible rows) + `members`, `streak` | members: the group's members that are social_ok and not blocked with the viewer, as `person(p, s, role, this_week_days (0), this_week_target (null), consistency (0), last_active iso\|null, shares_with_coach (only for coaching, else null))`, sorted by `(-current_streak or 0, handle or "")`. Note that member_count here is the **filtered** count, unlike the list endpoint |
| PATCH /v1/groups/{gid} | member, owner or admin | none | GroupPatch `{name 2..60, description ≤280, avatar_hue 0..359, streak_threshold 50..100}`, all optional | 200 `{id}` | 403 "Only the owner or an admin can edit". Applies **exclude_unset** fields; an explicit null is set as null (a null name would violate NOT NULL, a 500 quirk) |
| DELETE /v1/groups/{gid} | owner | none | none | 204 | 403 "Only the owner can delete a group"; hard delete with cascade |
| POST /v1/groups/{gid}/leave | member | none | none | 204 | 409 "Hand ownership to someone else, or delete the group" for the owner |
| POST /v1/groups/{gid}/invite/rotate | owner or admin | none | none | 200 `{invite_code}` | 403 "Only the owner or an admin can do that" |
| PATCH /v1/groups/{gid}/members/{member_id} (member_id = **user id**) | member | none | `{role ^(owner\|admin\|coach\|member)$}` | 200 `{role: target.role}` | 404 "Not found" for an unknown target. role=owner: 403 "Only the owner can hand over" if I'm not the owner; otherwise me→admin, target→owner, group.owner_id=target (if the target is myself, I become owner again... me and target are the same object, so the final role is owner). The owner may set any non-owner role on a target unless the target is the owner (409 "Hand over ownership instead"). An admin may change only coach or member targets, to coach or member. Otherwise 403 "Not allowed" |
| DELETE /v1/groups/{gid}/members/{member_id} | member | none | none | 204 | 404; 403 "Not allowed" if the target is the owner, I'm not owner or admin, or an admin targets an admin. An admin removing themself is also blocked (a target admin), while an owner removing themself is blocked as an owner target |
| PATCH /v1/groups/{gid}/me | member | none | `{shares_with_coach?: bool, muted?: bool}` | 200 `{shares_with_coach, muted}` | |
| GET /v1/coaching | auth | none | none | `{groups: [{id, name}], people: [...]}` | below |
| GET /v1/groups/{gid}/coach | member, coaching kind, role owner/admin/coach | none | none | `{members: [...]}` | 403 "Coaches only" |
| GET /v1/groups/{gid}/feed | member | none | `before`: **str**, parsed with `datetime.fromisoformat` (a bad value gives a 500) | feed page without reactions: `{events: [{id, kind, data, date, created_at, author, kudos, comments: 0, kudoed, mine}], next}` | filters: author in the group's members, hidden null, author visibility ≠ private, social_ok, not blocked. 25 per page with a 26-row probe |
| GET /v1/challenges | auth (get_profile) | none | none | `[_challenge_out(..., count = active participants or 0)]` | challenges where hidden is null AND (I joined with left_at null, OR group_id is in my groups) AND `ends_on >= today_local - 60d`, ordered by ends_on DESC |
| POST /v1/challenges | require_social | challenge-create 10/3600 | ChallengeIn (below) | 201 _challenge_out(joined=true, creator=true, count 1) | below |
| GET /v1/challenges/code/{code} | require_social | none | none | _challenge_out(joined=**false** always, count=null) | 404 "That code does not match a challenge" (code lowercased, **not stripped**; hidden). Works for resolved and group challenges too (it leaks the existence of group challenges to anyone who has the code) |
| GET /v1/challenges/{cid} | visible_challenge | none | none | _challenge_out + `{leaderboard, days_total, days_elapsed}` | 404. joined = my id is on the board. count = board length. `days_total = ends-starts+1`; `days_elapsed = max(0, min(today-starts+1, days_total))`. Commits, because snapshot writes |
| POST /v1/challenges/join | require_social | none | JoinIn code (strip+lower) | 200 `{id}` | 404 "That code does not match an open challenge" (missing, hidden or resolved). Works for group challenges by code too, with no membership check |
| POST /v1/challenges/{cid}/join | require_social, visible_challenge | none | none | 200 `{id}` | 404; 409 "That challenge has finished" (resolved) |
| POST /v1/challenges/{cid}/leave | auth | none | none | 204 always | If a participant row exists: left_at=now, and `UPDATE training_plans SET started_on=NULL WHERE user and challenge_id` |
| DELETE /v1/challenges/{cid} | creator | none | none | 204 | 404 when not the creator; hard delete with cascade (training_plans.challenge_id FK behaviour: check the training spec) |
| POST /v1/groups/{gid}/members/{member_id}/plan | member, coaching, role owner/admin/coach | assign-plan 20/86400 (after the consent check) | AssignIn `{plan_template_id ≤40?, plan_id uuid?, note ≤200?}` | **201** `{id: new plan id}` | 403 "Coaches only"; 403 "Only members who share their training with you" (missing, not sharing, or self); 404 "No such template" / "No such plan" (a plan_id not mine); 422 "Choose a plan to suggest". `check_plan_room(member)` may raise (training spec). `materialize(member, shared, assigned_by=me)`. notify member: kind plan_assigned, category groups, title `"@{coach.handle} suggested a plan: {plan.name}"`, body `clean_text(note) or "It's in your plans. Start it when you're ready, or not at all."` (**clean_text(None) crashes** when the note is null: `unicodedata.normalize` on None raises a TypeError and a 500; an empty note string falls back to the default text). Port with care: is the absence of a note a 500 in prod? Yes, a latent bug; decide whether to preserve it |
| GET /v1/groups/{gid}/announcements | member | none | none | `[{id, body, pinned, created_at, author: person\|null}]` ordered by pinned DESC, created_at DESC, limit 30 | |
| POST /v1/groups/{gid}/announcements | owner or admin | announce 5/86400 **per group** | `{body 1..500, pinned=false}` | 201 announcement | 403 "Only the owner or an admin can post"; 422 "Say something" (empty after cleaning). If pinned, first unpins all of the group's announcements. notify every other member: kind group_announcement, category groups, title `"{group.name}: {text[:80]}"`, body text if len>80 else null, url `/groups/{gid}`, data {group_id}, dedupe `announce:{item.id}` |
| DELETE /v1/groups/{gid}/announcements/{aid} | owner or admin | none | none | 204 | 403 "Only the owner or an admin can remove it"; 404 |

### ChallengeIn

| Field | Type and constraint |
|---|---|
| title | str 3..60, cleaned |
| description | ≤280, cleaned |
| kind | ^(active_days\|weekly_target\|plan_sessions)$, default active_days |
| target | int 1..366 or null |
| plan_template_id | ≤40 |
| plan_id | uuid |
| disciplines | list[str], max 11 items, each in DISCIPLINE_IDS, else 422 "unknown disciplines: a, b" |
| starts_on, ends_on | date, required |
| group_id | uuid or null |

Create checks, in order:
1. require_social, then the rate limit.
2. `ends < starts` → 422 "It ends before it starts".
3. `ends-starts+1 > 92` → 422 "Challenges last up to 92 days".
4. `starts < today_local - 1` → 422 "Challenges cannot start in the past".
5. A group_id where I'm not a member → 404 "Not found". A hidden group is not checked.
6. plan_sessions only:
   - Source: template (404 "No such template"), or plan_id (404 "No such plan" unless mine), or neither → 422 "Choose the plan everyone will follow".
   - `ends_on = starts + 7*len(shared.weeks) - 1` days.
   - Over 92 days → 422 "Plan challenges last up to 13 weeks".
   - `plan = shared.model_dump(json)`.
   - `target = body.target or sum(len(week) for week in weeks)`.

Note: the ends_on checks in steps 2-3 run on the body's dates even for plan_sessions.

After the checks: insert the challenge (invite_code), flush, insert the creator as a participant, then `_join_plan` for the creator.

`_challenge_out`:

```
{id, title, description, kind, target, disciplines, starts_on, ends_on, group_id|null, plan_name: plan.name if plan_sessions else null, status, joined, is_creator, invite_code: shown only if (creator or joined) and NOT a group challenge, participants}
```

status: `finished` if resolved or today > ends_on; `upcoming` if today < starts_on; otherwise `live`.

**visible_challenge**: 404 when the challenge is missing or hidden, or when I have no participant row (**left participants still count**) and I'm not a member of its group.

**_join**: no participant row: count all participants (including those who left); ≥200 → 409 "That challenge is full"; else insert. An existing row has left_at cleared. Then `_join_plan`.

**_join_plan** (plan_sessions with a plan only): reuse the user's earliest plan with this challenge_id (ordered by created_at, then id), or `check_plan_room` and `materialize(user, SharedPlan(c.plan), challenge_id)`. Then `run_only(plan, week_start(c.starts_on, user.week_starts_on))`. Both are training-module functions.

**_scores(c, today)** (the leaderboard):
- Participants where left_at is null, joined to profile, outer-joined to stats.
- `end = min(ends_on, today)`.
- Per participant:
  - resolved and final_score is set: final_score.
  - today < starts_on: 0.
  - active_days: `COUNT(DISTINCT workout.local_date)` where user, not deleted, `source='app'`, local_date between starts_on and end, `created_at <= started_at + 3 days`, and discipline IN disciplines when the list is non-empty.
  - plan_sessions: the earliest plan copy for the challenge; 0 if none or not started; else `plan_view(app_only=True).progress.done` or 0.
  - weekly_target: `snapshot(user)`; first = week_start(starts_on, that user's wso); count the main-chain weeks where `first <= week_start <= ends_on` (**not** end/today), status kept and days ≥ target.
- Sort by score DESC (stable, insertion order from the DB, otherwise arbitrary). Competition ranking: 1, 1, 3.
- Row: `person(profile, stats) + {score, rank: final_rank or rank, completed: part.completed or (target and score >= target)}`.
- "today" is the **viewer's** local date for every participant.

**resolve_finished(db, today_utc)** (worker, `app/worker.py:406`, every 5 minutes):
- Challenges where resolved is null and `ends_on < today - 1 day`, including hidden ones.
- `board = _scores(c, c.ends_on)`.
- For each board row (participants that haven't left):
  - final_score and final_rank.
  - `completed = (target and score >= target) or (no target and score > 0)`.
  - notify: kind challenge_finished, category groups, title `"{title} is over - you placed #{rank}"`, body `"{score} {unit}."` (units: active days / weeks kept / plan sessions done), url `/challenges/{id}`, data {group_id} if any, dedupe `challenge_done:{cid}`.
  - If completed: `emit_event(profile, "challenge", "challenge:{cid}", ends_on, {title, rank, score, kind})`.
- Then `resolved_at = now`. Returns the notification ids; the caller commits and delivers.

**GET /v1/coaching**:
- Groups where I am owner, admin or coach and the kind is coaching, ordered by name (**hidden groups are included**, but coach_view then 404s for a hidden group and the whole request raises a 404).
- For each, call coach_view (which re-checks).
- Merge members by key `handle or id`, appending `{id, name}` to `groups`. The first group's row wins.
- `last_session` = the max of recent[].date (an ISO string max).
- `quiet_days = today_local(coach tz) - last`.
- `attention = at_risk or no session or quiet_days >= 7`.
- Sort by `(not attention, last_session or "")`, so attention rows come first, then oldest last_session first, with no session sorting before others.

**coach_view** members: memberships with shares_with_coach true, excluding me, joined to profile. **No social_ok or block filter.** Per member:
- `snapshot()` (heavy). `main = chains[0].result`.
- Running plan: started_on set and finished_at null, ordered by started_on DESC, then id DESC.
- `plan_view` gives `plan: {name, week: current_week+1, weeks: weeks_count, done, due, from_this_coach: assigned_by == me}` or null.
- Recent: 10 non-deleted workouts by started_at DESC.
- Row: `person(p) | {current_streak, this_week_days, this_week_target, at_risk, consistency, plan, weeks: [{week_start, days, target, status}] (last 8), recent: [{id, date, discipline, title, duration_sec, distance_m, effort, feel, sets: count of sets that are completed and not warmup}]}`.
- N+1: workout.sets is a relationship, so it lazy/selectin-loads.

**group_streak(group)**:
- Members joined to profile and **inner-joined to user_stats** (members without stats are excluded), filtered by social_ok. No block filter, so the result is the same for every viewer.
- Per member:
  - since = week_start(local_date(member.created_at, tz), wso).
  - now = week_start(local_today(tz), wso).
  - span = (now - since) // 7 + 1.
  - history = `recent_weeks[-span:]`.
- `joint_streak(histories, threshold = streak_threshold/100)`, no max_weeks.
- Result: `{current, longest, threshold, weeks: last 12 statuses, this_week: {kept, counted} | null}`.
- Test: a single member who logged one session this week gives `this_week == {kept:0, counted:1}`.

## 5. Routes: search (`app/search/router.py`): owner-private, no social gate

| Method + path | Request | Response |
|---|---|---|
| GET /v1/search | `q` 2..60 chars (validated **before** strip), then stripped | `{q: stripped, results: [...]}` |
| GET /v1/day/{day} | day: date (YYYY-MM-DD, else 422) | the day bundle (below) |

**Search**:
- `like = '%' + escape(q) + '%'`, where escape doubles `\` and backslash-escapes `%` and `_`. Postgres ILIKE's default escape is `\`; in SQLite add `ESCAPE '\'`, and **SQLite LIKE is case-insensitive only for ASCII** (Postgres ILIKE is Unicode-aware; consider `lower()` on both sides, with the caveat that SQLite lower() is ASCII-only too; to match Unicode, fold in JS or store lowered copies).
- PER_KIND = 8 for each block. Blocks are appended in this order:

| kind | Query | Item |
|---|---|---|
| habit | habits of uid where name, cue or why matches; ORDER BY `archived_at IS NOT NULL`, position | `{kind, id, title: "{emoji} {name}", detail: "Archived" if archived else snippet(cue or why, q), url: /habits/{id}}` |
| habit_note | habit_logs join habits where log.note matches; ORDER BY day DESC | `{kind, id: log.id, title: "{emoji} {name}", detail: snippet(note), date: day, url: /habits/{habit_id}}` |
| workout | not deleted; title or notes matches; ORDER BY started_at DESC | `{title: title or discipline.title(), detail: snippet(notes), date: local_date, url: /workouts/{id}}`. Python `str.title()` capitalises after every non-letter (e.g. "open_water" → "Open_Water") |
| journal | journal_days note matches; ORDER BY day DESC | `{title: "Journal", detail: snippet(note), date, url: /day/{day}}` |
| food | foods of uid, name or brand matches; ORDER BY name | `{title: name, detail: "{brand} · " if brand, then "{round(kcal)} kcal", url: /food}` |
| recipe | recipes name matches; ORDER BY name | `{title, detail: "Recipe · {round(kcal)} kcal a serving", url: /food}` |

- **round() is Python banker's rounding** (round(2.5)=2). In JS: implement round-half-even.
- **Postgres ORDER BY name** uses the DB collation (probably en_US.UTF-8, or C on Neon? check); SQLite uses BINARY. Ordering may differ.

**snippet(text, q, width=90)**:
- Falsy text → null.
- `at = text.lower().find(q.lower())`. If `at < 0` or `len ≤ 90`: `text[:90]`.
- Otherwise `start = max(0, at - 30)`, giving `("…" if start) + text[start:start+90] + ("…" if start+90 < len)`.
- Python indices are code points; in JS use `Array.from`. `.lower()` can change length for some characters (İ), so match semantics may drift slightly.

**Day bundle**:

```
{date,
 workouts: [{id, title, discipline, duration_sec, distance_m}] (not deleted, local_date = day, ordered by started_at),
 habits: [{id, name, emoji, kind, unit, amount (0 when no log), note (null), done: is_done(kind, amount, daily_goal)}] (habits with started_on <= day and archived_at null, ordered by position; **archived habits are excluded even for past days**),
 food: {meals: [{meal, count, kcal: round(sum,1), protein_g: round(sum,1)}] (GROUP BY meal, no ORDER, arbitrary), kcal: round(total,1), protein_g},
 journal: {mood, note}|null,
 readiness: {sleep, energy, soreness}|null,
 rest: {kind, note}|null,
 weigh_ins: [{weight_kg, moment}] ordered by weighed_at}
```

`is_done`: quit → amount ≤ 0; check → amount > 0; otherwise amount ≥ (daily_goal or 1).

Sums use Postgres numeric/float. `round(x, 1)` is also banker's-style on the float repr; reproduce with care.

## 6. emit_event (`app/social/service.py`, called from training, game and resolve_finished)
- Skip when visibility is private, sharing_paused is set, or !social_allowed.
- `INSERT activity_events (user_id, kind, ref_key[:120], data, occurred_on, workout_id) ON CONFLICT (user_id, kind, ref_key) DO UPDATE SET data = excluded data`. occurred_on and workout_id are not updated.
- D1 supports `ON CONFLICT(...) DO UPDATE`; Drizzle has `onConflictDoUpdate`.

## 7. Porting hazards (Workers/D1)

| Area | Python / Postgres | Replacement / note |
|---|---|---|
| UUIDs | uuid4 PKs; Python UUID ordering for buddy `user_a < user_b`, and `sorted()` in block | `crypto.randomUUID()`; store lowercase TEXT, so string comparison equals uuid-int order. Keep the CHECK constraint |
| JSONB | activity_events.data, challenges.disciplines/plan, reports.snapshot | TEXT with `mode: 'json'` in Drizzle. `discipline IN disciplines` is resolved in JS from the parsed list |
| ILIKE | people search, /search | `LIKE ... ESCAPE '\'`; ASCII-only case folding in SQLite. Unicode handles and names: Postgres folds É/é and SQLite does not |
| ON CONFLICT DO NOTHING RETURNING id | notify dedupe | Supported in SQLite ≥ 3.35 (D1 yes); RETURNING yields no row on conflict, same as Postgres |
| Interval arithmetic | `created_at <= started_at + interval '3 days'` | store epoch ms or ISO text; in SQL: `created_at <= datetime(started_at, '+3 days')`, careful with ISO formats with offset and 'T'. Simplest: integer ms columns |
| timestamptz compare for `before` cursors | `created_at < :before` | ISO strings need an identical format (fixed micro precision, Z vs +00:00). The client echoes `next`, so the output format must be parseable back. Recommend storing ms ints and emitting Python-isoformat-compatible strings (`+00:00`, 6-digit micros when non-zero) |
| Correlated subqueries, EXISTS, NOT IN | feed, suggested, may_encourage | All work in SQLite. `select(or_(exists...))` becomes `SELECT EXISTS(...) OR EXISTS(...)` |
| func.length | handle ordering | SQLite `length()` counts characters, OK |
| COUNT(DISTINCT local_date) | challenge score | OK |
| Boolean ordering `archived_at IS NOT NULL` | search | OK (0/1) |
| ORDER BY name collation | food/recipe/group lists | Postgres collation vs SQLite BINARY; may reorder mixed-case names. Use `COLLATE NOCASE`, or accept the difference |
| Redis rate limiter | `enforce` INCR/EXPIRE fixed window | Workers KV is not atomic. Use a Durable Object counter, or the Workers Rate Limiting binding (approximate), or a D1 table `rate_limits(key, count, expires_at)` with an UPSERT; keep fail-open |
| BackgroundTasks `deliver` | after-response push/email | `c.executionCtx.waitUntil(deliver(ids))`; web push in Workers needs a VAPID/WebCrypto library (`@block65/webcrypto-web-push` or `web-push` is Node-only; see the notifications spec) |
| `secrets.choice` invite codes | 8 of 31 chars | `crypto.getRandomValues` with rejection sampling |
| `unicodedata.normalize` / category | clean_text | `String.prototype.normalize('NFKC')` and `/\p{Cc}\|\p{Cf}\|\p{Co}/u`. Unicode version differences between Python and V8 are negligible |
| Python slicing `[:140]`, `[:80]`, `[:120]` | by code point | `Array.from(s).slice(0,n).join('')` |
| `str.title()` | workout fallback title | custom implementation (capitalise after non-letters) |
| `round()` banker's | search kcal, day totals | implement round-half-even |
| CPU | `snapshot()` (full streak engine) runs per participant (weekly_target), per coached member, per coaching group, in profile view, in plan_view; `get_event` builds a whole feed page | Workers' CPU limit (30 s paid default, 10 ms free). A large coaching overview or a 200-person weekly_target challenge risks timeouts. Cache, or batch queries; D1 round trips per member (N+1) are slow |
| Transactions | `flush` then `commit`; multi-statement units (block: insert + delete + update; announce: unpin + insert + N notifies; create challenge + participant + plan materialize) | D1 has no interactive transactions. Use `db.batch([...])` for atomicity; generated ids are produced in JS up front so dependent inserts can be batched |
| Worker job | `resolve_finished` from the GHCR worker every 5 minutes | Cron Trigger (`scheduled` handler) |
| Implicit snapshot writes | profile view, challenge view and coach view commit inside GET | Keep the side effects (game spec) |
| FK cascades | deletes of events, groups, challenges | D1 enforces FKs; define ON DELETE in Drizzle |
| Postgres NULL-distinct unique | notifications(user_id, dedupe_key) with a null key | SQLite also treats NULLs as distinct: OK |
| Unique-violation 500s | invite_code collision, races on follow/kudos/membership double insert (concurrent requests become a 500 IntegrityError) | Same behaviour from SQLite constraint errors; map to 500 or retry |
| Pydantic quirks | min_length before cleaning; `Literal` 422; `before: datetime` parsing; JSON body optional on kudos (an empty body is fine, invalid JSON is a 422) | Zod: emulate the order. Kudos must accept no body and no content-type |

No filesystem use in scope. No Postgres-only functions beyond ILIKE, interval math and JSONB.

## 8. Latent bugs and quirks to preserve or decide

1. `assign_plan` with `note` null calls `clean_text(None)`, a TypeError and a 500. Tests always pass a note? (test_social_plans test_coach_can_suggest… check its body). Likely a real prod bug.
2. `GET /groups/{gid}/feed?before=garbage` gives a 500 (fromisoformat). Main feed `before` gives a 422.
3. `get_event` fallback reports `comments: 0`.
4. Feed comment counts ignore blocks and suspensions; the comment list filters them.
5. `GET /coaching` 404s entirely if any of my coaching groups is hidden.
6. `challenges/code/{code}` lowercases without stripping; join strips.
7. Group `member_count`: list = all members; detail = members visible to the viewer.
8. A follow notification dedupe per follower, forever.
9. `DELETE /events/{id}/kudos` has no visibility check (harmless).
10. Report `detail` of whitespace only is stored as "".
11. PATCH group with an explicit `"name": null` → NOT NULL violation, a 500.
12. Owner role handover to self: me and target are the same row, so the owner stays owner.

## 9. Tests

| File | Covers | Notable assertions |
|---|---|---|
| tests/test_social.py | follow, feed, privacy, block, sharing pause, kudos, comments, age gate, unverified, reports and moderation, groups, challenges, leaderboards, notification prefs, group mute, reactions | public follow gives `{"status":"accepted"}` and the follower sees the workout event with `data.title`, no `notes`, author handle, and a `new_follower` notice; followers-only needs approval; private: following returns 404 and the person can't be found; a block gives 204 and the person 404 both ways, and follow 404; under-16 follow 403; unverified follow 403; double kudos count stays 1; comment `"  Strong‮ work\u0000  "` → `"Strong work"`; event owner can_delete; a 281-char comment 422; group join 200, detail member_count 2, a member sees invite_code null; coach view empty until shares_with_coach, member coach view 403; active_days challenge scores `{pete:1, olga:0}`; muted group still gets the group_join inbox item; reactions: fire → `(1, "fire", {"fire":1})`, switch → `{"strong":1}`, a no-body kudos, the author sees `{"strong":1,"kudos":1}` with my_reaction None, exactly 2 kudos notices, "lol nice" 422, delete → `(1, {"strong":1}, None)`; a report hides content and suspends (admin side) |
| tests/test_buddies.py | joint_streak unit tests (pair, freezes and repairs, paused, group threshold, current week, max_weeks, short histories) + API | strangers 403; invite 201; re-invite 409; the inviter accepting gives 409; the invitee sees `incoming: true`; accept 200; `them` has exactly the keys {days, target, paused} and days == 1; blocking ends the pair, so the list is []; presets non-empty; encourage 403 before the follow, 202 `sent:true`, then `sent:false`, free text 422, exactly one inbox item; group streak threshold 75, this_week `{kept:0, counted:1}`, patch threshold 20 → 422, 100 → 200 |
| tests/test_social_plans.py | plan_sessions challenges, coach assign, announcements, buddy nudge (worker), coaching overview, same-named routines on join | plan challenge 201, join 200, everyone gets a copy, sessions scored; a plan challenge without a plan 422; assign without consent 403, with consent 201; a member posting an announcement 403, an owner post 201, delete 204; the overview spans groups and respects consent |
| tests/test_qol.py | /v1/search and /v1/day | (grep for `/v1/search`, `/v1/day/`) |
| tests/test_admin_merge.py, test_auth.py, test_training.py | touch follows, groups and events indirectly (account merge and deletion cascades, emit on workout) | |
