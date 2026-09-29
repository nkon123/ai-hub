"""The chat-model override must be settable by the name the docs give.

Docs, `.env.example` and log lines all say `AGENT_RUNTIME_CHAT_MODEL_ID`, but
until 2026-09-29 the field only read `AGENT_RUNTIME_CHAT_MODEL_ID_OVERRIDE`
(env_prefix + field name), so following the docs was silently ignored and
every runtime turn called an uninstalled model. The other tests of this
setting patch the attribute directly and never exercised the name.
"""

from __future__ import annotations

import pytest
from agent_runtime.config import AgentRuntimeSettings


@pytest.mark.parametrize(
    "name", ["AGENT_RUNTIME_CHAT_MODEL_ID", "AGENT_RUNTIME_CHAT_MODEL_ID_OVERRIDE"]
)
def test_either_env_name_sets_the_override(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    monkeypatch.delenv("AGENT_RUNTIME_CHAT_MODEL_ID", raising=False)
    monkeypatch.delenv("AGENT_RUNTIME_CHAT_MODEL_ID_OVERRIDE", raising=False)
    monkeypatch.setenv(name, "gemma4:latest")
    assert AgentRuntimeSettings(_env_file=None).chat_model_id_override == "gemma4:latest"


def test_unset_means_no_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENT_RUNTIME_CHAT_MODEL_ID", raising=False)
    monkeypatch.delenv("AGENT_RUNTIME_CHAT_MODEL_ID_OVERRIDE", raising=False)
    assert AgentRuntimeSettings(_env_file=None).chat_model_id_override is None


def test_keyword_construction_still_works() -> None:
    assert (
        AgentRuntimeSettings(_env_file=None, chat_model_id_override="x:1").chat_model_id_override
        == "x:1"
    )
