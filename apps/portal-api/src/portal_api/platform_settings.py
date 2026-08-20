"""Read/write helpers for `PlatformSetting` — see that model's docstring for
why this is a generic key/value store rather than a dedicated table.

`routers/admin.py` owns the HTTP surface (GET/PUT + RBAC + audit);
`routers/assets.py::_trigger_indexing`'s caller reads the configured model
through `get_setting` directly (no HTTP hop — same process) before
scheduling the background indexing job. Keeping this in its own module
(rather than importing router-to-router) avoids a routers/assets.py ->
routers/admin.py dependency for what is really a shared, non-HTTP concern.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from portal_api.models import PlatformSetting

# open-decisions.md D-075 / D-065 UPDATE: the embedding model portal-api
# tells indexing-runtime to use for NEWLY triggered indexing jobs
# (`routers/assets.py::_trigger_indexing`'s `embed_model` field). Unset
# (no row / value None) means "let indexing-runtime apply its own
# INDEXING_EMBED_MODEL default" — see `routers/admin.py` for the read/write
# endpoints and the two UI warnings this setting requires.
INDEXING_EMBED_MODEL_KEY = "indexing_embedding_model"

# open-decisions.md D-092: the chat model agent-runtime should use for
# `model_aliases["default-chat"].model_id` (D-091 incident — a chat model
# hardcoded in office-profile.json that wasn't installed on that PC, and
# nobody knew until a run 404'd). Unset (no row / value None) means "let
# agent-runtime apply its own two-tier default"
# (`AGENT_RUNTIME_CHAT_MODEL_ID` env override -> office-profile.json), same
# priority shape as `INDEXING_EMBED_MODEL_KEY` above. agent-runtime reads
# this back via `GET /api/v1/admin/chat-model-setting` (server-to-server,
# see `routers/admin.py`) — portal-api unreachable means agent-runtime keeps
# running on its existing value (D-092), it never blocks chat on this call.
CHAT_MODEL_KEY = "chat_model"


async def get_setting(db: AsyncSession, key: str) -> str | None:
    row = (
        await db.execute(select(PlatformSetting).where(PlatformSetting.key == key))
    ).scalar_one_or_none()
    return row.value if row is not None else None


async def set_setting(
    db: AsyncSession,
    key: str,
    value: str,
    *,
    updated_by_user_id: str,
    trace_id: str,
) -> PlatformSetting:
    row = (
        await db.execute(select(PlatformSetting).where(PlatformSetting.key == key))
    ).scalar_one_or_none()
    if row is None:
        row = PlatformSetting(key=key)
        db.add(row)
    row.value = value
    row.updated_by_user_id = updated_by_user_id
    row.trace_id = trace_id
    await db.commit()
    await db.refresh(row)
    return row
