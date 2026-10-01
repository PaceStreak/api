"""Meals, saved foods and daily targets. Private only, like BodyMetric and
WeighIn: nothing here ever reaches XP, a badge, a board, a feed or another
person. A calorie number anywhere competitive is an incentive to undereat."""

from datetime import date
from uuid import UUID

from sqlalchemy import CheckConstraint, Date, Float, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

MEALS = ("breakfast", "lunch", "dinner", "snack")


class Food(Base):
    """A food someone saved, with nutrition per serving. Saved from a barcode
    lookup or typed in; either way it is theirs to edit."""

    __tablename__ = "foods"
    __table_args__ = (UniqueConstraint("user_id", "barcode", name="uq_food_barcode"),)

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    brand: Mapped[str | None] = mapped_column(String(120))
    barcode: Mapped[str | None] = mapped_column(String(32))
    serving_label: Mapped[str | None] = mapped_column(String(40))
    kcal: Mapped[float] = mapped_column(Float, nullable=False)
    protein_g: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    carbs_g: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    fat_g: Mapped[float] = mapped_column(Float, default=0, nullable=False)


class MealEntry(Base):
    """One thing eaten. The id is chosen by the client, so a retried save is
    an update rather than a duplicate. Totals are stored, not derived from
    the food, so editing or deleting a saved food never rewrites history."""

    __tablename__ = "meal_entries"
    __table_args__ = (
        CheckConstraint(f"meal IN {MEALS}", name="ck_meal_entry_meal"),
        Index("ix_meal_entries_user_day", "user_id", "day"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    day: Mapped[date] = mapped_column(Date, nullable=False)
    meal: Mapped[str] = mapped_column(String(12), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    food_id: Mapped[UUID | None] = mapped_column(ForeignKey("foods.id", ondelete="SET NULL"))
    servings: Mapped[float] = mapped_column(Float, default=1, nullable=False)
    kcal: Mapped[float] = mapped_column(Float, nullable=False)
    protein_g: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    carbs_g: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    fat_g: Mapped[float] = mapped_column(Float, default=0, nullable=False)


class NutritionTarget(Base):
    """Daily targets. Any of them may be unset: someone tracking protein only
    should not be nagged about calories."""

    __tablename__ = "nutrition_targets"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    kcal: Mapped[float | None] = mapped_column(Float)
    protein_g: Mapped[float | None] = mapped_column(Float)
    carbs_g: Mapped[float | None] = mapped_column(Float)
    fat_g: Mapped[float | None] = mapped_column(Float)


class Recipe(Base):
    """A meal or recipe built from saved foods, logged in one tap. Macros are
    per serving and fixed when it's saved, like a meal entry, so editing a
    food later never quietly changes a recipe's history."""

    __tablename__ = "recipes"

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    serves: Mapped[float] = mapped_column(Float, default=1, nullable=False)
    # [{"food_id": "...", "name": "...", "servings": 2.0}], in order.
    items: Mapped[list] = mapped_column(JSONB, nullable=False)
    kcal: Mapped[float] = mapped_column(Float, nullable=False)
    protein_g: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    carbs_g: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    fat_g: Mapped[float] = mapped_column(Float, default=0, nullable=False)
