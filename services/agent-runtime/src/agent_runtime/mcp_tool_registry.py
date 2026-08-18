"""D-080: registration table that turns an *installed* MCP Tool asset into a
*callable* one.

The gap this closes. D-079 solved the Knowledge half of "installed but not
usable" — a Knowledge that arrived as an Offline Bundle needed to be
registered with search-runtime before `hybrid_search` would look at its
directory. MCP Tools have the same "설치됨" != "호출 가능" gap: Desktop can
install an MCP Tool asset, but `agent_runtime.mcp_tools.MCP_TOOL_SPECS` is a
hand-copied static table of the 3 built-in office-mcp-server tools (see that
module's docstring), and `workflow.py`'s ANALYZE stage refuses any tool name
that is not a key in that table with "알 수 없는 Tool입니다" — *even if* an
operator has already added the tool to the Office Profile's
`allowed_mcp_servers[].allowed_tools`. This module lets a caller supply the
missing `input_schema`/`confirmation_policy` for such a tool, so ANALYZE can
validate against it instead of refusing outright.

Why this is the harder half of D-079/D-080, and the design that keeps it
safe: registering a Knowledge index only affects *what search-runtime reads
back* — worst case, a bad registration returns wrong or no citations.
Registering an MCP Tool affects *what agent-runtime is willing to execute* —
a bad registration could, in principle, manufacture a network destination or
weaken a confirmation gate on a tool that already runs with elevated (if
READ_ONLY) trust. So registration here is deliberately unable to grant
anything the deployment did not already grant through its own Office
Profile and static tool table:

1. No `endpoint`/`server_url`/anything network-shaped is accepted anywhere
   in this contract (구현 원칙 7 — no arbitrary external URL). The endpoint a
   call actually dispatches to always comes from
   `office_profile["allowed_mcp_servers"]` (`mcp_tools.resolve_allowed_alias`,
   unchanged by this module) — registration only ever supplies
   `input_schema`/`confirmation_policy` metadata for a `tool_name` that is
   already present in that Office Profile server's `allowed_tools` list. A
   registration naming a `tool_name`/`server_alias` the Office Profile does
   not already permit is refused before it is ever stored
   (`server_alias_not_in_profile`, `tool_not_in_server_allowlist`) — this is
   what "registration may only describe what the deployment already
   permits, never widen it" means concretely.
2. `mcp_tool_registration_allowed_aliases` (config.py, empty by default,
   exactly like search-runtime's `LOCAL_INDEX_ROOTS`) is a second,
   independent gate on top of (1): even a `server_alias` the Office Profile
   already permits cannot be targeted by a *dynamic* registration unless an
   operator has explicitly opted that alias in. A deployment that never sets
   this refuses every registration (`mcp_tool_registration_disabled`),
   fail-closed.
3. `risk_level` must be exactly `"READ_ONLY"` (구현 원칙 8 — this PoC's MCP
   surface is read-only end to end); anything else is refused
   (`risk_level_not_read_only`).
4. Built-ins are never shadowed. `mcp_tools._spec_for` (the single
   resolution chokepoint `validate_tool_input`/`confirmation_policy_for` use)
   checks `MCP_TOOL_SPECS` first, unconditionally, and only falls back to
   this registry for a `tool_name` that is not a built-in. A registration
   naming an existing built-in tool_name is still accepted and stored (so an
   operator can, for instance, pre-stage a stricter future default) but is
   provably inert for schema/policy resolution as long as that ordering
   holds — see `mcp_tools.py`'s own tests. The one property this module
   *does* enforce at registration time, as defense in depth in case that
   ordering ever changes: a registration colliding with a built-in name may
   only tighten — a refused attempt raises `confirmation_policy_weaker_than_builtin` — never loosen,
   the built-in's confirmation policy (NEVER < ON_PARAMETER < ALWAYS) — a
   Bundle must never be able to turn a confirm-required built-in into a
   silently-callable one.
5. `input_schema` must be a structurally valid JSON Schema and must not
   declare an identity-shaped field (`user`/`role`/`org`/`roles`) — mirrors
   office-mcp-server's own completed-before-check ("Tool의 input_schema가
   user/role/org 같은 신원 필드를 절대 선언하지 않는가",
   `services/office-mcp-server/CLAUDE.md`). Identity only ever travels
   through the server-built `audit_context`, never through caller-supplied
   tool input — a registered schema that tried to accept an identity field
   would be an injection vector for role spoofing.

Defense in depth this module does NOT replace: office-mcp-server
independently re-validates every call against its own authoritative
`tools_setup.py` schema before touching the Connector (see that service's
`pipeline.py`). A loose or stale schema registered here can only cause a
downstream `MCP_INPUT_INVALID`-shaped rejection at the real server — it can
never cause an unauthorized call to actually execute, because this
service's schema check is a pre-flight convenience, not the authority. The
authority is (a) the Office Profile allowlist unchanged by this module, and
(b) office-mcp-server's own registry.

Consequence stated plainly (per this feature's design brief): installing a
new MCP Tool asset does NOT by itself make it callable. An operator still
has to add the tool to `office-profile.json`'s `allowed_tools` for the
relevant server AND opt that server alias into
`mcp_tool_registration_allowed_aliases` before a registration for that tool
can even be accepted. Granting execution permission stays an explicit
operator action, never a side effect of installing a Bundle.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

from agent_runtime import mcp_tools as _mcp_tools

_logger = logging.getLogger(__name__)

READ_ONLY = "READ_ONLY"

_CONFIRMATION_RANK: dict[str, int] = {
    _mcp_tools.NEVER: 0,
    _mcp_tools.ON_PARAMETER: 1,
    _mcp_tools.ALWAYS: 2,
}

# Conservative allowlist-shaped tool name: this value is never used to build
# a filesystem path (unlike D-079's knowledge_id), but it does flow into the
# MCP audit trail and office-mcp-server's own tool lookup, so it is
# constrained the same defensive way — no free-form text.
_TOOL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$")

# Same set office-mcp-server's request_context.py keeps identity fields out
# of Tool `input` for — a registered schema must not re-open that door.
_FORBIDDEN_SCHEMA_FIELDS = frozenset({"user", "role", "roles", "org", "organization_id"})

MAX_LABEL_LENGTH = 200
MAX_TOOL_NAME_LENGTH = 128


class MCPToolRegistrationError(Exception):
    """A registration/validation refusal — carries the central error code
    (07-data-api-contracts.md §8) and a machine-readable `reason` for the
    Error Envelope's `details`, same shape as search-runtime's
    `LocalIndexError` (D-079)."""

    def __init__(self, code: str, reason: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.reason = reason
        self.message = message

    @property
    def details(self) -> dict[str, str]:
        return {"reason": self.reason}


@dataclass(frozen=True)
class MCPToolRegistrationEntry:
    tool_name: str
    server_alias: str
    input_schema: dict[str, Any]
    confirmation_policy: str
    risk_level: str
    label: str | None
    registered_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "tool_name": self.tool_name,
            "server_alias": self.server_alias,
            "input_schema": self.input_schema,
            "confirmation_policy": self.confirmation_policy,
            "risk_level": self.risk_level,
            "label": self.label,
            "registered_at": self.registered_at,
        }

    @staticmethod
    def from_dict(raw: object) -> MCPToolRegistrationEntry | None:
        """Parses one persisted row, returning None for anything malformed —
        one unreadable row must not take the whole registry down (D-079's
        `LocalIndexEntry.from_dict` precedent)."""
        if not isinstance(raw, dict):
            return None
        tool_name = raw.get("tool_name")
        server_alias = raw.get("server_alias")
        input_schema = raw.get("input_schema")
        confirmation_policy = raw.get("confirmation_policy")
        risk_level = raw.get("risk_level")
        registered_at = raw.get("registered_at")
        if not (
            isinstance(tool_name, str)
            and isinstance(server_alias, str)
            and isinstance(input_schema, dict)
            and isinstance(confirmation_policy, str)
            and isinstance(risk_level, str)
            and isinstance(registered_at, str)
        ):
            return None
        label = raw.get("label")
        return MCPToolRegistrationEntry(
            tool_name=tool_name,
            server_alias=server_alias,
            input_schema=input_schema,
            confirmation_policy=confirmation_policy,
            risk_level=risk_level,
            label=label if isinstance(label, str) else None,
            registered_at=registered_at,
        )


def _server_by_alias(office_profile: dict[str, Any], alias: str) -> dict[str, Any] | None:
    for server in office_profile.get("allowed_mcp_servers", []):
        if server.get("alias") == alias:
            return server
    return None


class MCPToolRegistry:
    """Persistent registration table — one instance per process (see
    `get_registry`). Mirrors `search_runtime.local_index_registry
    .LocalIndexRegistry`'s shape: every mutation rewrites the whole JSON
    file under a lock, and every read re-validates against *current*
    settings/Office Profile rather than trusting what was true at
    registration time (an operator narrowing `allowed_tools` afterwards must
    take effect immediately)."""

    def __init__(
        self,
        registry_path: str | Path,
        allowed_aliases: tuple[str, ...],
        office_profile_provider: Callable[[], dict[str, Any]],
    ) -> None:
        self._registry_path = Path(registry_path)
        self._allowed_aliases = frozenset(allowed_aliases)
        self._office_profile_provider = office_profile_provider
        self._lock = threading.Lock()
        self._cache: tuple[tuple[int, int], list[MCPToolRegistrationEntry]] | None = None

    @property
    def enabled(self) -> bool:
        """False when no server alias is opted into dynamic registration for
        this deployment (the default) — registration is off."""
        return len(self._allowed_aliases) > 0

    # -- persistence --------------------------------------------------------

    def _read_all(self) -> list[MCPToolRegistrationEntry]:
        try:
            stat = self._registry_path.stat()
        except OSError:
            return []
        key = (stat.st_mtime_ns, stat.st_size)
        cached = self._cache
        if cached is not None and cached[0] == key:
            return cached[1]
        try:
            raw = json.loads(self._registry_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _logger.error("agent_runtime.mcp_tool_registry.registry_unreadable")
            return []
        if not isinstance(raw, list):
            _logger.error("agent_runtime.mcp_tool_registry.registry_malformed")
            return []
        entries = [
            e for e in (MCPToolRegistrationEntry.from_dict(row) for row in raw) if e is not None
        ]
        self._cache = (key, entries)
        return entries

    def _write_all(self, entries: list[MCPToolRegistrationEntry]) -> None:
        self._cache = None
        self._registry_path.parent.mkdir(parents=True, exist_ok=True)
        self._registry_path.write_text(
            json.dumps([e.to_dict() for e in entries], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # -- validation ---------------------------------------------------------

    def _require_enabled(self) -> None:
        if not self.enabled:
            raise MCPToolRegistrationError(
                "PERMISSION_DENIED",
                "mcp_tool_registration_disabled",
                "이 배포는 동적 MCP Tool 등록을 허용하지 않습니다 "
                "(AGENT_RUNTIME_MCP_TOOL_REGISTRATION_ALLOWED_ALIASES 미설정).",
            )

    def _validate(
        self,
        tool_name: str,
        server_alias: str,
        input_schema: dict[str, Any],
        confirmation_policy: str,
        risk_level: str,
        label: str | None,
    ) -> None:
        self._require_enabled()

        if not isinstance(tool_name, str) or not _TOOL_NAME_PATTERN.match(tool_name):
            raise MCPToolRegistrationError(
                "VALIDATION_ERROR",
                "tool_name_invalid",
                "tool_name은 'server.action' 형태의 이름이어야 합니다.",
            )
        if len(tool_name) > MAX_TOOL_NAME_LENGTH:
            raise MCPToolRegistrationError(
                "VALIDATION_ERROR",
                "tool_name_invalid",
                f"tool_name은 {MAX_TOOL_NAME_LENGTH}자를 넘을 수 없습니다.",
            )

        if risk_level != READ_ONLY:
            raise MCPToolRegistrationError(
                "VALIDATION_ERROR",
                "risk_level_not_read_only",
                "risk_level은 READ_ONLY만 등록할 수 있습니다 (구현 원칙 8).",
            )

        if confirmation_policy not in _CONFIRMATION_RANK:
            raise MCPToolRegistrationError(
                "VALIDATION_ERROR",
                "confirmation_policy_invalid",
                "confirmation_policy는 NEVER/ON_PARAMETER/ALWAYS 중 하나여야 합니다.",
            )

        if label is not None and len(label) > MAX_LABEL_LENGTH:
            raise MCPToolRegistrationError(
                "VALIDATION_ERROR",
                "label_too_long",
                f"label은 {MAX_LABEL_LENGTH}자를 넘을 수 없습니다.",
            )

        office_profile = self._office_profile_provider()
        server = _server_by_alias(office_profile, server_alias)
        if server is None:
            raise MCPToolRegistrationError(
                "VALIDATION_ERROR",
                "server_alias_not_in_profile",
                "Office Profile에 등록되지 않은 server_alias입니다 — "
                "먼저 office-profile.json에 서버를 추가해야 합니다.",
            )

        if server_alias not in self._allowed_aliases:
            raise MCPToolRegistrationError(
                "PERMISSION_DENIED",
                "server_alias_not_allowed_for_registration",
                "이 server_alias는 동적 Tool 등록이 허용되지 않았습니다 — "
                "운영자가 AGENT_RUNTIME_MCP_TOOL_REGISTRATION_ALLOWED_ALIASES에 "
                "추가해야 합니다.",
            )

        if tool_name not in (server.get("allowed_tools") or []):
            raise MCPToolRegistrationError(
                "PERMISSION_DENIED",
                "tool_not_in_server_allowlist",
                "Office Profile의 이 서버 allowed_tools에 없는 Tool입니다 — "
                "등록은 이미 허용된 실행 권한을 설명할 뿐, 새로 부여하지 않습니다.",
            )

        if not isinstance(input_schema, dict):
            raise MCPToolRegistrationError(
                "VALIDATION_ERROR",
                "input_schema_invalid",
                "input_schema는 JSON Schema 객체여야 합니다.",
            )
        try:
            Draft202012Validator.check_schema(input_schema)
        except SchemaError:
            raise MCPToolRegistrationError(
                "VALIDATION_ERROR",
                "input_schema_invalid",
                "input_schema가 올바른 JSON Schema가 아닙니다.",
            ) from None

        declared_fields = set((input_schema.get("properties") or {}).keys())
        if declared_fields & _FORBIDDEN_SCHEMA_FIELDS:
            raise MCPToolRegistrationError(
                "VALIDATION_ERROR",
                "input_schema_declares_identity_field",
                "input_schema는 user/role/org 같은 신원 필드를 선언할 수 없습니다 "
                "— 신원은 audit_context로만 전달됩니다.",
            )

        builtin = _mcp_tools.MCP_TOOL_SPECS.get(tool_name)
        if builtin is not None:
            builtin_rank = _CONFIRMATION_RANK[builtin["confirmation_policy"]]
            requested_rank = _CONFIRMATION_RANK[confirmation_policy]
            if requested_rank < builtin_rank:
                raise MCPToolRegistrationError(
                    "PERMISSION_DENIED",
                    "confirmation_policy_weaker_than_builtin",
                    "내장 Tool보다 느슨한 confirmation_policy로는 등록할 수 없습니다 "
                    f"(내장값: {builtin['confirmation_policy']}).",
                )

    def _still_valid(self, entry: MCPToolRegistrationEntry) -> bool:
        """Cheap re-validation applied on every read/resolve — what can
        change after registration is the Office Profile (an operator
        narrows `allowed_tools` or removes the server) and this
        deployment's `allowed_aliases` (an operator revokes the opt-in).
        Both must take effect immediately."""
        if not self.enabled or entry.server_alias not in self._allowed_aliases:
            return False
        office_profile = self._office_profile_provider()
        server = _server_by_alias(office_profile, entry.server_alias)
        if server is None:
            return False
        return entry.tool_name in (server.get("allowed_tools") or [])

    # -- public operations ---------------------------------------------------

    def register(
        self,
        tool_name: str,
        server_alias: str,
        input_schema: dict[str, Any],
        confirmation_policy: str,
        risk_level: str,
        label: str | None = None,
    ) -> MCPToolRegistrationEntry:
        self._validate(
            tool_name, server_alias, input_schema, confirmation_policy, risk_level, label
        )
        entry = MCPToolRegistrationEntry(
            tool_name=tool_name,
            server_alias=server_alias,
            input_schema=input_schema,
            confirmation_policy=confirmation_policy,
            risk_level=risk_level,
            label=label,
            registered_at=datetime.now(UTC).isoformat(),
        )
        with self._lock:
            kept = [e for e in self._read_all() if e.tool_name != tool_name]
            kept.append(entry)
            self._write_all(kept)
        _logger.info(
            "agent_runtime.mcp_tool_registry.registered tool_name=%s server_alias=%s",
            tool_name,
            server_alias,
        )
        return entry

    def unregister(self, tool_name: str) -> bool:
        with self._lock:
            all_entries = self._read_all()
            kept = [e for e in all_entries if e.tool_name != tool_name]
            if len(kept) == len(all_entries):
                return False
            self._write_all(kept)
        _logger.info("agent_runtime.mcp_tool_registry.unregistered tool_name=%s", tool_name)
        return True

    def list_entries(self) -> list[MCPToolRegistrationEntry]:
        """Registered entries that would actually be used right now. An
        entry that no longer passes re-validation is omitted rather than
        listed as if it worked."""
        return [e for e in self._read_all() if self._still_valid(e)]

    def resolve(self, tool_name: str) -> MCPToolRegistrationEntry | None:
        """The one lookup `mcp_tools._spec_for` falls back to for a
        `tool_name` that is not a built-in. Callers are responsible for
        checking `MCP_TOOL_SPECS` first — this method does not itself
        special-case built-in names."""
        if not self.enabled:
            return None
        for entry in self._read_all():
            if entry.tool_name == tool_name:
                return entry if self._still_valid(entry) else None
        return None


_registry: MCPToolRegistry | None = None
_registry_lock = threading.Lock()


def get_registry() -> MCPToolRegistry:
    """Process-wide singleton built from `agent_runtime.config.settings` and
    the standard Office Profile — lazy, not a module constant, so tests can
    point settings at a temp directory and call `reset_registry()` (same
    reason `search_runtime.local_index_registry.get_registry` is lazy)."""
    global _registry
    with _registry_lock:
        if _registry is None:
            # Deferred imports: `agent_runtime.config`/`agent_runtime.manifests`
            # do not import this module, so this is not a cycle — kept as a
            # local import purely to keep this module's import-time surface
            # limited to what construction actually needs.
            from agent_runtime.config import settings
            from agent_runtime.manifests import get_db_agent_config

            # `get_db_agent_config()`, not `get_standard_config()`: MCP
            # Tools are only ever dispatched from the MCP-capable agent
            # (`standard-db-agent`, `capabilities.mcp_allowed=true`,
            # workflow.py) — the standard agent's own Office Profile copy is
            # never consulted for a tool call at all (`mcp_allowed=false`
            # short-circuits before `resolve_allowed_alias` ever runs). Both
            # configs load the same `office-profile-default/
            # office-profile.json` file today, but as independent dict
            # copies (`manifests._load_default_office_profile` re-reads the
            # file per config), so this choice is the one that actually
            # matches what `workflow.py` checks a call against.
            _registry = MCPToolRegistry(
                registry_path=settings.mcp_tool_registry_path,
                allowed_aliases=settings.mcp_tool_registration_allowed_aliases,
                office_profile_provider=lambda: get_db_agent_config().office_profile,
            )
        return _registry


def reset_registry() -> None:
    """Test seam only — drops the singleton so the next `get_registry()`
    picks up freshly patched settings."""
    global _registry
    with _registry_lock:
        _registry = None
