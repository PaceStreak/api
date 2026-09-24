"""One-click email unsubscribe (RFC 8058).

The link carries a signed, category-scoped token, so it works from a mail
client with no session and cannot be used to change anything except that one
category's email switch.
"""

import hashlib
import hmac
from uuid import UUID

from app.config import get_settings

settings = get_settings()


def _secret() -> bytes:
    # Derived from the JWT private key rather than a new secret to manage:
    # rotating the signing key rotates these too, which is the right coupling.
    return hashlib.sha256(b"unsubscribe:" + settings.jwt_private_key.encode()).digest()


def sign(user_id: UUID, category: str) -> str:
    message = f"{user_id}:{category}".encode()
    return hmac.new(_secret(), message, hashlib.sha256).hexdigest()[:32]


def verify(user_id: UUID, category: str, signature: str) -> bool:
    return hmac.compare_digest(sign(user_id, category), signature)


def unsubscribe_link(user_id: UUID, category: str) -> str:
    return (
        f"{settings.frontend_url}/unsubscribe?u={user_id}&c={category}&s={sign(user_id, category)}"
    )
