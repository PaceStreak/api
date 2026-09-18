"""Aggregates every router that belongs under API_V1_PREFIX.

A new feature area adds its router here, once. app/main.py mounts this whole
thing at API_V1_PREFIX - it does not know or care what lives underneath.
"""

from fastapi import APIRouter

from app.auth.router import router as auth_router

router = APIRouter()
router.include_router(auth_router)
