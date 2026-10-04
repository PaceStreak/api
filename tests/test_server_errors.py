"""An unhandled error must still carry CORS headers, or the browser hides
the 500 and the app reports the server as unreachable."""

from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app


def test_a_500_still_carries_cors_headers():
    app = create_app()

    @app.get("/v1/_boom")
    async def boom():
        raise RuntimeError("boom")

    origin = get_settings().cors_origin_list[0]
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get("/v1/_boom", headers={"Origin": origin})
    assert r.status_code == 500
    assert r.headers.get("access-control-allow-origin") == origin
    assert "detail" in r.json()


def test_a_lost_unique_race_is_a_409():
    from sqlalchemy.exc import IntegrityError

    app = create_app()

    @app.get("/v1/_race")
    async def race():
        raise IntegrityError("insert", {}, Exception("duplicate key"))

    with TestClient(app, raise_server_exceptions=False) as c:
        assert c.get("/v1/_race").status_code == 409
