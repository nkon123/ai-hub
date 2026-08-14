# services/office-mcp-server (M10)

READ_ONLY MCP Tool 서버. Tool Registry, 실행 통제(Timeout/Rate
Limit/Result Limit), 사용자 확인 정책, Output Filter, Audit 로그를
담당한다. FastAPI, 포트 8500. 임의 SQL/코드 실행/외부 URL/패키지 설치 기능은
만들지 않는다(루트 CLAUDE.md 구현 원칙 7, 8).

## 먼저 읽을 것

- `docs/implementation-spec/05-mcp-security-governance.md` — §2 MCP
  구성요소(파이프라인 순서), §3 Request Context, §4 Tool Registry, §5 PoC
  Tool 정의(5.1~5.3), §6 System Connector, §7 인증과 권한, §8 실행 통제
  (8.1~8.4), §9 Output Filter, §10 MCP Audit Event, §11 운영 API.
- `packages/schemas/api/mcp-audit-context.schema.json` — `RequestContext`의
  스키마 대응물(D-049로 하나의 shape로 통합됨).
- `docs/implementation-spec/07-data-api-contracts.md` §8(공통/MCP 오류코드) —
  `errors.py`의 `ErrorCode`가 이 목록의 부분집합만 미러링한다.

## 코드 배치

- 전 코드는 `src/office_mcp_server/`에 있다(빈 부트스트랩 잔재 디렉터리
  없음).
- `main.py` — FastAPI 엔트리포인트: `/health`, `/health/live`,
  `/health/ready`, `/version`, `/mcp/v1/tools`,
  `/mcp/v1/tools/{tool_name}/call`, `/admin/tools*`, `/admin/audit/events`.
- `tools_setup.py` — `register_poc_tools`: 검토된 PoC Tool을 §4 메타데이터
  전체와 함께 등록(아래 "실제 Tool 목록" 참고).
- `tool_registry.py` — `RegisteredTool`, `UserConfirmationPolicy`(NEVER/
  ALWAYS/ON_PARAMETER), `ToolStatus`(ACTIVE/DISABLED), `ToolRegistry`(Kill
  Switch: `disable`/`enable`).
- `pipeline.py` — `ToolCallPipeline`: Request Context → Tool Registry(존재+
  Kill Switch) → Authorization → Input Validation → User Confirmation →
  Execution Guard(rate limit+timeout) → Tool Handler → Connector → Output
  Filter → Audit 순서로 배선(§2 다이어그램과 등록 순서가 다른 이유는
  `pipeline.py` 모듈 docstring 참고 — 권한 판단에 Registry의 `allowed_roles`
  메타데이터가 필요해서 Registry를 먼저 조회함).
- `request_context.py` — `RequestContext`/`RequestContextUser`
  (`extra="forbid"`, 모든 필드 필수). `audit_context` 필드에서만 파싱하고
  Tool `input`에서는 절대 읽지 않는다(Prompt Injection으로 role 위조 방지).
- `permissions.py` — `check_permission`: Role+Org+Site 교집합, Default
  Deny(빈 `allowed_roles`/`allowed_orgs`는 전원 거부).
- `execution.py` — `run_with_timeout`, `RateLimiter`(user+tool, agent/service+
  tool, 서버 전체 3중 키), `apply_result_limits`(row/byte/field 길이 상한).
- `connector.py` — `Connector` ABC(`health`/`execute_named_query`/`close`,
  `sql: str` 파라미터가 아예 없음 — 임의 SQL 원천 차단), `QueryId` enum(3개
  고정 named query), `MockOracleConnector`(D-014, 고정 in-memory 데이터셋),
  Schema/Table/Filter Field/Operator 허용목록(`ALLOWED_*`).
- `output_filter.py` — `apply_output_filter`: 금지 Column 제거 → PII 마스킹
  (이메일/휴대폰 정규식) → 결과 크기 재적용 → classification 라벨 추가 →
  출력 Schema 재검증.
- `audit.py` — `AuditEvent`(pydantic, `input`/`output` 필드 자체가 없음),
  `AuditResult`(SUCCEEDED/DENIED/FAILED/TIMEOUT), `InMemoryAuditSink`,
  `LoggingAuditSink`, `MultiAuditSink`.
- `errors.py` — `ErrorCode`(StrEnum), `McpError`, `error_response`(§10.2
  Error Envelope).
- `tools/db_metadata.py`, `tools/table_count.py` — Tool Handler + 입력
  검증 함수.

### 실제 Tool 목록(읽기 전용만, `tools_setup.py` 기준)

| Tool | 확인 정책 | 비고 |
|---|---|---|
| `calculator.add` | NEVER | Desktop 설치·연결 검증용 순수 덧셈 샘플 |
| `db_metadata.get_tables` | NEVER | 허용 Schema의 Table 목록 |
| `db_metadata.get_columns` | NEVER | Default Value 미반환, 금지 Column 제거 |
| `table_count.query` | ON_PARAMETER | 건수만 반환, 임의 SQL 미입력, 필터 없는 전체 카운트는 확인 필요 |

## 이 모듈의 경계

- `pyproject.toml` 의존성: `fastapi`, `uvicorn`, `pydantic`, `jsonschema`,
  workspace 패키지 `ai-asset-schemas`, `security-policy`, `observability`.
  `agent-runtime`이나 `portal-api`는 의존성에 없다.
  `tools_setup.py`가 `security_policy.roles.Role`(M11 중앙 Role enum)을
  가져오는 것이 유일한 타 모듈 참조 — 공개 패키지이지 내부 폴더 import가
  아니다.
- `services/agent-runtime`은 이 서버를 HTTP(`/mcp/v1/tools/{tool_name}/call`)
  로만 호출한다. 이 서버가 agent-runtime의 내부 코드를 참조하는 경로는
  없다.
- `Connector`는 어댑터 경계다 — 실제 Oracle 커넥터를 나중에 붙일 때도
  `execute_named_query(query_id, parameters, context)` 형태를 유지하고,
  `sql: str` 파라미터를 추가하지 않는다(구조적으로 임의 SQL을 막는 지점).

## 실행

`make dev-office-mcp-server` → `cd services/office-mcp-server && uv run
uvicorn office_mcp_server.main:app --reload --port 8500`.

## 테스트

`tests/unit/office_mcp_server/`(`test_audit.py`, `test_execution_limits.py`,
`test_injection.py`, `test_main_endpoints.py`, `test_output_filter.py`,
`test_permissions.py`, `test_request_context.py`, `test_tool_registry.py`).
실행: `uv run pytest tests/unit/office_mcp_server/ -q` — 확인 시점 110개
통과.

## 이 모듈에서 반복해서 틀렸던 것

- **CORS 미들웨어 자체가 아예 없었다(2026-08-14까지).** Desktop 채팅 화면은 이 서버의 상태를
  **렌더러에서** 직접 health-check한다(`electron/connections.ts`가 `ChatScreen.tsx`에서 호출,
  `/health`가 아니라 `/health/live`를 두드린다 — 이 서버는 `/health/live`를 정식 API로 문서화한다).
  CORS 헤더가 없으면 브라우저는 서버가 실제로 200을 돌려준 응답조차 읽지 못하고 던져버려서,
  화면에는 "Failed to fetch — 서비스가 실행 중인지 확인하세요"로 뜬다 — 서버 로그는 정상인데
  화면만 죽은 것으로 보이는, 이 저장소에서 이미 여러 번 반복된 증상이다. 지금은 `main.py`에
  `CORSMiddleware`가 붙어 있고, 허용 Origin 목록은 agent-runtime
  (`AgentRuntimeSettings.cors_origins`)·search-runtime(`settings.CORS_ORIGINS`)과 **동일한 값**을
  쓴다(portal-web 3000, Desktop 렌더러 5173, 과거 세션들이 쓰던 5174). 각 서비스는 자기 env
  (`OFFICE_MCP_CORS_ORIGINS`)로 덮어쓸 수 있지만 기본값은 세 서비스가 일치해야 하며,
  `tests/unit/search_runtime/test_cors.py`의 `test_default_origins_match_every_browser_facing_service`가
  이 일치를 강제한다 — 이 목록을 고칠 때는 그 테스트도 함께 돌린다. CORS는 이 서버의 Tool 실행
  API를 지켜주는 보안 장치가 **아니다**: cross-origin 단순 요청은 이 목록과 무관하게 서버에
  도달한다. 실제 보호는 §8 권한 검사·READ_ONLY 강제와 loopback 배포 형태다.

## 완료 전 확인

- 새/변경 Tool이 `risk_level="READ_ONLY"`인가 —
  `ToolRegistry.register`가 아니면 `ValueError`로 거부한다.
- Tool의 `input_schema`가 `user`/`role`/`org` 같은 신원 필드를 절대
  선언하지 않는가(신원은 `audit_context`로만 들어온다).
- `allowed_roles`/`allowed_orgs`를 비워두지 않았는가(빈 값은 "제한 없음"이
  아니라 전원 거부).
- Output Filter 순서(금지 Column 제거 → 마스킹 → 크기 재적용 →
  classification → Schema 재검증)를 건너뛰지 않았는가 — 특히 새 Tool을
  추가할 때 `output_schema`를 함께 등록했는가.
- `agent-runtime`의 `mcp_tools.py`(`MCP_TOOL_SPECS`)가 이 모듈의 Tool 계약과
  손으로 동기화되어야 한다는 것을 인지했는가 — 이 서버만 고쳐서는 반영되지
  않는다(별도 PR로 agent-runtime 쪽 업데이트 필요).
