"""LLM adapter backed by a local Ollama server."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from agent_runtime.adapters import LLMAdapter

logger = logging.getLogger(__name__)


class OllamaLLMAdapter(LLMAdapter):
    """Calls Ollama's /api/chat streaming endpoint.

    model_aliases: the Office Profile's model_aliases mapping, e.g.
    {"default-chat": {"provider": "ollama", "model_id": "exaone3.5:7.8b",
    "endpoint": "http://127.0.0.1:11434", ...}}
    """

    def __init__(self, model_aliases: dict[str, dict[str, Any]]) -> None:
        self._model_aliases = model_aliases

    # LLMAdapter.generate is declared `async def ... -> AsyncIterator[str]` in
    # the frozen ABC (agent_runtime/adapters/__init__.py, not modifiable here).
    # Implemented as an async generator (uses `yield`) so callers can
    # `async for` it directly without awaiting first; mypy sees this as a
    # Coroutine[..., AsyncIterator[str]] vs AsyncIterator[str] mismatch against
    # the supertype even though the runtime contract (and workflow.py's usage)
    # requires the generator form.
    async def generate(  # type: ignore[override, misc]
        self,
        messages: list[dict[str, Any]],
        model_alias: str,
        stream: bool = True,
    ) -> AsyncIterator[str]:
        alias_config = self._model_aliases.get(model_alias)
        if alias_config is None:
            raise ValueError(f"Unknown model_alias: {model_alias}")

        model_id = alias_config["model_id"]
        endpoint = alias_config["endpoint"]

        async for token in self._stream_chat(endpoint, model_id, messages):
            yield token

    @staticmethod
    async def _stream_chat(
        endpoint: str,
        model_id: str,
        messages: list[dict[str, Any]],
    ) -> AsyncIterator[str]:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST",
                f"{endpoint}/api/chat",
                json={"model": model_id, "messages": messages, "stream": True},
            ) as response:
                response.raise_for_status()
                async for raw_line in response.aiter_lines():
                    if not raw_line.strip():
                        continue
                    line = json.loads(raw_line)
                    content = line.get("message", {}).get("content")
                    if content:
                        yield content
                    if line.get("done"):
                        break
