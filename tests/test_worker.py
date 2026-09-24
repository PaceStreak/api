import asyncio
from datetime import UTC, datetime

from app.database import engine
from app.worker import streak_nudges, weekly_digest
from tests.conftest import bearer, person
from tests.test_social import log_session


def run(coro_fn):
    async def go():
        await engine.dispose()  # drop connections owned by the TestClient's loop
        try:
            return await coro_fn()
        finally:
            await engine.dispose()

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
