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
  D-078(Hub 질의 경계), D-083(TOOL_ROUTE — ANALYZE 반전, fail-closed).

## 코드 배치

- 실제 코드는 전부 `src/agent_runtime/` 아래에 있다. **`src/adapters/`는 빈
  부트스트랩 잔재이며 파일이 없다 — 여기에 새 코드를 쓰지 않는다.**
- `adapters/__init__.py` — ABC 7개: `LLMAdapter`, `KnowledgeAdapter`,
  `HubSearchAdapter`, `MCPAdapter`, `DeploymentResolver`,
  `AssetRegistryResolver`, `ChatModelSettingResolver`(D-092). 구현체는
  각각 `adapters/ollama.py`(`OllamaLLMAdapter`), `search.py`
  (`HttpKnowledgeAdapter`, search-runtime), `hub_search.py`
  (`HttpHubSearchAdapter`, portal-api 검색), `mcp.py`(`HttpMCPAdapter`,
  office-mcp-server), `deployment.py`(`HttpDeploymentResolver`),
  `registry.py`(`HttpAssetRegistryResolver`), `chat_model_setting.py`
  (`HttpChatModelSettingResolver`, portal-api의
  `GET /api/v1/admin/chat-model-setting`) — 이 마지막 것은 직접 쓰지 않고
  `chat_model_setting_cache.py`의 `ChatModelSettingCache`(TTL 캐시 +
  portal-api 미도달 시 마지막 값으로 fail-open)를 통해서만 쓴다(아래 D-092
  항목 참고). `ollama_models.py`(`list_ollama_models`/`is_chat_capable`,
  `GET /local/v1/models`가 쓰는 Ollama `/api/tags` 조회 + 채팅 가능 여부
  휴리스틱 — indexing-runtime의 `embedders.py`와 같은 역할, import 아님,
  모듈 경계상 복제).
- `workflow.py`(`run_knowledge_chat` 상태 머신), `routers/runs.py`
  (`/local/v1/runs*`), `routers/chat.py`(`/chat-api/v1/*`) — 동일한
  `run_knowledge_chat`/`RunStore`를 공유(spec §6.2 "Preview가 게시 Runtime
  Core를 사용").
- `manifests.py`(표준 config 로더 + D-034 Registry 해석), `hub_query.py`
  (Hub 질의를 만드는 유일한 경로 — 아래 참고), `conversation.py`(multi-turn
  `bound_history`/`rewrite_query_for_search`), `knowledge_router.py`
  (KNOWLEDGE_ROUTE 단계 — 후보 지식 자산 metadata + 이번 턴 질문만으로
  검색 대상 Knowledge를 고르는 선택적 LLM 호출 하나, 실패 시 후보 전체
  검색으로 fail-open), `tool_router.py`(D-083 TOOL_ROUTE 단계 — 후보 Tool
  metadata(`tool_name`/`input_schema`) + 이번 턴 질문만으로 Tool 이름+인자를
  "제안"하는 선택적 LLM 호출 하나, 실패/거절/스키마 불일치 시 **아무 Tool도
  호출하지 않는 fail-closed** — knowledge_router.py와 정반대 방향, 이유는
  그 모듈 자신의 docstring 참고).
- `mcp_client/`(D-094, 신규) — **진짜 MCP 프로토콜 클라이언트**. 공식 `mcp` SDK
  위에 얹혀 JSON-RPC·`initialize` 협상·`tools/list`·`tools/call` 을 말한다.
  이 저장소의 기존 "MCP"(`adapters/mcp.py` + office-mcp-server 의
  `/mcp/v1/tools/...`)는 이름만 MCP 인 자체 REST 라는 것이 2026-09-16 에
  확인됐다 — 저장소 전체에 `jsonrpc` 가 한 건도 없었다. 세 파일로 나뉜다:
  `connection.py`(**이 기능의 보안 경계 전부**), `client.py`(프로토콜 왕복),
  `policy.py`(Policy Enforcement Point — "이 호출을 해도 되는가"),
  `errors.py`(이름 있는 거부 사유). **`policy.py` 는 05-mcp-security-governance.md
  의 통제를 office-mcp-server 안에서 클라이언트로 옮긴 것이다** — 서버 안에
  있으면 우리가 만든 서버만 지키지만 클라이언트에 있으면 서드파티 서버에도
  적용된다. 옮기면서 느슨해지기 쉬운 네 가지는 회귀 테스트로 고정돼 있다:
  Default Deny(`allowed_roles`/`allowed_orgs` 가 비면 전원 거부, `allowed_sites`
  만 선택 차원), 거부가 정책을 누설하지 않음(차원은 감사에만, 사용자 메시지는
  전부 동일), `llm_routable` 은 `risk_level` 에서 **유도**(WRITE 는 모델 후보에서
  구조적 제외 — D-083 전제 보존), 확인 정책을 낮추지 않음. Rate Limit 검사는
  **인가보다 뒤**에 둔다 — 앞에 두면 어차피 거부될 호출이 정상 호출의 예산을
  갉아먹고, 권한 없는 호출 반복으로 남의 예산을 고갈시킬 수 있다.
  `ON_PARAMETER` 는 현재 `ALWAYS` 와 같게 동작한다(계약에 '어느 인자가 확인을
  유발하는가'를 적을 자리가 없어 일반 Tool 에 대해 알 수 없다 — D-049 와 같이
  엄격한 쪽으로 반올림). **연결 대상을 정하는 판단은 전부
  `connection.resolve_connection_target` 한 곳에만 둔다** — 두 곳에서 정하면
  한 곳만 고쳐진다. `client._build_sdk_target` 은 그 결정을 SDK 형태로 옮길
  뿐 아무것도 결정하지 않으며, 테스트 편의를 위해 받는 타입을 넓히지 않는다
  (그래서 프로토콜 테스트는 SDK `Client` 를 직접 열고 `discover()` 에 세션을
  넘긴다). SDK `Tool` 의 필드는 `input_schema` 이지 wire 형식의 `inputSchema`
  가 아니다 — 2.x 에서 바뀌었고, SDK 를 mock 했다면 못 잡았을 실수다.
- `mcp_tools.py` — office-mcp-server Tool 계약의 **손으로 복사한 정적 사본**
  (`MCP_TOOL_SPECS`) — M10이 Tool을 바꾸면 이 파일도 수동 갱신해야 한다
  (drift risk, open-decisions.md 기록). `list_candidate_tools`(D-083)가
  TOOL_ROUTE 후보 집합을 계산하는 유일한 경로 — (Office Profile의
  `allowed_mcp_servers[].allowed_tools` ∪ ACTIVE로 등록된 MCP 서버의
  `declared_tools`, D-094 이어 붙이기)와 이 파일이 스키마를 아는 Tool의
  교집합이며, 호출자가 보낸 무엇으로도 넓어지지 않는다. 사용자가 고른 범위
  (`input.mcp_tool_names`)는 `filter_candidates_to_scope`가 **좁히는 데만**
  쓴다.
- `run_store.py`/`chat_sessions.py` — in-memory `RunStore`/
  `ChatSessionStore`(PoC, 영속성 없음).
- `config/` — 기동 시 로드·검증하는 표준 정의 사본: `standard-agent`,
  `standard-prompt`, `standard-db-agent`, `standard-db-prompt`,
  `office-profile-default`. 4개 발행된 Hosted 챗봇이 이 트리에 의존한다.

### 워크플로 단계와 SSE 이벤트 (workflow.py 기준, 추측 아님)

INPUT_VALIDATE → PREPARE → (ANALYZE: 명시적 `mcp_tool` 필드로 결정, LLM이
아님 — 단, D-083: 명시적 필드가 없고 `input.tool_route=true`이면
TOOL_ROUTE가 대신 하나 제안한다) → KNOWLEDGE_SEARCH(0..n) → [Stage 2 Hub
조회, opt-in] → [TOOL_ROUTE, opt-in, D-083] → TOOL_CONFIRM (선택) →
MCP_TOOL_CALL(0..n) → ANSWER_GENERATE → OUTPUT_VALIDATE → COMPLETE.

Run 상태(`run_store.py`): `CREATED`, `PREFLIGHT`, `RUNNING`,
`WAITING_FOR_USER`(비종결, `RUNNING`/`CANCELLED`/`FAILED`로 귀결),
`SUCCEEDED`, `FAILED`, `CANCELLED`, `INSUFFICIENT_EVIDENCE`(`TERMINAL_STATUSES`).

내부 이벤트 이름: `run.started`, `preflight.completed`,
`knowledge.route.selected`, `knowledge.search.started`,
`knowledge.query_rewritten`, `knowledge.search.completed`,
`citation.added`, `hub.query_sent`, `hub.search.completed`,
`mcp.tool_route.selected`, `mcp.tool_route.rejected`(둘 다 D-083),
`mcp.confirmation_required`, `mcp.confirmation_resolved`,
`mcp.confirmation_expired`, `mcp.call.started`, `mcp.call.completed`,
`answer.delta`, `run.completed`, `run.failed`, `run.cancelled`.
Hosted(`chat.py`)는 이 중 6개만(`_INTERNAL_TO_HOSTED_EVENT`) 번역해 노출하고
나머지는 드롭한다 — `knowledge.route.selected`와 `mcp.tool_route.*`는
의도적으로 포함하지 않는다(Hosted 챗봇은 `knowledge_candidates`도
`tool_route`도 절대 보내지 않으므로 이 이벤트 자체가 발생하지 않는다).

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

- **"404 model not found"가 뜨면**(Knowledge 메타데이터 서제스트, 대화,
  Hosted Chat, 라우팅 등 `OllamaLLMAdapter`를 쓰는 모든 경로에서 발생 가능,
  D-091): 이건 `/api/chat` 경로가 없다는 뜻이 아니다(그 경로는 항상 있고
  GET 하면 405가 뜬다) — 지금 실제로 적용 중인 `default-chat` model_id가
  그 PC의 Ollama에 설치돼 있지 않다는 뜻이다. **D-092(2026-08-20)로 조치
  우선순위가 바뀌었다** — 지금 어떤 model_id가 적용 중인지는
  `GET /local/v1/models`의 `default_chat_model`로 확인한다(설치된 모델
  목록도 같은 응답의 `models`에 있다). 조치, 우선순위 높은 순: (1) **Portal
  관리자 화면(P15)에 채팅 모델 설정이 저장돼 있다면 그게 최우선이다** — 그
  화면에서 이미 설치된 모델로 바꾼다(설치 안 된 모델은 그 화면이 저장 자체를
  거부한다). (2) Portal 설정이 없다면 `ollama list`로 설치된 모델을 확인하고
  네트워크가 있으면 `ollama pull <model_id>`. (3) **폐쇄망이라 pull이 안
  되면** 이미 설치된 모델을 가리키도록
  `AGENT_RUNTIME_CHAT_MODEL_ID=<installed-model-id>` 환경변수를 설정하고
  재기동 — 기동 로그에 `office_profile.chat_model_id_override applied ...`
  한 줄이 찍히면 적용된 것이다. 단, **Portal 설정이 있으면 이 환경변수보다
  Portal 쪽이 이긴다** — 환경변수를 바꿔도 반응이 없다면 먼저 Portal에
  설정이 저장돼 있는지부터 확인한다. 설치된 모델로 **자동 대체는 절대 하지
  않는다**(D-091/D-092, 모든 층 공통) — 안 하면 사용자가 어떤 모델이 실제로
  답하는지 모른 채 성격이 바뀐다.
- **D-092 (2026-08-20): 채팅 모델 설정에 Portal 관리자 화면(P15) 계층이
  추가됐다.** 우선순위: Portal 설정(`chat_model_setting_cache
  .get_chat_model_setting_cache`, portal-api의
  `GET /api/v1/admin/chat-model-setting`을 TTL(`settings
  .chat_model_setting_cache_ttl_seconds`, 기본 30초)로 캐시) >
  `AGENT_RUNTIME_CHAT_MODEL_ID`(`settings.chat_model_id_override`) >
  office-profile.json. 뒤 두 층은 `manifests._load_default_office_profile`이
  기동 시점에 이미 `office_profile`에 반영해 두고, `routers/runs
  .get_llm_adapter`(현재 async)와 `routers/models.py`가 매 호출마다 그 위에
  Portal 층을 얹는다 — **office_profile을 직접 mutate하지 않고 얕은 복사로
  얹는다**, 그 객체는 여러 Run이 공유하는 캐시이기 때문이다. portal-api가
  닿지 않으면 `ChatModelSettingCache`가 예외를 삼키고 마지막으로 알려진
  값으로 계속 돈다(로그는 남기되 TTL당 한 번만 — 매 호출마다 도배하지
  않는다) — Portal이 죽어도 채팅이 죽지 않는다는 D-092의 요구사항이다.
  `GET /local/v1/models`(`routers/models.py`, `ollama_models.py`)가 이 모든
  계산의 참조 구현이자 설치된 모델 목록 조회 endpoint다 — 이 endpoint를
  건드리면 `tests/integration/agent_runtime/test_local_models_endpoint.py`를
  반드시 돌린다.

- **목록 설정(`tuple[str, ...]`)을 `.env`에 평문으로 쓰면 서비스가 아예 뜨지
  않았다(2026-09-18 사내 PC 실사용).** pydantic-settings는 복합 타입 값을
  **JSON으로만** 읽어서 `AGENT_RUNTIME_MCP_SERVER_INSTALL_ROOTS=C:\Users\...`
  같은 값이 `SettingsError: error parsing value for field "..." from source
  "DotEnvSettingsSource"`로 기동을 막았다 — 그 메시지는 원인도 해결책도
  말하지 않는다. "Windows 경로를 JSON에 넣으려면 역슬래시를 두 번 써야 한다"를
  이미 아는 사람만 쓸 수 있는 설정이었다. 지금은 세 목록 설정
  (`mcp_server_install_roots`/`local_agent_roots`/
  `mcp_tool_registration_allowed_aliases`)에 `NoDecode`를 붙이고
  `config.py::_parse_delimited_list`가 직접 읽는다: JSON 배열(기존 `.env`
  호환), `os.pathsep` 구분, 줄바꿈 구분, 값 하나짜리 평문. **새 목록 설정을
  추가하면 이 검증기의 필드 목록에 함께 넣는다** — 빠뜨리면 그 필드만 다시
  JSON 전용이 되고 다음 사람이 같은 메시지를 다시 만난다.
  두 가지는 일부러 거부한다(조용히 통과시키는 쪽이 더 나쁘다): (a) `[`로
  시작하는데 JSON이 아닌 값 — 구분자로 나누면 `["C:\a"]`가 경로 하나가 되어
  "설정은 했는데 아무것도 안 잡힌다", (b) 제어문자가 섞인 값 — `.env`에서
  큰따옴표로 감싸면 python-dotenv가 `\a`/`\t`를 해석해 없는 경로를 만든다.
  `tests/unit/agent_runtime/test_settings_list_parsing.py`가 고정한다.

- **TOOL_ROUTE 후보의 출처는 두 곳이다(2026-09-18, D-094 이어 붙이기).**
  `mcp_tools.list_candidate_tools` 는 Office Profile 의
  `allowed_mcp_servers[].allowed_tools` **와** ACTIVE 로 등록된 MCP 서버의
  `declared_tools` 를 합친다. 한동안 앞엣것만 봤는데, 그 동안 서버를 설치하고
  등록까지 마쳐도 대화에서는 그 Tool 이 존재하지 않는 것과 같았다 —
  `resolve_allowed_alias` 는 이미 등록 서버를 허용하고 있었으므로 "부를 수는
  있는데 고를 수는 없는" 상태였다(실사용 제보: hello-mcp 샘플). 후보를 넓히는
  코드를 건드릴 때는 **부를 수 있는 것과 고를 수 있는 것이 갈라지지 않는지**를
  먼저 본다.
- **사용자가 보낸 Tool 목록(`input.mcp_tool_names`)은 후보를 좁히기만 한다.**
  `filter_candidates_to_scope` 가 교집합만 하고, 후보에 없는 이름은 버린다 —
  넓힐 수 있게 하면 화면에서 보낸 문자열이 곧 권한이 된다. 빈 목록은 "고른 것이
  없음"이라 후보가 0개가 되고(fail-closed), 필드를 **생략**하는 것이 "후보
  전체"다. 이 셋(생략 / 빈 목록 / 일부)이 서로 다른 뜻이라는 것을
  `tests/unit/agent_runtime/test_mcp_tool_candidates_scope.py` 가 고정한다.

- **한 턴이 답변 전에 모델을 최대 세 번 부른다(KNOWLEDGE_ROUTE / 질의 재작성 /
  TOOL_ROUTE).** 로컬 모델에서는 이것이 체감 지연의 대부분이다. 2026-09-18에
  두 가지를 넣었다: (a) 라우팅 호출에 생성 토큰 상한
  (`settings.router_max_output_tokens` → `LLMAdapter.generate(max_output_tokens=)`
  → Ollama `options.num_predict`) — 상한이 없으면 모델이 이어 쓰다 타임아웃까지
  가고 **그 시간 전체가 대기 시간**이 된다(실측 `latency_ms=8010`). 답변 생성에는
  절대 상한을 걸지 않는다. (b) `settings.ollama_keep_alive` — 기본 5분이면 대화가
  잠깐 뜸한 사이 모델이 내려간다.
  **단계별 소요시간은 `workflow._log_stage` 가 `stage.timing` 한 줄로 남긴다**
  (`knowledge_route`/`query_rewrite`/`knowledge_search`/`tool_route`/
  `answer_first_token`/`answer_total`). 느리다는 제보가 오면 추측하지 말고 이
  줄부터 grep 한다 — 전에는 실패·폴백 경로에만 `latency_ms` 가 있어서 성공한
  느린 턴은 아무 흔적도 남지 않았다.
  **병렬화는 아직 하지 않았다**: 세 호출은 서로 독립이지만 Ollama 가 요청을
  직렬 처리하면(`OLLAMA_NUM_PARALLEL`) `asyncio.gather` 로 묶어도 벽시계 시간이
  줄지 않고, GPU 한 장에서는 동시 실행이 연산을 나눠 쓸 뿐이다. 하려면 그 값부터
  확인하고, 위 `stage.timing` 으로 전후를 비교한다.

## 완료 전 확인

- `mcp_tools.py`의 `MCP_TOOL_SPECS`를 office-mcp-server의
  `tools_setup.py`와 손으로 대조했는가(자동 동기화 없음).
- Hub 경로(`hub_query.py`/`hub_search.py`/`workflow.py` Stage 2)를
  건드렸다면 `test_hub_query.py`/`test_runs.py`의 hub 테스트를 실행했는가.
- 새 Run 상태/SSE 이벤트를 추가했다면 `run_store.py`의 `TERMINAL_STATUSES`와
  `routers/chat.py`의 `_INTERNAL_TO_HOSTED_EVENT` 매핑을 함께 갱신했는가.
- `config/standard-*` 스키마를 바꿨다면 기동이 실패 없이 도는지 확인했는가
  — 4개 발행된 Hosted 챗봇이 이 트리에 의존한다.
