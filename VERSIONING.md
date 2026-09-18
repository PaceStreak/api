# API versioning

This is the policy, not just the mechanism. If a change doesn't fit cleanly
into one of the categories below, that's a sign to slow down and decide
deliberately rather than guess.

## The strategy: URI path versioning

Every route is mounted under `/v1/...`. `CLAUDE.md` and `README.md` already
settled this before any code existed ("prefix routes with `/v1/`"); this
document is about what happens *after* that prefix is in place.

URI path versioning was chosen over header-based or media-type versioning for
reasons that hold specifically for this API, not versioning in the abstract:

- **The consumer is a single first-party frontend** (`app.pacestreak.com`),
  not a broad ecosystem of third-party integrators picking their own upgrade
  pace. Header-based versioning earns its complexity when different clients
  need to stay pinned to different versions indefinitely; here, `app` and
  `api` deploy from the same organisation and can move together.
- **It works with the infrastructure for free.** Load balancers, CDNs, and
  Cloudflare's edge all route on URL path natively. A header-based scheme
  needs `Vary` handled correctly everywhere or caching silently breaks.
- **It's testable in a browser and in `/docs`** without custom headers, which
  matters more than usual here because this is a small team, not a platform
  team with dedicated API tooling.
- **The version boundary is visible in the code.** `app/versioning.py`
  defines `API_V1_PREFIX` once; `app/v1/router.py` is the only place that
  mounts anything under it. Nothing else in the codebase hardcodes `/v1`.

The trade-off, accepted deliberately: an app-level version bump (see below)
never requires a URL change, but a genuine breaking change to a resource's
shape does - and that shows up in every client URL. That's the intended
behaviour, not a limitation to work around.

## Two different version numbers, on purpose

It is easy to conflate these. They answer different questions:

| | Lives where | Answers | Changes when |
| --- | --- | --- | --- |
| **URL version** (`/v1`) | `app/versioning.py` | "which contract am I calling?" | A breaking change ships |
| **App version** (`app_version` in `Settings`, shown as `info.version` in `/docs`'s OpenAPI document) | `.env` / `app/config.py` | "which build am I running?" | Every release, per semver |

A patch release, a new optional field, a new endpoint, a bug fix - all of
these bump the app version and ship inside the existing `/v1`. None of them
justify `/v2`.

## What is and isn't a breaking change

Requires a new URL version (`/v2`):

- Removing or renaming a field, endpoint, or query parameter a client relies on.
- Changing a field's type or the meaning of an existing value.
- Making a previously-optional request field required.
- Changing authentication or authorization requirements on an existing route.
- Changing error response shape in a way clients parse.

Does **not** require one - ships inside `/v1`, bumps the app version instead:

- Adding a new endpoint.
- Adding a new optional request field with a sensible default.
- Adding a new response field (clients that ignore unknown fields are
  unaffected - and every client here is first-party, so this is enforceable).
- Widening a validation rule (accepting more than before).
- Performance, internal refactors, bug fixes that bring behaviour in line
  with the documented contract rather than away from it.

## Adding /v2, when it's actually warranted

1. Create `app/v2/` mirroring `app/v1/`'s shape (a `router.py` aggregator).
2. Fork only the feature area that actually needs the breaking change - a
   `/v2/auth` does not require a `/v2/workouts` if workouts didn't change.
   Unchanged feature areas can be included into `app/v2/router.py` from their
   existing `app/<feature>/router.py`, same as `app/v1/router.py` does today.
3. Mount both: `app.include_router(v1_router, prefix="/v1")` and
   `app.include_router(v2_router, prefix="/v2")` stay side by side in
   `app/main.py` for the entire deprecation window. `/v1` is never rewritten
   in place - that would silently break every client still on it.
4. Update `API_VERSION` only if something needs to know "the latest version"
   programmatically; most call sites shouldn't need to.

## Deprecating a version

Not needed yet - `/v1` is the only version and has no announced end date.
When a version is deprecated, do it with headers, not just a changelog entry
a client has to go read:

- **`Deprecation` header** ([RFC 9745](https://datatracker.ietf.org/doc/html/rfc9745)) -
  a structured-field date marking when deprecation took effect. Present as
  soon as a version is discouraged, even before a removal date is set.
- **`Sunset` header** ([RFC 8594](https://datatracker.ietf.org/doc/html/rfc8594)) -
  an HTTP-date for when the version actually stops responding. Only added
  once a real date is committed to - an empty promise is worse than no
  header. Per RFC 8594, `Sunset` must never predate `Deprecation`.
- **`Link` header** ([RFC 8288](https://datatracker.ietf.org/doc/html/rfc8288))
  with `rel="successor-version"` pointing at the replacement endpoint, so a
  client (or a bored engineer with curl) doesn't have to go find the
  changelog.

Minimum sunset window: not yet decided, because there has never been a
version to retire. Decide the window *when* a `/v2` is proposed, based on who
is actually still calling `/v1` at that point - `app.pacestreak.com` being
the only consumer today means this could be short, but that stops being true
the moment anything else calls this API.

## What this is not

Not database migration versioning (Alembic, see `README.md#migrations`) and
not this package's semver (`pyproject.toml`'s `version`, bumped on release).
Those are real, separate axes and conflating them with the URL version is how
"just bump the version" stops meaning anything.
