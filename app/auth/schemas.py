from datetime import datetime
from uuid import UUID

from pydantic import EmailStr, Field

from app.schemas import BaseRequest, BaseResponse


class BaseAuthRequest(BaseRequest):
    email: EmailStr
    password: str = Field(
        min_length=16,
        max_length=256,
        description="Password must be between 16 and 256 characters long.",
    )


class SignupRequest(BaseAuthRequest):
    pass


class LoginRequest(BaseAuthRequest):
    pass


class TokenResponse(BaseResponse):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    # Also set as the csrf_token cookie. Returned in the body too because the
    # cookie is scoped to this API's /v1/auth path: JavaScript running on
    # app.pacestreak.com can never read it, so without this a browser client
    # has no way to learn the value it must echo back. Returning it is safe -
    # CORS stops any other origin reading this response.
    csrf_token: str | None = None


class UserResponse(BaseResponse):
    id: UUID
    email: EmailStr
    is_active: bool
    is_verified: bool


# --- Email verification ------------------------------------------------------


class EmailRequest(BaseRequest):
    """Used where only an address is supplied and the response must not
    reveal whether it is registered."""

    email: EmailStr


class TokenOnlyRequest(BaseRequest):
    token: str = Field(min_length=1, max_length=512)


class MessageResponse(BaseResponse):
    detail: str


# --- Password management ------------------------------------------------------


class ResetPasswordRequest(BaseRequest):
    token: str = Field(min_length=1, max_length=512)
    new_password: str = Field(min_length=16, max_length=256)


class ChangePasswordRequest(BaseRequest):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=16, max_length=256)


# --- Sessions ------------------------------------------------------------------


class SessionResponse(BaseResponse):
    id: UUID = Field(description="Session id. Same value as the token's `sid`.")
    created_at: datetime
    last_used_at: datetime | None = None
    expires_at: datetime
    user_agent: str | None = None
    ip_address: str | None = None
    current: bool = Field(default=False, description="True for the session making this request.")


# --- Two-factor ------------------------------------------------------------------


class TotpSetupResponse(BaseResponse):
    secret: str = Field(description="Base32 secret, for manual entry.")
    provisioning_uri: str = Field(description="otpauth:// URI to render as a QR code.")


class TotpEnableRequest(BaseRequest):
    """Confirming setup requires the password too, not just a live code.

    Otherwise a stolen-but-valid access token is enough to enrol a second
    factor the real owner never chose - turning a temporary compromise into
    persistent, hard-to-notice access.
    """

    password: str = Field(min_length=1, max_length=256)
    code: str = Field(min_length=6, max_length=10)


class TotpCodeRequest(BaseRequest):
    code: str = Field(min_length=6, max_length=10)


class TotpDisableRequest(BaseRequest):
    password: str = Field(min_length=1, max_length=256)
    code: str = Field(min_length=6, max_length=10)


class RecoveryCodesResponse(BaseResponse):
    recovery_codes: list[str] = Field(description="Shown once. Store them somewhere safe.")


class TwoFactorStatusResponse(BaseResponse):
    enabled: bool
    confirmed_at: datetime | None = None
    recovery_codes_remaining: int


class MfaChallengeResponse(BaseResponse):
    """Returned by /v1/auth/login when a second factor is required.

    Deliberately not a TokenResponse: there is no access token yet, and
    mfa_required lets a client branch without inspecting the status code.
    """

    mfa_required: bool = True
    mfa_token: str
    expires_in: int


class MfaVerifyRequest(BaseRequest):
    mfa_token: str = Field(min_length=1, max_length=4096)
    code: str = Field(min_length=6, max_length=11, description="TOTP code or a recovery code.")
