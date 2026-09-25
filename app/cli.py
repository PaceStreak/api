"""Operator commands. Run inside the API container or with the app's env:

    python -m app.cli create-admin admin@pacestreak.com
    python -m app.cli set-password admin@pacestreak.com
    python -m app.cli set-role someone@example.com moderator

Passwords are read with getpass (or from PACESTREAK_PASSWORD, for automation),
never from argv, where they would land in shell history and `ps` output.

There is deliberately no HTTP endpoint for any of this: the first admin has to
come from somewhere that already has database access, and granting roles
through the API is limited to existing admins (PATCH /v1/admin/users/{id}).
"""

import argparse
import asyncio
import getpass
import os
import sys

from sqlalchemy import select

from app.auth.models import User, UserRole
from app.auth.security import hash_password
from app.auth.service import finish_revoke_all, revoke_all_sessions
from app.common.time import utcnow
from app.database import AsyncSessionLocal

MIN_PASSWORD = 16


def _password(confirm: bool = True) -> str:
    from_env = os.environ.get("PACESTREAK_PASSWORD")
    if from_env:
        password = from_env
    else:
        password = getpass.getpass("New password: ")
        if confirm and getpass.getpass("Repeat it: ") != password:
            sys.exit("Passwords do not match.")
    if len(password) < MIN_PASSWORD:
        sys.exit(f"Passwords must be at least {MIN_PASSWORD} characters.")
    return password


async def _user(db, email: str) -> User | None:
    return (
        await db.execute(select(User).where(User.email == email.strip().lower()))
    ).scalar_one_or_none()


async def create_admin(email: str) -> None:
    async with AsyncSessionLocal() as db:
        if await _user(db, email) is not None:
            sys.exit(f"{email} already exists. Use set-role / set-password instead.")
        password = _password()
        now = utcnow()
        db.add(
            User(
                email=email.strip().lower(),
                hashed_password=hash_password(password),
                role=UserRole.ADMIN,
                # There is no inbox to verify from yet; the operator vouches.
                is_verified=True,
                verified_at=now,
                password_changed_at=now,
            )
        )
        await db.commit()
    print(f"Created admin {email}. Sign in and finish onboarding in the app.")


async def set_password(email: str) -> None:
    async with AsyncSessionLocal() as db:
        user = await _user(db, email)
        if user is None:
            sys.exit(f"No account for {email}.")
        user.hashed_password = hash_password(_password())
        user.password_changed_at = utcnow()
        # Same as a reset: every existing session ends.
        await revoke_all_sessions(db, user)
        await db.commit()
        user_id = user.id
    await finish_revoke_all(user_id)
    print(f"Password changed for {email}; all of its sessions were signed out.")


async def set_role(email: str, role: str) -> None:
    async with AsyncSessionLocal() as db:
        user = await _user(db, email)
        if user is None:
            sys.exit(f"No account for {email}.")
        user.role = UserRole(role)
        await db.commit()
        user_id = user.id
    # The role is cached with the user; drop it so the change applies now.
    await finish_revoke_all(user_id)
    print(f"{email} is now {role}.")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("create-admin").add_argument("email")
    commands.add_parser("set-password").add_argument("email")
    role = commands.add_parser("set-role")
    role.add_argument("email")
    role.add_argument("role", choices=[r.value for r in UserRole])
    args = parser.parse_args(argv)

    if args.command == "create-admin":
        asyncio.run(create_admin(args.email))
    elif args.command == "set-password":
        asyncio.run(set_password(args.email))
    else:
        asyncio.run(set_role(args.email, args.role))


if __name__ == "__main__":
    main()
