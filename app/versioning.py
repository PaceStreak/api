"""The one place this API's URL version is spelled out.

Every router mounts under `API_V1_PREFIX` rather than hardcoding "/v1"
itself, so introducing /v2 later is "add a new prefix here and a new router
package", not "grep every file for a string". See VERSIONING.md for the full
policy this constant is part of - when a version bump is warranted, how
non-breaking changes ship without one, and how a version gets deprecated.
"""

API_VERSION = "1"
API_V1_PREFIX = f"/v{API_VERSION}"
