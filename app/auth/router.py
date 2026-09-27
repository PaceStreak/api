import secrets
from datetime import timedelta
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.account.service import note_sign_in
from app.account.service import record as record_security_event
from app.auth.cache import revoke_session
from app.auth.dependencies import (
    CurrentAuth,
    get_current_auth,
    get_current_db_user,
    get_current_user,
    get_optional_user,
)
from app.auth.models import RecoveryCode, RefreshToken, TokenPurpose, User
from app.auth.schemas import (
    ChangePasswordRequest,
    EmailRequest,
    LoginRequest,
    MessageResponse,
    MfaChallengeResponse,
    MfaVerifyRequest,
    RecoveryCodesResponse,
    ResetPasswordRequest,
    SessionResponse,
    SignupRequest,
    TokenOnlyRequest,
    TokenResponse,
    TotpCodeRequest,
    TotpDisableRequest,
    TotpEnableRequest,
    TotpSetupResponse,
    TwoFactorStatusResponse,
    UserResponse,
)
from app.auth.security import (
    create_mfa_challenge_token,
    decode_mfa_challenge_token,
    encrypt_totp_secret,
    generate_totp_secret,
    hash_password,
    hash_refresh_token,
    totp_provisioning_uri,
    utcnow,
    verify_password,
)
from app.auth.service import (
    authenticate_user,
    consume_one_time_token,
    consume_recovery_code,
    consume_totp_code,
    count_unused_recovery_codes,
    finish_revoke_all,
    issue_one_time_token,
    issue_recovery_codes,
    list_sessions,
    login_user,
    revoke_all_sessions,
    revoke_session_family,
    rotate_refresh_token,
)
from app.config import get_settings
from app.database import get_db
from app.email import (
    send_email_change_email,
    send_email_changed_notice,
    send_password_changed_email,
    send_password_reset_email,
    send_verification_email,
)
from app.notifications.service import deliver
from app.ops.service import record_failure
from app.ratelimit import limiter
from app.turnstile import verify_turnstile
from app.versioning import API_V1_PREFIX

# Unprefixed with a version here on purpose: app/v1/router.py mounts this at
# API_V1_PREFIX, so this file has no idea what version it's serving under and
# needs no edit when a v2 of auth is ever forked from it.
router = APIRouter(prefix="/auth", tags=["auth"])

settings = get_settings()

CSRF_HEADER = "X-CSRF-Token"


def _cookie_name(base: str) -> str:
    """__Secure- only when Secure is actually set - the prefix is a promise
    enforced by the browser, and a mismatched cookie is silently refused."""
    return f"__Secure-{base}" if settings.cookie_secure else base


REFRESH_COOKIE = _cookie_name("refresh_token")
CSRF_COOKIE = _cookie_name("csrf_token")

# Scoped to this router's own mounted path, not "/", so the cookie is never
# sent to unrelated endpoints - and never to another subdomain's routes, even
# though Domain=pacestreak.com puts it within reach of all of them. Built
# from the same constant app/v1/router.py mounts this router under, so the
# two can never drift apart.
COOKIE_PATH = f"{API_V1_PREFIX}/auth"


def set_auth_cookies(response: Response, refresh_token: str, csrf_token: str) -> None:
    max_age = settings.refresh_token_days * 24 * 60 * 60

    response.set_cookie(
        key=REFRESH_COOKIE,
        value=refresh_token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        domain=settings.cookie_domain,
        path=COOKIE_PATH,
        max_age=max_age,
    )
    response.set_cookie(
        key=CSRF_COOKIE,
        value=csrf_token,
        httponly=False,  # read by JS to echo back in the X-CSRF-Token header
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        domain=settings.cookie_domain,
        path=COOKIE_PATH,
        max_age=max_age,
    )


def clear_auth_cookies(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, domain=settings.cookie_domain, path=COOKIE_PATH)
    response.delete_cookie(CSRF_COOKIE, domain=settings.cookie_domain, path=COOKIE_PATH)


def client_ip(request: Request) -> str | None:
    """Best-effort client address for the session list.

    X-Forwarded-For is trusted only because uvicorn runs with
    --forwarded-allow-ips behind Cloudflare / a platform load balancer.
    Descriptive only - never an authorisation input, since a direct client
    can send anything.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()[:45]
    return request.client.host if request.client else None


async def require_csrf(request: Request) -> None:
    cookie_token = request.cookies.get(CSRF_COOKIE)
    header_token = request.headers.get(CSRF_HEADER)
    if (
        not cookie_token
        or not header_token
        or not secrets.compare_digest(cookie_token, header_token)
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid CSRF token")


async def start_session(
    request: Request,
    response: Response,
    background: BackgroundTasks,
    db: AsyncSession,
    user: User,
) -> TokenResponse:
    """The last step of every way in - password, second factor or passkey:
    mint the pair, record the sign-in, set the cookies. One place, so the
    three paths cannot drift apart on what a session is."""
    access_token, refresh_token, expires_in = await login_user(
        db, user, user_agent=request.headers.get("user-agent"), ip_address=client_ip(request)
    )
    notes = await note_sign_in(db, user.id, request)
    await db.commit()
    background.add_task(deliver, notes)

    csrf_token = secrets.token_urlsafe(32)
    set_auth_cookies(response, refresh_token, csrf_token)
    return TokenResponse(access_token=access_token, expires_in=expires_in, csrf_token=csrf_token)


@router.post("/signup", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit(settings.rate_limit_signup)
async def signup(request: Request, body: SignupRequest, db: AsyncSession = Depends(get_db)) -> User:
    await verify_turnstile(request, body.turnstile_token)
    email = body.email.lower()
    result = await db.execute(select(User).where(User.email == email))

    if result.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    user = User(email=email, hashed_password=hash_password(body.password))
    db.add(user)
    await db.flush()
    # With the IP, so the admin abuse view can spot one address creating
    # accounts in bulk.
    await record_security_event(db, user.id, "signup", request)

    raw_token = await issue_one_time_token(
        db, user, TokenPurpose.EMAIL_VERIFY, timedelta(hours=settings.email_verify_token_hours)
    )
    await db.commit()
    await db.refresh(user)

    # After the commit: if the mail fails the account still exists and the
    # user can request another link, whereas a rollback would lose the account.
    await send_verification_email(user.email, raw_token)
    return user


@router.post(
    "/login",
    response_model=TokenResponse | MfaChallengeResponse,
    responses={
        200: {
            "description": "A token pair, or an MFA challenge when the account "
            "has two-factor enabled."
        }
    },
)
@limiter.limit(settings.rate_limit_login)
async def login(
    request: Request,
    body: LoginRequest,
    response: Response,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    await verify_turnstile(request, body.turnstile_token)
    # Lowercased to match how signup stores it, or mixed-case addresses could
    # register and then never sign in.
    user = await authenticate_user(db, body.email.lower(), body.password)

    if user is None:
        await record_failure(db, "login", request, body.email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password"
        )

    if settings.require_verified_email and not user.is_verified:
        # 403, not 401: the credentials were correct. A distinct code lets the
        # client offer "resend the link" instead of re-prompting for a password.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Email address not verified"
        )

    if user.totp_enabled:
        # No session is created yet. The password alone proves nothing until
        # the second factor is presented at /v1/auth/2fa/verify.
        mfa_token, mfa_expires_in = create_mfa_challenge_token(user.id, user.token_version)
        return MfaChallengeResponse(mfa_token=mfa_token, expires_in=mfa_expires_in)

    return await start_session(request, response, background, db, user)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    request: Request,
    response: Response,
    _: None = Depends(require_csrf),
    db: AsyncSession = Depends(get_db),
):
    raw_refresh_token = request.cookies.get(REFRESH_COOKIE)
    if not raw_refresh_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing refresh token"
        )

    access_token, new_refresh_token, expires_in = await rotate_refresh_token(db, raw_refresh_token)

    csrf_token = secrets.token_urlsafe(32)
    set_auth_cookies(response, new_refresh_token, csrf_token)
    return TokenResponse(access_token=access_token, expires_in=expires_in, csrf_token=csrf_token)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    _: None = Depends(require_csrf),
    db: AsyncSession = Depends(get_db),
):
    raw_token = request.cookies.get(REFRESH_COOKIE)
    if raw_token:
        result = await db.execute(
            select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(raw_token))
        )
        token = result.scalar_one_or_none()
        if token:
            # Revoke the whole family, not just the cookie's token: the
            # earlier tokens are already revoked by rotation, and this is what
            # makes "no live token in the family" mean "logged out" for the
            # database fallback in get_current_user.
            await db.execute(
                update(RefreshToken)
                .where(RefreshToken.family_id == token.family_id)
                .where(RefreshToken.revoked_at.is_(None))
                .values(revoked_at=utcnow())
            )
            await db.commit()
            # Denies the access tokens already issued for this session, which
            # would otherwise stay valid until they expire.
            await revoke_session(token.family_id)

    clear_auth_cookies(response)


@router.post("/logout-all", status_code=status.HTTP_204_NO_CONTENT)
async def logout_all(
    request: Request,
    response: Response,
    user: User = Depends(get_current_db_user),
    db: AsyncSession = Depends(get_db),
):
    await revoke_all_sessions(db, user)
    await record_security_event(db, user.id, "logout_all", request)
    await db.commit()
    # Must follow the commit: a concurrent request could otherwise repopulate
    # the cache with the pre-bump token_version.
    await finish_revoke_all(user.id)
    clear_auth_cookies(response)


@router.get("/me", response_model=UserResponse)
async def me(user: User = Depends(get_current_user)):
    return user


# ===========================================================================
# Email verification
# ===========================================================================


@router.post("/verify-email", response_model=MessageResponse)
async def verify_email(request: TokenOnlyRequest, db: AsyncSession = Depends(get_db)):
    """Redeem a link from the verification email.

    Unauthenticated on purpose: the person clicking the link has just arrived
    from their inbox and may not be signed in. Possession of the token is the
    proof, which is why it is single-use and short-lived.
    """
    user = await consume_one_time_token(db, request.token, TokenPurpose.EMAIL_VERIFY)

    if not user.is_verified:
        user.is_verified = True
        user.verified_at = utcnow()
        await record_security_event(db, user.id, "email_verified")

    await db.commit()
    # is_verified is part of the cached record, so drop the stale copy.
    await finish_revoke_all(user.id)
    return MessageResponse(detail="Email address verified")


@router.post("/resend-verification", response_model=MessageResponse)
@limiter.limit(settings.rate_limit_password_email)
async def resend_verification(
    request: Request,
    body: EmailRequest,
    db: AsyncSession = Depends(get_db),
    caller: User | None = Depends(get_optional_user),
):
    """Always reports success.

    Saying "no such account" here would turn this endpoint into a free user
    enumeration oracle - the same reason login returns one generic error.

    Called both anonymously (before Turnstile solves it, from Login's "not
    verified" branch) and from a live session nagging its own unverified
    owner (Today's coach card, Settings). The second case needs no widget:
    the caller already proved who they are, and can only ask for their own
    address, not use this as a free mailer for anyone else's.
    """
    if not (caller and caller.email == body.email.lower()):
        await verify_turnstile(request, body.turnstile_token)
    generic = MessageResponse(detail="If that address needs verification, a link has been sent.")

    result = await db.execute(select(User).where(User.email == body.email.lower()))
    user = result.scalar_one_or_none()

    if user is None or not user.is_active or user.is_verified:
        return generic

    raw_token = await issue_one_time_token(
        db, user, TokenPurpose.EMAIL_VERIFY, timedelta(hours=settings.email_verify_token_hours)
    )
    await db.commit()
    await send_verification_email(user.email, raw_token)
    return generic


# ===========================================================================
# Password reset and change
# ===========================================================================


@router.post("/forgot-password", response_model=MessageResponse)
@limiter.limit(settings.rate_limit_password_email)
async def forgot_password(request: Request, body: EmailRequest, db: AsyncSession = Depends(get_db)):
    """Always reports success, for the same enumeration reason as above."""
    await verify_turnstile(request, body.turnstile_token)
    generic = MessageResponse(detail="If that address has an account, a reset link has been sent.")

    result = await db.execute(select(User).where(User.email == body.email.lower()))
    user = result.scalar_one_or_none()

    if user is None or not user.is_active:
        return generic

    raw_token = await issue_one_time_token(
        db,
        user,
        TokenPurpose.PASSWORD_RESET,
        timedelta(minutes=settings.password_reset_token_minutes),
    )
    await db.commit()
    await send_password_reset_email(user.email, raw_token)
    return generic


@router.post("/reset-password", response_model=MessageResponse)
async def reset_password(
    request: ResetPasswordRequest, response: Response, db: AsyncSession = Depends(get_db)
):
    """Set a new password from an emailed token, and end every session.

    Signing out everywhere is the point of a reset, not a side effect: the
    usual reason to reset is that someone else may have had access.
    """
    user = await consume_one_time_token(db, request.token, TokenPurpose.PASSWORD_RESET)

    user.hashed_password = hash_password(request.new_password)
    user.password_changed_at = utcnow()

    # Reaching the inbox also proves the address, so a reset confirms it.
    if not user.is_verified:
        user.is_verified = True
        user.verified_at = utcnow()

    await record_security_event(db, user.id, "password_reset")
    await revoke_all_sessions(db, user)
    await db.commit()
    await finish_revoke_all(user.id)

    clear_auth_cookies(response)
    await send_password_changed_email(user.email)
    return MessageResponse(detail="Password updated. All sessions have been signed out.")


@router.post("/change-password", response_model=TokenResponse)
async def change_password(
    body: ChangePasswordRequest,
    request: Request,
    response: Response,
    user: User = Depends(get_current_db_user),
    db: AsyncSession = Depends(get_db),
):
    """Change the password of a signed-in user.

    The current password is required even though the caller is authenticated:
    it re-proves identity for a stolen but still-valid access token.

    Every other session is ended, and the caller is issued a fresh pair so
    they are not signed out of the device they just used. That is the whole
    reason this returns tokens rather than 204.
    """
    if not verify_password(body.current_password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Current password is incorrect"
        )

    if body.current_password == body.new_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must differ from the current one",
        )

    user.hashed_password = hash_password(body.new_password)
    user.password_changed_at = utcnow()

    # Bumps token_version, so the caller's own access token dies too - hence
    # the new pair issued below, minted after the bump.
    await revoke_all_sessions(db, user)
    await db.flush()
    await db.refresh(user)

    access_token, refresh_token, expires_in = await login_user(
        db, user, user_agent=request.headers.get("user-agent"), ip_address=client_ip(request)
    )
    await record_security_event(db, user.id, "password_changed", request)
    await db.commit()
    await finish_revoke_all(user.id)

    csrf_token = secrets.token_urlsafe(32)
    set_auth_cookies(response, refresh_token, csrf_token)
    await send_password_changed_email(user.email)
    return TokenResponse(access_token=access_token, expires_in=expires_in, csrf_token=csrf_token)


# ===========================================================================
# Session management
# ===========================================================================


@router.get("/sessions", response_model=list[SessionResponse])
async def get_sessions(
    auth: CurrentAuth = Depends(get_current_auth), db: AsyncSession = Depends(get_db)
):
    """Every active session, with the current one flagged.

    The id is the token family, which is also the sid claim - so the value
    listed here is exactly what DELETE /v1/auth/sessions/{id} expects.
    """
    sessions = await list_sessions(db, auth.user)
    return [
        SessionResponse(
            id=token.family_id,
            created_at=token.created_at,
            last_used_at=token.last_used_at,
            expires_at=token.expires_at,
            user_agent=token.user_agent,
            ip_address=token.ip_address,
            current=token.family_id == auth.session_id,
        )
        for token in sessions
    ]


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: UUID,
    response: Response,
    auth: CurrentAuth = Depends(get_current_auth),
    db: AsyncSession = Depends(get_db),
):
    """End one session remotely.

    404 rather than 403 when the session belongs to someone else: confirming
    that an unknown id exists would let a caller probe for other users'
    sessions.
    """
    revoked = await revoke_session_family(db, auth.user, session_id)
    if revoked:
        await record_security_event(
            db, auth.user.id, "session_revoked", meta={"session": str(session_id)}
        )
        await db.commit()
    if not revoked:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    # Ending your own session from this endpoint should also clear the
    # cookies on the response, so the browser is not left holding a dead
    # refresh token.
    if session_id == auth.session_id:
        clear_auth_cookies(response)


# ===========================================================================
# Two-factor authentication (TOTP)
# ===========================================================================


@router.get("/2fa", response_model=TwoFactorStatusResponse)
async def two_factor_status(
    user: User = Depends(get_current_db_user), db: AsyncSession = Depends(get_db)
):
    return TwoFactorStatusResponse(
        enabled=user.totp_enabled,
        confirmed_at=user.totp_confirmed_at,
        recovery_codes_remaining=await count_unused_recovery_codes(db, user),
    )


@router.post("/2fa/setup", response_model=TotpSetupResponse)
async def two_factor_setup(
    user: User = Depends(get_current_db_user), db: AsyncSession = Depends(get_db)
):
    """Generate a secret and return it for the authenticator app.

    Two-step on purpose: this stores the secret but leaves totp_enabled False,
    so an interrupted setup cannot lock the user out of their own account.
    Nothing changes about login until /2fa/enable proves the user can
    actually produce a code.
    """
    if user.totp_enabled:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Two-factor authentication is already enabled",
        )

    secret = generate_totp_secret()
    user.totp_secret = encrypt_totp_secret(secret)
    await db.commit()

    return TotpSetupResponse(
        secret=secret, provisioning_uri=totp_provisioning_uri(secret, user.email)
    )


@router.post("/2fa/enable", response_model=RecoveryCodesResponse)
async def two_factor_enable(
    body: TotpEnableRequest,
    user: User = Depends(get_current_db_user),
    db: AsyncSession = Depends(get_db),
):
    """Confirm setup with the password and a live code, then hand back
    recovery codes.

    The password is required, not just an access token: /2fa/disable already
    demands it, and enabling 2FA is exactly as sensitive - a stolen-but-valid
    token should not be able to turn itself into a persistent second factor
    the real owner never chose.

    This is the only time the recovery codes are readable - only their hashes
    are stored.
    """
    if user.totp_enabled:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Two-factor authentication is already enabled",
        )
    if not user.totp_secret:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Start with /v1/auth/2fa/setup"
        )
    if not verify_password(body.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Password is incorrect"
        )
    if not await consume_totp_code(db, user, body.code):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid code")

    user.totp_enabled = True
    user.totp_confirmed_at = utcnow()
    codes = await issue_recovery_codes(db, user)
    await record_security_event(db, user.id, "totp_enabled")
    await db.commit()
    await finish_revoke_all(user.id)

    return RecoveryCodesResponse(recovery_codes=codes)


@router.post("/2fa/disable", response_model=MessageResponse)
async def two_factor_disable(
    body: TotpDisableRequest,
    user: User = Depends(get_current_db_user),
    db: AsyncSession = Depends(get_db),
):
    """Turn 2FA off. Requires both the password and a current code.

    Demanding both means neither a stolen access token nor a borrowed phone is
    enough on its own to strip the account's second factor.
    """
    if not user.totp_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Two-factor authentication is not enabled",
        )
    if not verify_password(body.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Password is incorrect"
        )
    if not await consume_totp_code(db, user, body.code):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid code")

    user.totp_enabled = False
    user.totp_secret = None
    user.totp_confirmed_at = None
    user.totp_last_used_step = None
    await db.execute(delete(RecoveryCode).where(RecoveryCode.user_id == user.id))
    await record_security_event(db, user.id, "totp_disabled")
    await db.commit()
    await finish_revoke_all(user.id)

    return MessageResponse(detail="Two-factor authentication disabled")


@router.post("/2fa/recovery-codes", response_model=RecoveryCodesResponse)
async def regenerate_recovery_codes(
    body: TotpCodeRequest,
    user: User = Depends(get_current_db_user),
    db: AsyncSession = Depends(get_db),
):
    """Replace the recovery codes. Every previous code stops working."""
    if not user.totp_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Two-factor authentication is not enabled",
        )
    if not await consume_totp_code(db, user, body.code):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid code")

    codes = await issue_recovery_codes(db, user)
    await record_security_event(db, user.id, "recovery_codes_regenerated")
    await db.commit()
    return RecoveryCodesResponse(recovery_codes=codes)


@router.post("/2fa/verify", response_model=TokenResponse)
@limiter.limit(settings.rate_limit_mfa_verify)
async def two_factor_verify(
    request: Request,
    body: MfaVerifyRequest,
    response: Response,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Second half of login: exchange the MFA challenge plus a code for
    tokens.

    Accepts either a TOTP code or a recovery code, trying TOTP first because
    it is the common case and costs no extra database work.
    """
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired challenge"
    )

    try:
        payload = decode_mfa_challenge_token(body.mfa_token)
        user_id = UUID(payload["sub"])
    except Exception as err:
        raise invalid from err

    user = await db.get(User, user_id)
    if user is None or not user.is_active or not user.totp_enabled:
        raise invalid

    # The challenge carries the token_version it was minted under, so a
    # concurrent "sign out everywhere" invalidates a challenge in flight.
    if payload.get("ver") != user.token_version:
        raise invalid

    if not await consume_totp_code(db, user, body.code):
        if not await consume_recovery_code(db, user, body.code):
            await record_failure(db, "mfa", request, user_id=user.id)
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid code")

    return await start_session(request, response, background, db, user)


# ===========================================================================
# Recovery without the mailbox, and changing the address
# ===========================================================================


class RecoverRequest(BaseModel):
    email: EmailStr
    recovery_code: str = Field(min_length=6, max_length=64)
    new_password: str = Field(min_length=16, max_length=256)
    turnstile_token: str | None = Field(default=None)


@router.post("/recover", response_model=MessageResponse)
@limiter.limit(settings.rate_limit_mfa_verify)
async def recover(
    request: Request, body: RecoverRequest, response: Response, db: AsyncSession = Depends(get_db)
):
    """Set a new password with a two-factor recovery code, for someone who
    has lost both the password and access to the mailbox.

    The recovery code is the proof: it was shown once, when two-factor was
    turned on, and only its hash is stored. Like a reset, it ends every
    session. The old address is still told, in case it wasn't them.
    """
    await verify_turnstile(request, body.turnstile_token)
    failed = HTTPException(
        status.HTTP_401_UNAUTHORIZED, "That email and recovery code don't match."
    )
    user = (
        await db.execute(select(User).where(User.email == body.email.lower()))
    ).scalar_one_or_none()
    if user is None or not user.is_active or not user.totp_enabled:
        await record_failure(db, "recover", request, body.email)
        raise failed
    if not await consume_recovery_code(db, user, body.recovery_code):
        await record_failure(db, "recover", request, user_id=user.id)
        raise failed

    user.hashed_password = hash_password(body.new_password)
    user.password_changed_at = utcnow()
    await record_security_event(db, user.id, "password_recovered", request)
    await revoke_all_sessions(db, user)
    await db.commit()
    await finish_revoke_all(user.id)
    clear_auth_cookies(response)
    await send_password_changed_email(user.email)
    return MessageResponse(detail="Password updated with a recovery code. Sign in again.")


class ChangeEmailRequest(BaseModel):
    password: str = Field(min_length=1, max_length=256)
    new_email: EmailStr


@router.post("/change-email", response_model=MessageResponse)
@limiter.limit(settings.rate_limit_password_email)
async def change_email(
    request: Request,
    body: ChangeEmailRequest,
    user: User = Depends(get_current_db_user),
    db: AsyncSession = Depends(get_db),
):
    """Start moving the account to a new address. Nothing changes until the
    link sent to the new address is opened, so a typo can't lock anyone out.

    Needs the password, not just a session: this is how a stolen session
    would try to take the account for good.
    """
    if not verify_password(body.password, user.hashed_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Password is incorrect")
    new = body.new_email.lower()
    if new == user.email:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That's already your address")
    taken = (await db.execute(select(User.id).where(User.email == new))).scalar_one_or_none()
    # Same answer whether or not the address is in use, so this can't be used
    # to find out who has an account. If it is taken, no link is sent.
    generic = MessageResponse(
        detail=f"If {new} can be used, a confirmation link is on its way there."
    )
    if taken:
        return generic
    user.pending_email = new
    raw = await issue_one_time_token(
        db, user, TokenPurpose.EMAIL_CHANGE, timedelta(hours=settings.email_change_token_hours)
    )
    await record_security_event(db, user.id, "email_change_requested", request, {"to": new})
    await db.commit()
    await send_email_change_email(new, raw)
    return generic


@router.post("/confirm-email-change", response_model=MessageResponse)
async def confirm_email_change(body: TokenOnlyRequest, db: AsyncSession = Depends(get_db)):
    user = await consume_one_time_token(db, body.token, TokenPurpose.EMAIL_CHANGE)
    new = user.pending_email
    if not new:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid or expired token")
    if (await db.execute(select(User.id).where(User.email == new))).scalar_one_or_none():
        raise HTTPException(
            status.HTTP_409_CONFLICT, "That address is now in use by another account"
        )
    old = user.email
    user.email = new
    user.pending_email = None
    # Opening the link proves the new address.
    user.is_verified = True
    user.verified_at = utcnow()
    await record_security_event(db, user.id, "email_changed", meta={"from": old, "to": new})
    await db.commit()
    await finish_revoke_all(user.id)
    await send_email_changed_notice(old, new)
    return MessageResponse(detail="Your email address is updated.")
