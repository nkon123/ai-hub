"""Execution Control — 05-mcp-security-governance.md §8.

Covers Timeout (§8.1), Rate Limit (§8.2, keyed by User+Tool, Agent/Service+
Tool, and whole Server), and Result Limit (§8.3, max row/byte/field length
with `truncated` + limit info on overflow).

§8.1 cancellation propagation: this module runs every tool call under
`asyncio.wait_for`, so a caller (or the ASGI server, on client disconnect)
cancelling the awaiting task raises `asyncio.CancelledError` into the tool
coroutine exactly like a real DB driver's query-cancel would. The Mock
connector has no real in-flight query to cancel (it's synchronous dict
lookups), so this is necessarily a structural guarantee rather than an
end-to-end demonstration against a real driver — noted here rather than
silently assumed.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable
from copy import deepcopy
from typing import TypeVar

from office_mcp_server.errors import ErrorCode, McpError
from office_mcp_server.tool_registry import RegisteredTool

T = TypeVar("T")

# Server-wide ceilings — a single tool's declared execution_guards can never
# exceed these (§8.1 "Server 최대 Timeout", §8.2 "전체 Server" rate limit).
SERVER_MAX_TIMEOUT_SECONDS = 30
SERVER_RATE_LIMIT_PER_MINUTE = 300


async def run_with_timeout(awaitable: Awaitable[T], timeout_seconds: int) -> T:
    effective_timeout = min(timeout_seconds, SERVER_MAX_TIMEOUT_SECONDS)
    try:
        return await asyncio.wait_for(awaitable, timeout=effective_timeout)
    except TimeoutError as exc:
        raise McpError(
            ErrorCode.MCP_EXECUTION_TIMEOUT,
            "Tool 실행이 제한 시간을 초과했습니다.",
            details={"timeout_seconds": effective_timeout},
        ) from exc


class RateLimiter:
    """Fixed-window counter — §8.2 "PoC에서는 보수적인 고정 Limit으로
    시작". Not distributed/persistent; office-mcp-server is a single PoC
    process, so in-memory is sufficient."""

    def __init__(self, window_seconds: float = 60.0) -> None:
        self._window_seconds = window_seconds
        self._counts: dict[str, tuple[int, float]] = {}

    def _count_in_window(self, key: str, now: float) -> int:
        count, start = self._counts.get(key, (0, now))
        if now - start >= self._window_seconds:
            return 0
        return count

    def check_and_record(self, keys_with_limits: list[tuple[str, int]]) -> str | None:
        """All-or-nothing: if any key is already at its limit, nothing is
        recorded and that key is returned. Otherwise every key's counter is
        incremented and None is returned."""
        now = time.monotonic()
        for key, limit in keys_with_limits:
            if self._count_in_window(key, now) >= limit:
                return key
        for key, _limit in keys_with_limits:
            count, start = self._counts.get(key, (0, now))
            if now - start >= self._window_seconds:
                count, start = 0, now
            self._counts[key] = (count + 1, start)
        return None

    def check_tool_call(
        self, *, user_id: str, agent_or_service_id: str, tool_name: str, tool_limit: int
    ) -> None:
        keys = [
            (f"user:{user_id}:{tool_name}", tool_limit),
            (f"actor:{agent_or_service_id}:{tool_name}", tool_limit),
            ("server", SERVER_RATE_LIMIT_PER_MINUTE),
        ]
        over_key = self.check_and_record(keys)
        if over_key is not None:
            raise McpError(
                ErrorCode.RATE_LIMITED,
                "호출 빈도 제한을 초과했습니다. 잠시 후 다시 시도하세요.",
            )


def _truncate_field_strings(item: object, max_len: int) -> tuple[object, bool]:
    if not isinstance(item, dict):
        return item, False
    truncated = False
    new_item: dict = {}
    for key, value in item.items():
        if isinstance(value, str) and len(value) > max_len:
            new_item[key] = value[:max_len] + "…"
            truncated = True
        else:
            new_item[key] = value
    return new_item, truncated


def apply_result_limits(tool: RegisteredTool, output: dict) -> tuple[dict, bool]:
    """§8.3. Operates on any top-level list field in `output` (e.g. `items`,
    `columns`) — caps row count at `max_rows`, truncates long string fields
    at `max_field_length`, then re-checks total serialized size against
    `max_bytes` and trims further if still over budget."""
    result = deepcopy(output)
    truncated = False

    for key, value in list(result.items()):
        if not isinstance(value, list):
            continue
        rows = value
        if len(rows) > tool.max_rows:
            rows = rows[: tool.max_rows]
            truncated = True
        new_rows = []
        for row in rows:
            new_row, field_truncated = _truncate_field_strings(row, tool.max_field_length)
            new_rows.append(new_row)
            truncated = truncated or field_truncated
        result[key] = new_rows

    def _size() -> int:
        return len(json.dumps(result, ensure_ascii=False).encode("utf-8"))

    if _size() > tool.max_bytes:
        for key, value in list(result.items()):
            if not isinstance(value, list):
                continue
            while value and _size() > tool.max_bytes:
                value = value[:-1]
                result[key] = value
                truncated = True

    return result, truncated


def result_limit_info(tool: RegisteredTool) -> dict:
    return {
        "max_rows": tool.max_rows,
        "max_bytes": tool.max_bytes,
        "max_field_length": tool.max_field_length,
    }
