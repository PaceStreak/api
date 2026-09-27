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

import html as _html
import logging
import smtplib
import ssl
import time
from email.headerregistry import Address
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

import anyio

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# Hosted on www.pacestreak.com (live), not app.pacestreak.com (not deployed
# yet - see CLAUDE.md topology). A PNG, not the SVG mark: SVG support in email
# clients is poor, and this file is already published as a static asset.
_LOGO_URL = "https://www.pacestreak.com/brand/logo-512.png"

# Failures worth retrying: the connection dropped, the server was busy, or it
# answered with a 4xx "try again later". A 5xx (bad address, auth refused) is
# permanent and retrying it only delays the log line that explains it.
_TRANSIENT = (smtplib.SMTPServerDisconnected, smtplib.SMTPConnectError, TimeoutError, OSError)


def build_message(
    to: str,
    subject: str,
    body: str,
    headers: dict[str, str] | None = None,
    html: str | None = None,
):
    """Build the message. `body` is always the plain-text part.

    When `html` is given the message becomes multipart/alternative with the
    HTML as the second, preferred part - plain text stays first and is what
    a client falls back to if it can't (or won't) render HTML. When `html`
    is omitted the message is single-part text, unchanged from before.
    """
    message = EmailMessage()
    local, _, domain = settings.email_from.partition("@")
    message["From"] = Address(settings.email_from_name, local, domain)
    message["To"] = to
    message["Subject"] = subject
    message["Date"] = formatdate(localtime=False, usegmt=True)
    message["Message-ID"] = make_msgid(domain=domain or None)
    if settings.email_reply_to:
        message["Reply-To"] = settings.email_reply_to
    # Automated mail: tells well-behaved auto-responders not to reply to it.
    message["Auto-Submitted"] = "auto-generated"
    for key, value in (headers or {}).items():
        message[key] = value
    message.set_content(body)
    if html is not None:
        message.add_alternative(html, subtype="html")
    return message


def _deliver(message: EmailMessage) -> None:
    context = ssl.create_default_context()
    timeout = settings.smtp_timeout_seconds
    if settings.smtp_ssl:
        server = smtplib.SMTP_SSL(
            settings.smtp_host, settings.smtp_port, timeout=timeout, context=context
        )
    else:
        server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=timeout)
    with server as smtp:
        if settings.smtp_starttls and not settings.smtp_ssl:
            smtp.starttls(context=context)
        if settings.smtp_user and settings.smtp_password:
            smtp.login(settings.smtp_user, settings.smtp_password)
        smtp.send_message(message)


def _send_smtp(message: EmailMessage) -> None:
    attempts = max(1, settings.smtp_attempts)
    for attempt in range(1, attempts + 1):
        try:
            _deliver(message)
            return
        except smtplib.SMTPResponseException as error:
            if not 400 <= error.smtp_code < 500 or attempt == attempts:
                raise
        except _TRANSIENT:
            if attempt == attempts:
                raise
        # 1s, 2s, 4s: enough to ride out a blip without holding a thread for long.
        time.sleep(2 ** (attempt - 1))


async def send_email(
    to: str,
    subject: str,
    body: str,
    headers: dict[str, str] | None = None,
    html: str | None = None,
) -> None:
    try:
        if settings.email_backend == "smtp":
            message = build_message(to, subject, body, headers, html=html)
            # smtplib is blocking; keep it off the event loop.
            await anyio.to_thread.run_sync(_send_smtp, message)
        else:
            # Console backend logs the plain-text part only - readable in a
            # terminal, and it's the same wording the HTML part carries.
            logger.info("[email:console] to=%s subject=%s\n%s", to, subject, body)
    except Exception:
        # The address is deliberately not logged at error level with the body:
        # the body can hold a live reset link.
        logger.exception("failed to send email (subject=%s)", subject)


# ---------------------------------------------------------------------------
# HTML template
# ---------------------------------------------------------------------------
#
# Table-based, fully inline-styled, no external stylesheet or webfont - email
# clients strip <style>/<link> inconsistently and can't load arbitrary web
# fonts, so this deliberately does not reference the self-hosted Archivo used
# on web/app. Near-black text on white; lime (#d3ff3e) appears only as the
# button's background (with dark text on top, for contrast) and a thin top
# accent bar - never as body or link-colored text on the light background,
# since lime-on-white text fails contrast.

_FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
_INK = "#16161a"  # near-black body text
_DIM = "#5a5a63"  # muted secondary text, checked against white for contrast
_LIME = "#d3ff3e"
_BORDER = "#e7e7ea"


def _button_html(text: str, url: str) -> str:
    safe_text = _html.escape(text)
    safe_url = _html.escape(url, quote=True)
    return f"""
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
      <tr>
        <td style="border-radius:8px;background-color:{_LIME};">
          <a href="{safe_url}" target="_blank"
             style="display:inline-block;padding:14px 28px;font-family:{_FONT_STACK};
                    font-size:16px;font-weight:700;color:{_INK};text-decoration:none;
                    border-radius:8px;">
            {safe_text}
          </a>
        </td>
      </tr>
    </table>"""


def _html_template(
    *,
    preheader: str,
    heading: str,
    body_html: str,
    button_text: str | None = None,
    button_url: str | None = None,
    footer_note: str | None = None,
) -> str:
    """Wrap per-message content into the shared layout.

    `body_html` is a sequence of already-safe <p> blocks (callers escape any
    interpolated values themselves); `footer_note` is an optional extra line
    for messages whose recipient may not have an account yet (verification).
    """
    button = _button_html(button_text, button_url) if button_text and button_url else ""
    extra_note = (
        f'<p style="margin:0 0 8px;font-family:{_FONT_STACK};font-size:12px;'
        f'line-height:18px;color:{_DIM};">{footer_note}</p>'
        if footer_note
        else ""
    )
    safe_preheader = _html.escape(preheader)
    safe_heading = _html.escape(heading)
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{safe_heading}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f4f5;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
      {safe_preheader}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background-color:#f4f4f5;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
                 style="max-width:600px;width:100%;background-color:#ffffff;
                        border:1px solid {_BORDER};border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background-color:{_LIME};height:4px;line-height:4px;font-size:0;">
                &nbsp;</td>
            </tr>
            <tr>
              <td style="padding:28px 32px 0;">
                <img src="{_LOGO_URL}" width="36" height="36" alt="PaceStreak"
                     style="display:block;height:36px;width:36px;border:0;">
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 8px;">
                <h1 style="margin:0;font-family:{_FONT_STACK};font-size:20px;
                           line-height:28px;color:{_INK};font-weight:700;">
                  {safe_heading}
                </h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 4px;font-family:{_FONT_STACK};font-size:15px;
                         line-height:23px;color:{_INK};">
                {body_html}
                {button}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 28px;border-top:1px solid {_BORDER};margin-top:8px;">
                <p style="margin:20px 0 8px;font-family:{_FONT_STACK};font-size:14px;
                          line-height:20px;color:{_INK};">
                  &mdash; PaceStreak
                </p>
                {extra_note}
                <p style="margin:0;font-family:{_FONT_STACK};font-size:12px;
                          line-height:18px;color:{_DIM};">
                  Automated, transactional message from
                  <a href="https://www.pacestreak.com" style="color:{_DIM};">pacestreak.com</a>.
                  You don't need to reply.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>"""


def _p(text: str) -> str:
    """Escape and wrap one paragraph of already-plain text."""
    return f'<p style="margin:0 0 16px;">{_html.escape(text)}</p>'


# ---------------------------------------------------------------------------
# Message templates
# ---------------------------------------------------------------------------
#
# The raw code is a plain 6-digit number, typed back into app.pacestreak.com
# rather than clicked from a link. Only the digest is stored server-side, so
# this email is the only place the code ever exists in readable form.


def _code_html(code: str) -> str:
    """A large, monospaced rendering of a 6-digit code for the HTML email."""
    spaced = " ".join(code)
    return (
        '<p style="margin:0 0 16px;text-align:center;">'
        f'<span style="display:inline-block;padding:12px 20px;font-family:monospace;'
        f'font-size:28px;letter-spacing:4px;font-weight:bold;">{spaced}</span></p>'
    )


async def send_verification_email(to: str, code: str) -> None:
    subject = f"Confirm your {settings.app_name} email address"
    text = (
        f"Your verification code is: {code}\n\n"
        f"Enter it in the app to confirm your address. It expires in "
        f"{settings.email_verify_token_hours} hours.\n"
        "If you did not create this account, ignore this message."
    )
    html = _html_template(
        preheader="Your PaceStreak verification code.",
        heading="Confirm your email address",
        body_html=_p("Enter this code in the app to confirm your address.")
        + _code_html(code)
        + _p(
            f"This code expires in {settings.email_verify_token_hours} hours. "
            "If you did not create this account, ignore this message."
        ),
        footer_note="You're receiving this because someone used this address on PaceStreak.",
    )
    await send_email(to, subject, text, html=html)


async def send_password_reset_email(to: str, code: str) -> None:
    subject = f"Reset your {settings.app_name} password"
    text = (
        f"Your password reset code is: {code}\n\n"
        f"Enter it in the app to choose a new password. It expires in "
        f"{settings.password_reset_token_minutes} minutes and can be used once.\n"
        "If you did not request this, ignore this message - your password has "
        "not changed."
    )
    html = _html_template(
        preheader="Your PaceStreak password reset code.",
        heading="Reset your password",
        body_html=_p("Enter this code in the app to choose a new password.")
        + _code_html(code)
        + _p(
            f"This code expires in {settings.password_reset_token_minutes} minutes and "
            "can be used once. If you did not request this, ignore this message - your "
            "password has not changed."
        ),
    )
    await send_email(to, subject, text, html=html)


async def send_password_changed_email(to: str) -> None:
    """Sent after any password change, including a reset.

    Not a courtesy: this is how a person finds out their account was taken
    over when the attacker changed the password but not the email address.
    """
    subject = f"Your {settings.app_name} password was changed"
    text = (
        "Your password was just changed and all other sessions were signed "
        "out.\n\nIf this was not you, reset your password immediately."
    )
    html = _html_template(
        preheader="Your PaceStreak password was just changed.",
        heading="Your password was changed",
        body_html=_p("Your password was just changed and all other sessions were signed out.")
        + _p("If this was not you, reset your password immediately."),
        button_text="Reset password",
        button_url=f"{settings.frontend_url}/reset-password",
    )
    await send_email(to, subject, text, html=html)


async def send_email_change_email(to: str, code: str) -> None:
    subject = f"Confirm your new {settings.app_name} email address"
    text = (
        f"Your confirmation code is: {code}\n\n"
        f"Enter it in the app to use this address for your {settings.app_name} account. "
        f"It expires in {settings.email_change_token_hours} hours.\n"
        "If you didn't ask for this, ignore this message; nothing has changed."
    )
    html = _html_template(
        preheader=f"Confirm this address for your {settings.app_name} account.",
        heading="Confirm your new email address",
        body_html=_p(
            f"Enter this code in the app to use this address for your {settings.app_name} account."
        )
        + _code_html(code)
        + _p(
            f"This code expires in {settings.email_change_token_hours} hours. If you "
            "didn't ask for this, ignore this message; nothing has changed."
        ),
    )
    await send_email(to, subject, text, html=html)


async def send_email_changed_notice(old: str, new: str) -> None:
    """To the old address: the only warning someone gets if their account
    was moved away from them."""
    subject = f"Your {settings.app_name} email address was changed"
    text = (
        f"Your account now uses {new}. If this wasn't you, reply to this email "
        "straight away and we will help you get it back."
    )
    html = _html_template(
        preheader="Your PaceStreak account email address was changed.",
        heading="Your email address was changed",
        body_html=_p(f"Your account now uses {new}.")
        + _p(
            "If this wasn't you, reply to this email straight away and we will help "
            "you get it back."
        ),
    )
    await send_email(old, subject, text, html=html)
