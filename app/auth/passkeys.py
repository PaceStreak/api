"""Passkeys (WebAuthn): sign in with the device's own lock instead of a password.

Two ceremonies, each in two steps - the server issues a challenge, the
browser signs it, the server checks the signature:

- Registration (signed in, password re-entered): binds a new key pair to the
  account. Only the public key is stored.
- Sign-in (signed out, usernameless): the browser offers whichever passkeys
  it holds for this site, and the credential id says whose account it is.

A passkey sign-in skips the TOTP prompt. That is the standard treatment, not a
shortcut: the assertion requires user verification (a fingerprint, face or
device PIN) on a key the person possesses, bound by the browser to this
origin - two factors, and phishing-proof in a way a typed code is not.

Challenges live in Postgres and are deleted when used, so each is good for
exactly one ceremony even across API replicas and a Redis outage.
"""

import json
import secrets
from datetime import datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from pydantic import Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.exceptions import InvalidAuthenticationResponse, InvalidRegistrationResponse
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    AuthenticatorTransport,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from app.account.service import describe_agent
from app.account.service import record as record_security_event
from app.auth.dependencies import get_current_db_user
from app.auth.models import Passkey, User, WebAuthnChallenge
from app.auth.router import start_session
from app.auth.security import utcnow, verify_password
from app.config import get_settings
from app.database import get_db
from app.ops.service import record_failure
from app.ratelimit import limiter
from app.schemas import BaseRequest, BaseResponse

router = APIRouter(prefix="/auth/passkeys", tags=["auth"])
settings = get_settings()

REGISTER = "register"
SIGN_IN = "sign_in"


class PasskeyResponse(BaseResponse):
    id: UUID
    name: str
    backed_up: bool
    created_at: datetime
    last_used_at: datetime | None


class CeremonyResponse(BaseResponse):
    challenge_id: str
    # PublicKeyCredentialCreationOptions / RequestOptions, already in the
    # base64url JSON shape the browser's parse*OptionsFromJSON expects.
    options: dict


class RegisterOptionsRequest(BaseRequest):
    password: str = Field(min_length=1, max_length=256)


class RegisterRequest(BaseRequest):
    challenge_id: str = Field(max_length=128)
    credential: dict
    name: str | None = Field(default=None, max_length=60)


class SignInRequest(BaseRequest):
    challenge_id: str = Field(max_length=128)
    credential: dict


class RenameRequest(BaseRequest):
    name: str = Field(min_length=1, max_length=60)


class RemoveRequest(BaseRequest):
    password: str = Field(min_length=1, max_length=256)


async def _issue_challenge(
    db: AsyncSession, purpose: str, user_id: UUID | None
) -> tuple[str, bytes]:
    raw = secrets.token_bytes(32)
    challenge_id = bytes_to_base64url(raw)
    db.add(
        WebAuthnChallenge(
            challenge=challenge_id,
            user_id=user_id,
            purpose=purpose,
            expires_at=utcnow() + timedelta(seconds=settings.webauthn_challenge_seconds),
        )
    )
    await db.flush()
    return challenge_id, raw


async def _take_challenge(
    db: AsyncSession, challenge_id: str, purpose: str, user_id: UUID | None
) -> bytes:
    """Delete-and-return, so a challenge can never be answered twice."""
    row = (
        await db.execute(
            delete(WebAuthnChallenge)
            .where(
                WebAuthnChallenge.challenge == challenge_id,
                WebAuthnChallenge.purpose == purpose,
            )
            .returning(WebAuthnChallenge.user_id, WebAuthnChallenge.expires_at)
        )
    ).one_or_none()
    if row is None or row.expires_at < utcnow() or row.user_id != user_id:
        await db.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This passkey request expired. Try again.")
    return base64url_to_bytes(challenge_id)


def _transports(values: list[str]) -> list[AuthenticatorTransport]:
    known = {t.value for t in AuthenticatorTransport}
    return [AuthenticatorTransport(v) for v in values if v in known]


def _to_response(p: Passkey) -> PasskeyResponse:
    return PasskeyResponse(
        id=p.id,
        name=p.name,
        backed_up=p.backed_up,
        created_at=p.created_at,
        last_used_at=p.last_used_at,
    )


@router.get("", response_model=list[PasskeyResponse])
async def list_passkeys(
    user: User = Depends(get_current_db_user), db: AsyncSession = Depends(get_db)
):
    rows = (
        (
            await db.execute(
                select(Passkey).where(Passkey.user_id == user.id).order_by(Passkey.created_at)
            )
        )
        .scalars()
        .all()
    )
    return [_to_response(p) for p in rows]


@router.post("/register/options", response_model=CeremonyResponse)
async def register_options(
    body: RegisterOptionsRequest,
    user: User = Depends(get_current_db_user),
    db: AsyncSession = Depends(get_db),
):
    """Start adding a passkey. The password is required for the same reason
    enabling 2FA requires it: a stolen access token must not be able to plant a
    permanent way in that the owner never chose."""
    if not verify_password(body.password, user.hashed_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Password is incorrect")

    existing = (await db.execute(select(Passkey).where(Passkey.user_id == user.id))).scalars().all()
    if len(existing) >= settings.max_passkeys:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"You can have up to {settings.max_passkeys} passkeys. Remove one first.",
        )

    challenge_id, raw = await _issue_challenge(db, REGISTER, user.id)
    options = generate_registration_options(
        rp_id=settings.passkey_rp_id,
        rp_name=settings.webauthn_rp_name,
        # The account id, not the email: the handle is stored on the device and
        # must carry no personal data.
        user_id=user.id.bytes,
        user_name=user.email,
        user_display_name=user.email,
        challenge=raw,
        timeout=settings.webauthn_challenge_seconds * 1000,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        # Stops the same authenticator being registered twice.
        exclude_credentials=[
            PublicKeyCredentialDescriptor(
                id=base64url_to_bytes(p.credential_id), transports=_transports(p.transports)
            )
            for p in existing
        ],
    )
    await db.commit()
    return CeremonyResponse(challenge_id=challenge_id, options=json.loads(options_to_json(options)))


@router.post("/register", response_model=PasskeyResponse, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    request: Request,
    user: User = Depends(get_current_db_user),
    db: AsyncSession = Depends(get_db),
):
    expected = await _take_challenge(db, body.challenge_id, REGISTER, user.id)
    try:
        verified = verify_registration_response(
            credential=body.credential,
            expected_challenge=expected,
            expected_rp_id=settings.passkey_rp_id,
            expected_origin=settings.passkey_origin,
            require_user_verification=True,
        )
    except InvalidRegistrationResponse as err:
        await db.commit()
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "The passkey could not be verified"
        ) from err

    credential_id = bytes_to_base64url(verified.credential_id)
    if (
        await db.execute(select(Passkey.id).where(Passkey.credential_id == credential_id))
    ).scalar_one_or_none():
        await db.commit()
        raise HTTPException(status.HTTP_409_CONFLICT, "That passkey is already registered")

    transports = body.credential.get("response", {}).get("transports") or []
    passkey = Passkey(
        user_id=user.id,
        credential_id=credential_id,
        public_key=verified.credential_public_key,
        sign_count=verified.sign_count,
        transports=[t for t in transports if isinstance(t, str)][:8],
        backed_up=verified.credential_backed_up,
        name=(body.name or "").strip()
        or f"Passkey on {describe_agent(request.headers.get('user-agent'))}"[:60],
    )
    db.add(passkey)
    await db.flush()
    await record_security_event(db, user.id, "passkey_added", request, {"name": passkey.name})
    await db.commit()
    await db.refresh(passkey)
    return _to_response(passkey)


@router.patch("/{passkey_id}", response_model=PasskeyResponse)
async def rename(
    passkey_id: UUID,
    body: RenameRequest,
    user: User = Depends(get_current_db_user),
    db: AsyncSession = Depends(get_db),
):
    passkey = await db.get(Passkey, passkey_id)
    if passkey is None or passkey.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Passkey not found")
    passkey.name = body.name.strip()
    await db.commit()
    await db.refresh(passkey)
    return _to_response(passkey)


@router.post("/{passkey_id}/remove", status_code=status.HTTP_204_NO_CONTENT)
async def remove(
    passkey_id: UUID,
    body: RemoveRequest,
    request: Request,
    user: User = Depends(get_current_db_user),
    db: AsyncSession = Depends(get_db),
):
    """A POST with the password rather than a bare DELETE: removing a way in is
    as sensitive as adding one."""
    if not verify_password(body.password, user.hashed_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Password is incorrect")
    passkey = await db.get(Passkey, passkey_id)
    if passkey is None or passkey.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Passkey not found")
    await db.delete(passkey)
    await record_security_event(db, user.id, "passkey_removed", request, {"name": passkey.name})
    await db.commit()


@router.post("/sign-in/options", response_model=CeremonyResponse)
@limiter.limit(settings.rate_limit_login)
async def sign_in_options(request: Request, db: AsyncSession = Depends(get_db)):
    """Usernameless: no allow-list, so this reveals nothing about which
    accounts exist or what passkeys they hold."""
    challenge_id, raw = await _issue_challenge(db, SIGN_IN, None)
    options = generate_authentication_options(
        rp_id=settings.passkey_rp_id,
        challenge=raw,
        timeout=settings.webauthn_challenge_seconds * 1000,
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    await db.commit()
    return CeremonyResponse(challenge_id=challenge_id, options=json.loads(options_to_json(options)))


@router.post("/sign-in")
@limiter.limit(settings.rate_limit_login)
async def sign_in(
    request: Request,
    body: SignInRequest,
    response: Response,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    expected = await _take_challenge(db, body.challenge_id, SIGN_IN, None)
    # One message for every failure below: which step failed is of no use to
    # a person and of some use to someone probing.
    failed = HTTPException(
        status.HTTP_401_UNAUTHORIZED, "That passkey didn't work. Try again or use your password."
    )

    raw_id = body.credential.get("id")
    if not isinstance(raw_id, str) or len(raw_id) > 1400:
        await db.commit()
        await record_failure(db, "passkey", request)
        raise failed
    passkey = (
        await db.execute(select(Passkey).where(Passkey.credential_id == raw_id))
    ).scalar_one_or_none()
    if passkey is None:
        await db.commit()
        await record_failure(db, "passkey", request)
        raise failed

    try:
        verified = verify_authentication_response(
            credential=body.credential,
            expected_challenge=expected,
            expected_rp_id=settings.passkey_rp_id,
            expected_origin=settings.passkey_origin,
            credential_public_key=passkey.public_key,
            credential_current_sign_count=passkey.sign_count,
            require_user_verification=True,
        )
    except InvalidAuthenticationResponse as err:
        await db.commit()
        await record_failure(db, "passkey", request)
        raise failed from err

    user = await db.get(User, passkey.user_id)
    if user is None or not user.is_active:
        await db.commit()
        await record_failure(db, "passkey", request)
        raise failed
    if settings.require_verified_email and not user.is_verified:
        await db.commit()
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Email address not verified")

    passkey.sign_count = verified.new_sign_count
    passkey.backed_up = verified.credential_backed_up
    passkey.last_used_at = utcnow()
    return await start_session(request, response, background, db, user)


async def sweep_expired_challenges(db: AsyncSession) -> int:
    """Called by the worker's housekeeping job."""
    result = await db.execute(
        delete(WebAuthnChallenge).where(WebAuthnChallenge.expires_at < func.now())
    )
    return result.rowcount or 0
