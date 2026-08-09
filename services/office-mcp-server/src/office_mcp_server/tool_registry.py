"""MCP Tool Registry — READ_ONLY tools only. 05-mcp-security-governance.md §4.

Carries every piece of metadata §4 requires per tool: name+version,
description, Input/Output Schema, risk level, required permission (roles +
orgs + sites), timeout, max result byte/row, rate limit, user confirmation
policy, data classification, owner, and active/suspended status (the Kill
Switch — §11 `POST /admin/tools/{name}/disable`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class UserConfirmationPolicy(StrEnum):
    """§8.4."""

    NEVER = "NEVER"
    ALWAYS = "ALWAYS"
    ON_PARAMETER = "ON_PARAMETER"


class ToolStatus(StrEnum):
    ACTIVE = "ACTIVE"
    DISABLED = "DISABLED"


@dataclass(frozen=True)
class RegisteredTool:
    name: str
    version: str
    server_alias: str
    description: str
    input_schema: dict
    output_schema: dict
    risk_level: str = "READ_ONLY"
    allowed_roles: tuple[str, ...] = field(default_factory=tuple)
    allowed_orgs: tuple[str, ...] = field(default_factory=tuple)
    allowed_sites: tuple[str, ...] = field(default_factory=tuple)
    timeout_seconds: int = 10
    max_rows: int = 100
    max_bytes: int = 65536
    max_field_length: int = 500
    rate_limit_per_minute: int = 30
    user_confirmation_policy: UserConfirmationPolicy = UserConfirmationPolicy.NEVER
    classification: str = "INTERNAL"
    owner: str = "platform-team@miracom.com"

    def summary(self) -> dict:
        """Shape returned by `GET /mcp/v1/tools` and `GET /admin/tools`."""
        return {
            "name": self.name,
            "version": self.version,
            "server_alias": self.server_alias,
            "description": self.description,
            "input_schema": self.input_schema,
            "output_schema": self.output_schema,
            "risk_level": self.risk_level,
            "permissions": {
                "allowed_roles": list(self.allowed_roles),
                "allowed_orgs": list(self.allowed_orgs),
                "allowed_sites": list(self.allowed_sites),
            },
            "execution_guards": {
                "timeout_seconds": self.timeout_seconds,
                "max_rows": self.max_rows,
                "max_bytes": self.max_bytes,
                "max_field_length": self.max_field_length,
                "rate_limit_per_minute": self.rate_limit_per_minute,
                "user_confirmation_policy": self.user_confirmation_policy.value,
            },
            "classification": self.classification,
            "owner": self.owner,
        }


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, RegisteredTool] = {}
        self._status: dict[str, ToolStatus] = {}

    def register(self, tool: RegisteredTool) -> None:
        if tool.risk_level != "READ_ONLY":
            raise ValueError(f"PoC policy: only READ_ONLY tools allowed, got {tool.risk_level}")
        self._tools[tool.name] = tool
        self._status.setdefault(tool.name, ToolStatus.ACTIVE)

    def get(self, name: str) -> RegisteredTool | None:
        return self._tools.get(name)

    def list_all(self) -> list[RegisteredTool]:
        return list(self._tools.values())

    def status_of(self, name: str) -> ToolStatus | None:
        return self._status.get(name)

    def is_active(self, name: str) -> bool:
        return self._status.get(name) == ToolStatus.ACTIVE

    def disable(self, name: str) -> bool:
        """Kill Switch. Returns False if the tool is not registered."""
        if name not in self._tools:
            return False
        self._status[name] = ToolStatus.DISABLED
        return True

    def enable(self, name: str) -> bool:
        if name not in self._tools:
            return False
        self._status[name] = ToolStatus.ACTIVE
        return True

    def admin_list(self) -> list[dict]:
        return [
            {**tool.summary(), "status": self._status[name].value}
            for name, tool in self._tools.items()
        ]
