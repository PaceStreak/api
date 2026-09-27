"""HTML + plain-text multipart transactional email."""

import asyncio

from app.email import build_message, send_password_reset_email, send_verification_email


def test_build_message_is_multipart_alternative_with_text_and_html():
    message = build_message(
        "someone@example.com",
        "Subject",
        "plain body",
        html="<html><body>html body</body></html>",
    )
    assert message.is_multipart()
    parts = list(message.iter_parts())
    content_types = {part.get_content_type() for part in parts}
    assert content_types == {"text/plain", "text/html"}

    text_part = next(p for p in parts if p.get_content_type() == "text/plain")
    html_part = next(p for p in parts if p.get_content_type() == "text/html")
    assert text_part.get_content().strip() == "plain body"
    assert "html body" in html_part.get_content()


def test_build_message_without_html_stays_single_part():
    message = build_message("someone@example.com", "Subject", "plain body")
    assert not message.is_multipart()
    assert message.get_content().strip() == "plain body"


def test_verification_email_keeps_plain_text_security_wording(monkeypatch):
    sent: dict = {}

    async def fake_send_email(to, subject, body, headers=None, html=None):
        sent["to"] = to
        sent["subject"] = subject
        sent["body"] = body
        sent["html"] = html

    monkeypatch.setattr("app.email.send_email", fake_send_email)
    asyncio.run(send_verification_email("new@example.com", "123456"))

    assert sent["to"] == "new@example.com"
    assert "123456" in sent["body"]
    assert "If you did not create this account, ignore this message." in sent["body"]
    assert sent["html"] is not None
    # The HTML rendering spaces the digits out for legibility.
    assert "1 2 3 4 5 6" in sent["html"]
    assert "PaceStreak" in sent["html"]


def test_password_reset_email_html_has_matching_code(monkeypatch):
    sent: dict = {}

    async def fake_send_email(to, subject, body, headers=None, html=None):
        sent["body"] = body
        sent["html"] = html

    monkeypatch.setattr("app.email.send_email", fake_send_email)
    asyncio.run(send_password_reset_email("someone@example.com", "654321"))

    assert "654321" in sent["body"]
    assert "not changed" in sent["body"]
    assert "6 5 4 3 2 1" in sent["html"]
    assert "Reset your password" in sent["html"]


def test_html_template_escapes_untrusted_values():
    message = build_message(
        "someone@example.com",
        "Subject",
        "plain body",
        html="<html><body>&lt;script&gt;</body></html>",
    )
    html_part = next(p for p in message.iter_parts() if p.get_content_type() == "text/html")
    assert "<script>" not in html_part.get_content()
