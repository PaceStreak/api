# Auth spec (app/auth/*) for the Hono/Workers/D1 port

Sources: app/auth/{router,service,security,passkeys,dependencies,cache,models,schemas}.py, plus helpers they call:
app/turnstile.py, app/ratelimit.py, app/account/service.py (record, note_sign_in, describe_agent),
app/ops/service.py (record_failure), app/config.py, app/database.py (Base), app/main.py (startup checks, handlers).
Mounted: `app/v1/router.py` includes `auth_router` (prefix `/auth`) and `passkeys_router` (prefix `/auth/passkeys`) under `/v1`.

## 0. Config (defaults; env overrides, pydantic-settings)

| Setting | Default | Used for |
|---|---|---|
| jwt_issuer / jwt_audience | `api.pacestreak.com` / `pacestreak` | JWT iss/aud |
| access_token_minutes | 15 | access JWT exp; Redis revoked-sid TTL |
| refresh_token_days | 7 | refresh row expiry; cookie Max-Age (= days*86400) |
| jwt_private_key_pem / _public_key_pem (or *_path `./keys/private.pem`) | — | RS256; PEM with literal `\n` unescaped, `.strip()+"\n"` |
| cookie_domain | None | cookie Domain (prod `pacestreak.com`) |
| cookie_secure | False | Secure flag + `__Secure-` name prefix |
| cookie_samesite | `lax` | SameSite |
| user_cache_ttl_seconds | 60 | Redis user cache TTL |
| require_verified_email | False | login/passkey sign-in 403 gate |
| email_verify_token_hours | 24 | EMAIL_VERIFY code life |
| password_reset_token_minutes | 30 | PASSWORD_RESET code life |
| email_change_token_hours | 24 | EMAIL_CHANGE code life |
| mfa_challenge_minutes | 5 | mfa JWT exp |
| totp_valid_window | 1 | ±steps accepted |
| recovery_code_count | 10 | codes issued |
| totp_encryption_key | None | Fernet key (44-char urlsafe b64); None => plaintext (dev only) |
| totp_issuer | = app_name | otpauth issuer |
| webauthn_rp_id | None → hostname(frontend_url) or `localhost` | RP id |
| passkey_origin | frontend_url.rstrip("/") | expected origin (single string) |
| webauthn_rp_name | `PaceStreak` | |
| webauthn_challenge_seconds | 300 | challenge expiry and `timeout` (ms = *1000) |
| max_passkeys | 10 | |
| turnstile_secret_key | None (off) | |
| rate_limit_login | `10/minute` | login, passkey sign-in, sign-in/options |
| rate_limit_mfa_verify | `10/minute` | verify-email, reset-password, 2fa/verify, recover, confirm-email-change |
| rate_limit_signup | `5/minute` | signup |
| rate_limit_password_email | `3/minute` | resend-verification, forgot-password, change-email |

Production startup refuses unless: cookie_secure, !debug, totp_encryption_key set, turnstile_secret_key set, email_backend=smtp (main.py).

## 1. Cookies, CSRF, client IP

- Names: `__Secure-refresh_token` / `__Secure-csrf_token` when cookie_secure else `refresh_token` / `csrf_token`.
- Path: `/v1/auth` (both). Domain: cookie_domain. Max-Age = refresh_token_days*86400. SameSite = cookie_samesite (Starlette writes `SameSite=lax` lowercase), Secure = cookie_secure.
- refresh cookie HttpOnly; csrf cookie NOT HttpOnly.
- Value: refresh = `secrets.token_urlsafe(64)` (86-char base64url no pad); csrf = `token_urlsafe(32)` (43 chars), new on every login/refresh/change-password, also returned in body `csrf_token`.
- clear_auth_cookies: Starlette `delete_cookie(name, domain, path)` => `Set-Cookie: name=""; Max-Age=0; expires=<now GMT>; Path=/v1/auth; Domain=..; SameSite=lax` (Starlette delete_cookie also sets secure/httponly flags defaults false, samesite lax). Port must emit identical name/path/domain or browser won't delete.
- `require_csrf`: cookie CSRF_COOKIE and header `X-CSRF-Token` both present and constant-time equal, else **403 `{"detail":"Invalid CSRF token"}`**. Only on /refresh and /logout. Runs before body/cookie checks (dependency order: csrf then db).
- `client_ip`: first entry of `X-Forwarded-For`, stripped, `[:45]`; else socket peer. On Workers use `CF-Connecting-IP` (equivalent semantics), keep [:45].
- User-agent stored `[:400]`.
- CORS: explicit origins, credentials true, headers `*` + `X-CSRF-Token` (main.py).

## 2. Tokens

### Access JWT (RS256, header `{"alg":"RS256","typ":"JWT","kid":"main"}`)
Claims: `sub` (user uuid str), `type:"access"`, `ver` (users.token_version int), `sid` (refresh family uuid str), `jti` (uuid7 str), `iss`, `aud`, `iat`, `exp` (PyJWT encodes datetimes as **int** epoch seconds). `expires_in` = access_token_minutes*60 (900).
Decode: alg RS256 only, iss & aud checked, all of sub,type,ver,sid,jti,iat,exp,iss,aud required, type must be "access". PyJWT default leeway 0; also validates `iat` is not in the future? (PyJWT 2.x: iat must be numeric; `nbf`/`iat` future check — iat future raises ImmatureSignatureError only in old versions; treat as numeric-only).

### MFA challenge JWT
Same, `type:"mfa"`, no `sid`; exp = mfa_challenge_minutes (300s). Required claims sub,type,ver,jti,iat,exp,iss,aud.

### Refresh token rows
Raw = token_urlsafe(64); stored `sha256(raw).hexdigest()` (lowercase hex). family_id = uuid7 at login; parent_id chain; replaced_by.

### Auth dependency (`get_current_auth`) — used by every protected route in the API
1. `Authorization: Bearer <jwt>` (scheme case-insensitive). Missing/other → 401 "Invalid authentication credentials".
2. decode; any InvalidTokenError/ValueError/KeyError (incl bad sid uuid) → 401 "Invalid authentication credentials". NB: `sub` is not UUID-parsed here (string passed to db.get; a non-uuid sub would raise in Postgres -> 500 path; port: treat as 401).
3. Session denylist: Redis `EXISTS auth:revoked_sid:<sid>`; if Redis errors → DB fallback: live iff ∃ refresh_tokens row with family_id=sid AND revoked_at IS NULL. Revoked → 401 "Session has been logged out". NOTE: Redis-up path never hits DB, so a session whose family is fully revoked via rotation-burn writes Redis key too; consistent.
4. User: Redis `GET auth:user:<id>` JSON `{id,email,role,is_active,is_verified,token_version}`; miss → DB get then SET EX user_cache_ttl_seconds. Unreadable cache entry → delete + treat miss.
5. user missing or !is_active → 401 "User is inactive or missing".
6. payload.ver != user.token_version → 401 "Token has been revoked".
Returns (user, session_id).
- `get_current_user` = auth.user (may be cache-built, no secrets).
- `get_current_db_user` = DB re-read; missing/inactive → 401 "User is inactive or missing". Used where secrets read or user written.
- `get_optional_user`: no creds → None; any HTTPException → None.
- `get_verified_user` (403 "Email address not verified") — defined, unused in auth.
- FastAPI HTTPBearer(auto_error=False): a header like `Bearer` with no token → credentials None → 401.

## 3. Routes (22 in router.py + 7 in passkeys.py = 29)

Errors are `{"detail": "<msg>"}` unless stated. Pydantic validation failures → **422** with FastAPI's `{"detail":[{type,loc,msg,input,ctx?}]}` array (app relies on shape? check app's error parser). Rate limit (slowapi, key = `get_remote_address` = **request.client.host**, not XFF; Redis storage; fixed window "N/minute") → **429** body `{"error":"Rate limit exceeded: 10 per 1 minute"}` (slowapi `_rate_limit_exceeded_handler`; no Retry-After since headers_enabled=False). Decorator runs before body validation? slowapi's decorator wraps the endpoint, so validation (422) happens first, then limit counted on endpoint call. SlowAPIMiddleware also applies default limits (none configured).

Turnstile (`verify_turnstile`): no-op if secret unset. Else token missing/empty → 400 "Complete the verification challenge"; POST form to `https://challenges.cloudflare.com/turnstile/v0/siteverify` {secret,response,remoteip=client.host or ""} timeout 5s; network/JSON error → 503 "Verification is temporarily unavailable"; `success` falsy → 400 "Verification failed, please try again". Always called first in handler (after validation & rate limit).

| # | Method Path | Auth | RL | Request | Success | Errors |
|---|---|---|---|---|---|---|
|1|POST /v1/auth/signup|none + Turnstile|signup 5/min|SignupRequest {email: EmailStr, password: str 16..256, turnstile_token?: str\|null}|201 UserResponse {id,email,is_active,is_verified}|409 "Email already registered"; 422; turnstile|
|2|POST /v1/auth/login|none + Turnstile|login 10/min|LoginRequest same as signup (password 16..256 min — short passwords get 422!)|200 TokenResponse {access_token, token_type:"bearer", expires_in, csrf_token} + cookies; OR 200 MfaChallengeResponse {mfa_required:true, mfa_token, expires_in}|401 "Incorrect email or password"; 403 "Email address not verified" (if require_verified_email)|
|3|POST /v1/auth/refresh|CSRF (cookie+header)|—|cookie refresh|200 TokenResponse + new cookies|403 csrf; 401 "Missing refresh token"/"Invalid refresh token"/"Refresh token has been revoked due to suspicious activity."/"Refresh token has expired."/"User account is inactive or does not exist."|
|4|POST /v1/auth/logout|CSRF|—|cookie|204, cookies cleared (even with no/unknown cookie)|403 csrf|
|5|POST /v1/auth/logout-all|Bearer (db user)|—|—|204, cookies cleared|401s|
|6|GET /v1/auth/me|Bearer (cached user ok)|—|—|200 UserResponse|401s|
|7|POST /v1/auth/verify-email|none|mfa 10/min|EmailCodeRequest {email, code: ^\d{6}$}|200 {detail:"Email address verified"}|400 "Invalid or expired code"|
|8|POST /v1/auth/resend-verification|optional Bearer; Turnstile unless caller.email == body.email.lower()|pw_email 3/min|EmailRequest {email, turnstile_token?}|200 {detail:"If that address needs verification, a code has been sent."} always|turnstile|
|9|POST /v1/auth/forgot-password|none + Turnstile|pw_email 3/min|EmailRequest|200 {detail:"If that address has an account, a reset code has been sent."} always|turnstile|
|10|POST /v1/auth/reset-password|none (no Turnstile)|mfa 10/min|ResetPasswordRequest {email, code ^\d{6}$, new_password 16..256}|200 {detail:"Password updated. All sessions have been signed out."} + clear cookies|400 "Invalid or expired code"|
|11|POST /v1/auth/change-password|Bearer db user|—|{current_password 1..256, new_password 16..256}|200 TokenResponse + cookies|401 "Current password is incorrect"; 400 "New password must differ from the current one"|
|12|GET /v1/auth/sessions|Bearer (auth)|—|—|200 [SessionResponse {id(family), created_at, last_used_at, expires_at, user_agent, ip_address, current}]|401|
|13|DELETE /v1/auth/sessions/{session_id: UUID}|Bearer|—|path uuid (invalid → 422)|204; clears cookies if id == own sid|404 "Session not found"|
|14|GET /v1/auth/2fa|Bearer db|—|—|200 {enabled, confirmed_at, recovery_codes_remaining}|
|15|POST /v1/auth/2fa/setup|Bearer db|—|no body|200 {secret (base32), provisioning_uri}|409 "Two-factor authentication is already enabled"|
|16|POST /v1/auth/2fa/enable|Bearer db|—|{password 1..256, code 6..10}|200 {recovery_codes:[10 strings]}|409 already enabled; 400 "Start with /v1/auth/2fa/setup"; 401 "Password is incorrect"; 400 "Invalid code"|
|17|POST /v1/auth/2fa/disable|Bearer db|—|{password 1..256, code 6..10}|200 {detail:"Two-factor authentication disabled"}|400 "Two-factor authentication is not enabled"; 401 "Password is incorrect"; 400 "Invalid code"|
|18|POST /v1/auth/2fa/recovery-codes|Bearer db|—|{code 6..10} (TOTP only, not recovery code)|200 {recovery_codes}|400 not enabled; 400 "Invalid code"|
|19|POST /v1/auth/2fa/verify|none (mfa_token)|mfa 10/min|{mfa_token 1..4096, code 6..11}|200 TokenResponse + cookies|401 "Invalid or expired challenge"; 401 "Invalid code"|
|20|POST /v1/auth/recover|none + Turnstile|mfa 10/min|RecoverRequest {email, recovery_code 6..64, new_password 16..256, turnstile_token?}|200 {detail:"Password updated with a recovery code. Sign in again."} + clear cookies|401 "That email and recovery code don't match."|
|21|POST /v1/auth/change-email|Bearer db|pw_email 3/min|{password 1..256, new_email EmailStr}|200 {detail:"If {new} can be used, a confirmation code is on its way there."}|401 "Password is incorrect"; 422 `{"detail":"That's already your address"}` (string detail, not array)|
|22|POST /v1/auth/confirm-email-change|none|mfa 10/min|EmailCodeRequest {email=NEW address, code}|200 {detail:"Your email address is updated."}|400 "Invalid or expired code"; 400 "Invalid or expired token" (no pending); 409 "That address is now in use by another account"|
|23|GET /v1/auth/passkeys|Bearer db|—|—|200 [PasskeyResponse {id,name,backed_up,created_at,last_used_at}] ordered created_at asc|
|24|POST /v1/auth/passkeys/register/options|Bearer db|—|{password 1..256}|200 CeremonyResponse {challenge_id, options (PublicKeyCredentialCreationOptionsJSON)}|401 "Password is incorrect"; 409 "You can have up to 10 passkeys. Remove one first."|
|25|POST /v1/auth/passkeys/register|Bearer db|—|{challenge_id ≤128, credential: object, name?: ≤60}|201 PasskeyResponse|400 "This passkey request expired. Try again."; 400 "The passkey could not be verified"; 409 "That passkey is already registered"|
|26|PATCH /v1/auth/passkeys/{passkey_id: UUID}|Bearer db|—|{name 1..60} (stored stripped; whitespace-only becomes "" — quirk)|200 PasskeyResponse|404 "Passkey not found"|
|27|POST /v1/auth/passkeys/{passkey_id}/remove|Bearer db|—|{password 1..256}|204|401 "Password is incorrect" (checked before 404); 404|
|28|POST /v1/auth/passkeys/sign-in/options|none|login 10/min|no body|200 CeremonyResponse|
|29|POST /v1/auth/passkeys/sign-in|none|login 10/min|{challenge_id ≤128, credential: object}|200 TokenResponse + cookies|400 expired challenge; 401 "That passkey didn't work. Try again or use your password."; 403 "Email address not verified"|

(Count: router.py 22 routes, passkeys.py 7 = **29 routes**.)

Pydantic notes: EmailStr = email-validator (normalizes? pydantic v2 EmailStr returns the input string with domain lowercased? — pydantic v2 `validate_email` returns `normalized` email: **domain part lowercased / IDNA**, local part preserved). Code then `.lower()`s whole email where it matters. Extra fields ignored (BaseModel default). Strings not stripped. `min_length` counts Unicode code points.

### Per-route side effects / logic

1. **signup**: turnstile → email.lower(); SELECT users by email → 409. INSERT user(hashed_password=argon2(password), role 'user', is_active t, token_version 0, is_verified f). security_events 'signup' with ip/ua. issue_one_time_token(EMAIL_VERIFY, 24h). commit. Send verification email with 6-digit code (after commit; send failure → would 500 but account exists). No session, no cookies. Concurrent duplicate → IntegrityError → main.py handler 409 "That was saved twice at once. Try again." probably.
2. **login**: turnstile → authenticate_user(email.lower()): no user → verify against DUMMY hash (timing) → None; wrong pw → None; inactive → None (pw checked first). None → record_failure("login", request, body.email) (auth_failures row: kind, ip, email_hash=HMAC-SHA256(key, email.strip().lower()), user_id looked up) → 401. require_verified_email && !verified → 403. totp_enabled → MFA token (no DB writes). Else start_session.
   **start_session**: create refresh row (family uuid7, expires now+7d, ua[:400], ip, last_used_at=now) + access JWT; note_sign_in: new_device = no prior security_event kind 'login' with same user_agent (false if no UA); has_history = any prior 'login' event; insert security_event 'login'; if new_device && has_history → notify(kind new_sign_in, category security, title "New sign-in to your PaceStreak account", body "From {describe_agent(ua)}. If this was not you, change your password and sign out everywhere.", url "/settings/security"); commit; background task deliver(notes) (push/email delivery after response → use `ctx.waitUntil`). Set cookies, return TokenResponse.
3. **refresh**: see §4.
4. **logout**: if cookie and row found by hash: UPDATE refresh_tokens SET revoked_at=now WHERE family_id=? AND revoked_at IS NULL; commit; Redis SET auth:revoked_sid:<family> "1" EX 900. Always clear cookies, 204.
5. **logout-all**: revoke_all_sessions (UPDATE all user's unrevoked refresh rows revoked_at=now; UPDATE users SET token_version=token_version+1); security_event 'logout_all' (with req); commit; Redis DEL auth:user:<id>; clear cookies.
7. **verify-email**: consume_one_time_token(EMAIL_VERIFY); if !verified: is_verified=t, verified_at=now, event 'email_verified' (no request). commit (also persists attempts++ on failure? NO — on failure exception raised before commit, so attempts increments are **lost** unless something commits; get_db session closes w/o commit → rollback. Hazard/quirk: attempt counting in consume_one_time_token only persists if caller commits after a failure; none do. Verify with tests; likely attempts never persist → port faithfully or fix? Flag as open question). DEL user cache.
8. **resend-verification**: turnstile unless signed-in caller owns the address. Lookup by email.lower(); if none/inactive/verified → generic. Else issue code (invalidates older unused EMAIL_VERIFY codes: UPDATE used_at=now), commit, send email.
9. **forgot-password**: turnstile; user none/inactive → generic; issue PASSWORD_RESET (30 min); commit; send reset email.
10. **reset-password**: consume code; hash new pw; password_changed_at=now; if !verified set verified; event 'password_reset' (no req); revoke_all_sessions; commit; DEL cache; clear cookies; send password-changed email. Not checked: new==old.
11. **change-password**: verify current (401); equal → 400; set hash, password_changed_at; revoke_all_sessions; flush+refresh (to get bumped token_version); login_user (new family, ua, ip) — NB: no note_sign_in / no 'login' event; event 'password_changed' with req; commit; DEL cache; set cookies; send password-changed email.
12. **sessions**: SELECT refresh_tokens WHERE user_id AND revoked_at IS NULL AND expires_at > now ORDER BY created_at DESC; id=family_id; current = family_id == sid. created_at is the latest rotated row's created_at (not original login) — quirk to preserve.
13. **delete session**: exists row (family_id, user_id) LIMIT 1 else 404; UPDATE revoke unrevoked rows of family for user; commit; Redis revoked sid; event 'session_revoked' meta {"session": str(id)} (no req); commit. If own → clear cookies. Already-revoked family of own user → still 204 (row exists).
14. **2fa status**: count recovery_codes WHERE user_id AND used_at IS NULL.
15. **2fa setup**: 409 if enabled. secret = pyotp.random_base32() (32 chars, A-Z2-7); store Fernet(secret) in users.totp_secret (overwrites any pending); commit. provisioning_uri = `otpauth://totp/{issuer}:{email}?secret=...&issuer={issuer}` (pyotp format: label `quote(issuer)` + ':' + `quote(email)`, params secret, issuer; quoting via urllib.parse.quote — `@` encoded as `%40`, space `%20`). Reproduce exactly: pyotp builds `otpauth://totp/PaceStreak:a%40b.com?secret=XXX&issuer=PaceStreak`.
16. **2fa enable**: checks in order (enabled→409, no secret→400, password→401, consume_totp_code→400). totp_enabled=t, confirmed_at=now, issue recovery codes (DELETE old, INSERT 10 Argon2 hashes), event 'totp_enabled'; commit; DEL cache. totp_last_used_step updated by consume.
17. **2fa disable**: order: not enabled 400, password 401, code 400 (TOTP only). Clear totp_* fields, DELETE recovery_codes, event 'totp_disabled', commit, DEL cache. Sessions NOT revoked.
18. **recovery-codes**: TOTP only; reissue; event 'recovery_codes_regenerated'; commit (no cache DEL).
19. **2fa/verify**: decode mfa token (any exception → 401 challenge). db.get user; missing/inactive/!totp_enabled → 401 challenge; payload.ver != token_version → 401 challenge. consume_totp_code else consume_recovery_code else record_failure("mfa", user_id) → 401 "Invalid code". start_session. MFA token reusable within 5 min (no jti tracking) — TOTP replay protection limits it.
20. **recover**: turnstile; user by email.lower(); none/inactive/!totp_enabled → record_failure("recover", email) → 401; consume_recovery_code fail → record_failure(user_id) → 401. Note record_failure commits the session → on wrong recovery code nothing else pending. Set pw, password_changed_at, event 'password_recovered' (req), revoke_all_sessions, commit, DEL cache, clear cookies, send password-changed email to user.email. 2FA stays enabled.
21. **change-email**: password 401; new==user.email → 422; taken → generic (no write); else pending_email=new; issue EMAIL_CHANGE code (24h) for user; event 'email_change_requested' meta {"to": new} (req); commit; send change email to NEW address.
22. **confirm-email-change**: consume_one_time_token looks up users by **pending_email** = body.email.lower() (may be multiple users). Then: pending null → 400; another user has email=new → 409 (but code already marked used in session — the 409 raise means no commit → used_at rolls back). Set email=new, pending=null, is_verified=t, verified_at=now; event 'email_changed' meta {from, to}; commit; DEL cache; send notice to OLD address (old,new). Sessions not revoked.

### Passkeys (py_webauthn 2.x)
- `_issue_challenge`: raw = 32 random bytes; challenge_id = base64url(raw) no padding (43 chars); INSERT webauthn_challenges(challenge, user_id|null, purpose 'register'|'sign_in', expires_at=now+300s).
- `_take_challenge`: `DELETE ... WHERE challenge=? AND purpose=? RETURNING user_id, expires_at` (D1 supports RETURNING). If none / expired (expires_at < now) / user_id mismatch → commit (delete persists) → 400 "This passkey request expired. Try again.". Returns bytes of challenge.
- register/options: verify password; existing passkeys count ≥ max → 409; generate_registration_options(rp_id, rp_name, user_id=user.id.bytes (16 raw uuid bytes), user_name=email, user_display_name=email, challenge, timeout=300000, authenticatorSelection {residentKey:"required", userVerification:"required"} (py_webauthn also sets requireResidentKey:true when REQUIRED), excludeCredentials [{id, type:"public-key", transports}]), defaults: attestation "none", pubKeyCredParams algs py_webauthn default [-7 (ES256), -8 (EdDSA), -36 (ES512), -37 (PS256), -38, -39, -257 (RS256), -258, -259] — copy exact list from py_webauthn version in uv.lock. options_to_json → JSON with base64url fields: `{rp:{name,id}, user:{id,name,displayName}, challenge, pubKeyCredParams, timeout, excludeCredentials, authenticatorSelection, attestation:"none"}` (hints omitted). Port: build JSON manually (or @simplewebauthn/server generateRegistrationOptions with matching params — its defaults differ: supportedAlgorithmIDs [-8,-7,-257], attestation 'none', extensions credProps). App uses parse*OptionsFromJSON so exact alg list mostly cosmetic.
- register: take challenge (user-bound); verify_registration_response(expected challenge, rp_id, origin, require_user_verification=True) — failure → commit (challenge deleted) → 400. credential_id = base64url(verified.credential_id); duplicate → 409. transports = credential.response.transports filtered to strings, first 8. name = body.name.strip() or `"Passkey on {describe_agent(UA)}"[:60]`. INSERT passkeys(public_key = COSE bytes, sign_count, transports JSON, backed_up = credential_backed_up). event 'passkey_added' meta {name} (req).
- rename/remove: ownership check → 404; remove requires password first; event 'passkey_removed' {name}.
- sign-in/options: generate_authentication_options(rp_id, challenge, timeout 300000, userVerification "required", allowCredentials []).
- sign-in: take challenge (purpose sign_in, user null). credential.id must be str ≤1400 else record_failure("passkey") → 401. Lookup by credential_id (= the `id` string exactly as sent; must match stored base64url). verify_authentication_response(public_key, current sign_count, UV required) → fail 401. user missing/inactive → 401. require_verified_email && !verified → 403. Update sign_count=new_sign_count, backed_up, last_used_at; start_session (commits). **Skips TOTP even if enabled.** sign_count regression is py_webauthn: raises if (new>0 or current>0) and new <= current.
- `sweep_expired_challenges`: worker DELETE WHERE expires_at < now().

## 4. Algorithms

### Refresh rotation (`rotate_refresh_token`), REUSE_GRACE = 30 s
```
old = row by sha256(raw)  -> none: 401 "Invalid refresh token"
now = utcnow
tip = old
repeat up to 5:
  if tip.revoked_at is null or tip.replaced_by is null or now - tip.revoked_at > 30s: break
  succ = get(tip.replaced_by); if null break; tip = succ
if tip != old and tip.revoked_at is null and tip.expires_at > now: old = tip   # benign reload race: rotate from live tip
if old.revoked_at != null: UPDATE family unrevoked SET revoked_at=now; commit; redis revoke sid(family); 401 "...suspicious activity."
if old.expires_at <= now: old.revoked_at=now; commit; 401 "Refresh token has expired."
user=get(old.user_id); none/inactive: old.revoked_at=now; commit; 401 "User account is inactive or does not exist."
old.revoked_at=now; new row (same family, parent=old.id, ua/ip copied, last_used_at=now, expires now+7d); old.replaced_by=new.id
access JWT(user, token_version, family); commit
```
Note: refresh does NOT check token_version, so after logout-all all rows are revoked anyway. Expiry is not sliding beyond the 7 days per row — each rotation gets fresh 7 days (sliding session).

### One-time codes
- generate: `f"{randbelow(10**6):06d}"`; store sha256 hex of code string. Issue first sets used_at=now on all unused rows of same user+purpose.
- consume(email, code, purpose): users = SELECT users WHERE (pending_email if EMAIL_CHANGE else email) = email.lower() AND is_active. For each: newest (created_at DESC) row with used_at null, expires_at>now LIMIT 1; candidate if attempts < 5. If any candidate's hash == sha256(code) → used_at=now, return user. Else attempts += 1 on every candidate, raise 400 "Invalid or expired code". Plain `==` compare (not constant time). Caller commits; on failure nobody commits so the attempts increment is rolled back (see open question). Ordering by created_at (server_default now() — same-transaction rows share timestamp; irrelevant since older ones are marked used).

### Recovery codes
- alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (32 chars), 10 chars, format `XXXXX-XXXXX`.
- normalize: strip, upper, remove spaces (hyphen KEPT — so "ABCDEABCDE" without hyphen does NOT match). Hash with Argon2 (same params as passwords). Verify iterates every unused code (up to 10 Argon2 verifies!).

### TOTP (pyotp defaults: SHA1, 6 digits, 30 s period)
- step = floor(unix/30). Accept steps now-1..now+1 (totp_valid_window=1). code normalized: strip, remove spaces; compared via compare_digest to `totp.at(step*30)`. Returns step; reject if step <= totp_last_used_step; else store step. Order of window loop -1,0,+1 returns first match.
- secret stored Fernet-encrypted (AES-128-CBC + HMAC-SHA256, token format version 0x80|ts|iv|ct|hmac, urlsafe b64). Decrypt failure → "" → no match. Dev with no key: plaintext.
- `code` for 2fa/verify may be 11 chars (recovery `XXXXX-XXXXX`).

### Argon2 (pwdlib PasswordHash.recommended() → Argon2Hasher defaults from argon2-cffi): **argon2id, v=19, m=65536 KiB, t=3, p=4, hash_len 32, salt 16**. Output PHC string e.g. `$argon2id$v=19$m=65536,t=3,p=4$<salt b64 nopad>$<hash b64 nopad>`. verify: any exception → False. pwdlib verify also accepts any argon2 variant in the PHC string. DUMMY hash computed at import with random password.

## 5. Data access (tables)

All tables have Base columns: `id uuid pk default uuid7`, `created_at timestamptz server_default now()`, `updated_at timestamptz server_default now() onupdate now()`.

| Table | Columns | Indexes/constraints |
|---|---|---|
| users | email varchar320 UNIQUE idx; hashed_password 512; role enum userrole('admin','moderator','user') default user; is_active bool t; token_version int 0; is_verified bool f; verified_at; password_changed_at; pending_email 320 null; totp_secret 512 null; totp_enabled bool f; totp_confirmed_at; totp_last_used_step int null | (other modules add more columns — see their specs) |
| refresh_tokens | user_id FK users CASCADE idx; token_hash varchar64 UNIQUE idx; family_id uuid idx; parent_id FK refresh_tokens.id null; replaced_by uuid null; expires_at; revoked_at; user_agent 400; ip_address 45; last_used_at | |
| one_time_tokens | user_id FK CASCADE idx; purpose enum tokenpurpose('email_verify','password_reset','email_change'); token_hash 64 idx; expires_at; used_at; attempts int 0 | |
| recovery_codes | user_id FK CASCADE idx; code_hash 512; used_at | |
| passkeys | user_id FK CASCADE idx; credential_id varchar1400 UNIQUE; public_key bytea; sign_count bigint 0; transports JSONB list; backed_up bool; name varchar60; last_used_at | |
| webauthn_challenges | challenge varchar128 UNIQUE; user_id FK CASCADE null; purpose varchar12; expires_at | |
| security_events (account module) | user_id, kind, ip_address, user_agent, meta JSON | written by `record` |
| auth_failures (ops module) | kind, ip_address, email_hash, user_id | written by record_failure (commits itself, swallows errors) |
| notifications (via notify) | new_sign_in | |

Query shapes: equality lookups by email / token_hash / family_id / credential_id / challenge; `UPDATE ... SET token_version = token_version + 1`; COUNT recovery codes; DELETE ... RETURNING; ORDER BY created_at DESC LIMIT 1. Nothing Postgres-only except JSONB, enums, uuid type, timestamptz, `func.now()`.

Redis keys: `auth:user:<uuid>` (JSON, EX 60), `auth:revoked_sid:<uuid>` ("1", EX access_token_minutes*60), slowapi limiter counters (`LIMITER/<ip>/<route>/...`).

## 6. Porting hazards (Workers/D1)

| Python | Concern | JS replacement |
|---|---|---|
| pwdlib/argon2-cffi argon2id m=64MiB t=3 p=4 | **CPU/memory heavy**: ~50-100 ms native; WASM in Workers slower, 64 MiB of the 128 MiB isolate. Recovery verify = up to 10 hashes; login unknown-email still hashes (dummy). Free plan 10 ms CPU cap → impossible; paid plan 30 s ok. Must verify existing PHC hashes → keep params. | `hash-wasm` (argon2id/argon2Verify, pure WASM) or `@noble/hashes/argon2` (pure JS, very slow); `argon2-browser`. Parse PHC string yourself for verify (hash-wasm `argon2Verify` accepts encoded). Consider re-hash with lower params on login only if user agrees — changes behaviour. |
| PyJWT RS256 + `kid` | keys as PEM env | `jose` (SignJWT/jwtVerify, importPKCS8/importSPKI) via WebCrypto. Ensure iat/exp as ints, required-claim check manually, aud string. PKCS#1 "BEGIN RSA PRIVATE KEY" PEM must be converted to PKCS8 for WebCrypto — check key format in env. |
| pyotp | TOTP SHA1 | `otpauth` npm (TOTP.generate({timestamp})) or hand-roll HMAC-SHA1 with WebCrypto; base32 secret gen: 20 random bytes→base32 (pyotp random_base32 = 32 chars from alphabet via secrets.choice; equivalent). |
| cryptography Fernet | existing encrypted secrets must decrypt | `fernet` npm (uses crypto-js; ok in Workers) or hand-roll with WebCrypto AES-CBC + HMAC-SHA256 (simple, recommended). |
| py_webauthn (verify reg/auth, options_to_json) | CBOR/COSE parsing, attestation 'none' | `@simplewebauthn/server` v13 (Workers-compatible). Stored `public_key` = COSE bytes (same format simplewebauthn stores as `credential.publicKey`). credential_id base64url. Map sign-count rule; simplewebauthn's counter check: error if (newCounter>0||old>0) && newCounter<=old — same. `expectedOrigin` string, `requireUserVerification:true`. |
| email-validator (EmailStr) | validation rules, domain normalization | zod `.email()` differs; to be exact port email-validator rules or accept small divergence (check_deliverability is False in pydantic). |
| secrets.token_urlsafe, compare_digest | | crypto.getRandomValues + base64url; constant-time compare hand-rolled. |
| hashlib sha256 / hmac | async in WebCrypto | `crypto.subtle.digest` / HMAC. |
| uuid7 | | `uuidv7` npm or hand-roll; D1 stores TEXT. |
| Redis (user cache, sid denylist, slowapi) | no Redis on Workers | sid denylist: DB fallback already exists (refresh family live check) — just always do DB query, or KV (eventually consistent; ≤60 s propagation breaks immediate logout guarantee across PoPs). User cache: drop (D1 read) or KV. Rate limits: Workers Rate Limiting binding (`ratelimit` binding, periods 10 or 60 s) or Durable Object / D1 counter. Key by `CF-Connecting-IP` (current uses socket host which on FastAPI Cloud may be proxy IP — decide). 429 body `{"error":"Rate limit exceeded: 10 per 1 minute"}`. |
| httpx Turnstile | | `fetch` with form body, AbortSignal.timeout(5000); remoteip from CF-Connecting-IP. |
| BackgroundTasks deliver(notes) | | `c.executionCtx.waitUntil`. |
| SMTP email (Brevo) awaited inline | Workers can't open raw SMTP easily | Brevo HTTP API or `cloudflare:sockets` SMTP / `worker-mailer`; other spec covers. |
| Postgres types | timestamptz, uuid, JSONB, enums, bytea, bigint | D1: TEXT ISO-8601 UTC (make sure comparisons `expires_at > now` use same format, or integer ms), TEXT uuid, TEXT JSON, CHECK constraints for enums, BLOB for public_key. Drizzle `integer({mode:'timestamp_ms'})` simplest. Response datetimes: Pydantic serializes tz-aware as `2026-10-17T12:34:56.123456Z`?? — pydantic v2 emits `+00:00`→ actually `Z` for UTC in v2. Verify exact output format against a live response, since microseconds (6 digits) vs JS ms (3 digits). |
| `updated_at onupdate` | ORM-side | set manually in Drizzle (`$onUpdate`). |
| Transactions | get_db session = one transaction per request, commit points matter (e.g. failed consume rolled back; record_failure commits) | D1 has no interactive transactions; use `db.batch([...])`. Order writes so failure paths don't persist what Python rolls back. |
| `UPDATE token_version = token_version + 1` then flush+refresh | | fine in SQLite; re-read row. |
| DELETE ... RETURNING | | SQLite ≥3.35 supports, D1 ok. |
| `func.now()` sweep | | worker → Cron Trigger. |
| 422 shape | FastAPI validation error array | build an error mapper (zod → `{detail:[{type,loc:["body","field"],msg,input,ctx}]}`); check what app reads. |

## 7. Tests

| File | Tests | Notable assertions |
|---|---|---|
| tests/test_auth.py (20) | signup_does_not_log_in, rejects_duplicate_email (409), rejects_short_password (422), verify_email_confirms, code single-use, login wrong pw 401, login sets refresh+csrf cookies, me requires bearer, refresh requires csrf header (403), refresh rotates, reuse of rotated token burns session, reload race keeps session (grace window), logout ends session, logout_all revokes other sessions' access tokens, sessions list current flagged, forgot always success, reset signs out everywhere, change_password requires current, 2FA setup/enable/login challenge, 2FA disable requires password+code | |
| tests/test_passkeys.py (10) | register & sign in, registration requires password, challenge single-use, wrong origin refused, UV required, unknown credential refused, passkey satisfies 2FA (no mfa challenge), remove requires password & stops sign-in, someone else's passkey invisible (404), same authenticator can't register twice (409) | uses a soft authenticator to build credentials — reusable for TS tests |
| tests/test_turnstile.py (9) | off by default; signup needs token when enabled; accepts approved; rejects declined; login needs token; Cloudflare unreachable fails closed (503); resend anonymous needs token; skipped for signed-in owner; can't spam someone else's address | siteverify mocked |
| tests/conftest.py | helpers for signup/login flows; also test_prelaunch.py, test_social.py, test_training.py hit /v1/auth for setup | |

## 8. Open questions
1. OTP `attempts` increments are never committed on failure (exception → rollback), so the 5-attempt limit is likely ineffective today; port 1:1 (no persistence) or fix? Rate limit 10/min/IP is the only real guard.
2. Rate-limit key is `request.client.host` (slowapi get_remote_address), not XFF; on FastAPI Cloud that may be a proxy IP (global bucket). Use CF-Connecting-IP in port?
3. Argon2 m=64MiB t=3 p=4 in Workers WASM: CPU time per login and recovery path (10 verifies); paid Workers plan required. Keep params to verify existing hashes.
4. Redis replacement for sid denylist/user cache: DB-only (strong) vs KV (eventual).
5. Exact datetime JSON format (Pydantic microseconds/`Z`) to match app expectations.
6. JWT key format (PKCS1 vs PKCS8) for WebCrypto import.
7. Email sending from Workers (SMTP vs Brevo HTTP API).
