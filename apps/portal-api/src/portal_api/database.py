from __future__ import annotations

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from portal_api.config import settings

engine = create_async_engine(str(settings.database_url), echo=False)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session


async def init_db() -> None:
    """App startup hook — schema creation contract.

    Schema for the running app is owned by Alembic migrations
    (`apps/portal-api/migrations/`), NOT by `Base.metadata.create_all`. Prior
    to Alembic adoption (D-043), `create_all` only added *missing* tables and
    silently left existing tables un-ALTERed when a model gained a column —
    this caused three separate "no such column" outages against the running
    `portal.db` (see docs/implementation-spec/progress-log.md, 2026-08-03).

    A fresh clone must run `make migrate` (== `alembic upgrade head`) once,
    from `apps/portal-api/`, before starting the app — that single command
    builds a correct DB from the baseline revision plus any later
    migrations. This function intentionally does NOT call `create_all`, so
    an un-migrated DB fails fast/loud on the first query instead of silently
    running with a partial or stale schema.

    The test suite does not go through this function or `init_db()` at all:
    `tests/integration/portal_api/conftest.py` builds its own isolated
    in-memory engine and calls `Base.metadata.create_all` directly, which is
    fine for ephemeral per-test databases that never need an ALTER.
    """
    return None
