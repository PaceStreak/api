"""Aggregates every router that belongs under API_V1_PREFIX.

A new feature area adds its router here, once. app/main.py mounts this whole
thing at API_V1_PREFIX - it does not know or care what lives underneath.
"""

from fastapi import APIRouter

from app.account.calendar import router as calendar_router
from app.account.router import router as account_router
from app.admin.router import router as admin_router
from app.auth.passkeys import router as passkeys_router
from app.auth.router import router as auth_router
from app.game.leaderboards import router as leaderboards_router
from app.game.router import router as stats_router
from app.groups.router import router as groups_router
from app.notifications.router import router as notifications_router
from app.ops.router import router as ops_router
from app.profile.router import router as profile_router
from app.social.buddies import router as buddies_router
from app.social.router import router as social_router
from app.training.gear import router as gear_router
from app.training.plans import router as plans_router
from app.training.router import router as training_router

router = APIRouter()
router.include_router(auth_router)
router.include_router(passkeys_router)
router.include_router(profile_router)
router.include_router(stats_router)
router.include_router(account_router)
router.include_router(calendar_router)
router.include_router(training_router)
router.include_router(gear_router)
router.include_router(plans_router)
router.include_router(social_router)
router.include_router(buddies_router)
router.include_router(groups_router)
router.include_router(leaderboards_router)
router.include_router(notifications_router)
router.include_router(admin_router)
router.include_router(ops_router)
