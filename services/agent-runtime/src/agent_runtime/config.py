"""Agent Runtime settings."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode

from agent_runtime.ollama_config import load_ollama_endpoint

_REPO_ROOT = Path(__file__).parent.parent.parent.parent.parent  # enterprise-ai-asset-hub/
#: services/agent-runtime/ — `.env` 가 놓이는 곳. 파일 위치에서 거슬러 올라가므로
#: 프로세스를 어디서 띄우든 같은 파일을 가리킨다(아래 `env_file` 주석 참고).
_SERVICE_ROOT = Path(__file__).parent.parent.parent


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
    mcp_tool_registration_allowed_aliases: Annotated[tuple[str, ...], NoDecode] = ()
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

    # --- 로컬 모델 지연 (2026-09-18 실사용: "채팅 반응이 너무 느리다") -------
    #
    # 라우팅 3종(KNOWLEDGE_ROUTE/TOOL_ROUTE/질의 재작성)은 JSON 한 줄을 받으려고
    # 답변과 **같은 채팅 모델**을 부른다. 상한이 없으면 모델이 계속 이어 써서
    # 위 타임아웃까지 가고, 그 시간 전체가 사용자 대기 시간이 된다(실측:
    # `tool.route.no_tool reason=error_or_timeout latency_ms=8010`). 0 이하로
    # 두면 상한을 보내지 않는다(기존 동작).
    #
    # 답변 생성에는 적용하지 않는다 — 답을 길이로 자르면 잘린 답이 나온다.
    router_max_output_tokens: int = 160
    # Ollama `keep_alive`. 기본값(5분)이면 대화가 잠깐 뜸한 사이 모델이
    # 내려가고 다음 질문이 로딩 시간을 통째로 기다린다. 빈 문자열이면 필드를
    # 보내지 않는다(= Ollama 기본값).
    ollama_keep_alive: str = "30m"
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
    local_agent_roots: Annotated[tuple[str, ...], NoDecode] = ()
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
    # D-094 기능 스위치. 기본 꺼짐 — 등록된 서버는 PEP 가 police 하는 대상이
    # 되고, 그 목록에 무엇이 들어가는지는 운영자가 정한다.
    #
    # 처음에는 `mcp_server_install_roots` 가 비었는지로 이 판단을 대신했는데,
    # 그러면 로컬에서 아무것도 실행하지 않는 HTTP 서버를 등록하는 데도 의미
    # 없는 경로를 설정해야 한다(실제로 office-mcp-server 를 등록해 보려다
    # 막혔다). 실행과 무관한 것을 실행 설정으로 막으면 운영자는 그 설정을
    # 아무 값으로나 채우게 되고, 정작 stdio 를 막으려던 통제가 형해화된다.
    mcp_server_registration_enabled: bool = False

    #: **stdio 전용** — "이 배포에서 서드파티 코드를 어디서 실행해도 되는가".
    #: HTTP 서버 등록에는 관여하지 않는다.
    mcp_server_install_roots: Annotated[tuple[str, ...], NoDecode] = ()
    # stdio 서버를 실행할 인터프리터의 **절대 경로**. PATH 탐색으로 대체하지
    # 않는다(D-084 의 `pythonInterpreterPath` 와 같은 이유 — PATH 는 검토된 적
    # 없는 런타임으로 조용히 해석된다). 비어 있으면 그 interpreter 를 요구하는
    # 매니페스트는 `interpreter_not_configured` 로 거부된다.
    mcp_node_interpreter_path: str | None = None
    mcp_python_interpreter_path: str | None = None
    # 핸드셰이크와 `tools/list` 에 허용하는 시간. 응답하지 않는 서버 때문에
    # 등록 요청이 매달려 있지 않게 한다.
    mcp_connect_timeout_seconds: float = 20.0

    #: MCP Tool 인가(`mcp_client.policy._authorization_denial`)에 쓰는 **로컬
    #: 사용자 역할**. 이 Runtime 에는 아직 호출자 신원 어댑터가 없어(D-015 PoC
    #: Mock User Context, D-035 미인증) 모든 대화가 같은 고정 사용자로 판정된다.
    #:
    #: 예전에는 `workflow.py` 의 상수 `["USER"]` 였다. 그래서 `CREATOR`/`ADMIN`
    #: 만 허용하는 서버(예: hello-mcp 1.0.0)는 Desktop 대화에서 **어떤 설정으로도**
    #: 부를 수 없었다(2026-09-18 실사용: `hello.now` 가 제안됐는데
    #: MCP_PERMISSION_DENIED). 운영자가 이 PC 의 역할을 정할 수 있게 설정으로 뺐다.
    #: 기본값은 그대로 `USER` — 설정하지 않으면 동작이 바뀌지 않는다.
    #:
    #: 모든 등록 서버의 판정에 영향을 준다(서버마다 따로 줄 수 없다). 받는 모양:
    #: `USER,CREATOR` / `USER;CREATOR` / `["USER", "CREATOR"]`. 대문자로 맞춘다.
    poc_mcp_user_roles: Annotated[tuple[str, ...], NoDecode] = ("USER",)

    @field_validator("poc_mcp_user_roles", mode="before")
    @classmethod
    def _parse_roles(cls, value: object) -> object:
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError as e:
                    raise ValueError(
                        f'역할을 JSON 배열로 읽지 못했습니다({e.msg}). 예: ["USER", "CREATOR"] '
                        "또는 대괄호 없이 USER,CREATOR"
                    ) from e
                if not isinstance(parsed, list):
                    raise ValueError('JSON 으로 쓸 경우 배열이어야 합니다(예: ["USER", "CREATOR"]).')
                items = [str(item) for item in parsed]
            else:
                items = text.replace(";", ",").split(",")
        elif isinstance(value, (list, tuple)):
            items = [str(item) for item in value]
        else:
            return value
        roles = tuple(dict.fromkeys(item.strip().strip('"').strip("'").upper() for item in items if item.strip()))
        # 비어 있으면 Default Deny 로 **모든** Tool 이 조용히 거부된다 — 설정 실수가
        # "권한 없음"으로만 보이지 않게 기동 시점에 말한다.
        if not roles:
            raise ValueError(
                "역할이 비어 있습니다 — 이대로면 모든 MCP Tool 이 거부됩니다. "
                "기본값(USER)을 쓰려면 이 설정을 지우세요."
            )
        return roles

    # --- 목록 설정을 사람이 쓰는 모양 그대로 받는다 -------------------------
    #
    # 위 세 필드는 `.env` 나 환경변수로 들어온다. pydantic-settings 는 기본적으로
    # 복합 타입(tuple/list) 값을 **JSON 으로만** 읽어서, 사람이 자연스럽게 쓰는
    # 두 모양이 전부 기동 실패가 됐다(2026-09-18 실사용 제보 — 사내 PC 에서
    # agent-runtime 이 이 오류로 뜨지 않았다):
    #
    #     AGENT_RUNTIME_MCP_SERVER_INSTALL_ROOTS=C:\Users\hong\assets
    #     AGENT_RUNTIME_MCP_SERVER_INSTALL_ROOTS=["C:\Users\hong\assets"]
    #
    # 앞의 것은 JSON 이 아니라서, 뒤의 것은 `\U` 가 JSON 에서 잘못된 이스케이프라서
    # 실패한다 — 즉 "Windows 경로를 JSON 에 넣으려면 역슬래시를 두 번 써야 한다"를
    # 이미 아는 사람만 쓸 수 있는 설정이었다. 게다가 그때 나오는 메시지는
    # `error parsing value for field "..." from source "DotEnvSettingsSource"` 한 줄뿐이라
    # **무엇이 잘못됐는지도, 어떻게 고치는지도 말하지 않는다.**
    #
    # 그래서 `NoDecode` 로 JSON 해석을 끄고 여기서 직접 읽는다. 받는 모양:
    #   - JSON 배열 `["C:/a", "C:/b"]` — 기존 `.env` 가 그대로 계속 동작한다
    #   - `os.pathsep` 구분 목록 `C:\a;C:\b` (Windows `;`, POSIX `:`) —
    #     search-runtime 의 `SEARCH_LOCAL_INDEX_ROOTS` 와 같은 관례
    #   - 줄바꿈 구분, 또는 값 하나짜리 평문
    #
    # `[` 로 시작하는데 JSON 으로 못 읽으면 **구분자 분리로 넘어가지 않고 거부**한다.
    # 그대로 나누면 `["C:\a"]` 같은 문자열이 경로 하나로 통째로 들어가 "설정은
    # 했는데 아무것도 안 잡히는" 상태가 되고, 그 증상은 기동 실패보다 찾기 어렵다.
    @field_validator(
        "mcp_tool_registration_allowed_aliases",
        "local_agent_roots",
        "mcp_server_install_roots",
        mode="before",
    )
    @classmethod
    def _parse_delimited_list(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        text = value.strip()
        if not text:
            return ()
        if text.startswith("["):
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError as e:
                raise ValueError(
                    f"JSON 배열로 쓰다가 읽지 못했습니다({e.msg}). Windows 경로를 JSON 에 "
                    '넣으려면 역슬래시를 두 번 쓰거나 슬래시를 쓰세요(["C:/Users/..."]). '
                    f'대괄호 없이 "{os.pathsep}" 로 구분해 나열해도 됩니다.'
                ) from e
            if not isinstance(parsed, list):
                raise ValueError('JSON 으로 쓸 경우 배열이어야 합니다(예: ["C:/Users/..."]).')
            return tuple(str(item).strip() for item in parsed if str(item).strip())
        parts = [part for line in text.splitlines() for part in line.split(os.pathsep)]
        values = tuple(
            cleaned
            for cleaned in (part.strip().strip('"').strip("'") for part in parts)
            if cleaned
        )
        # `.env` 에서 값을 **큰따옴표로 감싸면** python-dotenv 가 그 안의
        # `\a`/`\t`/`\U` 를 이스케이프로 해석한다 — `"C:\Users\hong\assets"` 가
        # 조용히 `C:\Users\hong\x07ssets` 가 되어 기동은 성공하는데 그 경로가
        # 없으니 아무 서버도 잡히지 않는다. 여기 도달했을 때는 이미 망가진
        # 뒤라 원래 값을 되돌릴 수 없으므로, 대신 **틀렸다고 말한다** —
        # 실제 경로에는 제어문자가 들어가지 않는다.
        for item in values:
            if any(ch < " " for ch in item):
                raise ValueError(
                    "값에 제어문자가 들어 있습니다 — `.env` 에서 큰따옴표로 감싸면 "
                    r"역슬래시가 이스케이프로 해석됩니다(\a, \t, \U ...). "
                    "따옴표를 빼거나 작은따옴표를 쓰세요."
                )
        return values

    class Config:
        env_prefix = "AGENT_RUNTIME_"

        # 이 서비스 폴더의 `.env` 를 읽는다(`make dev-agent-runtime` 과
        # `scripts/windows/start-agent-runtime.ps1` 이 거기서 기동한다).
        #
        # 없어도 동작한다 — 환경변수가 여전히 우선이고, `.env` 는 그것을
        # 대신하는 것이 아니라 기본값 위에 얹는 층이다.
        #
        # **왜 필요한가**: stdio MCP 서버 설정(설치 루트, 해석기 경로)은
        # PC 마다 다른 값이다. 지금까지 이런 값을 넣는 방법은 기동 스크립트를
        # 고치는 것뿐이었는데, 그것은 추적되는 파일이라 사람마다 다른 값이
        # 커밋 대상으로 올라온다(`config/ollama.json` 이 실제로 그렇게 됐다).
        # `.env` 는 `.gitignore` 에 이미 들어 있어 그 문제가 없다.
        #
        # **절대 경로다.** 처음에는 `".env"` 라고만 적었는데, 그러면 경로가
        # **프로세스의 CWD** 기준이라 `services/agent-runtime` 밖에서 띄우면
        # 파일이 조용히 무시된다 — 오류도 경고도 없이 모든 값이 기본값으로
        # 돌아가고, 증상은 "설정을 넣었는데 반영이 안 된다"로만 나타난다
        # (실제로 이 저장소 루트에서 띄워 보고 발견했다: enabled=False,
        # roots=()). `make dev-agent-runtime` 은 `cd` 후 실행해서 우연히
        # 동작하고 있었을 뿐이다.
        env_file = _SERVICE_ROOT / ".env"
        # `utf-8` 이 아니라 `utf-8-sig` 다. Windows 에서 메모장이나
        # PowerShell `Set-Content -Encoding utf8`(5.1)이 BOM 을 붙이는데,
        # 그러면 첫 줄의 키 이름이 `﻿AGENT_RUNTIME_...` 이 되어
        # "Extra inputs are not permitted" 로 기동이 죽는다 — 파일은 눈으로
        # 보면 멀쩡해서 원인을 짐작하기 어렵다(실제로 그렇게 한 번 막혔다).
        # `utf-8-sig` 는 BOM 이 있으면 벗기고 없으면 그냥 읽는다
        # (`ollama_config.py` 가 같은 이유로 같은 인코딩을 쓴다).
        env_file_encoding = "utf-8-sig"


settings = AgentRuntimeSettings()
