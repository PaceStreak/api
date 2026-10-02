"""Merging one account into another."""

import asyncio

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from app.config import get_settings
from tests.conftest import bearer, person
from tests.test_features import forget_cached_user, make_role
from tests.test_social import log_session


def _admin(client, email="boss@example.com", handle="bossy"):
    token = person(client, email, handle)
    make_role(email, "admin")
    forget_cached_user(client.get("/v1/me", headers=bearer(token)).json()["user"]["id"])
    return bearer(token)


def _id(client, token):
    return client.get("/v1/me", headers=bearer(token)).json()["user"]["id"]


def test_merge_moves_data_drops_self_links_and_credentials(client):
    old = person(client, "old@example.com", "oldme")
    new = person(client, "new@example.com", "newme")
    log_session(client, old)
    log_session(client, old)
    log_session(client, new)
    client.post("/v1/people/newme/follow", headers=bearer(old))
    client.post("/v1/people/oldme/follow", headers=bearer(new))
    old_id, new_id = _id(client, old), _id(client, new)
    admin = _admin(client)

    wrong = client.post(
        f"/v1/admin/users/{old_id}/merge",
        json={"into": new_id, "confirm_email": "new@example.com"},
        headers=admin,
    )
    assert wrong.status_code == 422

    done = client.post(
        f"/v1/admin/users/{old_id}/merge",
        json={"into": new_id, "confirm_email": "OLD@example.com"},
        headers=admin,
    )
    assert done.status_code == 200, done.text
    assert done.json()["moved"]["workouts"] == 2

    me = client.get("/v1/me/stats", headers=bearer(new))
    assert me.status_code == 200
    workouts = client.get("/v1/workouts/changes?since=0", headers=bearer(new)).json()
    assert len([w for w in workouts["workouts"] if not w.get("deleted_at")]) == 3
    # The old login is gone, and its sessions did not follow the data.
    assert client.get("/v1/me", headers=bearer(old)).status_code == 401
    # No one follows themselves.
    assert _scalar("select count(*) from follows where follower_id = followee_id") == 0
    assert _scalar(f"select count(*) from refresh_tokens where user_id = '{old_id}'") == 0
    assert _scalar(f"select count(*) from users where id = '{old_id}'") == 0


def test_merge_refuses_itself_and_the_acting_admin(client):
    admin = _admin(client)
    admin_id = client.get("/v1/me", headers=admin).json()["user"]["id"]
    other = _id(client, person(client, "x@example.com", "xavier"))
    same = client.post(
        f"/v1/admin/users/{other}/merge",
        json={"into": other, "confirm_email": "x@example.com"},
        headers=admin,
    )
    assert same.status_code == 422
    me = client.post(
        f"/v1/admin/users/{admin_id}/merge",
        json={"into": other, "confirm_email": "boss@example.com"},
        headers=admin,
    )
    assert me.status_code == 409


def _scalar(sql: str):
    async def go():
        engine = create_async_engine(get_settings().database_url, poolclass=NullPool)
        async with engine.connect() as conn:
            value = (await conn.execute(text(sql))).scalar()
        await engine.dispose()
        return value

    return asyncio.run(go())
