"""Deployment identity for the three services that lacked it (2026-08-14).

portal-api and distribution-service got `build_version`/`commit_sha` on
2026-08-12, search-runtime on 2026-08-13. agent-runtime, indexing-runtime and
office-mcp-server did not — and that gap has a measured cost: on 2026-08-13 a
search-runtime process from six days earlier was still listening, a route
added that week returned 404, and the only way to tell a stale process from a
fresh one was reading `/openapi.json` by hand. These tests pin the contract so
every long-running service in this repo answers "what code are you running"
the same way.

The shape is deliberately identical across services (`status`, `version`,
`commit_sha`) so one operator check — and the `scripts/macos/dev-stack.sh`
`status` subcommand — works everywhere without per-service special cases.
"""

from __future__ import annotations

import json
import logging

import pytest


@pytest.mark.asyncio
async def test_agent_runtime_health_exposes_injected_identity(monkeypatch) -> None:
    from agent_runtime.config import settings
    from agent_runtime.main import health

    monkeypatch.setattr(settings, "build_version", "1.2.3")
    monkeypatch.setattr(settings, "commit_sha", "abc123def456")

    response = await health()

    assert response.status_code == 200
    assert json.loads(response.body) == {
        "status": "ok",
        "version": "1.2.3",
        "commit_sha": "abc123def456",
    }


@pytest.mark.asyncio
async def test_agent_runtime_startup_log_identifies_revision(monkeypatch, caplog) -> None:
    from agent_runtime.config import settings
    from agent_runtime.main import app, lifespan

    monkeypatch.setattr(settings, "build_version", "1.2.3")
    monkeypatch.setattr(settings, "commit_sha", "abc123def456")

    with caplog.at_level(logging.INFO, logger="agent_runtime.main"):
        async with lifespan(app):
            pass

    assert "service.started service=agent-runtime" in caplog.text
    assert "build_version=1.2.3" in caplog.text
    assert "commit_sha=abc123def456" in caplog.text


@pytest.mark.asyncio
async def test_indexing_runtime_health_exposes_injected_identity(monkeypatch) -> None:
    from indexing_runtime import main as indexing_main

    monkeypatch.setattr(indexing_main, "BUILD_VERSION", "1.2.3")
    monkeypatch.setattr(indexing_main, "COMMIT_SHA", "abc123def456")

    response = await indexing_main.health()

    assert response.status_code == 200
    assert json.loads(response.body) == {
        "status": "ok",
        "version": "1.2.3",
        "commit_sha": "abc123def456",
    }


@pytest.mark.asyncio
async def test_indexing_runtime_startup_log_identifies_revision(monkeypatch, caplog) -> None:
    from indexing_runtime import main as indexing_main

    monkeypatch.setattr(indexing_main, "BUILD_VERSION", "1.2.3")
    monkeypatch.setattr(indexing_main, "COMMIT_SHA", "abc123def456")

    with caplog.at_level(logging.INFO, logger="indexing_runtime"):
        async with indexing_main.lifespan(indexing_main.app):
            pass

    assert "service.started service=indexing-runtime" in caplog.text
    assert "build_version=1.2.3" in caplog.text
    assert "commit_sha=abc123def456" in caplog.text


@pytest.mark.asyncio
async def test_office_mcp_health_exposes_injected_identity(monkeypatch) -> None:
    from office_mcp_server import main as mcp_main

    monkeypatch.setattr(mcp_main, "BUILD_VERSION", "1.2.3")
    monkeypatch.setattr(mcp_main, "COMMIT_SHA", "abc123def456")

    response = await mcp_main.health_legacy()

    assert response.status_code == 200
    assert json.loads(response.body) == {
        "status": "ok",
        "version": "1.2.3",
        "commit_sha": "abc123def456",
    }


@pytest.mark.asyncio
async def test_office_mcp_liveness_probe_stays_minimal() -> None:
    """§11: `/health/live` is a liveness probe, not an identity endpoint.
    Build identity lives on `/health` and `/version` — do not grow this one."""
    from office_mcp_server.main import health_live

    response = await health_live()

    assert json.loads(response.body) == {"status": "ok"}


@pytest.mark.asyncio
async def test_office_mcp_version_reports_both_kinds_of_version(monkeypatch) -> None:
    """`server_version` (what this MCP server advertises to clients) and
    `build_version`/`commit_sha` (which build is running) answer different
    questions — the endpoint must not collapse them into one."""
    from office_mcp_server import main as mcp_main

    monkeypatch.setattr(mcp_main, "BUILD_VERSION", "1.2.3")
    monkeypatch.setattr(mcp_main, "COMMIT_SHA", "abc123def456")

    body = json.loads((await mcp_main.version()).body)

    assert body["server_version"] == mcp_main.SERVER_VERSION
    assert body["schema_version"] == mcp_main.SCHEMA_VERSION
    assert body["build_version"] == "1.2.3"
    assert body["commit_sha"] == "abc123def456"


def test_defaults_are_honest_when_nothing_is_injected() -> None:
    """A dev process must say `unknown`, never invent a plausible SHA — the
    same "근거 없는 값을 만들지 않는다" rule the rest of this repo follows."""
    from agent_runtime.config import AgentRuntimeSettings
    from indexing_runtime import settings as indexing_settings
    from office_mcp_server import main as mcp_main

    assert AgentRuntimeSettings().commit_sha == "unknown"
    assert indexing_settings.COMMIT_SHA == "unknown"
    assert mcp_main.COMMIT_SHA == "unknown"
