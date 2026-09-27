from datetime import datetime
from enum import StrEnum
from uuid import UUID

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, LargeBinary, String
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class UserRole(StrEnum):
    ADMIN = "admin"
    # Reviews reports and moderates content. Cannot change roles or delete
    # accounts - those stay with admins.
    MODERATOR = "moderator"
    USER = "user"


class User(Base):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(512), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        SAEnum(
            UserRole,
            name="userrole",
            # Store the declared values ("user") rather than member names ("USER").
            values_callable=lambda enum: [member.value for member in enum],
        ),
        default=UserRole.USER,
        nullable=False,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # Bumped by /v1/auth/logout-all so already-issued access tokens stop
    # validating even though their signature and expiry are still fine.
    token_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    password_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Set while a change of address waits for the link sent to the new one.
    # The account keeps signing in with the old address until then.
    pending_email: Mapped[str | None] = mapped_column(String(320), nullable=True)

    # --- TOTP two-factor -----------------------------------------------------
    # Fernet ciphertext, not the raw Base32 secret - see app/auth/security.py's
    # encrypt_secret/decrypt_secret. Present but unconfirmed between
    # /2fa/setup and /2fa/enable; totp_enabled is the only flag login consults.
    totp_secret: Mapped[str | None] = mapped_column(String(512), nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    totp_confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # The TOTP time-step last accepted, so the same 30s code cannot be replayed
    # for the rest of its validity window. NULL until the first successful
    # verification.
    totp_last_used_step: Mapped[int | None] = mapped_column(Integer, nullable=True)

    refresh_tokens: Mapped[list[RefreshToken]] = relationship(
        "RefreshToken",
        back_populates="user",
        cascade="all, delete-orphan",
        foreign_keys="RefreshToken.user_id",
    )


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    user: Mapped[User] = relationship(
        "User", back_populates="refresh_tokens", foreign_keys=[user_id]
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    # Stable across rotation - identifies one login session for its lifetime,
    # and doubles as the JWT "sid" claim and the /v1/auth/sessions id.
    family_id: Mapped[UUID] = mapped_column(index=True, nullable=False)
    parent_id: Mapped[UUID | None] = mapped_column(ForeignKey("refresh_tokens.id"), nullable=True)
    replaced_by: Mapped[UUID | None] = mapped_column(nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Captured at login so a person can recognise their own sessions in the
    # /v1/auth/sessions list. Descriptive only - never used for authorisation,
    # since a client controls both values.
    user_agent: Mapped[str | None] = mapped_column(String(400), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TokenPurpose(StrEnum):
    EMAIL_VERIFY = "email_verify"
    PASSWORD_RESET = "password_reset"
    EMAIL_CHANGE = "email_change"


class OneTimeToken(Base):
    """A single-use 6-digit code, emailed to the user and typed back.

    Same storage discipline as RefreshToken: only the SHA-256 digest is kept,
    so a database dump yields nothing that can be redeemed. `used_at` marks
    redemption rather than deleting the row, which keeps the audit trail and
    lets a replayed code be distinguished from one that never existed.

    Unlike a link token, the code alone isn't unique across users (six digits,
    many accounts), so lookup is always by (user, purpose) for the newest
    unused row, and the code is compared against that row's hash. `attempts`
    bounds online guessing, which a random link token never needed because
    guessing 32 bytes isn't feasible.
    """

    __tablename__ = "one_time_tokens"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    purpose: Mapped[TokenPurpose] = mapped_column(
        SAEnum(
            TokenPurpose,
            name="tokenpurpose",
            values_callable=lambda enum: [member.value for member in enum],
        ),
        nullable=False,
    )
    token_hash: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class RecoveryCode(Base):
    """One of the printable codes issued when 2FA is enabled.

    Hashed like a password rather than with SHA-256: these are short enough to
    be guessable, so the slow hash matters. Single use - `used_at` is set on
    redemption and the row is kept so the user can be told how many remain.
    """

    __tablename__ = "recovery_codes"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    code_hash: Mapped[str] = mapped_column(String(512), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Passkey(Base):
    """A WebAuthn credential: a key pair whose private half never leaves the
    person's device or password manager.

    Only the public key is stored, so a database dump yields nothing that can
    sign in. A passkey is phishing-resistant by construction - the browser
    binds every assertion to the origin - which is why signing in with one
    satisfies two-factor on its own (see app/auth/passkeys.py).
    """

    __tablename__ = "passkeys"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # base64url of the authenticator's credential id. Unique across the whole
    # table: an id is how a usernameless sign-in finds its account.
    credential_id: Mapped[str] = mapped_column(String(1400), unique=True, nullable=False)
    public_key: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # Most synced passkeys report 0 forever; a counter that does move and then
    # goes backwards means a cloned authenticator, and is refused.
    sign_count: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    transports: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    # Whether the credential is synced (iCloud Keychain, Google Password
    # Manager...). Shown in the list so people know which ones survive losing
    # a phone.
    backed_up: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WebAuthnChallenge(Base):
    """A pending passkey ceremony. Kept in Postgres rather than Redis because
    Redis here is best-effort by design, and a challenge that can be replayed
    after a Redis outage is a correctness bug, not a performance one. Deleted
    on use; the worker sweeps expired rows."""

    __tablename__ = "webauthn_challenges"

    challenge: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    # NULL for sign-in: a usernameless ceremony does not know who is coming.
    user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    purpose: Mapped[str] = mapped_column(String(12), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
