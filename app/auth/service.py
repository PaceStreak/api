from datetime import timedelta
from uuid import UUID, uuid7

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.cache import invalidate_user, revoke_session
from app.auth.models import OneTimeToken, RecoveryCode, RefreshToken, TokenPurpose, User
from app.auth.security import (
    DUMMY_PASSWORD_HASH,
    create_access_token,
    decrypt_totp_secret,
    find_matching_totp_step,
    generate_otp_code,
    generate_recovery_code,
    generate_refresh_token,
    hash_one_time_token,
    hash_recovery_code,
    hash_refresh_token,
    utcnow,
    verify_password,
    verify_recovery_code,
)
from app.config import get_settings

settings = get_settings()

# A code stops being redeemable after this many wrong guesses, independent of
# its expiry - six digits is only ~20 bits, so the attempt count is the real
# defense against guessing, not the code space.
MAX_OTP_ATTEMPTS = 5


async def authenticate_user(db: AsyncSession, email: str, password: str) -> User | None:
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()

    if user is None:
        # Run a real verification anyway so a nonexistent account takes the
        # same time as a wrong password - otherwise the response latency
        # itself would enumerate registered emails.
        verify_password(password, DUMMY_PASSWORD_HASH)
        return None

    if not verify_password(password, user.hashed_password):
        return None

    if not user.is_active:
        return None

    return user


async def create_refresh_session(
    db: AsyncSession,
    user: User,
    *,
    family_id: UUID | None = None,
    parent_id: UUID | None = None,
    user_agent: str | None = None,
    ip_address: str | None = None,
) -> tuple[str, RefreshToken]:
    raw_token = generate_refresh_token()

    refresh = RefreshToken(
        user_id=user.id,
        token_hash=hash_refresh_token(raw_token),
        family_id=family_id or uuid7(),
        parent_id=parent_id,
        expires_at=utcnow() + timedelta(days=settings.refresh_token_days),
        user_agent=(user_agent[:400] if user_agent else None),
        ip_address=ip_address,
        last_used_at=utcnow(),
    )
    db.add(refresh)
    await db.flush()  # populates refresh.id for the caller

    return raw_token, refresh


async def login_user(
    db: AsyncSession,
    user: User,
    *,
    user_agent: str | None = None,
    ip_address: str | None = None,
) -> tuple[str, str, int]:
    refresh_token, refresh = await create_refresh_session(
        db, user, user_agent=user_agent, ip_address=ip_address
    )
    access_token, expires_in = create_access_token(user.id, user.token_version, refresh.family_id)
    return access_token, refresh_token, expires_in


# How long after rotation the previous refresh token may still be presented
# (see rotate_refresh_token). Long enough for a reload race, too short to be
# a useful window for a stolen token.
REUSE_GRACE = timedelta(seconds=30)


async def rotate_refresh_token(db: AsyncSession, raw_token: str) -> tuple[str, str, int]:
    token_hash = hash_refresh_token(raw_token)
    result = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    old_token = result.scalar_one_or_none()

    if old_token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        )

    now = utcnow()

    # A benign race, not theft: a page reloaded (or a second tab opened)
    # while a refresh was in flight, so the browser presents the token just
    # rotated away before the new cookie landed. Within a short window, and
    # only while the token it became is still the live one, continue the
    # session from that live token instead of burning the family. Outside the
    # window, reuse is treated as theft exactly as before.
    tip = old_token
    for _ in range(5):  # several overlapping reloads rotate it more than once
        if tip.revoked_at is None or tip.replaced_by is None or now - tip.revoked_at > REUSE_GRACE:
            break
        successor = await db.get(RefreshToken, tip.replaced_by)
        if successor is None:
            break
        tip = successor
    if tip is not old_token and tip.revoked_at is None and tip.expires_at > now:
        old_token = tip

    if old_token.revoked_at is not None:
        # A token that has already been rotated away is being presented again
        # - the signature of a stolen refresh token. Burn the whole family:
        # whichever party holds the current token loses it too, but that is
        # the correct trade against leaving a compromised session alive.
        await db.execute(
            update(RefreshToken)
            .where(RefreshToken.family_id == old_token.family_id)
            .where(RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        await db.commit()
        await revoke_session(old_token.family_id)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token has been revoked due to suspicious activity.",
        )

    if old_token.expires_at <= now:
        old_token.revoked_at = now
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token has expired."
        )

    user = await db.get(User, old_token.user_id)
    if user is None or not user.is_active:
        old_token.revoked_at = now
        await db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account is inactive or does not exist.",
        )

    old_token.revoked_at = now
    new_raw_token, new_token = await create_refresh_session(
        db,
        user,
        family_id=old_token.family_id,
        parent_id=old_token.id,
        # Carry the session's identity forward so /v1/auth/sessions keeps
        # showing the device it was created on rather than resetting on every
        # refresh.
        user_agent=old_token.user_agent,
        ip_address=old_token.ip_address,
    )
    old_token.replaced_by = new_token.id

    access_token, expires_in = create_access_token(user.id, user.token_version, old_token.family_id)
    await db.commit()

    return access_token, new_raw_token, expires_in


# ---------------------------------------------------------------------------
# Session-wide revocation
# ---------------------------------------------------------------------------


async def revoke_all_sessions(db: AsyncSession, user: User) -> None:
    """End every session for a user, access tokens included.

    Two mechanisms, because neither covers both credential types: revoking the
    refresh rows kills the refresh path, and bumping token_version invalidates
    every access token already in circulation.

    Callers must commit. The cache is invalidated after that commit by
    finish_revoke_all, never before - a concurrent request could otherwise
    repopulate it with the pre-bump value.
    """
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id)
        .where(RefreshToken.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )
    await db.execute(
        update(User).where(User.id == user.id).values(token_version=User.token_version + 1)
    )


async def finish_revoke_all(user_id: UUID) -> None:
    await invalidate_user(user_id)


async def revoke_session_family(db: AsyncSession, user: User, family_id: UUID) -> bool:
    """End one session. Returns False if it does not belong to this user.

    The ownership check is the security-relevant part: family_id comes from a
    URL, so without it any user could end any other user's session.
    """
    result = await db.execute(
        select(RefreshToken.id)
        .where(RefreshToken.family_id == family_id)
        .where(RefreshToken.user_id == user.id)
        .limit(1)
    )
    if result.scalar_one_or_none() is None:
        return False

    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.family_id == family_id)
        .where(RefreshToken.user_id == user.id)
        .where(RefreshToken.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )
    await db.commit()
    # Denies the access tokens this session already handed out.
    await revoke_session(family_id)
    return True


async def list_sessions(db: AsyncSession, user: User) -> list[RefreshToken]:
    """The live token of each active session, newest first.

    Rotation leaves exactly one unrevoked row per family, so filtering on
    revoked_at IS NULL yields one row per session with no grouping needed.
    """
    result = await db.execute(
        select(RefreshToken)
        .where(RefreshToken.user_id == user.id)
        .where(RefreshToken.revoked_at.is_(None))
        .where(RefreshToken.expires_at > utcnow())
        .order_by(RefreshToken.created_at.desc())
    )
    return list(result.scalars().all())


# ---------------------------------------------------------------------------
# One-time codes
# ---------------------------------------------------------------------------


async def issue_one_time_token(
    db: AsyncSession, user: User, purpose: TokenPurpose, lifetime: timedelta
) -> str:
    """Mint an OTP code, invalidating any earlier unused one for the same
    purpose so only the most recently emailed code works."""
    await db.execute(
        update(OneTimeToken)
        .where(OneTimeToken.user_id == user.id)
        .where(OneTimeToken.purpose == purpose)
        .where(OneTimeToken.used_at.is_(None))
        .values(used_at=utcnow())
    )

    raw = generate_otp_code()
    db.add(
        OneTimeToken(
            user_id=user.id,
            purpose=purpose,
            token_hash=hash_one_time_token(raw),
            expires_at=utcnow() + lifetime,
        )
    )
    await db.flush()
    return raw


async def _users_awaiting_code(db: AsyncSession, purpose: TokenPurpose, email: str) -> list[User]:
    """Which users a code for this purpose should be checked against.

    Email change is the one purpose where the code is sent to an address the
    account doesn't have yet, so it's looked up by pending_email rather than
    email - everything else looks up by the account's current address.
    pending_email isn't unique (two accounts may ask for the same address,
    and only one can win), so this can be more than one user.
    """
    column = User.pending_email if purpose is TokenPurpose.EMAIL_CHANGE else User.email
    result = await db.execute(select(User).where(column == email, User.is_active.is_(True)))
    return list(result.scalars())


async def consume_one_time_token(
    db: AsyncSession, email: str, raw_code: str, purpose: TokenPurpose
) -> User:
    """Redeem an OTP code, or raise 400.

    Every failure mode returns the same message. Distinguishing "expired" from
    "already used" from "wrong code" would tell an attacker which guesses were
    close. Codes aren't unique across users the way link tokens were, so the
    lookup is always by (user, purpose) for the newest unused, unexpired row,
    then the submitted code is checked against that row's hash.

    The caller must commit; used_at is set here so redemption and the action
    it authorises land in one transaction.
    """
    invalid = HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired code"
    )

    candidates: list[tuple[User, OneTimeToken]] = []
    for user in await _users_awaiting_code(db, purpose, email.lower()):
        result = await db.execute(
            select(OneTimeToken)
            .where(OneTimeToken.user_id == user.id)
            .where(OneTimeToken.purpose == purpose)
            .where(OneTimeToken.used_at.is_(None))
            .where(OneTimeToken.expires_at > utcnow())
            .order_by(OneTimeToken.created_at.desc())
            .limit(1)
        )
        token = result.scalar_one_or_none()
        if token is not None and token.attempts < MAX_OTP_ATTEMPTS:
            candidates.append((user, token))

    digest = hash_one_time_token(raw_code)
    for user, token in candidates:
        if token.token_hash == digest:
            token.used_at = utcnow()
            return user
    for _, token in candidates:
        token.attempts += 1
    raise invalid


# ---------------------------------------------------------------------------
# Recovery codes
# ---------------------------------------------------------------------------


async def issue_recovery_codes(db: AsyncSession, user: User) -> list[str]:
    """Replace the user's recovery codes and return the new plaintext set.

    This is the only moment the codes are readable. Old ones are deleted
    rather than marked used: they are being replaced, not spent.
    """
    await db.execute(delete(RecoveryCode).where(RecoveryCode.user_id == user.id))

    codes = [generate_recovery_code() for _ in range(settings.recovery_code_count)]
    for code in codes:
        db.add(RecoveryCode(user_id=user.id, code_hash=hash_recovery_code(code)))
    await db.flush()
    return codes


async def consume_recovery_code(db: AsyncSession, user: User, code: str) -> bool:
    """Spend one recovery code. Caller commits.

    Every unused code has to be checked because each carries its own Argon2
    salt, so there is nothing to look up by. With ten codes that is ten
    verifications - acceptable on a path this rare, and it doubles as rate
    limiting.
    """
    result = await db.execute(
        select(RecoveryCode)
        .where(RecoveryCode.user_id == user.id)
        .where(RecoveryCode.used_at.is_(None))
    )
    for candidate in result.scalars().all():
        if verify_recovery_code(code, candidate.code_hash):
            candidate.used_at = utcnow()
            return True
    return False


async def count_unused_recovery_codes(db: AsyncSession, user: User) -> int:
    result = await db.execute(
        select(func.count())
        .select_from(RecoveryCode)
        .where(RecoveryCode.user_id == user.id)
        .where(RecoveryCode.used_at.is_(None))
    )
    return int(result.scalar_one())


# ---------------------------------------------------------------------------
# TOTP verification, with replay protection
# ---------------------------------------------------------------------------


async def consume_totp_code(db: AsyncSession, user: User, code: str) -> bool:
    """Verify a TOTP code and record the step it matched, so it cannot be
    replayed again for the rest of its ~90s validity window.

    Caller commits. Returns False for an invalid code or one whose step has
    already been spent - both look identical to the client on purpose.
    """
    if not user.totp_secret:
        return False

    secret = decrypt_totp_secret(user.totp_secret)
    step = find_matching_totp_step(secret, code)
    if step is None:
        return False
    if user.totp_last_used_step is not None and step <= user.totp_last_used_step:
        return False

    user.totp_last_used_step = step
    return True
