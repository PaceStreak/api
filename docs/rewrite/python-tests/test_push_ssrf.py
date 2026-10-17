"""The push endpoint is a URL the worker later requests, so it must never be
allowed to point at our own network (SSRF)."""

from app.common.net import is_safe_public_url
from tests.conftest import bearer, person


def test_internal_targets_are_rejected():
    for bad in [
        "https://169.254.169.254/latest/meta-data/",  # cloud metadata
        "https://127.0.0.1/x",
        "https://localhost/x",
        "https://10.0.0.5/x",
        "https://192.168.1.1/x",
        "http://fcm.googleapis.com/x",  # not https
        "https://[::1]/x",
        "not-a-url",
    ]:
        assert is_safe_public_url(bad) is False, bad


def test_a_public_literal_is_allowed():
    assert is_safe_public_url("https://8.8.8.8/push/abc") is True


def test_subscribe_refuses_an_internal_endpoint(client):
    token = person(client, "ssrf@example.com", "ssrf")
    r = client.post(
        "/v1/notifications/push/subscribe",
        json={"endpoint": "https://169.254.169.254/x", "keys": {"p256dh": "a", "auth": "b"}},
        headers=bearer(token),
    )
    # 422 when push is configured; 404 when it isn't - never 201 or a 500.
    assert r.status_code in (422, 404), r.text
