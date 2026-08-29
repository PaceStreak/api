"""The session cookie attributes are a documented constraint, so assert them.

Every rule checked here is stated in README.md and ARCHITECTURE.md. Without
these tests those documents are the only thing holding the rules in place, and
a plausible-looking `set_cookie` call elsewhere would quietly break them.
"""

from __future__ import annotations

from http.cookies import SimpleCookie

from fastapi import Response

from app.config import Settings
from app.security import clear_session_cookie, set_session_cookie


def _set_cookie_attrs(settings: Settings) -> SimpleCookie:
    response = Response()
    set_session_cookie(response, settings, value="opaque-session-id", max_age=3600)
    jar: SimpleCookie = SimpleCookie()
    jar.load(response.headers["set-cookie"])
    return jar


def test_cookie_uses_the_secure_prefix(settings: Settings) -> None:
    """`__Secure-` is the strongest prefix available given the Domain attribute.

    `__Host-` would be stronger but forbids Domain, and this cookie must span
    app.pacestreak.com and api.pacestreak.com.
    """
    assert settings.cookie_name.startswith("__Secure-")
    assert not settings.cookie_name.startswith("__Host-")


def test_cookie_is_scoped_to_the_registrable_domain(settings: Settings) -> None:
    jar = _set_cookie_attrs(settings)

    assert jar[settings.cookie_name]["domain"] == "pacestreak.com"


def test_cookie_is_secure_httponly_and_lax(settings: Settings) -> None:
    morsel = _set_cookie_attrs(settings)[settings.cookie_name]

    assert morsel["secure"]
    assert morsel["httponly"]
    # Lax, not None: the two hosts are same-site, so None would widen exposure
    # without enabling anything.
    assert morsel["samesite"].lower() == "lax"


def test_clearing_matches_the_domain_and_path_used_to_set(settings: Settings) -> None:
    """A mismatched domain or path leaves the original cookie in the browser.

    The user appears to stay signed in and the bug looks like a session bug.
    """
    set_response = Response()
    set_session_cookie(set_response, settings, value="opaque", max_age=3600)
    clear_response = Response()
    clear_session_cookie(clear_response, settings)

    set_jar: SimpleCookie = SimpleCookie()
    set_jar.load(set_response.headers["set-cookie"])
    clear_jar: SimpleCookie = SimpleCookie()
    clear_jar.load(clear_response.headers["set-cookie"])

    set_morsel = set_jar[settings.cookie_name]
    clear_morsel = clear_jar[settings.cookie_name]

    assert clear_morsel["domain"] == set_morsel["domain"]
    assert clear_morsel["path"] == set_morsel["path"]
