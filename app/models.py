"""Imports every model module so Base.metadata knows every table.

Alembic's env.py imports this one file; adding a feature area means adding
its models here, once, rather than remembering to touch env.py.
"""

import app.account.models  # noqa: F401
import app.auth.models  # noqa: F401
import app.game.models  # noqa: F401
import app.groups.models  # noqa: F401
import app.notifications.models  # noqa: F401
import app.profile.models  # noqa: F401
import app.social.models  # noqa: F401
import app.training.models  # noqa: F401
