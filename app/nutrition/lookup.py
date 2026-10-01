"""Barcode -> nutrition, from Open Food Facts (open data, no account, no key).

Only the barcode leaves this server: no user id, no cookie, nothing that
says who scanned it. Answers are cached in Redis - hits for a month, misses
for a day - so a popular product is fetched once, not once per person.
"""

import json
import logging
import re

import httpx

from app.cache import get_client
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

BARCODE = re.compile(r"^\d{8,14}$")
_HIT_TTL = 30 * 86400
_MISS_TTL = 86400
# Named, not inlined: see the note on the same tuple in app/turnstile.py.
_REQUEST_ERRORS = (httpx.HTTPError, ValueError)
_REDIS_ERRORS = (OSError, ConnectionError)


class LookupUnavailable(Exception):
    """Open Food Facts could not be reached; distinct from "not found"."""


def _number(value) -> float | None:
    try:
        n = float(value)
    except TypeError, ValueError:
        return None
    return n if n >= 0 else None


def parse_product(product: dict) -> dict | None:
    """Per serving when the product says what a serving is, else per 100 g.
    None when there is no energy figure at all - a food without calories is
    no use to a calorie log."""
    n = product.get("nutriments") or {}
    name = (product.get("product_name") or "").strip()
    if not name:
        return None
    serving = _number(product.get("serving_quantity"))
    if serving and _number(n.get("energy-kcal_serving")) is not None:
        suffix, label = "_serving", (product.get("serving_size") or f"{serving:g} g")[:40]
    elif _number(n.get("energy-kcal_100g")) is not None:
        suffix, label = "_100g", "100 g"
    else:
        return None
    return {
        "name": name[:120],
        "brand": ((product.get("brands") or "").split(",")[0].strip() or None),
        "serving_label": label,
        "kcal": round(_number(n.get("energy-kcal" + suffix)) or 0, 1),
        "protein_g": round(_number(n.get("proteins" + suffix)) or 0, 1),
        "carbs_g": round(_number(n.get("carbohydrates" + suffix)) or 0, 1),
        "fat_g": round(_number(n.get("fat" + suffix)) or 0, 1),
    }


async def fetch(barcode: str) -> dict | None:
    """The product's nutrition, or None if it isn't known. Raises
    LookupUnavailable when the lookup is off or unreachable."""
    if not settings.food_lookup_url:
        raise LookupUnavailable
    key = f"food:{barcode}"
    cache = get_client()
    try:
        cached = await cache.get(key)
        if cached is not None:
            return json.loads(cached) or None
    except _REDIS_ERRORS:
        cached = None
    try:
        async with httpx.AsyncClient(timeout=5) as http:
            res = await http.get(
                settings.food_lookup_url.format(barcode=barcode),
                params={"fields": "product_name,brands,nutriments,serving_quantity,serving_size"},
                headers={"User-Agent": "PaceStreak/1.0 (hello@pacestreak.com)"},
            )
        if res.status_code == 404:
            found = None
        else:
            res.raise_for_status()
            data = res.json()
            found = parse_product(data.get("product") or {}) if data.get("status") == 1 else None
    except _REQUEST_ERRORS as exc:
        logger.warning("food lookup failed: %s", exc)
        raise LookupUnavailable from exc
    try:
        await cache.set(key, json.dumps(found or {}), ex=_HIT_TTL if found else _MISS_TTL)
    except _REDIS_ERRORS:
        pass
    return found
