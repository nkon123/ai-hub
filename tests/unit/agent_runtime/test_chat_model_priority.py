"""`routers.runs.get_llm_adapter` — the D-092 (open-decisions.md) 3-tier
chat model priority as it's actually applied on every Run: Portal admin
setting > `AGENT_RUNTIME_CHAT_MODEL_ID` > office-profile.json.

The bottom two tiers are already baked into `StandardKnowledgeChatConfig
.office_profile` at load time by `manifests._load_default_office_profile`
(covered by `test_manifests_chat_model_override.py`) — this file covers the
top tier: that `get_llm_adapter` re-checks the Portal setting on every call
and, when present, wins over whatever office_profile already contains,
without mutating the shared cached config.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from agent_runtime.routers import runs as runs_router


@dataclass
class _FakeStandardConfig:
    office_profile: dict[str, Any]


class _FakeCache:
    def __init__(self, configured_model: str | None) -> None:
        self._configured_model = configured_model
        self.call_count = 0

    async def get_configured_chat_model(self) -> str | None:
        self.call_count += 1
        return self._configured_model


def _office_profile(model_id: str) -> dict[str, Any]:
    return {
        "model_aliases": {
            "default-chat": {
                "provider": "ollama",
                "model_id": model_id,
                "endpoint": "http://127.0.0.1:11434",
            },
            "default-embedding": {
                "provider": "ollama",
                "model_id": "qwen3-embedding:0.6b",
                "endpoint": "http://127.0.0.1:11434",
            },
        }
    }


async def test_no_portal_setting_uses_office_profile_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Represents both "nothing configured anywhere" and "only
    AGENT_RUNTIME_CHAT_MODEL_ID is set" — either way, by the time
    get_llm_adapter runs, that value already lives in office_profile
    (manifests._load_default_office_profile's job, tested separately)."""
    profile = _office_profile("exaone3.5:7.8b")
    monkeypatch.setattr(
        runs_router, "get_standard_config", lambda: _FakeStandardConfig(profile)
    )
    monkeypatch.setattr(runs_router, "get_chat_model_setting_cache", lambda: _FakeCache(None))

    adapter = await runs_router.get_llm_adapter()

    assert adapter._model_aliases["default-chat"]["model_id"] == "exaone3.5:7.8b"


async def test_portal_setting_overrides_office_profile_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = _office_profile("exaone3.5:7.8b")
    monkeypatch.setattr(
        runs_router, "get_standard_config", lambda: _FakeStandardConfig(profile)
    )
    monkeypatch.setattr(
        runs_router, "get_chat_model_setting_cache", lambda: _FakeCache("llama3.1:8b")
    )

    adapter = await runs_router.get_llm_adapter()

    assert adapter._model_aliases["default-chat"]["model_id"] == "llama3.1:8b"


async def test_portal_setting_only_touches_default_chat_alias(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = _office_profile("exaone3.5:7.8b")
    monkeypatch.setattr(
        runs_router, "get_standard_config", lambda: _FakeStandardConfig(profile)
    )
    monkeypatch.setattr(
        runs_router, "get_chat_model_setting_cache", lambda: _FakeCache("llama3.1:8b")
    )

    adapter = await runs_router.get_llm_adapter()

    assert adapter._model_aliases["default-chat"]["endpoint"] == "http://127.0.0.1:11434"
    assert adapter._model_aliases["default-embedding"]["model_id"] == "qwen3-embedding:0.6b"


async def test_portal_setting_override_does_not_mutate_cached_office_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`StandardKnowledgeChatConfig.office_profile` is a module-level cached
    object shared across every run (`manifests._cached_config`) — building
    the Portal-overridden alias set must never mutate it in place, or one
    run's Portal-configured model would leak into every other run that
    happens to read the cached config directly."""
    profile = _office_profile("exaone3.5:7.8b")
    monkeypatch.setattr(
        runs_router, "get_standard_config", lambda: _FakeStandardConfig(profile)
    )
    monkeypatch.setattr(
        runs_router, "get_chat_model_setting_cache", lambda: _FakeCache("llama3.1:8b")
    )

    await runs_router.get_llm_adapter()

    assert profile["model_aliases"]["default-chat"]["model_id"] == "exaone3.5:7.8b"


async def test_portal_setting_is_only_fetched_once_per_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = _office_profile("exaone3.5:7.8b")
    fake_cache = _FakeCache("llama3.1:8b")
    monkeypatch.setattr(
        runs_router, "get_standard_config", lambda: _FakeStandardConfig(profile)
    )
    monkeypatch.setattr(runs_router, "get_chat_model_setting_cache", lambda: fake_cache)

    await runs_router.get_llm_adapter()

    assert fake_cache.call_count == 1
