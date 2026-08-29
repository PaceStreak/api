"""Operational health reporting.

This endpoint is deliberately **not** under `/v1`. It is an operational
concern, not part of the client-facing contract: when `/v2` ships, the uptime
monitor should not have to move, and `/v1` should not have to be kept alive
merely to answer a health check.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app import __version__

router = APIRouter(tags=["ops"])


class Health(BaseModel):
    """The health payload.

    `status` is asserted on by the uptime monitor in `PaceStreak/status`. A 200
    alone does not prove the service works - a container that boots and then
    fails to reach its database still answers 200 from a bare handler - so the
    monitor matches this body, which makes the field's shape part of the
    operational contract. Do not rename it without changing the monitor.
    """

    status: str = "ok"
    version: str = __version__


@router.get("/health", summary="Report service health")
async def health() -> Health:
    return Health()
