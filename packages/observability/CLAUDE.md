# Observability (Trace ID + Sanitized Logging)

Trace ID 전파(contextvars)와 구조화 로깅을 담당하는 Cross-cutting 공유
패키지. 12개 모듈 소유권 표에 속하지 않고, M02 `apps/portal-api`, M05
`services/agent-runtime`, M07 `services/indexing-runtime`, M08
`services/search-runtime`, M10 `services/office-mcp-server`가 소비한다.
루트 CLAUDE.md 구현 원칙 9("모든 주요 요청과 실행에는 Trace ID를 사용한다")를
뒷받침한다.

## 먼저 읽을 것

- `docs/implementation-spec/README.md` §11 NFR-04(관측성: "요청·Job·Agent
  Run·MCP Tool을 Trace ID로 연결"), §15 최종 인수 시나리오 12번("Portal·
  Desktop·Runtime·MCP 로그가 동일 Trace ID로 연결된다")
- `docs/implementation-spec/07-data-api-contracts.md` §10 (Event/Log 상관관계)

## 코드 배치

- `context.py` — `contextvars` 기반 `trace_id`/`run_id` 바인딩:
  `bind_trace_id`/`bind_run_id`/`get_trace_id`/`get_run_id`/
  `reset_trace_id`/`reset_run_id`, 그리고 `with` 블록용 `trace_context`.
  stdlib(`contextvars`)만 의존.
- `logging_config.py` — `configure_logging(service_name, level="INFO")`가
  루트 로거에 `TraceContextFilter`를 부착한 핸들러를 건다. `uvicorn`은 자체
  로깅 설정에서 `uvicorn`/`uvicorn.error`/`uvicorn.access` 로거에만 핸들러를
  붙이고 루트 로거는 그대로 두므로, 이 호출이 없으면 앱 자신의
  `logging.getLogger(__name__).info(...)` 호출은 조용히 사라진다(WARNING
  미만은 `lastResort` 핸들러가 버림). stdlib(`logging`)만 의존, 여러 번
  호출해도 안전(idempotent).
- `middleware.py` — `TraceIdMiddleware`(starlette 의존). `X-Trace-Id` 헤더로
  Trace ID가 들어오는 서비스 전용. Trace ID가 요청 **바디** 필드로 오는
  서비스(agent-runtime의 Run `trace_id`, search-runtime의
  `SearchRequest.trace_id`, distribution-service의
  `BundleJobRequest.trace_id`)는 이 미들웨어를 쓰지 않고 그 지점에서
  `bind_trace_id`/`trace_context`를 직접 호출한다 — 미들웨어를 거기도 붙이면
  같은 요청에 서로 다른 Trace ID가 두 개 생긴다.
- 공개 API는 `__init__.py`에 전부 재노출: `bind_trace_id`, `bind_run_id`,
  `get_trace_id`, `get_run_id`, `reset_trace_id`, `reset_run_id`,
  `trace_context`, `TraceContextFilter`, `configure_logging`.

## 이 모듈의 경계

`pyproject.toml` dependencies: `starlette`(`middleware.py`만 의존; `context`/
`logging_config`는 stdlib뿐). 모든 소비 서비스가 이미 `fastapi`를 통해
`starlette`를 간접 의존하므로 신규 폐쇄망 다운로드가 필요 없다.

- 이 패키지는 "prompt 원문/문서 전체를 그대로 로그에 남기는" 지름길을 API
  표면에 두지 않는다 — 공개 함수는 stdlib `logging`의 `msg`/`extra` 그대로라,
  id 하나를 넣는 것과 문서 전체를 넣는 것의 난이도가 같다(구조적 억제이지
  강제는 아니다 — 호출부가 여전히 큰 값을 `extra`에 넣을 수는 있다).

## 테스트

`tests/unit/observability/` — `test_context.py`, `test_logging_config.py`,
`test_middleware.py`.

```
uv run pytest tests/unit/observability -q
```

## 완료 전 확인

- 새 서비스가 이 패키지를 쓴다면 `configure_logging()`을 `main.py` 상단,
  `app = FastAPI(...)` 이전에 호출했는지
- Trace ID가 요청 헤더로 오는지 요청 바디 필드로 오는지 먼저 확인하고, 후자면
  `TraceIdMiddleware`를 추가하지 않고 `bind_trace_id`/`trace_context`를 그
  지점에서 직접 호출했는지(중복 Trace ID 생성 방지)
- 새로 추가한 로그 호출이 prompt 원문/문서 전체/DB 결과/Secret을 그대로
  넣지 않는지(이 패키지가 구조적으로 막아주지 않으므로 호출부에서 직접
  검토해야 한다)
