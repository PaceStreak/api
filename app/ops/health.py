"""Health endpoints, unversioned so a monitor's URL never changes.

- /health          liveness: the process answers. Used by the container
                   healthcheck, so it must never touch a dependency - a slow
                   database must not get a healthy API container restarted.
- /health/ready    readiness: Postgres answers (hard requirement) and Redis
                   answers (reported, not required - it is best-effort here).
- /health/worker   the scheduler ticked recently. A separate URL so the status
                   page can show "reminders delayed" without calling the API
                   down.

None of them say anything a stranger could use: no versions, no hostnames,
no error text.
"""

from datetime import timedelta

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import select, text

from app.cache import get_client
from app.common.time import utcnow
from app.config import get_settings
from app.database import AsyncSessionLocal
from app.ops.models import WorkerHeartbeat

router = APIRouter(prefix="/health", tags=["health"])
settings = get_settings()

WORKER_NAME = "scheduler"


def worker_stale_after() -> timedelta:
    # Three missed ticks. One late tick is a slow job; three is a dead worker.
    return timedelta(seconds=max(180, settings.worker_interval_seconds * 3))


@router.get("")
async def live():
    return {"status": "healthy"}


@router.get("/ready")
async def ready():
    checks: dict[str, str] = {}
    try:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:
        checks["database"] = "down"
    try:
        await get_client().ping()
        checks["cache"] = "ok"
    except Exception:
        checks["cache"] = "degraded"
    ok = checks["database"] == "ok"
    return JSONResponse(
        {"status": "ready" if ok else "unavailable", "checks": checks},
        status_code=200 if ok else 503,
    )


async def worker_state() -> dict:
    async with AsyncSessionLocal() as db:
        beat = (
            await db.execute(select(WorkerHeartbeat).where(WorkerHeartbeat.name == WORKER_NAME))
        ).scalar_one_or_none()
    if beat is None:
        return {"status": "never_ran", "last_tick_at": None}
    age = utcnow() - beat.last_tick_at
    return {
        "status": "stale" if age > worker_stale_after() else "ok",
        "last_tick_at": beat.last_tick_at.isoformat(),
        "age_seconds": int(age.total_seconds()),
        "duration_ms": beat.duration_ms,
        "failing_ticks": beat.failing_ticks,
        "jobs": beat.jobs,
    }


@router.get("/worker")
async def worker():
    try:
        state = await worker_state()
    except Exception:
        return JSONResponse({"status": "unknown"}, status_code=503)
    ok = state["status"] == "ok"
    # Only the verdict and age: job names and errors are for the admin panel.
    return JSONResponse(
        {"status": state["status"], "age_seconds": state.get("age_seconds")},
        status_code=200 if ok else 503,
    )
