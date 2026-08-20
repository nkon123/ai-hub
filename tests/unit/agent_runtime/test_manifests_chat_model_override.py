"""AGENT_RUNTIME_CHAT_MODEL_ID (settings.chat_model_id_override) — D-091,
open-decisions.md.

`manifests._load_default_office_profile` is the single loader shared by
every resolution path (standard/db-agent local copies AND Registry-resolved
configs — see that module's docstring). Covers:

- unset (default) -> office-profile.json's model_id is used byte-for-byte,
  exactly as before this setting existed.
- set -> only `model_aliases["default-chat"].model_id` is overridden;
  `default-embedding` (and everything else in the profile) is untouched.
- the override being applied is logged (never a silent model swap).
"""

from __future__ import annotations

import logging

import pytest
from agent_runtime import manifests
from agent_runtime.config import settings


def test_no_override_leaves_model_id_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "chat_model_id_override", None, raising=False)

    profile = manifests._load_default_office_profile(settings.config_dir)

    assert profile["model_aliases"]["default-chat"]["model_id"] == "exaone3.5:7.8b"


def test_override_replaces_only_default_chat_model_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "chat_model_id_override", "llama3.1:8b", raising=False)

    profile = manifests._load_default_office_profile(settings.config_dir)

    assert profile["model_aliases"]["default-chat"]["model_id"] == "llama3.1:8b"
    # Nothing else in the alias, or any other alias, is touched.
    assert profile["model_aliases"]["default-chat"]["endpoint"] == "http://127.0.0.1:11434"
    assert profile["model_aliases"]["default-embedding"]["model_id"] == "qwen3-embedding:0.6b"


def test_override_application_is_logged(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(settings, "chat_model_id_override", "llama3.1:8b", raising=False)

    with caplog.at_level(logging.INFO, logger="agent_runtime.manifests"):
        manifests._load_default_office_profile(settings.config_dir)

    assert any(
        "chat_model_id_override" in record.getMessage() and "llama3.1:8b" in record.getMessage()
        for record in caplog.records
    )


def test_no_override_does_not_log_override_line(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(settings, "chat_model_id_override", None, raising=False)

    with caplog.at_level(logging.INFO, logger="agent_runtime.manifests"):
        manifests._load_default_office_profile(settings.config_dir)

    assert not any("chat_model_id_override" in record.getMessage() for record in caplog.records)
