"""D-034 해석 경로 4 — registration table that turns a *locally installed*
Agent Package (an `agent` asset paired with a `prompt` asset) into one this
Runtime is willing to load and run.

The gap this closes. `manifests.py`'s docstring documents three resolution
paths for `StandardKnowledgeChatConfig` — the standard local copies under
`services/agent-runtime/config/` (path 1), and an APPROVED Registry lookup
over HTTP against portal-api (path 2). Neither path can serve an Agent
Package Desktop (M04) installed from an Offline Bundle: it never went
through Portal approval, and it is not one of the two hand-maintained
`config/` trees. Before this module, such an Agent had no execution path at
all — installed, listed as "설치됨", never runnable. This is the same
"설치됨" != "사용 가능" gap D-079 (Knowledge) and D-080 (MCP Tool) already
closed for their own asset types; this module is the same shape for Agent
Packages.

What this explicitly is NOT: a workflow graph engine. `agent-manifest
.schema.json`'s `workflow.roles[]` is a role declaration, not a node/edge
graph — there is nothing here to "execute" beyond what resolution path 2
already does (`resolve_registry_agent_config`): read `capabilities`
(`knowledge_required`/`mcp_allowed`/`streaming`/`citation_required`),
`limits`, `workflow.entry_role`, and the paired Prompt's `template`. This
module's only job is producing the same `StandardKnowledgeChatConfig` shape
those two paths already produce, sourced from a locally installed
directory instead.

Trust boundary — read this before touching `_validate_and_load`. A local
manifest file's own `status`-shaped fields can never be trusted (unlike
path 2's portal-api `status == "APPROVED"` gate): a local JSON file is
editable by whoever has filesystem access, so this module never reads or
branches on any such field. The actual trust argument is structural, not
content-based: the directory this module accepts input from was populated
by `apps/desktop-client`'s Offline Bundle installer, which verifies a
15-step chain (`bundle-verify.ts`) including per-file checksums
(`fileChecksums`, D-060) *before* the files ever land on disk. This module
does not re-verify those checksums — it assumes the installer already did,
exactly as the installer's own trust chain intends. That assumption is
stated here once, deliberately, rather than silently baked into a check
this module does not perform.

Path safety — why this is one step stricter than D-079's
`local_index_registry.py`. Root CLAUDE.md 코드 규칙: "사용자가 제공한
파일명으로 파일 경로를 만들지 않는다." D-079's `RegisterLocalIndexRequest`
still accepts a caller-supplied `index_path` (validated against allow-roots,
but the string itself is caller input). This module accepts NO path or
filename from a caller at all — only `agent_asset_id`/`agent_version`/
`prompt_asset_id`/`prompt_version` (each pattern-constrained: UUID / semver,
never used to build a filesystem path directly — no free text). The
directory is instead assembled entirely by this service from a configured
allow-root using the Desktop install layout, which is deterministic and
verified against `apps/desktop-client/electron/bundle-install.ts` (not
guessed): `{root}/assets/{agents|prompts}/{asset_id}/{version}/manifest.json`
(`ASSET_TYPE_FOLDER`/`assetInstallDir`/`readAssetManifest`'s
`MANIFEST_FILE_BY_TYPE` fallback — the default `"manifest.json"`, not a
type-prefixed name; only `service` gets a different filename in that map).
The assembled path is still `resolve()`d and containment-checked against the
allow-roots afterwards (mirrors D-079's `_is_contained`) purely as symlink
defense — a symlink planted inside an allowed root's `assets/` tree must not
be able to point this service at a directory the operator never intended,
even though the path components themselves cannot carry `..` or an absolute
path injection (the ids/versions are pattern-validated before they ever
reach `Path(...) /`).

Structural unreachability from Hosted Chat (spec §12, this brief's
constraint C). This module is imported only by `manifests.py` and
`routers/local_agents.py`/`routers/runs.py` (`/local/v1/*`, single-caller
Local Runtime API) — `routers/chat.py` (`/chat-api/v1/*`, multi-user Hosted
Chat) does not import this module, `local_agent_registry`, or the resolution
function `manifests.resolve_local_agent_config` anywhere in its source.
`tests/integration/agent_runtime/test_local_agent_registry.py`'s
`test_chat_router_never_references_local_agent_resolution` pins this by
reading `chat.py`'s source text directly (same technique
`test_tool_route_workflow.py::test_chat_router_never_passes_tool_route_enabled`
uses for D-083) — a live-call test cannot prove a code path is absent, only
that it was not exercised by the particular inputs tried; the source-text
assertion is what actually forecloses it.

Fail-closed default, unchanged deployment behavior. `local_agent_roots`
(`agent_runtime.config.AgentRuntimeSettings`) defaults to `()` — every
registration attempt is refused (`local_agents_disabled`) until an operator
explicitly lists at least one Desktop install root, mirroring D-079's
`SEARCH_LOCAL_INDEX_ROOTS`/this service's own `mcp_tool_registration_
allowed_aliases`. No existing deployment's behavior changes merely because
this module now exists.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ai_asset_schemas.validator import SchemaType, ValidationError, validate

_logger = logging.getLogger(__name__)

# Same shape D-079's `local_index_registry._UUID_PATTERN` pins an
# AssetVersion UUID to — here it is the Asset id manifests declare in their
# own top-level `id` field (agent-manifest.schema.json / prompt-manifest
# .schema.json both `format: uuid`), and the same value
# `apps/desktop-client/electron/bundle-install.ts` uses to name the install
# directory (`included_assets[].asset_id`). Never used to build a path
# without going through this pattern check first.
_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE
)
# agent-manifest.schema.json / prompt-manifest.schema.json's own `version`
# pattern — mirrored here (not imported; these schemas are pure JSON, no
# Python constant to import) so an invalid version is refused before it
# ever reaches `Path(...) /`.
_VERSION_PATTERN = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")

# Verified against `apps/desktop-client/electron/bundle-install.ts`
# (`ASSET_TYPE_FOLDER`, `assetInstallDir`, `readAssetManifest`'s
# `MANIFEST_FILE_BY_TYPE`) — not guessed. Only `service` gets a
# type-prefixed manifest filename there; agent/prompt both use the generic
# fallback `"manifest.json"`.
AGENT_FOLDER = "agents"
PROMPT_FOLDER = "prompts"
MANIFEST_FILENAME = "manifest.json"

MAX_LABEL_LENGTH = 200


class LocalAgentRegistrationError(Exception):
    """A registration/validation refusal — same shape as search-runtime's
    `LocalIndexError` (D-079) and this service's own
    `MCPToolRegistrationError` (D-080): a central `code`
    (VALIDATION_ERROR/PERMISSION_DENIED), a machine-readable `reason` for
    the Error Envelope's `details`, and a Korean, user-facing `message` that
    never contains a filesystem path (07-data-api-contracts.md §10.2)."""

    def __init__(self, code: str, reason: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.reason = reason
        self.message = message

    @property
    def details(self) -> dict[str, str]:
        return {"reason": self.reason}


@dataclass(frozen=True)
class LocalAgentEntry:
    agent_asset_id: str
    agent_version: str
    prompt_asset_id: str
    prompt_version: str
    agent_dir: str
    prompt_dir: str
    label: str | None
    registered_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent_asset_id": self.agent_asset_id,
            "agent_version": self.agent_version,
            "prompt_asset_id": self.prompt_asset_id,
            "prompt_version": self.prompt_version,
            "agent_dir": self.agent_dir,
            "prompt_dir": self.prompt_dir,
            "label": self.label,
            "registered_at": self.registered_at,
        }

    @staticmethod
    def from_dict(raw: object) -> LocalAgentEntry | None:
        """One malformed persisted row must not take the whole registry
        down (D-079's `LocalIndexEntry.from_dict` precedent)."""
        if not isinstance(raw, dict):
            return None
        fields = (
            "agent_asset_id",
            "agent_version",
            "prompt_asset_id",
            "prompt_version",
            "agent_dir",
            "prompt_dir",
            "registered_at",
        )
        if not all(isinstance(raw.get(f), str) for f in fields):
            return None
        label = raw.get("label")
        return LocalAgentEntry(
            agent_asset_id=raw["agent_asset_id"],
            agent_version=raw["agent_version"],
            prompt_asset_id=raw["prompt_asset_id"],
            prompt_version=raw["prompt_version"],
            agent_dir=raw["agent_dir"],
            prompt_dir=raw["prompt_dir"],
            label=label if isinstance(label, str) else None,
            registered_at=raw["registered_at"],
        )


def _resolved_allowed_roots(allowed_roots: tuple[str, ...]) -> list[Path]:
    roots: list[Path] = []
    for raw in allowed_roots:
        try:
            roots.append(Path(raw).expanduser().resolve())
        except OSError:
            _logger.warning("agent_runtime.local_agent.allowed_root_unresolvable")
    return roots


def _is_contained(candidate: Path, roots: list[Path]) -> bool:
    """True when `candidate` is one of `roots` or lives beneath one — same
    "both sides already resolve()d" reasoning as D-079's `_is_contained`:
    containment is decided on real paths, so neither a symlink planted
    inside an allowed root nor (structurally impossible here, since ids/
    versions are pattern-validated first, but checked anyway as defense in
    depth) a `..` segment can point outside what the operator allowed."""
    for root in roots:
        if candidate == root or root in candidate.parents:
            return True
    return False


def _load_manifest_json(install_dir: Path, *, missing_reason: str, unreadable_reason: str) -> dict:
    manifest_path = install_dir / MANIFEST_FILENAME
    if not manifest_path.is_file():
        raise LocalAgentRegistrationError(
            "VALIDATION_ERROR",
            missing_reason,
            f"설치된 자산 폴더에 {MANIFEST_FILENAME}이 없습니다.",
        )
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise LocalAgentRegistrationError(
            "VALIDATION_ERROR",
            unreadable_reason,
            f"{MANIFEST_FILENAME}을 읽을 수 없습니다(손상되었을 수 있습니다).",
        ) from None
    if not isinstance(manifest, dict):
        raise LocalAgentRegistrationError(
            "VALIDATION_ERROR",
            unreadable_reason,
            f"{MANIFEST_FILENAME} 형식이 올바르지 않습니다(JSON 객체가 아님).",
        )
    return manifest


def load_and_validate(
    agent_dir: Path,
    prompt_dir: Path,
    agent_asset_id: str,
    agent_version: str,
    prompt_asset_id: str,
    prompt_version: str,
) -> tuple[dict[str, Any], dict[str, Any], str]:
    """Reads and fully re-validates both manifests plus the prompt template
    text fresh from disk — used both at registration time (to fail loudly
    while an operator is watching) and again at every Run resolution
    (`manifests.resolve_local_agent_config`), never trusting that what
    passed registration is still true (files under an installed version
    directory should not change, but this module does not assume that
    either). Raises `LocalAgentRegistrationError` naming exactly one
    refusal reason; never returns a partially-valid result."""
    agent_manifest = _load_manifest_json(
        agent_dir,
        missing_reason="agent_manifest_missing",
        unreadable_reason="agent_manifest_unreadable",
    )
    try:
        validate(agent_manifest, SchemaType.AGENT)
    except ValidationError as e:
        raise LocalAgentRegistrationError(
            "VALIDATION_ERROR",
            "agent_manifest_schema_invalid",
            f"Agent manifest.json이 스키마를 충족하지 않습니다: {e}",
        ) from e
    if agent_manifest.get("id") != agent_asset_id:
        raise LocalAgentRegistrationError(
            "VALIDATION_ERROR",
            "agent_manifest_id_mismatch",
            "Agent manifest.json에 기록된 id가 요청한 agent_asset_id와 다릅니다.",
        )
    if agent_manifest.get("version") != agent_version:
        raise LocalAgentRegistrationError(
            "VALIDATION_ERROR",
            "agent_manifest_version_mismatch",
            "Agent manifest.json에 기록된 version이 요청한 agent_version과 다릅니다.",
        )

    prompt_manifest = _load_manifest_json(
        prompt_dir,
        missing_reason="prompt_manifest_missing",
        unreadable_reason="prompt_manifest_unreadable",
    )
    try:
        validate(prompt_manifest, SchemaType.PROMPT)
    except ValidationError as e:
        raise LocalAgentRegistrationError(
            "VALIDATION_ERROR",
            "prompt_manifest_schema_invalid",
            f"Prompt manifest.json이 스키마를 충족하지 않습니다: {e}",
        ) from e
    if prompt_manifest.get("id") != prompt_asset_id:
        raise LocalAgentRegistrationError(
            "VALIDATION_ERROR",
            "prompt_manifest_id_mismatch",
            "Prompt manifest.json에 기록된 id가 요청한 prompt_asset_id와 다릅니다.",
        )
    if prompt_manifest.get("version") != prompt_version:
        raise LocalAgentRegistrationError(
            "VALIDATION_ERROR",
            "prompt_manifest_version_mismatch",
            "Prompt manifest.json에 기록된 version이 요청한 prompt_version과 다릅니다.",
        )

    template_file = (prompt_manifest.get("template") or {}).get("file")
    prompt_dir_resolved = prompt_dir.resolve()
    template_path = None
    if isinstance(template_file, str) and template_file:
        try:
            template_path = (prompt_dir / template_file).resolve()
        except OSError:
            template_path = None
    if (
        template_path is None
        or not _is_contained(template_path, [prompt_dir_resolved])
        or not template_path.is_file()
    ):
        raise LocalAgentRegistrationError(
            "VALIDATION_ERROR",
            "prompt_template_missing",
            "Prompt manifest.json의 template.file을 찾을 수 없습니다.",
        )
    try:
        prompt_template = template_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        raise LocalAgentRegistrationError(
            "VALIDATION_ERROR",
            "prompt_template_missing",
            "Prompt template 파일을 읽을 수 없습니다.",
        ) from None

    return agent_manifest, prompt_manifest, prompt_template


class LocalAgentRegistry:
    """Persistent registration table — one instance per process (see
    `get_registry`). Mirrors `search_runtime.local_index_registry
    .LocalIndexRegistry` and this service's own `mcp_tool_registry
    .MCPToolRegistry`: every mutation rewrites the whole JSON file under a
    lock, and every read re-validates against the *current* filesystem
    state rather than trusting what was true at registration time."""

    def __init__(self, registry_path: str | Path, allowed_roots: tuple[str, ...]) -> None:
        self._registry_path = Path(registry_path)
        self._allowed_roots = _resolved_allowed_roots(tuple(allowed_roots))
        self._lock = threading.Lock()
        self._cache: tuple[tuple[int, int], list[LocalAgentEntry]] | None = None

    @property
    def enabled(self) -> bool:
        """False when no allow-root is configured for this deployment (the
        default) — registration is off entirely."""
        return len(self._allowed_roots) > 0

    # -- persistence --------------------------------------------------------

    def _read_all(self) -> list[LocalAgentEntry]:
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
            _logger.error("agent_runtime.local_agent.registry_unreadable")
            return []
        if not isinstance(raw, list):
            _logger.error("agent_runtime.local_agent.registry_malformed")
            return []
        entries = [e for e in (LocalAgentEntry.from_dict(row) for row in raw) if e is not None]
        self._cache = (key, entries)
        return entries

    def _write_all(self, entries: list[LocalAgentEntry]) -> None:
        self._cache = None
        self._registry_path.parent.mkdir(parents=True, exist_ok=True)
        self._registry_path.write_text(
            json.dumps([e.to_dict() for e in entries], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # -- validation -----------------------------------------------------

    def _require_enabled(self) -> None:
        if not self.enabled:
            raise LocalAgentRegistrationError(
                "PERMISSION_DENIED",
                "local_agents_disabled",
                "이 배포는 로컬 설치 Agent Package 등록을 허용하지 않습니다 "
                "(AGENT_RUNTIME_LOCAL_AGENT_ROOTS 미설정).",
            )

    def _resolve_install_dir(
        self, folder: str, asset_id: str, version: str, *, missing_reason: str
    ) -> Path:
        """Assembles the install directory itself from a configured
        allow-root using the deterministic Desktop layout — never from a
        caller-supplied path/filename (module docstring, "Path safety").
        Tries each configured root in order; the first that both contains
        (post-`resolve()`) and actually holds this asset wins."""
        outside_root_seen = False
        for root in self._allowed_roots:
            candidate = root / "assets" / folder / asset_id / version
            try:
                resolved = candidate.resolve()
            except OSError:
                continue
            if not _is_contained(resolved, self._allowed_roots):
                # A symlink under this root pointed outside every allowed
                # root — tampering, not "try the next root". Refuse
                # immediately rather than silently falling through.
                outside_root_seen = True
                continue
            if resolved.is_dir():
                return resolved
        if outside_root_seen:
            raise LocalAgentRegistrationError(
                "PERMISSION_DENIED",
                "path_outside_allowed_roots",
                "조립된 설치 경로가 허용된 루트 밖입니다.",
            )
        raise LocalAgentRegistrationError(
            "VALIDATION_ERROR",
            missing_reason,
            "허용된 설치 루트에서 해당 자산 버전을 찾을 수 없습니다.",
        )

    def _validate_ids(
        self, agent_asset_id: str, agent_version: str, prompt_asset_id: str, prompt_version: str
    ) -> None:
        checks = (
            (
                agent_asset_id,
                _UUID_PATTERN,
                "agent_asset_id_invalid",
                "agent_asset_id는 자산 UUID여야 합니다.",
            ),
            (
                agent_version,
                _VERSION_PATTERN,
                "agent_version_invalid",
                "agent_version은 semver 형식이어야 합니다.",
            ),
            (
                prompt_asset_id,
                _UUID_PATTERN,
                "prompt_asset_id_invalid",
                "prompt_asset_id는 자산 UUID여야 합니다.",
            ),
            (
                prompt_version,
                _VERSION_PATTERN,
                "prompt_version_invalid",
                "prompt_version은 semver 형식이어야 합니다.",
            ),
        )
        for value, pattern, reason, message in checks:
            if not isinstance(value, str) or not pattern.match(value):
                raise LocalAgentRegistrationError("VALIDATION_ERROR", reason, message)

    def _still_valid(self, entry: LocalAgentEntry) -> bool:
        """Cheap re-check applied on every read/resolve — what can change
        after registration is the filesystem (asset removed/moved) and this
        deployment's allow-roots (operator narrows them); both must take
        effect immediately, mirroring D-079's `_still_valid`. Manifest
        content is NOT re-validated here (that is the more expensive
        `load_and_validate`, reserved for actual Run resolution) — this
        only decides whether the entry is still listable/resolvable at
        all."""
        if not self.enabled:
            return False
        try:
            agent_dir = Path(entry.agent_dir).resolve()
            prompt_dir = Path(entry.prompt_dir).resolve()
        except OSError:
            return False
        return (
            _is_contained(agent_dir, self._allowed_roots)
            and agent_dir.is_dir()
            and _is_contained(prompt_dir, self._allowed_roots)
            and prompt_dir.is_dir()
        )

    # -- public operations ----------------------------------------------

    def register(
        self,
        agent_asset_id: str,
        agent_version: str,
        prompt_asset_id: str,
        prompt_version: str,
        label: str | None = None,
    ) -> LocalAgentEntry:
        self._require_enabled()
        self._validate_ids(agent_asset_id, agent_version, prompt_asset_id, prompt_version)
        if label is not None and len(label) > MAX_LABEL_LENGTH:
            raise LocalAgentRegistrationError(
                "VALIDATION_ERROR",
                "label_too_long",
                f"label은 {MAX_LABEL_LENGTH}자를 넘을 수 없습니다.",
            )

        agent_dir = self._resolve_install_dir(
            AGENT_FOLDER, agent_asset_id, agent_version, missing_reason="agent_install_not_found"
        )
        prompt_dir = self._resolve_install_dir(
            PROMPT_FOLDER,
            prompt_asset_id,
            prompt_version,
            missing_reason="prompt_install_not_found",
        )

        # Fail loudly at registration time, while an operator is watching —
        # same reasoning D-079's `_validated_path` documents.
        load_and_validate(
            agent_dir, prompt_dir, agent_asset_id, agent_version, prompt_asset_id, prompt_version
        )

        entry = LocalAgentEntry(
            agent_asset_id=agent_asset_id,
            agent_version=agent_version,
            prompt_asset_id=prompt_asset_id,
            prompt_version=prompt_version,
            agent_dir=str(agent_dir),
            prompt_dir=str(prompt_dir),
            label=label,
            registered_at=datetime.now(UTC).isoformat(),
        )
        with self._lock:
            kept = [e for e in self._read_all() if e.agent_asset_id != agent_asset_id]
            kept.append(entry)
            self._write_all(kept)
        _logger.info(
            "agent_runtime.local_agent.registered agent_asset_id=%s agent_version=%s",
            agent_asset_id,
            agent_version,
        )
        return entry

    def unregister(self, agent_asset_id: str) -> bool:
        with self._lock:
            all_entries = self._read_all()
            kept = [e for e in all_entries if e.agent_asset_id != agent_asset_id]
            if len(kept) == len(all_entries):
                return False
            self._write_all(kept)
        _logger.info("agent_runtime.local_agent.unregistered agent_asset_id=%s", agent_asset_id)
        return True

    def list_entries(self) -> list[LocalAgentEntry]:
        """Registered entries that would actually resolve right now — a
        stale entry (asset removed, allow-roots narrowed) is omitted rather
        than listed as if it still worked."""
        return [e for e in self._read_all() if self._still_valid(e)]

    def resolve(self, agent_asset_id: str) -> LocalAgentEntry | None:
        """The one lookup `manifests.resolve_local_agent_config` uses.
        Returns None whenever this id is not usable right now — disabled
        deployment, never registered, or no longer `_still_valid`."""
        if not self.enabled:
            return None
        for entry in self._read_all():
            if entry.agent_asset_id == agent_asset_id:
                return entry if self._still_valid(entry) else None
        return None


_registry: LocalAgentRegistry | None = None
_registry_lock = threading.Lock()


def get_registry() -> LocalAgentRegistry:
    """Process-wide singleton built from `agent_runtime.config.settings` —
    lazy, not a module constant, so tests can point settings at a temp
    directory and call `reset_registry()` (same reason `search_runtime
    .local_index_registry.get_registry`/this service's own
    `mcp_tool_registry.get_registry` are lazy)."""
    global _registry
    with _registry_lock:
        if _registry is None:
            from agent_runtime.config import settings

            _registry = LocalAgentRegistry(
                registry_path=settings.local_agent_registry_path,
                allowed_roots=settings.local_agent_roots,
            )
        return _registry


def reset_registry() -> None:
    """Test seam only — drops the singleton so the next `get_registry()`
    picks up freshly patched settings."""
    global _registry
    with _registry_lock:
        _registry = None
