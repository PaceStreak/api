"""The export as an email attachment, for people who opted in to that.

Zipped JSON - the same document GET /v1/me/export?format=json returns - so
it imports straight back with POST /v1/me/import. Capped well under common
mailbox limits (Gmail: 25 MB): an export too big to attach falls back to
the reminder-with-a-link email rather than bouncing.
"""

import io
import json
import zipfile
from datetime import date
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024


async def export_attachment(db: AsyncSession, user_id: UUID) -> tuple[str, bytes, str] | None:
    from app.account.router import build_export

    user = await db.get(User, user_id)
    if user is None:
        return None
    data = json.dumps(await build_export(db, user), default=str, ensure_ascii=False).encode()
    name = f"pacestreak-export-{date.today():%Y-%m}"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{name}.json", data)
    blob = buffer.getvalue()
    if len(blob) > MAX_ATTACHMENT_BYTES:
        return None
    return f"{name}.zip", blob, "application/zip"
