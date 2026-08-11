# tests (M12)

계약(Contract)·단위(Unit)·통합(Integration)·E2E·보안(Security) 테스트. 4~5개 계층은 서로
**실행 모델이 다르다** — 어느 계층에 테스트를 두느냐가 그 테스트가 CI에서 항상 도는지,
사람이 라이브 스택을 띄운 뒤에만 도는지를 결정한다. 아래를 읽지 않고 e2e/security에
테스트를 추가하면 "로컬에서 통과했는데 CI가 이상하다"가 아니라 "CI가 조용히 그 테스트를
한 번도 실행한 적이 없다"는 훨씬 조용한 실패가 난다.

## 먼저 읽을 것

- `docs/implementation-spec/06-quality-delivery.md` §4(모듈별 필수 테스트), §5(Contract Test),
  §8(E2E 시나리오 10종 — E2E-01~E2E-10 각각의 목적).
- `docs/implementation-spec/05-mcp-security-governance.md` §12/§13 — `tests/security/`가
  증명해야 하는 교차 보안 속성.

## 실행 모델 (계층별로 반드시 다름)

| 계층 | 기본 `pytest tests/ -q`에 포함? | 무엇을 상대로 도는가 | 실패 시 동작 |
|---|---|---|---|
| `contract/` | 예 | Schema/Fixture/OpenAPI (오프라인) | 실패 |
| `unit/` | 예 | 각 모듈 내부 로직 (오프라인, mock/fixture) | 실패 |
| `integration/` | 예 | FastAPI `TestClient` 등 인프로세스 (오프라인) | 실패 |
| `e2e/` | **아니오** | **살아 있는 서비스 스택 + 실제 Ollama** | 스택 없으면 **skip** |
| `security/` | **아니오** | e2e와 동일 라이브 스택 | 스택 없으면 **skip** |

- 루트 `pyproject.toml`의 `[tool.pytest.ini_options]`: `addopts = "-m 'not e2e and not
  security'"` — 이 때문에 `uv run pytest tests/ -q`(또는 `make test`)는 e2e/security를
  **애초에 collect는 하지만 실행하지 않는다**. 완전히 오프라인으로 돈다.
- `make e2e-test`(`pytest tests/e2e/ -v -m e2e`), `make security-test`
  (`pytest tests/security/ -v -m security`) — 커맨드라인 `-m`이 addopts를 덮어써서 실제로
  돈다. 두 계층 다 `tests/e2e/conftest.py::_require_live_services`(session-scoped, autouse)가
  매 세션 시작 시 portal-api(8000)/agent-runtime(8100)/indexing-runtime(8200)/
  search-runtime(8300)/distribution-service(8400)/office-mcp-server(8500)/Ollama(11434)의
  헬스 엔드포인트를 probe하고, 하나라도 응답이 없으면 **suite 전체를 skip**한다(fail 아님).
  **이 skip 동작을 절대 깨지 마라** — CI가 라이브 스택 없이 돌기 때문에, 여기서 fail로
  바꾸면 스택이 없는 모든 CI 실행이 항상 빨간불이 된다.
- `tests/security/conftest.py`는 `tests/e2e/conftest.py`의 fixture/헬퍼를 **재정의하지 않고
  import로 재사용**한다(같은 liveness gate, 같은 정리 로직) — 새 security 테스트를 쓸 때도
  이 conftest를 그대로 쓴다.

## e2e/security는 실제 DB/인덱스에 쓴다 — 반드시 지킬 규칙

`tests/e2e/`와 `tests/security/`는 **실제 `apps/portal-api/portal.db`와 `data/indexes/`**에
쓴다(mock이 아니다 — 이 자체가 의도된 설계다. 아래 "테스트가 진짜인지" 참고). 그 DB는
시딩된 데모 데이터(HR 정책 Knowledge, 재택근무 정책 Knowledge, `remote-work-guide` 등 5개
게시 Deployment)로 실제 데모 트래픽을 서빙한다. 새 e2e/security 테스트를 쓸 때 반드시:

1. 이름/Slug는 `tests/e2e/conftest.py`의 `e2e_name()`/`e2e_slug()`로 만들어 `e2e-` 접두사를
   붙인다. 이 접두사가 "테스트가 만든 것"과 "시딩된 데모"를 구분하는 유일한 표식이다.
2. 새로 만든 asset/service/deployment/distribution은 `register_knowledge_asset`/
   `create_service`/`create_deployment`/`wait_for_distribution` 같은 기존 choke-point 헬퍼를
   통해서만 만든다 — 각 헬퍼 내부의 `_track()` 호출이 정리 대상 id를 추적하는 유일한 지점이다.
   직접 `httpx.post`로 만들면 추적되지 않아 정리되지 않는다.
3. `PROTECTED_ASSET_IDS`/`PROTECTED_ASSET_NAMES`/`EXISTING_DEPLOYMENT_SLUGS`/
   `PROTECTED_INDEX_DIR_NAMES`(시딩된 데모 식별자)를 우회하거나 재정의하지 않는다 — 이건
   삭제 로직이 실수로 데모 데이터를 지우지 못하게 막는 하드 가드다.
4. 시딩된 APPROVED Knowledge(`APPROVED_KNOWLEDGE_ASSET_ID`/`APPROVED_KNOWLEDGE_VERSION_ID`)는
   읽기만 한다 — 상태 전환(suspend/deprecate/재승인)이나 `data/indexes/` 재인덱싱을 하지 않는다.
5. 정리는 `_e2e_created_ids`(함수 단위 autouse)가 자동으로 처리한다 — 테스트가 직접
   `DELETE`를 만들지 않는다. 이전 실행이 남긴 잔재는 `make e2e-clean`으로 청소한다(이
   저장소 담당자가 지금 이 커맨드를 실행할 필요는 없다 — CI/개발자 로컬 환경에서 필요할 때
   실행).

## 새 테스트를 어느 계층에 둘지

- 순수 함수/한 모듈 내부 로직, mock으로 충분함 → `unit/<module_name>/`.
- FastAPI 앱을 `TestClient`로(실제 프로세스 기동 없이) 인프로세스로 검증 → `integration/`.
- Schema/Fixture/OpenAPI 자체의 정합성 → `contract/`.
- 여러 살아있는 서비스를 실제로 띄우고 HTTP로 엮어야만 재현되는 시나리오(배포 URL 게시,
  Offline Bundle round-trip, 실제 Ollama 답변 품질) → `e2e/`. 새 파일은 `test_e2e_NN_*.py`
  이름 규칙과 `pytestmark = pytest.mark.e2e`를 따른다.
- 인증/인가 우회, 권한 상승, Injection, Secret 유출, 감사 로그, Trace 상관관계처럼
  **여러 서비스에 걸친** 보안 속성 → `security/`. `test_security_NN_*.py` +
  `pytestmark = pytest.mark.security`. 이미 `unit/office_mcp_server/`,
  `unit/distribution_service/`, `unit/security_policy/`, `integration/portal_api/`가
  격리 단위로 잘 덮는 것(allowlist 거부, RBAC 매트릭스, zip-slip, 승인 버전 불변성)은
  여기서 다시 만들지 않는다 — 각 security 테스트 모듈 docstring에 이 계층이 추가하는
  교차 속성이 명시되어 있다.

## 이 모듈에서 반복해서 틀렸던 것

- **테스트가 통과한다는 것과 그 속성이 실제로 성립한다는 것은 다르다.** 이 저장소에서
  실제로 있었던 일이다 — 변조(tamper) 테스트가 "변조 후에도 파일이 문제없이 열리도록"
  바이트를 골라 뒤집어서, 정작 검증하려던 실제 공격면(체크섬 불일치 탐지)을 비껴간 적이
  있다. 지금 `tests/e2e/test_e2e_03_package_tamper.py`는 `original[0] ^ 0xFF`로 바이트를
  뒤집는다 — XOR이므로 원본과 반드시 달라짐이 보장되고, 파일 포맷이 깨져 아예 못 여는
  것도 아니고, 우연히 원본과 같은 값이 되어 "변조 안 한 것"이 되는 것도 아니다. **새
  변조/오염 테스트를 쓸 때 이 패턴(값이 확실히 달라짐을 보장하는 방법)을 따르고, 통과한
  assertion이 정말로 노리는 취약점을 때리는지 — 우회 가능한 입력을 우연히 고른 것은
  아닌지 — 직접 되짚어라.** "테스트가 초록불이다"는 증명이 아니라 시작점이다.
- **`tests/e2e/`가 mock이 아니라 실 서비스를 때려야 하는 이유가 실제로 있었다**
  (`tests/e2e/conftest.py` 모듈 docstring): 청킹 변경이 문서를 4개 청크에서 1개로
  붕괴시켜 실제 게시된 챗봇이 실제 질문("장비 지원은 무엇이 있나요?")에 0 Citation으로
  답하지 못하게 된 적이 있는데, 그동안 청커 단위 테스트 60개는 전부 통과했고 평가
  Quality Gate도 PASS를 보고했다. 실제 챗봇을 찔러봐야만 드러났다 — 이것이 `e2e/`가
  fake adapter가 아니라 실제 프로세스에 HTTP로 붙어 실제 답변 내용/Citation을 assert하는
  이유다. 이 원칙(mock으로 대체하지 않음)을 훼손하는 "더 빠르게 만들자"는 리팩터는 하지 않는다.

## 완료 전 확인

- e2e/security에 테스트를 추가했다면: liveness skip이 여전히 동작하는가(라이브 스택 없이
  `make e2e-test`를 실행하면 fail이 아니라 skip인가 — 직접 실행하지 말고 코드 리뷰로 확인),
  이름/Slug가 `e2e_name()`/`e2e_slug()`를 통해 `e2e-` 접두사를 받는가, 생성한 리소스가
  choke-point 헬퍼(`_track()` 경유)를 통해 만들어져 자동 정리 대상에 들어가는가.
- 계약을 바꿨다면(`packages/schemas/`) `tests/contract/`와 `fixtures/`를 함께 고쳤는가.
- 변조/오염/우회 시나리오를 테스트한다면, assertion이 실제로 그 취약점을 때리는지 —
  "패스하는 입력을 고른 것"은 아닌지 — 위 경고에 비추어 재확인했는가.
- 오프라인 기본 테스트(`uv run pytest tests/ -q`)가 여전히 통과하는가.
