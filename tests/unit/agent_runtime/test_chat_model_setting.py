"""Portal-configured chat model_id resolver + TTL cache (D-092,
open-decisions.md).

Covers, at the unit level (no real portal-api process):

- `HttpChatModelSettingResolver` parses portal-api's
  `{"configured_model": ..., "trace_id": ...}` shape (both a real value and
  `null`), and raises (never silently returns `None`) on a transport
  failure — `httpx.MockTransport`, same pattern as
  `test_ollama_adapter.py`.
- `ChatModelSettingCache` TTL: a fetch within the TTL window never calls
  the resolver again.
- `ChatModelSettingCache` fail-open: a resolver failure never raises to the
  caller — it returns the last known value (or `None` if there has never
  been a successful fetch), and only refreshes its fetch timestamp on
  failure too, so an unreachable portal-api is retried once per TTL window,
  not once per call (no WARNING-log spam, no request-per-call retry storm).
"""

from __future__ import annotations

import logging

import httpx
import pytest
from agent_runtime.adapters.chat_model_setting import HttpChatModelSettingResolver
from agent_runtime.chat_model_setting_cache import ChatModelSettingCache

# --- HttpChatModelSettingResolver ---


async def test_resolver_returns_configured_model() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer dev-user-token"
        return httpx.Response(200, json={"configured_model": "llama3.1:8b", "trace_id": "t-1"})

    resolver = HttpChatModelSettingResolver(
        "http://portal-api.test", "dev-user-token", transport=httpx.MockTransport(handler)
    )

    assert await resolver.get_configured_chat_model() == "llama3.1:8b"


async def test_resolver_returns_none_when_unset() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"configured_model": None, "trace_id": "t-2"})

    resolver = HttpChatModelSettingResolver(
        "http://portal-api.test", "dev-user-token", transport=httpx.MockTransport(handler)
    )

    assert await resolver.get_configured_chat_model() is None


async def test_resolver_raises_on_connection_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    resolver = HttpChatModelSettingResolver(
        "http://portal-api.test", "dev-user-token", transport=httpx.MockTransport(handler)
    )

    with pytest.raises(httpx.ConnectError):
        await resolver.get_configured_chat_model()


async def test_resolver_raises_on_server_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"code": "INTERNAL", "message": "boom"}})

    resolver = HttpChatModelSettingResolver(
        "http://portal-api.test", "dev-user-token", transport=httpx.MockTransport(handler)
    )

    with pytest.raises(httpx.HTTPStatusError):
        await resolver.get_configured_chat_model()


# --- ChatModelSettingCache ---


class _FakeResolver:
    """Counts calls; raises `error_to_raise` if set, else returns `value`."""

    def __init__(self, value: str | None = None, error_to_raise: Exception | None = None) -> None:
        self.value = value
        self.error_to_raise = error_to_raise
        self.call_count = 0

    async def get_configured_chat_model(self) -> str | None:
        self.call_count += 1
        if self.error_to_raise is not None:
            raise self.error_to_raise
        return self.value


class _FakeClock:
    def __init__(self, start: float = 0.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


async def test_cache_returns_resolver_value_on_first_call() -> None:
    resolver = _FakeResolver(value="llama3.1:8b")
    cache = ChatModelSettingCache(resolver, ttl_seconds=30.0, clock=_FakeClock())

    assert await cache.get_configured_chat_model() == "llama3.1:8b"
    assert resolver.call_count == 1


async def test_cache_does_not_refetch_within_ttl() -> None:
    resolver = _FakeResolver(value="llama3.1:8b")
    clock = _FakeClock()
    cache = ChatModelSettingCache(resolver, ttl_seconds=30.0, clock=clock)

    await cache.get_configured_chat_model()
    clock.now += 10.0  # still within the 30s TTL
    await cache.get_configured_chat_model()
    clock.now += 5.0
    await cache.get_configured_chat_model()

    assert resolver.call_count == 1


async def test_cache_refetches_after_ttl_expires() -> None:
    resolver = _FakeResolver(value="llama3.1:8b")
    clock = _FakeClock()
    cache = ChatModelSettingCache(resolver, ttl_seconds=30.0, clock=clock)

    await cache.get_configured_chat_model()
    clock.now += 31.0  # past the TTL
    await cache.get_configured_chat_model()

    assert resolver.call_count == 2


async def test_cache_falls_back_to_last_known_value_on_failure() -> None:
    resolver = _FakeResolver(value="llama3.1:8b")
    clock = _FakeClock()
    cache = ChatModelSettingCache(resolver, ttl_seconds=30.0, clock=clock)

    assert await cache.get_configured_chat_model() == "llama3.1:8b"

    # portal-api goes unreachable on the next refresh.
    resolver.error_to_raise = httpx.ConnectError("connection refused")
    clock.now += 31.0

    assert await cache.get_configured_chat_model() == "llama3.1:8b"


async def test_cache_returns_none_when_first_fetch_ever_fails() -> None:
    """No successful fetch has ever happened -> None, which is exactly "no
    Portal override" and lets AGENT_RUNTIME_CHAT_MODEL_ID/office-profile.json
    win, unchanged (D-092)."""
    resolver = _FakeResolver(error_to_raise=httpx.ConnectError("connection refused"))
    cache = ChatModelSettingCache(resolver, ttl_seconds=30.0, clock=_FakeClock())

    assert await cache.get_configured_chat_model() is None


async def test_cache_failure_never_raises_to_caller() -> None:
    resolver = _FakeResolver(error_to_raise=RuntimeError("unexpected"))
    cache = ChatModelSettingCache(resolver, ttl_seconds=30.0, clock=_FakeClock())

    # Must not raise.
    await cache.get_configured_chat_model()


async def test_cache_does_not_retry_every_call_while_unreachable(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A failed refresh still stamps the fetch time, so repeated calls
    within the TTL window (even while portal-api stays unreachable) neither
    re-call the resolver nor log another WARNING — otherwise every LLM call
    would retry portal-api and the log would be spammed with an identical
    line."""
    resolver = _FakeResolver(error_to_raise=httpx.ConnectError("connection refused"))
    clock = _FakeClock()
    cache = ChatModelSettingCache(resolver, ttl_seconds=30.0, clock=clock)

    with caplog.at_level(logging.WARNING, logger="agent_runtime.chat_model_setting_cache"):
        await cache.get_configured_chat_model()
        clock.now += 5.0
        await cache.get_configured_chat_model()
        clock.now += 5.0
        await cache.get_configured_chat_model()

    assert resolver.call_count == 1
    warning_lines = [
        r for r in caplog.records if "portal_api_unreachable" in r.getMessage()
    ]
    assert len(warning_lines) == 1
