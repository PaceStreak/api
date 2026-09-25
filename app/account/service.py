from uuid import UUID

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.account.models import SecurityEvent

LABELS = {
    "login": "Signed in",
    "logout_all": "Signed out everywhere",
    "password_changed": "Password changed",
    "password_reset": "Password reset by email",
    "totp_enabled": "Two-factor turned on",
    "totp_disabled": "Two-factor turned off",
    "recovery_codes_regenerated": "Recovery codes replaced",
    "session_revoked": "A session was signed out",
    "email_verified": "Email address confirmed",
    "deletion_scheduled": "Account deletion scheduled",
    "deletion_cancelled": "Account deletion cancelled",
    "data_exported": "Data exported",
    "passkey_added": "Passkey added",
    "passkey_removed": "Passkey removed",
}


def _client(request: Request | None) -> tuple[str | None, str | None]:
    """(ip, user agent), truncated to their columns. Descriptive only."""
    if request is None:
        return None, None
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        ip = forwarded.split(",")[0].strip()
    else:
        ip = request.client.host if request.client else None
    agent = request.headers.get("user-agent")
    return (ip[:45] if ip else None), (agent[:400] if agent else None)


async def record(
    db: AsyncSession,
    user_id: UUID,
    kind: str,
    request: Request | None = None,
    meta: dict | None = None,
) -> SecurityEvent:
    ip, agent = _client(request)
    event = SecurityEvent(user_id=user_id, kind=kind, ip_address=ip, user_agent=agent, meta=meta)
    db.add(event)
    await db.flush()
    return event


async def is_new_device(db: AsyncSession, user_id: UUID, request: Request) -> bool:
    """A login from a user agent this account has never signed in with.

    Deliberately coarse. It will not catch an attacker on the same browser
    version, and that is fine - the point is the cheap, high-signal case of
    "a sign-in from a kind of device you do not own".
    """
    _, agent = _client(request)
    if not agent:
        return False
    seen = (
        await db.execute(
            select(SecurityEvent.id)
            .where(
                SecurityEvent.user_id == user_id,
                SecurityEvent.kind == "login",
                SecurityEvent.user_agent == agent,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    return seen is None


def describe_agent(agent: str | None) -> str:
    """ "Firefox on Linux" from a user agent string. Good enough to recognise
    your own devices; not a fingerprint."""
    if not agent:
        return "an unknown device"
    browser = next(
        (
            name
            for key, name in (
                ("Edg/", "Edge"),
                ("OPR/", "Opera"),
                ("Firefox/", "Firefox"),
                ("Chrome/", "Chrome"),
                ("Safari/", "Safari"),
            )
            if key in agent
        ),
        "a browser",
    )
    system = next(
        (
            name
            for key, name in (
                ("iPhone", "iPhone"),
                ("iPad", "iPad"),
                ("Android", "Android"),
                ("Mac OS X", "macOS"),
                ("Windows", "Windows"),
                ("CrOS", "ChromeOS"),
                ("Linux", "Linux"),
            )
            if key in agent
        ),
        "an unknown system",
    )
    return f"{browser} on {system}"


async def note_sign_in(db: AsyncSession, user_id: UUID, request: Request) -> list[UUID]:
    """Record a sign-in; if it is from a device this account has never used,
    tell the owner. Returns notification ids for the caller to deliver."""
    from app.notifications.service import notify

    new_device = await is_new_device(db, user_id, request)
    has_history = (
        await db.execute(
            select(SecurityEvent.id)
            .where(SecurityEvent.user_id == user_id, SecurityEvent.kind == "login")
            .limit(1)
        )
    ).scalar_one_or_none() is not None
    event = await record(db, user_id, "login", request)
    if new_device and has_history:
        nid = await notify(
            db,
            user_id,
            kind="new_sign_in",
            category="security",
            title="New sign-in to your PaceStreak account",
            body=f"From {describe_agent(event.user_agent)}. If this was not you, change your "
            "password and sign out everywhere.",
            url="/settings/security",
        )
        return [nid] if nid else []
    return []
