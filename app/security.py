"""Session cookie handling.

The rules below are not preferences. They follow from the deployment topology
(`ARCHITECTURE.md`) and were settled before this code existed, so they are
implemented once, here, and asserted in `tests/test_security.py` rather than
being restated in every handler that touches a cookie.
"""

from __future__ import annotations

from typing import Final

from fastapi import Response

from app.config import Settings

#: Cookies named with this prefix are required by the browser to be `Secure`
#: and to be set from a secure origin. The stricter `__Host-` prefix is *not*
#: usable here: it forbids a `Domain` attribute, and this cookie must carry one
#: to travel from app.pacestreak.com to api.pacestreak.com.
SECURE_PREFIX: Final = "__Secure-"

#: `Lax` is sufficient. app.pacestreak.com and api.pacestreak.com are different
#: origins but the *same site*, so the browser does not treat requests between
#: them as cross-site. `None` would be needed only for a genuinely cross-site
#: caller, and would widen exposure for no benefit here.
SAME_SITE: Final = "lax"


def set_session_cookie(
    response: Response,
    settings: Settings,
    *,
    value: str,
    max_age: int,
) -> None:
    """Attach the session cookie to `response`.

    Every call site goes through this function so the attributes cannot drift.
    """
    response.set_cookie(
        key=settings.cookie_name,
        value=value,
        max_age=max_age,
        domain=settings.cookie_domain,
        path="/",
        secure=True,
        httponly=True,
        samesite=SAME_SITE,
    )


def clear_session_cookie(response: Response, settings: Settings) -> None:
    """Expire the session cookie.

    The domain and path must match those used when the cookie was set, or the
    browser silently keeps the original cookie and the user stays signed in.
    """
    response.delete_cookie(
        key=settings.cookie_name,
        domain=settings.cookie_domain,
        path="/",
        secure=True,
        httponly=True,
        samesite=SAME_SITE,
    )
