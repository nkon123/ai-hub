"""Portal-configured chat model_id resolver (D-092, open-decisions.md).

`HttpChatModelSettingResolver` is the production implementation of
`ChatModelSettingResolver` (see that interface's docstring in
`agent_runtime.adapters.__init__`). This adapter itself never caches and
never swallows a failure — it raises on any transport/HTTP error, exactly
like `HttpAssetRegistryResolver`/`HttpHubSearchAdapter` do for their own
portal-api calls. TTL caching and the "portal-api unreachable -> keep the
last known value" fallback live one layer up, in
`agent_runtime.chat_model_setting_cache.ChatModelSettingCache` — this module
is deliberately as dumb as `HttpAssetRegistryResolver`.
"""

from __future__ import annotations

import httpx

from agent_runtime.adapters import ChatModelSettingResolver


class HttpChatModelSettingResolver(ChatModelSettingResolver):
    """Calls portal-api's `GET /api/v1/admin/chat-model-setting` —
    `{"configured_model": "<model_id>" | null, "trace_id": "..."}`.

    `token` is the same PoC Test Identity Adapter bearer token (D-001) every
    other portal-api-calling adapter in this service already uses
    (`HttpAssetRegistryResolver`, `HttpHubSearchAdapter`) — not a secret,
    see those adapters' docstrings.
    """

    def __init__(
        self,
        portal_api_url: str,
        token: str,
        *,
        timeout: float = 5.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._portal_api_url = portal_api_url
        self._headers = {"Authorization": f"Bearer {token}"}
        self._timeout = timeout
        # Test-only hook (httpx.MockTransport) — same pattern as
        # `OllamaLLMAdapter`'s `transport` parameter
        # (agent_runtime.adapters.ollama). Production callers never pass
        # this, so `httpx.AsyncClient` still opens a real connection.
        self._transport = transport

    async def get_configured_chat_model(self) -> str | None:
        async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
            response = await client.get(
                f"{self._portal_api_url}/api/v1/admin/chat-model-setting",
                headers=self._headers,
            )
            response.raise_for_status()
            body = response.json()
        return body.get("configured_model")
