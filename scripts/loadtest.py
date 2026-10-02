"""A small load test: signed-in users doing what the app does all day.

Each virtual user signs in once, then loops through opening the app (/me,
stats, habits), syncing (the change feed), logging a session, and reading
the feed. Reports throughput, latency percentiles per endpoint, and every
non-2xx status, so the first thing that breaks is obvious.

    # Against the local stack (make dev), with limits raised for test accounts:
    RATE_LIMIT_SIGNUP=1000/minute RATE_LIMIT_LOGIN=1000/minute \\
      TURNSTILE_SECRET_KEY= EMAIL_BACKEND=console docker compose up -d api
    uv run python scripts/loadtest.py --users 20 --seconds 60

Accounts are made through signup with console email, so it needs the
verification codes in the API log (docker compose logs). Never point this at
production: its accounts, rate limits and free-tier quotas are real.
Production gets --health-only, a gentle read of /health.
"""

import argparse
import asyncio
import re
import statistics
import subprocess
import time
import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta

import httpx

PASSWORD = "load-test-password-long-enough"


def code_for(email: str) -> str:
    for _ in range(40):
        log = subprocess.run(
            ["docker", "compose", "logs", "--since", "10m", "api"], capture_output=True, text=True
        ).stdout
        at = log.rfind(email)
        if at >= 0 and (m := re.search(r"\b(\d{6})\b", log[at + len(email) :])):
            return m.group(1)
        time.sleep(0.25)
    raise RuntimeError(f"no code for {email}")


async def setup_post(client: httpx.AsyncClient, path: str, **kw) -> httpx.Response:
    """Account setup goes through the real per-IP limits (verification is
    10 a minute), so wait them out rather than failing."""
    while True:
        r = await client.post(path, **kw)
        if r.status_code != 429:
            return r
        print(f"  {path} rate-limited; waiting a minute (the limit is doing its job)")
        await asyncio.sleep(61)


async def make_user(client: httpx.AsyncClient, i: int) -> str:
    tag = f"load{uuid.uuid4().hex[:10]}"
    email = f"{tag}@example.com"
    await setup_post(client, "/auth/signup", json={"email": email, "password": PASSWORD})
    code = await asyncio.to_thread(code_for, email)
    verified = await setup_post(client, "/auth/verify-email", json={"email": email, "code": code})
    if verified.status_code != 200:
        raise SystemExit(
            f"Verifying a test account failed: {verified.status_code} {verified.text[:200]}"
        )
    login = await setup_post(client, "/auth/login", json={"email": email, "password": PASSWORD})
    if login.status_code != 200:
        raise SystemExit(f"Login for a test account failed: {login.status_code} {login.text[:200]}")
    token = login.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    await client.post(
        "/me/onboarding",
        json={"handle": tag, "birth_year": 1990, "accept_terms": True},
        headers=headers,
    )
    await client.post("/habits", json={"name": "Read"}, headers=headers)
    return token


class Stats:
    def __init__(self) -> None:
        self.times: dict[str, list[float]] = defaultdict(list)
        self.errors: dict[str, int] = defaultdict(int)

    async def call(self, client, name, method, path, **kw):
        start = time.perf_counter()
        try:
            r = await client.request(method, path, **kw)
            status = r.status_code
        except httpx.HTTPError as err:
            status = type(err).__name__
        self.times[name].append((time.perf_counter() - start) * 1000)
        if not (isinstance(status, int) and status < 400):
            self.errors[f"{name} {status}"] += 1


async def virtual_user(client, token, stats: Stats, until: float) -> None:
    h = {"Authorization": f"Bearer {token}"}
    while time.monotonic() < until:
        await stats.call(client, "GET /me", "GET", "/me", headers=h)
        await stats.call(client, "GET /me/stats", "GET", "/me/stats", headers=h)
        await stats.call(client, "GET /habits", "GET", "/habits", headers=h)
        await stats.call(
            client, "GET /workouts/changes", "GET", "/workouts/changes?since=0", headers=h
        )
        now = datetime.now(UTC)
        await stats.call(
            client,
            "PUT /workouts/{id}",
            "PUT",
            f"/workouts/{uuid.uuid4()}",
            headers=h,
            json={
                "discipline": "run",
                "started_at": (now - timedelta(hours=1)).isoformat(),
                "client_updated_at": now.isoformat(),
                "duration_sec": 1800,
                "distance_m": 5000,
            },
        )
        await stats.call(client, "GET /feed", "GET", "/feed", headers=h)


def report(stats: Stats, seconds: float) -> None:
    total = sum(len(v) for v in stats.times.values())
    print(f"\n{total} requests in {seconds:.0f}s = {total / seconds:.1f} req/s\n")
    print(f"{'endpoint':28} {'n':>6} {'p50 ms':>8} {'p95 ms':>8} {'max ms':>8}")
    for name, values in sorted(stats.times.items()):
        values.sort()
        p95 = values[min(len(values) - 1, int(len(values) * 0.95))]
        print(
            f"{name:28} {len(values):6} {statistics.median(values):8.0f} "
            f"{p95:8.0f} {values[-1]:8.0f}"
        )
    if stats.errors:
        print("\nErrors:")
        for key, n in sorted(stats.errors.items(), key=lambda kv: -kv[1]):
            print(f"  {n:6}  {key}")
    else:
        print("\nNo errors.")


async def health_only(base: str, users: int, seconds: int) -> None:
    stats = Stats()
    until = time.monotonic() + seconds
    async with httpx.AsyncClient(base_url=base, timeout=15) as client:

        async def loop():
            while time.monotonic() < until:
                await stats.call(client, "GET /health", "GET", "/health")
                await asyncio.sleep(0.2)  # gentle: at most 5 req/s per user

        await asyncio.gather(*(loop() for _ in range(users)))
    report(stats, seconds)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://localhost:8000")
    parser.add_argument("--users", type=int, default=10)
    parser.add_argument("--seconds", type=int, default=30)
    parser.add_argument("--health-only", action="store_true")
    args = parser.parse_args()
    if args.health_only:
        await health_only(args.base, args.users, args.seconds)
        return
    if "localhost" not in args.base and "127.0.0.1" not in args.base:
        raise SystemExit("Full load runs only against a local stack; use --health-only elsewhere.")
    async with httpx.AsyncClient(base_url=f"{args.base}/v1", timeout=30) as client:
        print(f"Making {args.users} accounts...")
        tokens = [await make_user(client, i) for i in range(args.users)]
        stats = Stats()
        start = time.monotonic()
        await asyncio.gather(
            *(virtual_user(client, t, stats, start + args.seconds) for t in tokens)
        )
        report(stats, time.monotonic() - start)


if __name__ == "__main__":
    asyncio.run(main())
