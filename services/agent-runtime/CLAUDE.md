# services/agent-runtime (M05)

Local/Hosted 공용 Agent Runtime Core. Knowledge 검색, LLM 생성, MCP Tool 조정,
Hosted Chat 세션을 담당한다. FastAPI, 포트 8100 (`local` 모드는 127.0.0.1
loopback, `hosted` 모드는 0.0.0.0 — `main.py` 모듈 docstring).

## 먼저 읽을 것

- `docs/implementation-spec/02-desktop-and-agent-runtime.md` §5 — 5.1 Public
  Interface, 5.2 Runtime 구성요소(Workflow 단계), 5.3 Run 상태, 5.4 Run Event,
  5.5 오류와 Fallback.
- `packages/schemas/api/local-runtime-api.yaml`(`/local/v1/runs*`),
  `hosted-chat-api.yaml`(`/chat-api/v1/*`), `api/mcp-audit-context.schema.json`
  (Request Context, office-mcp-server와 공유).
- `open-decisions.md` D-034(Registry 해석 순서), D-062(clearance 기본값),
  D-078(Hub 질의 경계).

## 코드 배치

- 실제 코드는 전부 `src/agent_runtime/` 아래에 있다. **`src/adapters/`는 빈
  부트스트랩 잔재이며 파일이 없다 — 여기에 새 코드를 쓰지 않는다.**
- `adapters/__init__.py` — ABC 6개: `LLMAdapter`, `KnowledgeAdapter`,
  `HubSearchAdapter`, `MCPAdapter`, `DeploymentResolver`,
  `AssetRegistryResolver`. 구현체는 각각 `adapters/ollama.py`
  (`OllamaLLMAdapter`), `search.py`(`HttpKnowledgeAdapter`, search-runtime),
  `hub_search.py`(`HttpHubSearchAdapter`, portal-api 검색), `mcp.py`
  (`HttpMCPAdapter`, office-mcp-server), `deployment.py`
  (`HttpDeploymentResolver`), `registry.py`(`HttpAssetRegistryResolver`).
- `workflow.py`(`run_knowledge_chat` 상태 머신), `routers/runs.py`
  (`/local/v1/runs*`), `routers/chat.py`(`/chat-api/v1/*`) — 동일한
  `run_knowledge_chat`/`RunStore`를 공유(spec §6.2 "Preview가 게시 Runtime
  Core를 사용").
- `manifests.py`(표준 config 로더 + D-034 Registry 해석), `hub_query.py`
  (Hub 질의를 만드는 유일한 경로 — 아래 참고), `conversation.py`(multi-turn
  `bound_history`/`rewrite_query_for_search`), `knowledge_router.py`
  (KNOWLEDGE_ROUTE 단계 — 후보 지식 자산 metadata + 이번 턴 질문만으로
  검색 대상 Knowledge를 고르는 선택적 LLM 호출 하나, 실패 시 후보 전체
  검색으로 fail-open).
- `mcp_tools.py` — office-mcp-server Tool 계약의 **손으로 복사한 정적 사본**
  (`MCP_TOOL_SPECS`) — M10이 Tool을 바꾸면 이 파일도 수동 갱신해야 한다
  (drift risk, open-decisions.md 기록).
- `run_store.py`/`chat_sessions.py` — in-memory `RunStore`/
  `ChatSessionStore`(PoC, 영속성 없음).
- `config/` — 기동 시 로드·검증하는 표준 정의 사본: `standard-agent`,
  `standard-prompt`, `standard-db-agent`, `standard-db-prompt`,
  `office-profile-default`. 4개 발행된 Hosted 챗봇이 이 트리에 의존한다.

### 워크플로 단계와 SSE 이벤트 (workflow.py 기준, 추측 아님)

INPUT_VALIDATE → PREPARE → (ANALYZE: 명시적 `mcp_tool` 필드로 결정, LLM이
아님) → KNOWLEDGE_SEARCH(0..n) → [Stage 2 Hub 조회, opt-in] → TOOL_CONFIRM
(선택) → MCP_TOOL_CALL(0..n) → ANSWER_GENERATE → OUTPUT_VALIDATE → COMPLETE.

Run 상태(`run_store.py`): `CREATED`, `PREFLIGHT`, `RUNNING`,
`WAITING_FOR_USER`(비종결, `RUNNING`/`CANCELLED`/`FAILED`로 귀결),
`SUCCEEDED`, `FAILED`, `CANCELLED`, `INSUFFICIENT_EVIDENCE`(`TERMINAL_STATUSES`).

내부 이벤트 이름: `run.started`, `preflight.completed`,
`knowledge.route.selected`, `knowledge.search.started`,
`knowledge.query_rewritten`, `knowledge.search.completed`,
`citation.added`, `hub.query_sent`, `hub.search.completed`,
`mcp.confirmation_required`, `mcp.confirmation_resolved`,
`mcp.confirmation_expired`, `mcp.call.started`, `mcp.call.completed`,
`answer.delta`, `run.completed`, `run.failed`, `run.cancelled`.
Hosted(`chat.py`)는 이 중 6개만(`_INTERNAL_TO_HOSTED_EVENT`) 번역해 노출하고
나머지는 드롭한다 — `knowledge.route.selected`는 의도적으로 포함하지 않는다
(Hosted 챗봇은 `knowledge_candidates`를 절대 보내지 않으므로 이 이벤트
자체가 발생하지 않는다).

**근거 0건이면 LLM을 호출하지 않는다** (D-036 hallucination guard,
`workflow.py`의 `if len(citations) == 0 and len(tool_results) == 0:` →
`INSUFFICIENT_EVIDENCE`로 즉시 종료, `ANSWER_GENERATE`에 도달하지 않음).
`history`는 검색 질의 재작성에만 영향을 주고 이 가드를 절대 우회하지 않는다
— 회귀 테스트: `test_history_does_not_bypass_hallucination_guard`.

## 이 모듈의 경계

- `pyproject.toml` 의존성: `fastapi`, `uvicorn`, `pydantic`, `httpx`,
  `jsonschema`, workspace 패키지 `ai-asset-schemas`, `security-policy`,
  `observability`. `services/office-mcp-server`/`apps/portal-api`는
  의존성에 없다 — **HTTP로만** 통신한다.
- 두 서비스의 내부 코드를 import하지 않는다. office-mcp-server 호출은
  `adapters/mcp.py`의 `HttpMCPAdapter`가, portal-api 호출은
  `adapters/registry.py`/`hub_search.py`/`deployment.py`가 공개 REST API로만
  수행한다.

## 실행

`make dev-agent-runtime` (`uv run uvicorn agent_runtime.main:app --reload --port 8100`).

## 테스트

`tests/integration/agent_runtime/` (conftest가 `app.dependency_overrides`로
Fake 어댑터 6종을 주입 — 실 서비스 불필요). 실행: `uv run pytest
tests/integration/agent_runtime/ -q` — 확인 시점 74개 통과.

## 이 모듈에서 반복해서 틀렸던 것

- **D-078: 로컬 조회 데이터를 허브로 보내지 않는다.** Hub(portal-api 중앙
  Knowledge Registry)에 보낼 질의 문자열을 만드는 경로는 `hub_query.py`의
  `build_hub_query` **하나뿐**이며, 이번 턴의 `question`과 이전 턴들의
  `turn["question"]`만 읽는다 — `turn["answer"]`(로컬 문서 내용 포함 가능)·
  인용문·로컬 재작성 검색 질의는 절대 읽지 않는다. `UserTypedQuery` 타입이
  이를 강제한다(`HttpHubSearchAdapter.search`가 다른 타입이면 `TypeError`).
  회귀 테스트: `test_hub_query.py`
  (`test_build_hub_query_never_includes_answer_text_even_with_marker`),
  `test_runs.py`(`test_hub_lookup_never_leaks_prior_answer_text_to_hub`).
  **`hub_query.py`/`workflow.py` Stage 2/`hub_search.py`를 건드리면 반드시
  이 두 테스트 파일을 실행해 통과를 확인한다.**
- CORS `allow_origins`는 `settings.cors_origins`(`config.py`)를 반드시
  거쳐야 한다 — `main.py`에 한때 하드코딩되어 이 설정을 무시한 적이 있다
  (증상: 서버 로그는 200인데 브라우저가 응답을 버림). 새 origin이 필요하면
  `cors_origins` 리스트에 `localhost`/`127.0.0.1` 두 형태를 모두 추가한다.
  같은 이유로 timeout류 값도 `config.py`의 `AgentRuntimeSettings` 필드로
  두고 `workflow.py`/`conversation.py`에 리터럴로 박지 않는다.
  **설정으로 옮긴 뒤에도 값 자체가 틀릴 수 있다(2026-08-14 실사용).** 이 목록의
  기본값은 한동안 `5174`였는데, Desktop 렌더러의 실제 포트는 `apps/desktop-client/
  vite.config.ts`의 `port: 5173`/`strictPort: true`와 `electron/main.ts`가 로드하는
  5173이다 — 목록을 포트를 바인딩하는 코드가 아니라 문서를 보고 적었던 것이 원인이었고,
  search-runtime이 이 목록을 그대로 복사해가면서 같은 오류가 두 서비스에 번졌다. 지금은
  search-runtime/office-mcp-server와 목록을 동일하게 맞췄고(env `AGENT_RUNTIME_CORS_ORIGINS`로
  개별 덮어쓰기 가능), `tests/unit/search_runtime/test_cors.py`의
  `test_default_origins_match_every_browser_facing_service`가 세 서비스 목록이 갈라지면
  즉시 깨지도록 고정한다 — 이 목록을 바꾸면 그 테스트를 반드시 같이 돌린다.

## 완료 전 확인

- `mcp_tools.py`의 `MCP_TOOL_SPECS`를 office-mcp-server의
  `tools_setup.py`와 손으로 대조했는가(자동 동기화 없음).
- Hub 경로(`hub_query.py`/`hub_search.py`/`workflow.py` Stage 2)를
  건드렸다면 `test_hub_query.py`/`test_runs.py`의 hub 테스트를 실행했는가.
- 새 Run 상태/SSE 이벤트를 추가했다면 `run_store.py`의 `TERMINAL_STATUSES`와
  `routers/chat.py`의 `_INTERNAL_TO_HOSTED_EVENT` 매핑을 함께 갱신했는가.
- `config/standard-*` 스키마를 바꿨다면 기동이 실패 없이 도는지 확인했는가
  — 4개 발행된 Hosted 챗봇이 이 트리에 의존한다.
