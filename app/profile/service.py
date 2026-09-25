import random
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.profile.models import Profile
from app.training.models import StreakChain


async def get_profile(db: AsyncSession, user_id: UUID) -> Profile:
    """The user's profile, created on first use.

    Lazily rather than at signup, so the auth router stays ignorant of the
    product and accounts that predate this table still work.
    """
    profile = (
        await db.execute(select(Profile).where(Profile.user_id == user_id))
    ).scalar_one_or_none()
    if profile is None:
        profile = Profile(user_id=user_id, avatar_hue=random.randint(0, 359))
        db.add(profile)
        await db.flush()
    return profile


async def get_chains(db: AsyncSession, profile: Profile) -> list[StreakChain]:
    """Active chains, first one being the main streak. Creates the default
    all-disciplines chain the first time, so there is always one."""
    chains = (
        (
            await db.execute(
                select(StreakChain)
                .where(StreakChain.user_id == profile.user_id, StreakChain.archived.is_(False))
                .order_by(StreakChain.position, StreakChain.created_at)
            )
        )
        .scalars()
        .all()
    )
    if not chains:
        chain = StreakChain(
            user_id=profile.user_id,
            name="Everything",
            disciplines=[],
            # Backdated far enough that every past week is judged by it.
            target_history=[{"from": "2000-01-03", "target": 3}],
            position=0,
        )
        db.add(chain)
        await db.flush()
        chains = [chain]
    return list(chains)


def set_chain_target(chain: StreakChain, target: int, effective_week: str) -> None:
    """Record a target change from `effective_week` onwards. Weeks before it
    keep the target they were judged by."""
    history = [h for h in chain.target_history if h["from"] < effective_week]
    history.append({"from": effective_week, "target": target})
    chain.target_history = history


def set_chain_requirements(
    chain: StreakChain, requirements: list[dict], effective_week: str
) -> None:
    """Same discipline as targets: effective from `effective_week`, earlier
    weeks keep the rules they were played under."""
    history = [h for h in chain.requirements_history if h["from"] < effective_week]
    history.append({"from": effective_week, "requirements": requirements})
    chain.requirements_history = history
