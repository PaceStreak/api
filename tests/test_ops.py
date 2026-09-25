"""Operator tooling and delivery plumbing: the admin CLI, key loading,
outgoing mail headers and RFC 8058 one-click unsubscribe."""

import pytest

from app import cli
from app.config import _read_key
from app.email import build_message
from app.notifications import unsubscribe
from tests.conftest import bearer, person


def test_pem_from_environment_is_unescaped_and_cached():
    flat = "-----BEGIN KEY-----\\nabc\\n-----END KEY-----"
    key = _read_key(flat, "/nonexistent")
    assert key == "-----BEGIN KEY-----\nabc\n-----END KEY-----\n"
    assert _read_key(flat, "/nonexistent") is key


def test_outgoing_mail_carries_the_headers_providers_expect():
    message = build_message("someone@example.com", "Hello", "Body", {"List-Unsubscribe-Post": "x"})
    assert message["From"].addresses[0].display_name == "PaceStreak"
    assert message["Message-ID"] and message["Date"]
    assert message["Auto-Submitted"] == "auto-generated"
    assert message["List-Unsubscribe-Post"] == "x"


def test_one_click_unsubscribe(client):
    token = person(client, "mail@example.com", "mailer")
    me = client.get("/v1/me", headers=bearer(token)).json()["user"]["id"]
    headers = unsubscribe.list_headers(me, "digest")
    assert headers["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"
    url = headers["List-Unsubscribe"].split(">")[0].lstrip("<")
    path = url.split("://", 1)[1].split("/", 1)[1]
    ok = client.post("/" + path, data={"List-Unsubscribe": "One-Click"})
    assert ok.status_code == 200, ok.text
    forged = client.post("/" + path.replace("s=", "s=0"), data={})
    assert forged.status_code == 400


def test_cli_refuses_short_passwords(monkeypatch):
    monkeypatch.setenv("PACESTREAK_PASSWORD", "short")
    with pytest.raises(SystemExit, match="16"):
        cli._password()
