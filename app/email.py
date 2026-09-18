"""Outbound email.

Two backends, chosen by EMAIL_BACKEND:

  console  logs the message (including the link) instead of sending it. The
           default, so a fresh checkout works with no mail provider.
  smtp     sends via the SMTP_* settings.

No third-party email API is wired in here on purpose - see CLAUDE.md on
staying on Cloudflare's free tier with no third-party services. SMTP is a
protocol, not a vendor, so this backend works against any provider the owner
later picks without changing this file.

Sending is best-effort and never raises into a request handler. A mail outage
must not turn "we sent you a link" into a 500 - the caller has already
committed its database work by the time we get here, and the user can always
ask for another link.
"""

import logging
import smtplib
from email.message import EmailMessage

import anyio

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


def _send_smtp(to: str, subject: str, body: str) -> None:
    message = EmailMessage()
    message["From"] = settings.email_from
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)

    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
        if settings.smtp_starttls:
            smtp.starttls()
        if settings.smtp_user and settings.smtp_password:
            smtp.login(settings.smtp_user, settings.smtp_password)
        smtp.send_message(message)


async def send_email(to: str, subject: str, body: str) -> None:
    try:
        if settings.email_backend == "smtp":
            # smtplib is blocking; keep it off the event loop.
            await anyio.to_thread.run_sync(_send_smtp, to, subject, body)
        else:
            logger.info("[email:console] to=%s subject=%s\n%s", to, subject, body)
    except Exception:
        logger.exception("failed to send email to %s (subject=%s)", to, subject)


# ---------------------------------------------------------------------------
# Message templates
# ---------------------------------------------------------------------------
#
# The raw token is placed in a URL pointing at app.pacestreak.com, which posts
# it back to this API. Only the digest is stored server-side, so this email is
# the only place the token ever exists in readable form.


async def send_verification_email(to: str, token: str) -> None:
    link = f"{settings.frontend_url}/verify-email?token={token}"
    await send_email(
        to,
        f"Confirm your {settings.app_name} email address",
        f"Confirm your address by opening this link:\n\n{link}\n\n"
        f"The link expires in {settings.email_verify_token_hours} hours.\n"
        "If you did not create this account, ignore this message.",
    )


async def send_password_reset_email(to: str, token: str) -> None:
    link = f"{settings.frontend_url}/reset-password?token={token}"
    await send_email(
        to,
        f"Reset your {settings.app_name} password",
        f"Reset your password by opening this link:\n\n{link}\n\n"
        f"The link expires in {settings.password_reset_token_minutes} minutes "
        "and can be used once.\n"
        "If you did not request this, ignore this message - your password has "
        "not changed.",
    )


async def send_password_changed_email(to: str) -> None:
    """Sent after any password change, including a reset.

    Not a courtesy: this is how a person finds out their account was taken
    over when the attacker changed the password but not the email address.
    """
    await send_email(
        to,
        f"Your {settings.app_name} password was changed",
        "Your password was just changed and all other sessions were signed "
        "out.\n\nIf this was not you, reset your password immediately.",
    )
