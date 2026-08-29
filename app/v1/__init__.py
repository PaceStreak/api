"""Version 1 of the public API.

Every client-facing route is mounted under `/v1`. The prefix exists from the
first endpoint on purpose: retrofitting a version onto URLs that clients
already call is far more expensive than carrying one from the start.

The router is currently empty. Add route modules here and include them below.
"""

from fastapi import APIRouter

router = APIRouter(prefix="/v1")

__all__ = ["router"]
