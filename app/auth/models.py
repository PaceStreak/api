from datetime import datetime
from enum import StrEnum
from uuid import UUID

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class UserRole(StrEnum):
    ADMIN = "admin"
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
    parent_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("refresh_tokens.id"), nullable=True
    )
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


class OneTimeToken(Base):
    """A single-use link token, emailed to the user.

    Same storage discipline as RefreshToken: only the SHA-256 digest is kept,
    so a database dump yields nothing that can be redeemed. `used_at` marks
    redemption rather than deleting the row, which keeps the audit trail and
    lets a replayed link be distinguished from one that never existed.
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
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


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
