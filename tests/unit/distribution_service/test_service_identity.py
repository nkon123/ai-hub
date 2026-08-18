"""Deployment identity checks for the Distribution Service."""

from __future__ import annotations

import json
import logging

import pytest
from distribution_service.config import settings
from distribution_service.main import app, health, lifespan


@pytest.mark.asyncio
async def test_health_exposes_injected_build_identity(monkeypatch) -> None:
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
async def test_startup_log_identifies_loaded_revision(monkeypatch, caplog) -> None:
    monkeypatch.setattr(settings, "build_version", "1.2.3")
    monkeypatch.setattr(settings, "commit_sha", "abc123def456")

    with caplog.at_level(logging.INFO, logger="distribution_service.main"):
        async with lifespan(app):
            pass

    assert "service.started service=distribution-service" in caplog.text
    assert "build_version=1.2.3" in caplog.text
    assert "commit_sha=abc123def456" in caplog.text
