"""Agent Runtime settings."""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings

_REPO_ROOT = Path(__file__).parent.parent.parent.parent.parent  # enterprise-ai-asset-hub/


class AgentRuntimeSettings(BaseSettings):
    # Deployment identity — same contract as `portal_api.config.Settings` and
    # `distribution_service.config.Settings` (2026-08-12), extended to this
    # service on 2026-08-14. Release automation injects the immutable commit
    # SHA; the explicit "unknown" fallback keeps a local/dev process honest
    # without making Git metadata a runtime dependency.
    #
    # Why this service needed it too: on 2026-08-13 a search-runtime process
    # from six days earlier was still listening, so a route added that week
    # returned 404 and the only way to tell a fresh process from a stale one
    # was reading `/openapi.json` by hand. Every long-running service in this
    # repo must be able to answer "what code are you actually running" from
    # `/health` alone.
    build_version: str = "0.1.0"
    commit_sha: str = "unknown"

    config_dir: Path = _REPO_ROOT / "services" / "agent-runtime" / "config"
    search_runtime_url: str = "http://localhost:8300"
    portal_api_url: str = "http://localhost:8000"
    office_mcp_url: str = "http://localhost:8500"
    # Browser origins allowed to call this runtime directly. Portal Web (:3000)
    # drives Preview/Hosted Chat; the Desktop renderer's Vite dev server (:5174)
    # drives D06/D07, which talk to this service over HTTP rather than through
    # the Electron IPC bridge (the bridge exists for filesystem work only).
    # Packaged Electron sends `Origin: null` from a file:// document and is NOT
    # covered here — that needs its own decision, tracked as D-059.
    # Desktop 렌더러는 **5173** 이다 — `apps/desktop-client/vite.config.ts` 가
    # `port: 5173` + `strictPort: true` 로 고정하고 `electron/main.ts` 도 5173 을
    # 로드한다. 이 목록에 오래 남아 있던 5174 는 문서에만 있던 값이었고, 그 탓에
    # 실제 렌더러(5173)에서 이 서비스를 부르면 서버는 200 을 기록하는데 브라우저가
    # 응답을 버려 "Failed to fetch" 로 보였다(2026-08-14 실사용에서 발생).
    # 5174 는 과거 세션들이 `--port 5174` 로 띄우던 관행이 남아 있어 함께 유지한다.
    cors_origins: list[str] = [
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ]
    # 02-desktop-and-agent-runtime.md §5.3: "WAITING_FOR_USER는 Tool 확인 또는
    # 추가 입력에 사용한다. 무한 대기를 방지하기 위해 만료시간을 가진다." —
    # a setting (not a literal in workflow.py) so it is tunable per
    # deployment/test without a code change, per the lesson learned on this
    # file's sibling (main.py previously hardcoded a CORS value that silently
    # shadowed the `cors_origins` setting above).
    mcp_confirmation_timeout_seconds: float = 120.0
    # D-062 (open-decisions.md), 04-knowledge-platform.md §3.8: the clearance
    # asserted to search-runtime's `access_context.clearance` when a Run's
    # own `user_context` (StartRunRequest.user_context, set by the calling
    # service — never by `input`, which a chat UI's end user controls) is
    # absent or omits `clearance` — Hosted Chat (chat.py) never supplies one
    # at all today (D-015: no identity layer). INTERNAL, not the more
    # conservative PUBLIC_INTERNAL, because this PoC's demo Knowledge assets
    # default to INTERNAL classification (apps/portal-web/app/knowledge/new
    # /page.tsx's `useState("INTERNAL")`) and the existing published demo
    # chatbots are meant to keep answering once their indexes are upgraded
    # via `stamp-classification` — see open-decisions.md D-062 for the full
    # reasoning and its explicit caveat: this is the platform ASSERTING a
    # clearance on an unauthenticated caller's behalf, not verifying one.
    default_search_clearance: str = "INTERNAL"
    # D-034: the Bearer token this runtime presents to portal-api when
    # resolving an Agent/Prompt AssetVersion from the Registry
    # (`agent_runtime.adapters.registry.HttpAssetRegistryResolver`). PoC-only
    # (D-001 Test Identity Adapter fixed dev token, not a secret — see that
    # adapter's docstring) until a real service-identity mechanism exists.
    portal_api_token: str = "dev-user-token"
    # Desktop 대화 고도화 (multi-turn) — `StartRunRequest.input.history` is
    # additive/optional (agent_runtime.conversation.bound_history). These two
    # bound its growth server-side regardless of what a caller sends, so a
    # long-lived Desktop conversation can never make the prompt grow without
    # limit — settings, not literals in conversation.py, for the same reason
    # `mcp_confirmation_timeout_seconds` above is a setting: this file already
    # documents the CORS-hardcoding lesson this repo was bitten by once.
    # Omitting `history` entirely (every caller today except the new Desktop
    # persistence work) reproduces prior behavior exactly — `bound_history`
    # returns `[]` for `None` input regardless of these values.
    # Prior user/assistant turn pairs kept, most-recent-first — beyond this
    # the oldest turns are dropped first (oldest-first eviction).
    max_history_turns: int = 6
    # Approximate character budget for the rendered history block (question +
    # answer text summed across kept turns). No LLM tokenizer dependency is
    # wired into this PoC, so this is a conservative proxy, not an exact
    # token count — mirrors 04-knowledge-platform.md §3.11's Context Budget
    # "안전 여유를 둔다" (safety margin) philosophy for its own token budget.
    max_history_chars: int = 4000
    # 04-knowledge-platform.md §3.4 Query Rewrite — only invoked when history
    # is non-empty (agent_runtime.conversation.rewrite_query_for_search).
    # "Timeout 또는 Output 오류 시 원문 Fallback" is a hard §3.4 rule; this
    # bounds how long a run waits before falling back, so a stuck Ollama call
    # cannot hang a Run indefinitely just to rewrite a search query.
    query_rewrite_timeout_seconds: float = 8.0
    # Agentic Knowledge selection (KNOWLEDGE_ROUTE stage,
    # agent_runtime.knowledge_router) — additive/optional: only exercised
    # when a caller populates `input.knowledge_candidates`. Every existing
    # `knowledge_ids`/`knowledge_id` caller, including the 4 published
    # Hosted chatbots (chat.py never sends candidates at all), never pays
    # this LLM call and is byte-for-byte unaffected. At or below this many
    # candidates, routing is skipped entirely (no LLM call) — deciding
    # among 1-2 Knowledge is pure latency for no benefit; every candidate is
    # searched instead. A setting, not a literal in workflow.py/
    # knowledge_router.py, per this file's own CORS-hardcoding lesson.
    knowledge_route_skip_threshold: int = 2
    # Mirrors `query_rewrite_timeout_seconds`'s role for KNOWLEDGE_ROUTE:
    # "Timeout 또는 Output 오류 시 원문 Fallback" applied to routing — a
    # stuck/slow routing call falls back to searching every candidate
    # rather than hanging the Run. Routing is an optimization; a failed
    # optimization must never silently reduce recall (fail-open, never
    # zero, never a guessed-at subset — see knowledge_router.py).
    knowledge_route_timeout_seconds: float = 8.0

    # D-080: registration table that turns an *installed* MCP Tool asset's
    # contract into one `mcp_tools.validate_tool_input` will actually
    # recognize (see `mcp_tool_registry.py` module docstring for the full
    # design). Empty by default, exactly like search-runtime's D-079
    # `SEARCH_LOCAL_INDEX_ROOTS` (`LOCAL_INDEX_ROOTS`) — an empty tuple means
    # every registration attempt is refused (`mcp_tool_registration_disabled`),
    # fail-closed. An operator opts a specific Office Profile
    # `allowed_mcp_servers[].alias` into dynamic registration by listing it
    # here; this is deliberately narrower than "registration is on/off" —
    # it is "registration is on for these already-office-profile-approved
    # servers", so turning it on can never by itself grant a new server any
    # permission it did not already have in `office-profile.json`.
    mcp_tool_registration_allowed_aliases: tuple[str, ...] = ()
    # Persistent JSON file backing the registry (same "rewrite whole file
    # under a lock" design as search-runtime's `LOCAL_INDEX_REGISTRY_PATH`).
    mcp_tool_registry_path: Path = _REPO_ROOT / "data" / "agent-runtime" / "mcp-tool-registry.json"

    class Config:
        env_prefix = "AGENT_RUNTIME_"


settings = AgentRuntimeSettings()
