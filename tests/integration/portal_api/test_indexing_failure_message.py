"""Integration tests for the 2026-08-14 indexing-failure-message incident.

`_trigger_indexing`'s (`routers/assets.py`) `except Exception` block used to
write `job.error_message = str(e)` directly. For a real indexing job that
timed out at exactly `settings.indexing_runtime_timeout_seconds`, `str()` on
the resulting `httpx` timeout exception is the empty string `''` — the code
believed it had recorded a reason and had in fact recorded nothing, leaving
an operator no way to learn what happened from a FAILED job.

This suite exercises `describe_indexing_failure` (the small named function
`_trigger_indexing` now delegates to) through the real background-task path,
using the existing `get_indexing_caller`/`get_indexing_session_factory` DI
seams (`routers/assets.py`) — no live indexing-runtime process needed, same
approach `test_indexing_embedding_model.py` already uses for this task.
"""

from __future__ import annotations

import json
import uuid

import httpx
import pytest
from portal_api.config import settings
from portal_api.main import app
from portal_api.models import IndexingJob
from portal_api.routers.assets import (
    describe_indexing_failure,
    get_indexing_caller,
    get_indexing_session_factory,
)
from sqlalchemy import select

from tests.integration.portal_api.conftest import auth_header


def _knowledge_manifest(**overrides) -> dict:
    manifest = {
        "schema_version": "1.0",
        "id": str(uuid.uuid4()),
        "type": "knowledge",
        "name": "테스트 Knowledge (safe to delete)",
        "version": "1.0.0",
        "owner": {"org": "miracom", "team": "hr", "creator_id": "dev-user@miracom.com"},
        "classification": "INTERNAL",
        "description": "test_indexing_failure_message.py fixture",
        "tags": ["test"],
        "source": {
            "type": "portal_upload",
            "documents": [
                {
                    "path": "documents/doc.md",
                    "mime_type": "text/markdown",
                    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                    "language": "ko",
                }
            ],
        },
        "indexing_profile_ref": {"name": "default-korean-parent-child", "version": "1.0.0"},
        "access_control": {"allowed_orgs": ["miracom"], "allowed_roles": ["USER", "CREATOR"]},
    }
    manifest.update(overrides)
    return manifest


@pytest.fixture
def override_indexing_seams_with_caller(session_factory):
    """Like `test_indexing_embedding_model.py`'s `override_indexing_seams`,
    but lets each test supply its own (failing) caller instead of a fixed
    fake that always succeeds."""

    def _install(caller):
        app.dependency_overrides[get_indexing_caller] = lambda: caller
        app.dependency_overrides[get_indexing_session_factory] = lambda: session_factory

    yield _install
    app.dependency_overrides.pop(get_indexing_caller, None)
    app.dependency_overrides.pop(get_indexing_session_factory, None)


async def _upload_and_get_job(client: httpx.AsyncClient, db) -> IndexingJob:
    resp = await client.post(
        "/api/v1/assets",
        data={"manifest": json.dumps(_knowledge_manifest(), ensure_ascii=False)},
        files={"files": ("doc.md", "# 제목\n\n본문 내용입니다.".encode(), "text/markdown")},
        headers=auth_header("dev-user-token"),
    )
    assert resp.status_code == 201, resp.text
    version_id = resp.json()["id"]

    job = (
        await db.execute(
            select(IndexingJob)
            .where(IndexingJob.asset_version_id == version_id)
            .order_by(IndexingJob.created_at.desc())
        )
    ).scalars().first()
    assert job is not None
    return job


# --- describe_indexing_failure (unit-level, no live service) ----------------


def test_describe_indexing_failure_is_never_empty_and_names_the_exception_type() -> None:
    """The exact incident: an exception whose str() is the empty string
    (e.g. a bare httpx.TimeoutException with no message text)."""
    exc = httpx.ReadTimeout("")
    assert str(exc) == ""  # confirms the premise before asserting the fix

    message = describe_indexing_failure(exc, 300.0)

    assert message  # never empty
    assert "ReadTimeout" in message


def test_describe_indexing_failure_timeout_names_the_configured_budget() -> None:
    message = describe_indexing_failure(httpx.ReadTimeout("timed out"), 42.0)

    assert "42" in message
    assert "ReadTimeout" in message


def test_describe_indexing_failure_generic_exception_preserves_its_own_text() -> None:
    message = describe_indexing_failure(
        ValueError("indexing-runtime returned malformed JSON"), 300.0
    )

    assert "indexing-runtime returned malformed JSON" in message
    assert "ValueError" in message


def test_describe_indexing_failure_never_leaks_a_filesystem_path() -> None:
    for exc in (
        httpx.ConnectError("Connection refused: http://localhost:8200/indexing/v1/jobs"),
        httpx.ReadTimeout(""),
    ):
        message = describe_indexing_failure(exc, 300.0)
        assert "/indexing/v1/jobs" not in message
        assert "localhost:8200" not in message


# --- End-to-end via the real background-task path ---------------------------


@pytest.mark.asyncio
async def test_timeout_failure_persists_nonempty_message_naming_the_budget(
    client: httpx.AsyncClient, db, override_indexing_seams_with_caller
) -> None:
    async def _timeout_caller(payload: dict) -> dict:
        raise httpx.ReadTimeout("")  # empty str(e), same shape as the real incident

    override_indexing_seams_with_caller(_timeout_caller)

    job = await _upload_and_get_job(client, db)
    await db.refresh(job)

    assert job.status == "FAILED"
    assert job.error_message  # never empty
    assert str(int(settings.indexing_runtime_timeout_seconds)) in job.error_message
    assert "/indexing/v1/jobs" not in job.error_message


@pytest.mark.asyncio
async def test_exception_with_empty_str_persists_nonempty_message_naming_the_type(
    client: httpx.AsyncClient, db, override_indexing_seams_with_caller
) -> None:
    class _SilentError(Exception):
        def __str__(self) -> str:
            return ""

    async def _silent_caller(payload: dict) -> dict:
        raise _SilentError()

    override_indexing_seams_with_caller(_silent_caller)

    job = await _upload_and_get_job(client, db)
    await db.refresh(job)

    assert job.status == "FAILED"
    assert job.error_message
    assert "_SilentError" in job.error_message


@pytest.mark.asyncio
async def test_generic_exception_message_is_preserved(
    client: httpx.AsyncClient, db, override_indexing_seams_with_caller
) -> None:
    async def _broken_caller(payload: dict) -> dict:
        raise RuntimeError("chunking profile not found")

    override_indexing_seams_with_caller(_broken_caller)

    job = await _upload_and_get_job(client, db)
    await db.refresh(job)

    assert job.status == "FAILED"
    assert "chunking profile not found" in job.error_message
    assert "RuntimeError" in job.error_message
