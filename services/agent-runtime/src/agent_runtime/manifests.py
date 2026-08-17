"""Standard Agent/Prompt/Office Profile config loader — and (D-034) the
Agent/Prompt Registry resolution this module now also performs.

Resolution order (D-034, docs/implementation-spec/open-decisions.md):

1. `agent_profile in {"standard-agent", "standard-db-agent"}`
   (`load_standard_config`/`load_db_agent_config`, below) — ALWAYS reads the
   runtime's own local copies under `services/agent-runtime/config/`, never
   reaches portal-api. This is unchanged from before D-034 and MUST stay
   that way: the 4 live published chatbots (`remote-work-guide`, `langchain`,
   `remote-work-approved`, `chatbot-chura7`) run through `standard-agent`,
   and this path guarantees they keep working identically even if portal-api
   is completely unreachable.
2. An explicit Registry id pair (`registry_agent_version_id` +
   `registry_prompt_version_id` on `StartRunRequest.input`, wired in
   `routers/runs.py`) — `resolve_registry_agent_config` below calls
   portal-api over HTTP (`agent_runtime.adapters.registry
   .HttpAssetRegistryResolver`, itself calling the public
   `GET /api/v1/asset-versions/{id}[/template]` API — no cross-module
   import, CLAUDE.md 원칙 2) to fetch both manifests, requires
   `status == "APPROVED"` on each (an unapproved Agent/Prompt is refused
   with a clear error code — `RegistryResolutionError`, consistent with the
   existing APPROVED-only gate for Knowledge distribution, D-044), and
   validates each against its `ai_asset_schemas` SchemaType. A successful
   resolution is cached in-memory (`_registry_cache`, keyed by the id pair)
   so a *later* Registry outage never breaks a run that already resolved
   successfully once — only a *first-time* resolution of a given id pair
   requires portal-api to be reachable.
3. Neither supplied — `routers/runs.py` defaults `agent_profile` to
   `"standard-agent"`, i.e. falls into path 1 above.
4. `local_agent_id` on `StartRunRequest.input`, wired in `routers/runs.py`
   (`/local/v1/runs*` ONLY — never `routers/chat.py`) —
   `resolve_local_agent_config` below resolves an Agent Package Desktop
   (M04) installed locally from an Offline Bundle, via
   `agent_runtime.local_agent_registry.LocalAgentRegistry` (that module's
   docstring has the full design: no workflow engine, path assembled only
   from a configured allow-root — never from caller input, local `status`
   fields never trusted, checksum-verified Bundle install assumed rather
   than re-verified). Structurally unreachable from Hosted Chat — see that
   module's docstring and `test_local_agent_registry
   .py::test_chat_router_never_references_local_agent_resolution`.

Loading the standard configs still never reaches into the top-level
fixtures/ contract-testing tree. Validation failures for the *standard*
configs must surface loudly at startup, not lazily (see `main.py`'s
lifespan) — Registry resolution failures, by contrast, surface per-run,
since they depend on a specific run's input, not on startup state.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ai_asset_schemas.validator import SchemaType, ValidationError, validate

from agent_runtime import local_agent_registry
from agent_runtime.adapters import AssetRegistryResolver
from agent_runtime.config import settings


@dataclass(frozen=True)
class StandardKnowledgeChatConfig:
    agent_manifest: dict[str, Any]
    prompt_manifest: dict[str, Any]
    prompt_template: str
    office_profile: dict[str, Any]


def _load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return json.load(f)  # type: ignore[no-any-return]


def _load_default_office_profile(config_dir: Path) -> dict[str, Any]:
    """Shared by every resolution path (standard/db-agent local copies AND
    Registry-resolved configs, below) — there is no Office Profile Registry
    either (same D-034-adjacent gap, documented in open-decisions.md), so a
    Registry-resolved Agent/Prompt still runs against this one static
    Office Profile rather than a per-Service one."""
    office_profile = _load_json(config_dir / "office-profile-default" / "office-profile.json")
    validate(office_profile, SchemaType.OFFICE_PROFILE)
    return office_profile


def _load_agent_config(
    config_dir: Path, agent_dir_name: str, prompt_dir_name: str
) -> StandardKnowledgeChatConfig:
    """Shared loader behind `load_standard_config`/`load_db_agent_config` —
    only the Agent/Prompt subdirectory names differ; both share the same
    `office-profile-default` file. Pure function — raises
    ai_asset_schemas.validator.ValidationError if any manifest fails schema
    validation."""
    agent_manifest = _load_json(config_dir / agent_dir_name / "agent-manifest.json")
    validate(agent_manifest, SchemaType.AGENT)

    prompt_manifest = _load_json(config_dir / prompt_dir_name / "prompt-manifest.json")
    validate(prompt_manifest, SchemaType.PROMPT)

    template_file = prompt_manifest["template"]["file"]
    prompt_template = (config_dir / prompt_dir_name / template_file).read_text(encoding="utf-8")

    office_profile = _load_default_office_profile(config_dir)

    return StandardKnowledgeChatConfig(
        agent_manifest=agent_manifest,
        prompt_manifest=prompt_manifest,
        prompt_template=prompt_template,
        office_profile=office_profile,
    )


def load_standard_config(config_dir: Path) -> StandardKnowledgeChatConfig:
    """Load and validate the standard (Knowledge-only, `mcp_allowed: false`)
    Agent/Prompt/Office Profile config. Unchanged behavior — four live
    published chatbots depend on this exact config tree
    (`standard-agent`/`standard-prompt`)."""
    return _load_agent_config(config_dir, "standard-agent", "standard-prompt")


def load_db_agent_config(config_dir: Path) -> StandardKnowledgeChatConfig:
    """Load and validate the MCP-capable Agent config (`standard-db-agent`,
    `mcp_allowed: true`), paired with its own `standard-db-prompt` (not
    `standard-prompt` — its instructions additionally cover grounding in MCP
    Tool evidence, see `config/standard-db-prompt/template.md`). Shares the
    same `office-profile-default` file as the standard agent."""
    return _load_agent_config(config_dir, "standard-db-agent", "standard-db-prompt")


_cached_config: StandardKnowledgeChatConfig | None = None
_cached_db_agent_config: StandardKnowledgeChatConfig | None = None


def get_standard_config() -> StandardKnowledgeChatConfig:
    """Lazily load-and-cache the standard config using settings.config_dir."""
    global _cached_config
    if _cached_config is None:
        _cached_config = load_standard_config(settings.config_dir)
    return _cached_config


def set_standard_config(config: StandardKnowledgeChatConfig | None) -> None:
    """Explicitly set (or reset, with None) the cached config.

    Used by the FastAPI lifespan (to force eager loading at startup) and by
    tests (to inject a controlled config or reset the cache).
    """
    global _cached_config
    _cached_config = config


def get_db_agent_config() -> StandardKnowledgeChatConfig:
    """Lazily load-and-cache the MCP-capable agent config using
    settings.config_dir."""
    global _cached_db_agent_config
    if _cached_db_agent_config is None:
        _cached_db_agent_config = load_db_agent_config(settings.config_dir)
    return _cached_db_agent_config


class RegistryResolutionError(Exception):
    """Raised by `resolve_registry_agent_config` — `code` is a stable,
    machine-readable error code (surfaced to the SSE client the same way
    `AGENT_PROFILE_UNKNOWN` already is in `routers/runs.py`), `message` is
    the Korean, user-facing text."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# D-034 resolution path 2 (see module docstring): successful Registry
# resolutions, keyed by (agent_version_id, prompt_version_id). Deliberately
# never caches a *failure* — a transient portal-api outage or a version that
# is APPROVED a moment later must not be permanently remembered as broken.
_registry_cache: dict[tuple[str, str], StandardKnowledgeChatConfig] = {}


def reset_registry_cache() -> None:
    """Test-only — mirrors `set_standard_config(None)`'s reset role."""
    _registry_cache.clear()


async def _fetch_approved_version(
    resolver: AssetRegistryResolver,
    version_id: str,
    expected_type: str,
    *,
    not_found_code: str,
    wrong_type_code: str,
    not_approved_code: str,
) -> dict[str, Any]:
    try:
        version = await resolver.get_asset_version(version_id)
    except Exception as e:  # httpx errors, connection refused, timeouts, etc.
        raise RegistryResolutionError(
            "ASSET_REGISTRY_UNAVAILABLE",
            f"Registry({expected_type})를 조회할 수 없습니다: {e}",
        ) from e

    if version is None:
        raise RegistryResolutionError(
            not_found_code, f"{expected_type} 자산 버전을 찾을 수 없습니다: {version_id}"
        )
    # portal-api's `GET /api/v1/asset-versions/{id}` (AssetVersionOut) has no
    # top-level `type` field — the asset type only ever appears inside the
    # manifest itself (`manifest.type`), same as every other consumer of
    # this shape (e.g. `_MANIFEST_TYPE_TO_SCHEMA` in assets.py). Found via
    # live verification against a real portal-api instance — an earlier
    # version of this check read a non-existent top-level `version["type"]`
    # (always None) and misreported every version as wrong-type.
    manifest_type = (version.get("manifest") or {}).get("type")
    if manifest_type != expected_type:
        raise RegistryResolutionError(
            wrong_type_code,
            f"{version_id}는 {expected_type} 자산 버전이 아닙니다: {manifest_type}",
        )
    if version.get("status") != "APPROVED":
        # Consistent with the existing APPROVED-only gate for Knowledge
        # distribution (D-044, distributions.py) — an unapproved Agent/
        # Prompt must never be usable for execution, only for review/draft
        # editing in the Portal itself.
        raise RegistryResolutionError(
            not_approved_code,
            f"승인되지 않은 {expected_type} 버전은 사용할 수 없습니다 "
            f"(status={version.get('status')}).",
        )
    return version


async def resolve_registry_agent_config(
    agent_version_id: str,
    prompt_version_id: str,
    resolver: AssetRegistryResolver,
) -> StandardKnowledgeChatConfig:
    """D-034 resolution path 2 — see module docstring for the full order.

    Raises `RegistryResolutionError` (never a bare exception) on any
    failure: not found, wrong type, not APPROVED, schema-invalid, or the
    Registry itself unreachable. Callers (routers/runs.py) turn this into
    the same `run.failed` SSE shape `AGENT_PROFILE_UNKNOWN` already uses.
    """
    cache_key = (agent_version_id, prompt_version_id)
    cached = _registry_cache.get(cache_key)
    if cached is not None:
        return cached

    agent_version = await _fetch_approved_version(
        resolver,
        agent_version_id,
        "agent",
        not_found_code="AGENT_NOT_FOUND",
        wrong_type_code="AGENT_ASSET_WRONG_TYPE",
        not_approved_code="AGENT_VERSION_NOT_APPROVED",
    )
    prompt_version = await _fetch_approved_version(
        resolver,
        prompt_version_id,
        "prompt",
        not_found_code="PROMPT_NOT_FOUND",
        wrong_type_code="PROMPT_ASSET_WRONG_TYPE",
        not_approved_code="PROMPT_VERSION_NOT_APPROVED",
    )

    agent_manifest = agent_version["manifest"]
    prompt_manifest = prompt_version["manifest"]
    try:
        validate(agent_manifest, SchemaType.AGENT)
        validate(prompt_manifest, SchemaType.PROMPT)
    except ValidationError as e:
        raise RegistryResolutionError(
            "REGISTRY_MANIFEST_INVALID", f"Registry Manifest이 스키마를 충족하지 않습니다: {e}"
        ) from e

    try:
        template_content = await resolver.get_prompt_template(prompt_version_id)
    except Exception as e:
        raise RegistryResolutionError(
            "ASSET_REGISTRY_UNAVAILABLE", f"Prompt 템플릿을 조회할 수 없습니다: {e}"
        ) from e
    if template_content is None:
        raise RegistryResolutionError(
            "PROMPT_TEMPLATE_NOT_FOUND",
            f"Prompt 템플릿 파일을 찾을 수 없습니다: {prompt_version_id}",
        )

    config = StandardKnowledgeChatConfig(
        agent_manifest=agent_manifest,
        prompt_manifest=prompt_manifest,
        prompt_template=template_content,
        office_profile=_load_default_office_profile(settings.config_dir),
    )
    _registry_cache[cache_key] = config
    return config


def set_db_agent_config(config: StandardKnowledgeChatConfig | None) -> None:
    """Explicitly set (or reset, with None) the cached MCP-capable agent
    config — same purpose as `set_standard_config`."""
    global _cached_db_agent_config
    _cached_db_agent_config = config


class LocalAgentResolutionError(Exception):
    """Raised by `resolve_local_agent_config` — same `code`/`message` shape
    as `RegistryResolutionError` above, but never caches a config across
    calls (unlike path 2's `_registry_cache`): a locally installed Agent can
    be uninstalled or re-registered between runs, and re-reading fresh from
    the registry/filesystem every time is what makes that take effect
    immediately, consistent with `LocalAgentRegistry.resolve`'s own
    freshness guarantee."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def resolve_local_agent_config(
    local_agent_id: str,
    registry: local_agent_registry.LocalAgentRegistry,
) -> StandardKnowledgeChatConfig:
    """D-034 resolution path 4 (see module docstring). `local_agent_id` is
    the registered Agent asset's id (`LocalAgentEntry.agent_asset_id`) — the
    handle a Run references instead of any path. Deliberately never caches:
    every call re-reads the registry entry and re-validates both manifests
    fresh from disk (`local_agent_registry.load_and_validate`), so an
    uninstall or a narrowed `local_agent_roots` takes effect on the very
    next run, not just the next registration.

    Raises `LocalAgentResolutionError` on any failure — not registered, or
    a re-validation failure (asset removed after registration, manifest
    edited to no longer match, etc.). Callers (`routers/runs.py`) turn this
    into the same `run.failed` SSE shape `AGENT_PROFILE_UNKNOWN`/
    `RegistryResolutionError` already use."""
    entry = registry.resolve(local_agent_id)
    if entry is None:
        raise LocalAgentResolutionError(
            "LOCAL_AGENT_NOT_REGISTERED",
            f"등록된 로컬 Agent Package를 찾을 수 없습니다: {local_agent_id}",
        )

    try:
        agent_manifest, prompt_manifest, prompt_template = local_agent_registry.load_and_validate(
            Path(entry.agent_dir),
            Path(entry.prompt_dir),
            entry.agent_asset_id,
            entry.agent_version,
            entry.prompt_asset_id,
            entry.prompt_version,
        )
    except local_agent_registry.LocalAgentRegistrationError as e:
        raise LocalAgentResolutionError(e.code, e.message) from e

    return StandardKnowledgeChatConfig(
        agent_manifest=agent_manifest,
        prompt_manifest=prompt_manifest,
        prompt_template=prompt_template,
        office_profile=_load_default_office_profile(settings.config_dir),
    )
