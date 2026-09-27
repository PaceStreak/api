import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid7

import jwt
import pyotp
from cryptography.fernet import Fernet, InvalidToken
from jwt.exceptions import InvalidTokenError
from pwdlib import PasswordHash

from app.config import get_settings

settings = get_settings()

password_hash = PasswordHash.recommended()

# A fixed, well-formed hash to run a real verification against when the
# account does not exist, so login takes the same time either way and cannot
# be used to enumerate registered emails by timing.
DUMMY_PASSWORD_HASH = password_hash.hash(secrets.token_urlsafe(32))


def utcnow() -> datetime:
    return datetime.now(UTC)


# ---------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------


def hash_password(password: str) -> str:
    return password_hash.hash(password)


def verify_password(password: str, hashed_password: str) -> bool:
    try:
        return password_hash.verify(password, hashed_password)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Refresh tokens
# ---------------------------------------------------------------------------


def generate_refresh_token() -> str:
    return secrets.token_urlsafe(64)


def hash_refresh_token(token: str) -> str:
    # SHA-256, not a slow hash: the input is already 64 bytes of CSPRNG output,
    # so there is nothing a slow hash would protect against, and this needs to
    # be an indexed, deterministic lookup column.
    return hashlib.sha256(token.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Access tokens (RS256 JWT)
# ---------------------------------------------------------------------------


def create_access_token(user_id: UUID, token_version: int, session_id: UUID) -> tuple[str, int]:
    now = utcnow()
    expires_at = now + timedelta(minutes=settings.access_token_minutes)

    payload = {
        "sub": str(user_id),
        "type": "access",
        "ver": token_version,
        # The refresh-token family this access token was issued from. Stable
        # across rotation, so it identifies one login session for its lifetime.
        "sid": str(session_id),
        "jti": str(uuid7()),
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
        "iat": now,
        "exp": expires_at,
    }

    token = jwt.encode(
        payload,
        settings.jwt_private_key,
        algorithm="RS256",
        headers={"kid": "main"},
    )
    return token, int((expires_at - now).total_seconds())


def decode_access_token(token: str) -> dict:
    payload = jwt.decode(
        token,
        settings.jwt_public_key,
        algorithms=["RS256"],
        issuer=settings.jwt_issuer,
        audience=settings.jwt_audience,
        options={"require": ["sub", "type", "ver", "sid", "jti", "iat", "exp", "iss", "aud"]},
    )
    if payload.get("type") != "access":
        raise InvalidTokenError("Invalid token type")
    return payload


# ---------------------------------------------------------------------------
# One-time codes (email verification, password reset, email change)
# ---------------------------------------------------------------------------


def generate_otp_code() -> str:
    """A 6-digit numeric code, emailed and typed back by hand.

    Low entropy compared to a link token, on purpose - it has to be readable
    off an email and retyped. That's why OneTimeToken.attempts exists: the
    code alone is not enough to resist guessing, a bounded attempt count is.
    """
    return f"{secrets.randbelow(1_000_000):06d}"


def hash_one_time_token(token: str) -> str:
    """SHA-256, for the same reason refresh tokens use it: only the digest is
    stored, so a database dump yields nothing redeemable on its own - the
    attempt limit in app/auth/service.py is what stops online guessing."""
    return hashlib.sha256(token.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Recovery codes
# ---------------------------------------------------------------------------


def generate_recovery_code() -> str:
    """Short enough to type off paper, formatted in two groups for legibility."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no I/O/0/1 - misread on paper
    raw = "".join(secrets.choice(alphabet) for _ in range(10))
    return f"{raw[:5]}-{raw[5:]}"


def normalize_recovery_code(code: str) -> str:
    return code.strip().upper().replace(" ", "")


def hash_recovery_code(code: str) -> str:
    """Argon2, not SHA-256. A recovery code is ~50 bits and human-typed, which
    puts it in guessable territory - so the slow hash earns its cost here."""
    return password_hash.hash(normalize_recovery_code(code))


def verify_recovery_code(code: str, hashed: str) -> bool:
    try:
        return password_hash.verify(normalize_recovery_code(code), hashed)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# TOTP
# ---------------------------------------------------------------------------

_fernet: Fernet | None = None


def _get_fernet() -> Fernet | None:
    """None when TOTP_ENCRYPTION_KEY is unset.

    app/main.py refuses to start with the key unset outside development, so
    None only ever happens in dev - callers fall back to storing the secret in
    the clear rather than crashing a local checkout.
    """
    global _fernet
    if _fernet is None and settings.totp_encryption_key:
        _fernet = Fernet(settings.totp_encryption_key.encode())
    return _fernet


def encrypt_totp_secret(secret: str) -> str:
    fernet = _get_fernet()
    return fernet.encrypt(secret.encode()).decode() if fernet else secret


def decrypt_totp_secret(stored: str) -> str:
    fernet = _get_fernet()
    if not fernet:
        return stored
    try:
        return fernet.decrypt(stored.encode()).decode()
    except InvalidToken:
        # Ciphertext written under a different key (e.g. TOTP_ENCRYPTION_KEY
        # rotated without re-enrolling everyone), or never encrypted at all.
        # Either way it cannot be a valid secret - treat as "wrong code"
        # rather than raising 500s out of a login path.
        return ""


def generate_totp_secret() -> str:
    return pyotp.random_base32()


def totp_provisioning_uri(secret: str, email: str) -> str:
    """The otpauth:// URI an authenticator app consumes, usually via QR code."""
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=settings.totp_issuer)


def totp_current_step(at: datetime | None = None) -> int:
    return int((at or utcnow()).timestamp() // 30)


def find_matching_totp_step(secret: str, code: str) -> int | None:
    """The time-step `code` is valid for, or None.

    Checked by generating the code for each step in the tolerated window
    rather than via `pyotp.TOTP.verify`, because the step number is what
    replay protection needs to record - `verify` only returns a bool.
    """
    if not secret or not code:
        return None
    code = code.strip().replace(" ", "")
    totp = pyotp.TOTP(secret)
    now_step = totp_current_step()
    for offset in range(-settings.totp_valid_window, settings.totp_valid_window + 1):
        step = now_step + offset
        try:
            if secrets.compare_digest(totp.at(step * 30), code):
                return step
        except Exception:
            continue
    return None


# ---------------------------------------------------------------------------
# MFA challenge token
# ---------------------------------------------------------------------------
#
# Handed out when the password is correct but a second factor is still owed.
# It is deliberately NOT an access token: `type` is "mfa", and
# decode_access_token rejects anything whose type is not "access", so this
# cannot be presented to a protected endpoint.


def create_mfa_challenge_token(user_id: UUID, token_version: int) -> tuple[str, int]:
    now = utcnow()
    expires_at = now + timedelta(minutes=settings.mfa_challenge_minutes)
    payload = {
        "sub": str(user_id),
        "type": "mfa",
        "ver": token_version,
        "jti": str(uuid7()),
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
        "iat": now,
        "exp": expires_at,
    }
    token = jwt.encode(
        payload, settings.jwt_private_key, algorithm="RS256", headers={"kid": "main"}
    )
    return token, int((expires_at - now).total_seconds())


def decode_mfa_challenge_token(token: str) -> dict:
    payload = jwt.decode(
        token,
        settings.jwt_public_key,
        algorithms=["RS256"],
        issuer=settings.jwt_issuer,
        audience=settings.jwt_audience,
        options={"require": ["sub", "type", "ver", "jti", "iat", "exp", "iss", "aud"]},
    )
    if payload.get("type") != "mfa":
        raise InvalidTokenError("Invalid token type")
    return payload
