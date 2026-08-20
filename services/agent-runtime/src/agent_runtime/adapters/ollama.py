"""LLM adapter backed by a local Ollama server."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from agent_runtime.adapters import LLMAdapter

logger = logging.getLogger(__name__)


class OllamaModelNotFoundError(Exception):
    """Ollama returned HTTP 404 with an `{"error": "model '<id>' not found"}`
    body from `/api/chat` — meaning `model_id` is not installed on the
    Ollama instance at `endpoint`, NOT that the endpoint/route is missing
    (Ollama's own `/api/chat` route exists regardless; a GET to it 405s, it
    never 404s). This is a configuration problem with a one-line fix
    (`ollama pull <model_id>`, or point `model_id` at a model that is
    already installed), and must never be reported to a user the same way
    as "Ollama is unreachable" (connection refused/timeout) or "Ollama
    itself errored" (500) — those need different remedies (실사용 제보
    2026-08-20, see docs/implementation-spec/open-decisions.md).

    `model_id`/`model_alias` are not secrets — safe to log and to surface
    verbatim in an API error response.
    """

    def __init__(self, *, model_id: str, model_alias: str) -> None:
        self.model_id = model_id
        self.model_alias = model_alias
        super().__init__(
            f"Ollama model '{model_id}' (alias '{model_alias}') is not installed"
        )


class OllamaLLMAdapter(LLMAdapter):
    """Calls Ollama's /api/chat streaming endpoint.

    model_aliases: the Office Profile's model_aliases mapping, e.g.
    {"default-chat": {"provider": "ollama", "model_id": "exaone3.5:7.8b",
    "endpoint": "http://127.0.0.1:11434", ...}}
    """

    def __init__(
        self,
        model_aliases: dict[str, dict[str, Any]],
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._model_aliases = model_aliases
        # Test-only hook (httpx.MockTransport) — production callers never
        # pass this, so `httpx.AsyncClient` still opens a real connection to
        # `endpoint` exactly as before.
        self._transport = transport

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

        async for token in self._stream_chat(
            endpoint, model_id, messages, model_alias=model_alias, transport=self._transport
        ):
            yield token

    @staticmethod
    async def _stream_chat(
        endpoint: str,
        model_id: str,
        messages: list[dict[str, Any]],
        *,
        model_alias: str,
        transport: httpx.BaseTransport | None = None,
    ) -> AsyncIterator[str]:
        async with httpx.AsyncClient(timeout=None, transport=transport) as client:
            async with client.stream(
                "POST",
                f"{endpoint}/api/chat",
                json={"model": model_id, "messages": messages, "stream": True},
            ) as response:
                if response.status_code == 404:
                    # Ollama's own /api/chat route always exists (a GET to it
                    # 405s, never 404s) — a 404 here means the model isn't
                    # installed, distinguishable only by reading the body,
                    # never by status code alone. Read it before
                    # raise_for_status() consumes the response.
                    raw_body = await response.aread()
                    error_message = ""
                    try:
                        parsed_body = json.loads(raw_body)
                    except json.JSONDecodeError:
                        parsed_body = None
                    if isinstance(parsed_body, dict):
                        error_message = str(parsed_body.get("error", ""))
                    if "not found" in error_message.lower():
                        raise OllamaModelNotFoundError(
                            model_id=model_id, model_alias=model_alias
                        )
                    # Unrecognized 404 shape — fall through to the generic
                    # HTTP error path rather than guessing.
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
