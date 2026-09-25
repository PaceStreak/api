import asyncio
from datetime import UTC, datetime

from sqlalchemy import update

from app import cache
from app.auth.cache import invalidate_user
from app.auth.models import User, UserRole
from app.cache import close_cache
from app.database import AsyncSessionLocal, engine
from app.worker import streak_nudges, weekly_digest
from tests.conftest import bearer, person
from tests.test_social import log_session


def run(coro_fn):
    async def go():
        # Drop connections owned by the TestClient's loop - database and Redis.
        # The Redis pool is detached rather than closed: closing it would have
        # to run on the loop that owns it. The TestClient re-creates one lazily.
        await engine.dispose()
        cache._pool = None
        try:
            return await coro_fn()
        finally:
            await engine.dispose()
            await close_cache()

    return asyncio.run(go())


def test_streak_at_risk_nudge_fires_once_at_the_reminder_hour(client):
    token = person(client, "risk@example.com", "risky", weekly_target=7)
    hour = datetime.now(UTC).hour
    client.patch("/v1/me/profile", json={"reminder_hour": hour}, headers=bearer(token))
    log_session(client, token)

    first = run(streak_nudges)
    second = run(streak_nudges)
    assert len(first) == 1
    assert second == []  # de-duplicated

    inbox = client.get("/v1/notifications", headers=bearer(token)).json()["items"]
    risk = [n for n in inbox if n["kind"] == "streak_risk"]
    assert len(risk) == 1
    # The nudge always carries the off-ramp.
    assert "repair" in risk[0]["body"] or "freeze" in risk[0]["body"]


def test_no_nudge_outside_the_reminder_hour(client):
    token = person(client, "calm@example.com", "calm", weekly_target=7)
    hour = (datetime.now(UTC).hour + 5) % 24
    client.patch("/v1/me/profile", json={"reminder_hour": hour}, headers=bearer(token))
    log_session(client, token)
    assert run(streak_nudges) == []


def test_digest_is_quiet_without_history(client):
    person(client, "digest@example.com", "digester")
    assert run(weekly_digest) == []


def test_health_endpoints(client):
    assert client.get("/health").json() == {"status": "healthy"}
    ready = client.get("/health/ready")
    assert ready.status_code == 200
    assert ready.json()["checks"]["database"] == "ok"

    # No tick yet: the status page should say so, loudly.
    assert client.get("/health/worker").status_code == 503

    from app.worker import tick

    run(tick)
    worker = client.get("/health/worker")
    assert worker.status_code == 200
    assert worker.json()["status"] == "ok"
    # Job names and errors are admin-only, never on the public endpoint.
    assert "jobs" not in worker.json()


def test_a_failing_job_is_reported_and_counted(client, monkeypatch):
    import app.worker as worker

    async def broken():
        raise RuntimeError("boom")

    monkeypatch.setattr(worker, "housekeeping", broken)
    run(worker.tick)
    # The lock from the first tick would skip the second; clear it.
    run(lambda: worker.get_client().delete("worker:tick"))
    run(worker.tick)

    admin = person(client, "ops@example.com", "opsadmin")

    async def promote():
        async with AsyncSessionLocal() as db:
            user = (
                await db.execute(
                    update(User)
                    .where(User.email == "ops@example.com")
                    .values(role=UserRole.ADMIN)
                    .returning(User.id)
                )
            ).scalar_one()
            await db.commit()
        await invalidate_user(user)

    run(promote)
    metrics = client.get("/v1/admin/metrics", headers=bearer(admin))
    assert metrics.status_code == 200, metrics.text
    state = metrics.json()["worker"]
    assert state["jobs"]["housekeeping"] == {"error": "RuntimeError"}
    assert state["jobs"]["stats"] == {"result": 0}
    assert state["failing_ticks"] == 2


def test_monthly_backup_reminder_is_opt_in_and_monthly(client, monkeypatch):
    from sqlalchemy import true

    import app.worker as worker

    opted = person(client, "backup@example.com", "backer")
    person(client, "nobackup@example.com", "nobacker")
    client.put(
        "/v1/notifications/preferences",
        json={"channels": {"backup": {"email": True}}},
        headers=bearer(opted),
    )
    # Pin "now" to 09:00 on the 1st, whatever the real clock says.
    monkeypatch.setattr(worker, "_local_hour_is", lambda _column: true())
    monkeypatch.setattr(worker, "local_now", lambda _tz: datetime(2026, 10, 1, 9, 5, tzinfo=UTC))

    first = run(worker.monthly_backup)
    again = run(worker.monthly_backup)
    assert len(first) == 1  # only the person who opted in
    assert again == []  # once per month

    inbox = client.get("/v1/notifications", headers=bearer(opted)).json()
    items = inbox["items"] if isinstance(inbox, dict) else inbox
    note = next(n for n in items if n["kind"] == "monthly_backup")
    # A link into the app, never a download token.
    assert note["url"] == "/settings/data?backup=1"

    monkeypatch.setattr(worker, "local_now", lambda _tz: datetime(2026, 10, 2, 9, 5, tzinfo=UTC))
    assert run(worker.monthly_backup) == []
