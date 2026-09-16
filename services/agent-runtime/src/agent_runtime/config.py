"""Agent Runtime settings."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings

from agent_runtime.ollama_config import load_ollama_endpoint

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

    # D-083: agentic MCP Tool selection (TOOL_ROUTE stage,
    # agent_runtime.tool_router) — additive/optional: only exercised when a
    # caller sets `input.tool_route=true` AND the resolved agent allows MCP
    # (`capabilities.mcp_allowed`) AND no explicit `mcp_tool` was already
    # declared on `input` (an explicit caller-declared tool always wins —
    # see workflow.py). Every existing caller, including the 4 published
    # Hosted chatbots (chat.py never sets `tool_route`), never pays this LLM
    # call and is byte-for-byte unaffected.
    #
    # Deliberately 0, unlike `knowledge_route_skip_threshold` (2): Knowledge
    # routing below its threshold is a safe no-op (search every candidate
    # anyway), but a *single* candidate Tool still needs its arguments
    # extracted from the question by the model — there is no safe
    # "propose the only one" shortcut, so this is never used as a latency
    # optimization, only as the true "nothing to route over" case (zero
    # candidate tools — see tool_router.py's module docstring).
    tool_route_skip_threshold: int = 0
    # Mirrors `knowledge_route_timeout_seconds`'s role for TOOL_ROUTE: a
    # stuck/slow routing call fails CLOSED (propose no tool at all), never
    # hanging the Run and never guessing a tool as a fallback — a Tool Call
    # is an action, unlike a Knowledge search, so "guess and call anyway" is
    # not an acceptable fallback here (see tool_router.py).
    tool_route_timeout_seconds: float = 8.0
    # D-083 follow-up: bounds each candidate's human-readable `description`
    # (built-in `MCP_TOOL_SPECS` text or a D-080 registration's `label`)
    # before `tool_router._normalize_candidates` renders it into the routing
    # prompt. A `label` on a registered tool originates from an installed
    # asset's manifest — more trusted than document content, but still text
    # that reaches a prompt that decides actions, so it gets the same
    # "setting, not a literal" treatment as every other bound in this file
    # (this file's own CORS-hardcoding lesson). `_normalize_candidates` also
    # collapses all whitespace (so a hostile multi-line description can
    # never inject a fake candidate line into the prompt) independent of
    # this length; this setting only caps how long the single resulting
    # line may be.
    tool_route_description_max_chars: int = 160

    # `routers/knowledge_metadata_suggest.py` (POST
    # /local/v1/knowledge-metadata-suggest) — the character bound applied to
    # the caller-supplied `excerpt` before it goes into the LLM prompt. A
    # setting, not a literal in the router, per this file's own
    # CORS-hardcoding lesson (a hardcoded bound would silently ignore any
    # future need to tune it per deployment). Longer excerpts are truncated
    # silently (never rejected as an error) — this endpoint is best-effort
    # accelerator, not a contract the caller must satisfy exactly.
    knowledge_metadata_suggest_excerpt_max_chars: int = 4000
    # Timeout budget for the single non-streaming Ollama call this endpoint
    # makes — mirrors `query_rewrite_timeout_seconds`'s role: a stuck model
    # call must fail this accelerator quickly, never hang the caller's
    # registration screen.
    knowledge_metadata_suggest_timeout_seconds: float = 20.0

    # 실사용 제보(2026-08-20, 사내 Windows): `office-profile.json`의
    # `model_aliases["default-chat"].model_id`는 git 추적 파일이라, 테스트
    # PC마다 설치된 Ollama 모델이 다르면 그 파일을 직접 고쳐야 했고 그때마다
    # 더러운 작업 트리가 생겼다. 이 값을 설정하면 `manifests
    # ._load_default_office_profile`이 로드 직후 alias "default-chat"의
    # `model_id`만 이 값으로 덮어쓴다(다른 alias는 건드리지 않는다) — 적용
    # 시점에 로그 한 줄을 남긴다(조용한 대체가 가장 나쁘다). 기본값
    # `None`이면 아무 것도 바뀌지 않는다(office-profile.json 값 그대로).
    # 설치된 모델로 자동 대체(fallback)는 절대 하지 않는다 — Desktop이
    # `/api/tags`로 설치된 모델 중 자동 선택하는 것과 달리, 여기서 조용히
    # 다른 모델로 바뀌면 답변 품질/성격이 말없이 달라진다(이 저장소 원칙:
    # 모르면 추측하지 말고 정직하게 실패한다). open-decisions.md 참고.
    #
    # D-092 (2026-08-20): 이 값은 더 이상 채팅 모델을 바꾸는 "유일한" 수단이
    # 아니다 — Portal 관리자 화면(P15)에서 저장한 설정
    # (`chat_model_setting_cache.get_chat_model_setting_cache`, portal-api의
    # `GET /api/v1/admin/chat-model-setting`)이 이 값보다 우선한다. 최종
    # 우선순위: Portal 설정 > 이 값(`AGENT_RUNTIME_CHAT_MODEL_ID`) >
    # office-profile.json. Portal 설정이 비어 있으면(`configured_model:
    # null`) 이 값이 여전히 그대로 적용된다 — 이 필드 자체의 동작은 바뀌지
    # 않았다.
    chat_model_id_override: str | None = None

    # Shared config/ollama.json endpoint for chat and model discovery.
    # manifests applies this to Ollama aliases; the existing environment
    # override AGENT_RUNTIME_OLLAMA_ENDPOINT retains precedence.
    ollama_endpoint: str = Field(default_factory=load_ollama_endpoint)

    # D-092: Portal 관리자 화면(P15)의 채팅 모델 설정을 이 런타임이 매 LLM
    # 호출/모델 목록 조회마다 portal-api에 물어보면 portal-api 지연이 모든
    # 채팅 응답의 임계 경로에 들어가고, portal-api 장애가 곧 채팅 장애가
    # 된다 — D-092가 명시적으로 금지한 결합이다. 이 TTL(초) 동안은
    # `chat_model_setting_cache.ChatModelSettingCache`가 portal-api를 다시
    # 부르지 않고 마지막으로 알려진 값을 그대로 쓴다. 설정을 Portal에서
    # 바꿔도 이 TTL이 지나기 전까지는(그리고 이미 시작된 Run에는, TTL과
    # 무관하게) 반영되지 않는다 — open-decisions.md D-092의 남은 결정
    # 항목.
    chat_model_setting_cache_ttl_seconds: float = 30.0
    # `HttpChatModelSettingResolver`가 portal-api를 호출할 때 쓰는 타임아웃
    # — `query_rewrite_timeout_seconds`와 같은 역할: portal-api가 느리게
    # 응답해도 이 런타임의 요청이 무한정 걸리지 않게 한다. 타임아웃이든
    # 다른 어떤 실패든 `ChatModelSettingCache`가 잡아 마지막으로 알려진
    # 값으로 계속 돈다(예외를 절대 호출자에게 흘리지 않는다).
    chat_model_setting_timeout_seconds: float = 5.0

    # D-034 해석 경로 4 (`local_agent_registry.py`): registration table that
    # turns a Desktop-installed Agent Package into a runnable local
    # resolution path — same fail-closed-by-default shape as D-079's
    # `SEARCH_LOCAL_INDEX_ROOTS` and this file's own
    # `mcp_tool_registration_allowed_aliases`. Empty by default: every
    # registration is refused (`local_agents_disabled`) until an operator
    # explicitly lists at least one Desktop install root (the directory
    # containing `assets/agents/<id>/<version>/`, i.e.
    # `company-ai-client/`, NOT the `assets/` subdirectory itself — this
    # module joins `assets/agents|prompts/...` onto each configured root
    # itself, see that module's docstring "Path safety"). No existing
    # deployment's behavior changes merely because this setting now exists.
    local_agent_roots: tuple[str, ...] = ()
    # Persistent JSON file backing the registry (same "rewrite whole file
    # under a lock" design as `mcp_tool_registry_path` above and
    # search-runtime's `LOCAL_INDEX_REGISTRY_PATH`).
    local_agent_registry_path: Path = (
        _REPO_ROOT / "data" / "agent-runtime" / "local-agent-registry.json"
    )

    # --- D-094 MCP 서버 (프로토콜 클라이언트) --------------------------------
    #
    # 이 서비스가 두 모드로 돈다는 사실은 그동안 `main.py` docstring 에만 있고
    # 코드에는 없었다(바인딩 주소만 달랐다). D-094 가 이 값을 **판정에** 쓰기
    # 시작하므로 명시적 설정으로 올린다.
    #
    # 기본값이 `hosted` 인 것은 의도다. 이 값이 결정하는 것은 "stdio MCP 서버를
    # 자식 프로세스로 띄울 수 있는가" 하나인데, 두 방향의 실수가 대칭이 아니다:
    # hosted 인데 `local` 로 잘못 두면 공유 서버에서 서드파티 코드가 **지금
    # 대화 중인 사용자의 감사 컨텍스트로** 실행된다. 반대로 local 인데
    # `hosted` 로 두면 stdio 서버가 안 뜰 뿐이고, 거부 사유가 무엇을 설정해야
    # 하는지 그대로 알려준다. 위험한 쪽이 명시적 선택을 요구하게 둔다.
    #
    # stdio 를 켜는 **별도 스위치는 없다**. hosted 에서 stdio 를 허용하는 설정을
    # 만들면 그것은 언젠가 켜지는 스위치이고, D-094 가 막으려던 것이 정확히
    # 그것이다.
    runtime_mode: Literal["local", "hosted"] = "hosted"
    # 외부에서 설치된 MCP 서버 Bundle 을 등록할 수 있는 루트 목록. 비어 있으면
    # 등록이 전면 거부된다(`mcp_server_registration_disabled`) — D-079 의
    # `SEARCH_LOCAL_INDEX_ROOTS`, 위의 `local_agent_roots` 와 같은 모양이다.
    # Bundle 설치가 서버를 실행 가능하게 만들지 않는다는 성질이 여기서 나온다.
    mcp_server_install_roots: tuple[str, ...] = ()
    # stdio 서버를 실행할 인터프리터의 **절대 경로**. PATH 탐색으로 대체하지
    # 않는다(D-084 의 `pythonInterpreterPath` 와 같은 이유 — PATH 는 검토된 적
    # 없는 런타임으로 조용히 해석된다). 비어 있으면 그 interpreter 를 요구하는
    # 매니페스트는 `interpreter_not_configured` 로 거부된다.
    mcp_node_interpreter_path: str | None = None
    mcp_python_interpreter_path: str | None = None
    # 핸드셰이크와 `tools/list` 에 허용하는 시간. 응답하지 않는 서버 때문에
    # 등록 요청이 매달려 있지 않게 한다.
    mcp_connect_timeout_seconds: float = 20.0

    class Config:
        env_prefix = "AGENT_RUNTIME_"


settings = AgentRuntimeSettings()
