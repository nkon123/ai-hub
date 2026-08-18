"""Deployment identity checks for the Portal API health contract."""

from __future__ import annotations

import logging

import pytest
from portal_api.config import settings
from portal_api.main import app, lifespan


@pytest.mark.asyncio
async def test_health_exposes_injected_build_identity(client, monkeypatch) -> None:
    monkeypatch.setattr(settings, "build_version", "1.2.3")
    monkeypatch.setattr(settings, "commit_sha", "abc123def456")

    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "version": "1.2.3",
        "commit_sha": "abc123def456",
    }


@pytest.mark.asyncio
async def test_startup_log_identifies_loaded_revision(monkeypatch, caplog) -> None:
    async def _skip_database_initialization() -> None:
        return None

    monkeypatch.setattr("portal_api.main.init_db", _skip_database_initialization)
    monkeypatch.setattr(settings, "build_version", "1.2.3")
    monkeypatch.setattr(settings, "commit_sha", "abc123def456")

    with caplog.at_level(logging.INFO, logger="portal_api.main"):
        async with lifespan(app):
            pass

    assert "service.started service=portal-api" in caplog.text
    assert "build_version=1.2.3" in caplog.text
    assert "commit_sha=abc123def456" in caplog.text
