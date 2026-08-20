"""TTL cache in front of `ChatModelSettingResolver` (D-092, open-decisions.md).

The Portal admin chat-model setting would otherwise be checked on every
`/local/v1/runs*` call (`routers/runs.get_llm_adapter`, which builds a fresh
`OllamaLLMAdapter` per run) and every `GET /local/v1/models` call
(`routers/models.py`). Calling portal-api on every single one of those would
put a live network hop's latency on this runtime's chat critical path and
would turn a portal-api hiccup into a chat outage — exactly the coupling
D-092 rules out ("Desktop이 agent-runtime을 직접 부르는 경로가 있어 Portal이
죽으면 채팅도 죽는 구조로 만들 수 없다").

Fail-open design: a refresh failure (connection refused, timeout, non-2xx,
malformed body) NEVER raises to the caller. `ChatModelSettingCache.
get_configured_chat_model` logs one WARNING per failed refresh attempt (not
per call — a call within the TTL window never even reaches the resolver, so
this is already naturally rate-limited to at most once per
`ttl_seconds`) and returns whatever was last known: `None` if there has
never been a successful fetch yet. `None` here is exactly "no Portal
override" and lets the next priority layer win unchanged
(`AGENT_RUNTIME_CHAT_MODEL_ID`/office-profile.json, already baked into
`StandardKnowledgeChatConfig.office_profile` by
`agent_runtime.manifests._load_default_office_profile` — see D-092's
decided priority order: Portal 설정 > `AGENT_RUNTIME_CHAT_MODEL_ID` >
office-profile.json).
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from agent_runtime.adapters import ChatModelSettingResolver

logger = logging.getLogger(__name__)


class ChatModelSettingCache:
    """Wraps a single `ChatModelSettingResolver` with a TTL and a
    fail-open-to-last-known-value fallback. Not thread-safe against
    concurrent `get_configured_chat_model()` calls racing a refresh (a rare,
    harmless double-fetch under this PoC's single-process async event loop
    — the same tolerance `manifests._registry_cache` accepts for its own
    in-memory cache)."""

    def __init__(
        self,
        resolver: ChatModelSettingResolver,
        *,
        ttl_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._resolver = resolver
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        self._cached_value: str | None = None
        self._last_fetch_at: float | None = None

    async def get_configured_chat_model(self) -> str | None:
        now = self._clock()
        if self._last_fetch_at is not None and (now - self._last_fetch_at) < self._ttl_seconds:
            return self._cached_value

        try:
            value = await self._resolver.get_configured_chat_model()
        except Exception as exc:  # httpx errors, connection refused, timeouts, bad body, etc.
            logger.warning(
                "chat_model_setting.portal_api_unreachable error=%s "
                "falling_back_to_cached_value=%s",
                exc,
                self._cached_value,
            )
            # Stamp the fetch time even on failure — otherwise an
            # unreachable portal-api would be retried on literally every
            # call instead of once per TTL window, defeating the point of
            # this cache and re-introducing the outage-coupling D-092 rules
            # out.
            self._last_fetch_at = now
            return self._cached_value

        self._cached_value = value
        self._last_fetch_at = now
        return value


_cache: ChatModelSettingCache | None = None
_cache_lock = threading.Lock()


def get_chat_model_setting_cache() -> ChatModelSettingCache:
    """Process-wide singleton built from `agent_runtime.config.settings` —
    lazy, not a module constant, so tests can point settings at a fake
    portal-api URL/token/TTL and call `reset_chat_model_setting_cache()`
    (same reasoning as `local_agent_registry.get_registry`/this service's
    own `mcp_tool_registry.get_registry`)."""
    global _cache
    with _cache_lock:
        if _cache is None:
            from agent_runtime.adapters.chat_model_setting import HttpChatModelSettingResolver
            from agent_runtime.config import settings

            _cache = ChatModelSettingCache(
                HttpChatModelSettingResolver(
                    portal_api_url=settings.portal_api_url,
                    token=settings.portal_api_token,
                    timeout=settings.chat_model_setting_timeout_seconds,
                ),
                ttl_seconds=settings.chat_model_setting_cache_ttl_seconds,
            )
        return _cache


def reset_chat_model_setting_cache() -> None:
    """Test-only seam — drops the singleton so the next
    `get_chat_model_setting_cache()` picks up freshly patched settings, and
    so one test's cached value never leaks into the next (mirrors
    `local_agent_registry.reset_registry`)."""
    global _cache
    with _cache_lock:
        _cache = None
