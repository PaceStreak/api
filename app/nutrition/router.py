"""Calorie and macro logging: meals by day, saved foods, daily targets and a
barcode lookup. All private to their owner."""

from collections import defaultdict
from datetime import date, timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.common.time import local_today
from app.database import get_db
from app.nutrition.expenditure import WINDOW_DAYS, estimate, suggest
from app.nutrition.lookup import BARCODE, LookupUnavailable, fetch
from app.nutrition.models import Food, MealEntry, NutritionTarget, Recipe
from app.profile.service import get_profile
from app.ratelimit import limiter
from app.training.models import WeighIn, WeightGoal

router = APIRouter(prefix="/nutrition", tags=["nutrition"])

MAX_FOODS = 500
MAX_RECIPES = 200
MAX_BACKDATE_DAYS = 60
MACROS = ("kcal", "protein_g", "carbs_g", "fat_g")


class FoodIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    brand: str | None = Field(default=None, max_length=120)
    barcode: str | None = Field(default=None, pattern=BARCODE.pattern)
    serving_label: str | None = Field(default=None, max_length=40)
    kcal: float = Field(ge=0, le=10000)
    protein_g: float = Field(default=0, ge=0, le=1000)
    carbs_g: float = Field(default=0, ge=0, le=1000)
    fat_g: float = Field(default=0, ge=0, le=1000)


class EntryIn(BaseModel):
    """A saved food or recipe times servings, or the numbers typed in."""

    date: date
    meal: Literal["breakfast", "lunch", "dinner", "snack"]
    food_id: UUID | None = None
    recipe_id: UUID | None = None
    servings: float = Field(default=1, gt=0, le=50)
    name: str | None = Field(default=None, max_length=120)
    kcal: float | None = Field(default=None, ge=0, le=20000)
    protein_g: float | None = Field(default=None, ge=0, le=2000)
    carbs_g: float | None = Field(default=None, ge=0, le=2000)
    fat_g: float | None = Field(default=None, ge=0, le=2000)


class RecipeItemIn(BaseModel):
    food_id: UUID
    servings: float = Field(default=1, gt=0, le=50)


class RecipeIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    serves: float = Field(default=1, gt=0, le=50)
    items: list[RecipeItemIn] = Field(min_length=1, max_length=40)


class TargetIn(BaseModel):
    kcal: float | None = Field(default=None, ge=500, le=10000)
    protein_g: float | None = Field(default=None, ge=0, le=1000)
    carbs_g: float | None = Field(default=None, ge=0, le=2000)
    fat_g: float | None = Field(default=None, ge=0, le=1000)


class CopyIn(BaseModel):
    from_date: date
    to_date: date
    meal: Literal["breakfast", "lunch", "dinner", "snack"] | None = None


def _food_out(f: Food) -> dict:
    return {
        "id": str(f.id),
        "name": f.name,
        "brand": f.brand,
        "barcode": f.barcode,
        "serving_label": f.serving_label,
        **{k: getattr(f, k) for k in MACROS},
    }


def _entry_out(e: MealEntry) -> dict:
    return {
        "id": str(e.id),
        "date": e.day.isoformat(),
        "meal": e.meal,
        "name": e.name,
        "food_id": str(e.food_id) if e.food_id else None,
        "servings": e.servings,
        **{k: getattr(e, k) for k in MACROS},
    }


def _target_out(t: NutritionTarget | None) -> dict | None:
    return {k: getattr(t, k) for k in MACROS} if t else None


def totals(entries) -> dict:
    return {k: round(sum(getattr(e, k) for e in entries), 1) for k in MACROS}


async def get_target(db: AsyncSession, user_id: UUID) -> NutritionTarget | None:
    return (
        await db.execute(select(NutritionTarget).where(NutritionTarget.user_id == user_id))
    ).scalar_one_or_none()


async def _today(db: AsyncSession, user: User) -> date:
    return local_today((await get_profile(db, user.id)).timezone)


async def _own_food(db: AsyncSession, user: User, food_id: UUID) -> Food:
    food = await db.get(Food, food_id)
    if food is None or food.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return food


def _check_day(day: date, today: date) -> None:
    if day > today:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That day hasn't happened yet")
    if day < today - timedelta(days=MAX_BACKDATE_DAYS):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Meals can be backdated up to {MAX_BACKDATE_DAYS} days",
        )


# --- days ----------------------------------------------------------------------------


@router.get("/days/{day}")
async def get_day(
    day: date, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    rows = await db.execute(
        select(MealEntry)
        .where(MealEntry.user_id == user.id, MealEntry.day == day)
        .order_by(MealEntry.created_at)
    )
    entries = list(rows.scalars())
    return {
        "date": day.isoformat(),
        "entries": [_entry_out(e) for e in entries],
        "totals": totals(entries),
        "target": _target_out(await get_target(db, user.id)),
    }


@router.get("/history")
async def history(
    days: int = Query(default=30, ge=1, le=365),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Daily totals, oldest first. Only days with something logged."""
    since = await _today(db, user) - timedelta(days=days - 1)
    rows = await db.execute(
        select(MealEntry.day, *(func.sum(getattr(MealEntry, k)) for k in MACROS))
        .where(MealEntry.user_id == user.id, MealEntry.day >= since)
        .group_by(MealEntry.day)
        .order_by(MealEntry.day)
    )
    return [
        {"date": d.isoformat(), **{k: round(v, 1) for k, v in zip(MACROS, sums, strict=True)}}
        for d, *sums in rows
    ]


# --- entries -------------------------------------------------------------------------


@router.put("/entries/{entry_id}")
async def put_entry(
    entry_id: UUID,
    body: EntryIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _check_day(body.date, await _today(db, user))
    if body.recipe_id is not None:
        recipe = await _own_recipe(db, user, body.recipe_id)
        values = {"name": recipe.name} | {
            k: round(getattr(recipe, k) * body.servings, 1) for k in MACROS
        }
    elif body.food_id is not None:
        food = await _own_food(db, user, body.food_id)
        values = {"name": food.name} | {
            k: round(getattr(food, k) * body.servings, 1) for k in MACROS
        }
    else:
        if not (body.name or "").strip() or body.kcal is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "A name and calories, or a saved food"
            )
        values = {"name": body.name.strip()} | {k: getattr(body, k) or 0 for k in MACROS}
    entry = await db.get(MealEntry, entry_id)
    if entry is not None and entry.user_id != user.id:
        # Somebody else's id. 404 rather than 403, so ids cannot be probed.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if entry is None:
        entry = MealEntry(id=entry_id, user_id=user.id)
        db.add(entry)
    entry.day, entry.meal, entry.food_id, entry.servings = (
        body.date,
        body.meal,
        body.food_id,
        body.servings,
    )
    for key, value in values.items():
        setattr(entry, key, value)
    await db.commit()
    return _entry_out(entry)


@router.delete("/entries/{entry_id}", status_code=204)
async def delete_entry(
    entry_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    await db.execute(
        delete(MealEntry).where(MealEntry.id == entry_id, MealEntry.user_id == user.id)
    )
    await db.commit()
    return Response(status_code=204)


@router.post("/copy", status_code=201)
async def copy_meals(
    body: CopyIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Copy a day (or one meal of it) onto another: "same breakfast as
    yesterday" in one tap."""
    _check_day(body.to_date, await _today(db, user))
    query = select(MealEntry).where(MealEntry.user_id == user.id, MealEntry.day == body.from_date)
    if body.meal:
        query = query.where(MealEntry.meal == body.meal)
    copied = []
    for e in (await db.execute(query.order_by(MealEntry.created_at))).scalars().all():
        new = MealEntry(
            user_id=user.id,
            day=body.to_date,
            meal=e.meal,
            name=e.name,
            food_id=e.food_id,
            servings=e.servings,
            **{k: getattr(e, k) for k in MACROS},
        )
        db.add(new)
        copied.append(new)
    await db.commit()
    return [_entry_out(e) for e in copied]


# --- saved foods ---------------------------------------------------------------------


@router.get("/foods")
async def list_foods(
    q: str | None = Query(default=None, max_length=60),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(Food).where(Food.user_id == user.id)
    if q:
        query = query.where(Food.name.ilike(f"%{q.replace('%', '').replace('_', '')}%"))
    rows = await db.execute(query.order_by(Food.name))
    return [_food_out(f) for f in rows.scalars()]


@router.get("/recent")
async def recent_foods(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """The most-logged things of the last 30 days, for quick re-entry."""
    since = await _today(db, user) - timedelta(days=30)
    rows = await db.execute(
        select(MealEntry)
        .where(MealEntry.user_id == user.id, MealEntry.day >= since)
        .order_by(MealEntry.created_at.desc())
    )
    counts: dict[tuple, int] = defaultdict(int)
    latest: dict[tuple, MealEntry] = {}
    for e in rows.scalars():
        key = (e.food_id, e.name) if e.food_id else (None, e.name)
        counts[key] += 1
        latest.setdefault(key, e)
    ranked = sorted(counts, key=lambda k: -counts[k])[:20]
    out = []
    for key in ranked:
        e = latest[key]
        per = max(e.servings, 0.01)
        out.append(
            {
                "name": e.name,
                "food_id": str(e.food_id) if e.food_id else None,
                "times": counts[key],
                **{k: round(getattr(e, k) / per, 1) for k in MACROS},
            }
        )
    return out


@router.post("/foods", status_code=201)
async def create_food(
    body: FoodIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    count = (
        await db.execute(select(func.count()).select_from(Food).where(Food.user_id == user.id))
    ).scalar_one()
    if count >= MAX_FOODS:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{MAX_FOODS} saved foods is the limit")
    if (
        body.barcode
        and (
            await db.execute(
                select(Food.id).where(Food.user_id == user.id, Food.barcode == body.barcode)
            )
        ).first()
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "That barcode is already saved")
    food = Food(user_id=user.id, **(body.model_dump() | {"name": body.name.strip()}))
    db.add(food)
    await db.commit()
    return _food_out(food)


@router.put("/foods/{food_id}")
async def update_food(
    food_id: UUID,
    body: FoodIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    food = await _own_food(db, user, food_id)
    if body.barcode and body.barcode != food.barcode:
        clash = await db.execute(
            select(Food.id).where(Food.user_id == user.id, Food.barcode == body.barcode)
        )
        if clash.first():
            raise HTTPException(status.HTTP_409_CONFLICT, "That barcode is already saved")
    for key, value in (body.model_dump() | {"name": body.name.strip()}).items():
        setattr(food, key, value)
    await db.commit()
    return _food_out(food)


@router.delete("/foods/{food_id}", status_code=204)
async def delete_food(
    food_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """Logged meals keep their numbers; they just stop pointing here."""
    food = await _own_food(db, user, food_id)
    await db.delete(food)
    await db.commit()


@router.get("/barcode/{code}")
@limiter.limit("30/minute")
async def barcode(
    request: Request,
    code: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """A saved food first, so a correction someone made sticks; then Open
    Food Facts. `source` says which, and an outside result is not saved
    until the person confirms it with POST /foods."""
    if not BARCODE.match(code):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Not a product barcode")
    saved = (
        await db.execute(select(Food).where(Food.user_id == user.id, Food.barcode == code))
    ).scalar_one_or_none()
    if saved is not None:
        return {"source": "saved", "food": _food_out(saved)}
    try:
        found = await fetch(code)
    except LookupUnavailable:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Barcode lookup is unavailable right now"
        ) from None
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found")
    return {"source": "openfoodfacts", "food": found | {"barcode": code}}


# --- target --------------------------------------------------------------------------


@router.get("/target")
async def read_target(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return _target_out(await get_target(db, user.id))


@router.put("/target")
async def put_target(
    body: TargetIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """All four empty removes the target."""
    target = await get_target(db, user.id)
    if all(getattr(body, k) is None for k in MACROS):
        if target is not None:
            await db.delete(target)
        await db.commit()
        return None
    if target is None:
        target = NutritionTarget(user_id=user.id)
        db.add(target)
    for k in MACROS:
        setattr(target, k, getattr(body, k))
    await db.commit()
    return _target_out(target)


# --- recipes -------------------------------------------------------------------------


def _recipe_out(r: Recipe) -> dict:
    return {
        "id": str(r.id),
        "name": r.name,
        "serves": r.serves,
        "items": r.items,
        **{k: getattr(r, k) for k in MACROS},
    }


async def _own_recipe(db: AsyncSession, user: User, recipe_id: UUID) -> Recipe:
    recipe = await db.get(Recipe, recipe_id)
    if recipe is None or recipe.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return recipe


async def _fill_recipe(db: AsyncSession, user: User, recipe: Recipe, body: RecipeIn) -> None:
    """Snapshot the foods as they are now: per-serving macros are the sum of
    the items divided by how many it serves."""
    ids = {i.food_id for i in body.items}
    foods = {
        f.id: f
        for f in (
            await db.execute(select(Food).where(Food.user_id == user.id, Food.id.in_(ids)))
        ).scalars()
    }
    if len(foods) != len(ids):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "A food in this recipe isn't saved")
    recipe.name, recipe.serves = body.name.strip(), body.serves
    recipe.items = [
        {"food_id": str(i.food_id), "name": foods[i.food_id].name, "servings": i.servings}
        for i in body.items
    ]
    for k in MACROS:
        total = sum(getattr(foods[i.food_id], k) * i.servings for i in body.items)
        setattr(recipe, k, round(total / body.serves, 1))


@router.get("/recipes")
async def list_recipes(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = await db.execute(select(Recipe).where(Recipe.user_id == user.id).order_by(Recipe.name))
    return [_recipe_out(r) for r in rows.scalars()]


@router.post("/recipes", status_code=201)
async def create_recipe(
    body: RecipeIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    count = (
        await db.execute(select(func.count()).select_from(Recipe).where(Recipe.user_id == user.id))
    ).scalar_one()
    if count >= MAX_RECIPES:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{MAX_RECIPES} recipes is the limit")
    recipe = Recipe(user_id=user.id)
    await _fill_recipe(db, user, recipe, body)
    db.add(recipe)
    await db.commit()
    return _recipe_out(recipe)


@router.put("/recipes/{recipe_id}")
async def update_recipe(
    recipe_id: UUID,
    body: RecipeIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    recipe = await _own_recipe(db, user, recipe_id)
    await _fill_recipe(db, user, recipe, body)
    await db.commit()
    return _recipe_out(recipe)


@router.delete("/recipes/{recipe_id}", status_code=204)
async def delete_recipe(
    recipe_id: UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    recipe = await _own_recipe(db, user, recipe_id)
    await db.delete(recipe)
    await db.commit()


# --- adaptive expenditure ------------------------------------------------------------


@router.get("/expenditure")
async def expenditure(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Estimated daily energy burn from the last four weeks of food and
    weigh-ins, and a target toward the weight goal. Private, like both."""
    end = await _today(db, user) - timedelta(days=1)
    start = end - timedelta(days=WINDOW_DAYS - 1)
    intake = {
        d: kcal
        for d, kcal in await db.execute(
            select(MealEntry.day, func.sum(MealEntry.kcal))
            .where(MealEntry.user_id == user.id, MealEntry.day.between(start, end))
            .group_by(MealEntry.day)
        )
    }
    weights = {
        d: kg
        for d, kg in await db.execute(
            select(WeighIn.local_date, func.avg(WeighIn.weight_kg))
            .where(WeighIn.user_id == user.id, WeighIn.local_date.between(start, end))
            .group_by(WeighIn.local_date)
        )
    }
    est = estimate(intake, weights, end)
    goal = (
        await db.execute(select(WeightGoal.target_kg).where(WeightGoal.user_id == user.id))
    ).scalar_one_or_none()
    return {
        "window_days": WINDOW_DAYS,
        **{k: v for k, v in est.__dict__.items()},
        "suggestion": suggest(est, goal),
    }
