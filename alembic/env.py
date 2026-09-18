import asyncio

from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

import app.auth.models  # noqa: F401 - registers auth tables on Base.metadata
from alembic import context
from app.config import get_settings
from app.database import Base

config = context.config
target_metadata = Base.metadata

# The database URL is read from the app's own settings (DATABASE_URL), not
# alembic.ini - so a migration run always talks to the same database the
# application would, with no value to keep in sync by hand.
config.set_main_option("sqlalchemy.url", get_settings().database_url)


def run_migrations_offline() -> None:
    """`alembic upgrade --sql` - emits SQL without a live connection."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def _do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(_do_run_migrations)

    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
