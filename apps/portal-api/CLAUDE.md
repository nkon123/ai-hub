# Portal API (M02)

Registry, Version, Review, Service/Deployment API. FastAPI 앱, 포트 8000.
Portal UI(M01)의 유일한 백엔드이며, 모델을 직접 호출하지 않는다(Preview/게시
실행은 별도 Hosted Agent Runtime을 사용 — 루트 CLAUDE.md UI 구현 규칙).

## 먼저 읽을 것

- `docs/implementation-spec/01-portal-and-distribution.md` §3 (M02 Portal API
  & Asset Registry), 특히 §3.2 필수 API, §3.3 Registry 규칙, §3.5 수명주기
- `docs/implementation-spec/07-data-api-contracts.md` §3 주요 Entity, §8
  오류코드 분류, §10 Event/Log 상관관계
- `docs/implementation-spec/05-mcp-security-governance.md` §12.4 승인
  Workflow, §12.9 감사 보관 — 검토 체인/감사 기록의 근거(M11 소유, M02가 구현)
- `packages/schemas/api/portal-openapi.yaml`

## 코드 배치

실제 코드는 전부 `src/portal_api/` 아래에 있다. `src/routers/`,
`src/models/`, `src/adapters/`는 **부트스트랩 잔재로 파일이 0개인 빈
디렉터리**다 — 새 코드를 여기 쓰면 패키징도 안 되고(아래 "경계" 참고)
아무도 import하지 않는다.

- `main.py` — 앱 조립. `reviews_router`를 `assets_router`보다 먼저
  등록한다(순서 중요, 아래 "반복해서 틀렸던 것" 참고).
- `config.py` — `Settings`(env prefix `PORTAL_`). 다른 모듈(M04/M05/M09)의
  정책 파일을 코드 Import 없이 경로로만 읽는 설정들(`office_profile_path`,
  `knowledge_package_policy_path`, `desktop_bundle_policy_path`,
  `evaluation_quality_gate_policy`)이 몰려 있다.
- `rbac.py` — `security_policy.has_permission` 판정을 HTTP 403 + 거부 감사로
  변환하는 유일한 지점.
- `audit.py` — `AuditEvent` 기록 헬퍼(`record_audit`).
- `auth.py` — D-001 테스트용 토큰 어댑터(`_TEST_TOKENS`). SSO/OIDC 전까지 임시.
- `database.py` — 스키마는 Alembic이 소유, `init_db()`는 `create_all`을
  호출하지 않는다(의도적).
- `semver.py`, `diffing.py`, `platform_settings.py`, `errors.py`,
  `schemas.py`(Pydantic API 모델, 1000줄+) — 각 파일 docstring에 관련 화면
  ID(P06 등)와 근거가 적혀 있다.
- `routers/` — `admin.py`, `assets.py`, `deployments.py`,
  `distributions.py`, `evaluations.py`, `knowledge_search.py`,
  `reviews.py`, `services.py`.
- `models/` — SQLAlchemy ORM: `asset.py`, `distribution.py`,
  `evaluation.py`, `platform_setting.py`, `review.py`, `revocation.py`,
  `service.py`.
- `migrations/` — Alembic. `alembic.ini`는 반드시 ASCII만 유지(아래 참고).

## 이 모듈의 경계

`pyproject.toml` dependencies: `ai-asset-schemas`, `security-policy`,
`observability`, `evaluation-runner`, `pyyaml` (+ 웹/DB 표준 스택).

- `security_policy`(M11)에서 `Role`/`Permission`/`has_permission`/
  `VersionStatus`/`Stage`/`Classification`/`redact_if_secret` 등 공개 API만
  가져온다. 판정 로직을 이 모듈에서 재구현하지 않는다.
- `evaluation_runner`(M09)는 공개 API만(`run_evaluation`/`load_dataset`/
  `load_policy`/`compare_versions`) 백그라운드 Job에서 호출한다.
- `knowledge_packager`는 **의도적으로 의존하지 않는다** — `package-policy.yaml`
  하나만 필요한데 그 패키지는 `chromadb`를 끌고 오므로, 대신 `pyyaml`로 파일을
  직접 읽는다(`pyproject.toml` 주석에 근거 상세).
- M04/M05/M09가 소유한 정책 파일들은 코드 Import 없이 경로만 알아 직접
  읽는다(`config.py`의 `*_path` 설정들) — 다른 모듈 소스 포맷에 결합되지
  않도록 공유 데이터 Contract(`packages/schemas/policies/...`)를 우선한다.

## 실행

```
make dev-portal-api   # uv run uvicorn portal_api.main:app --reload --port 8000
make migrate          # alembic upgrade head
make migration name=... && make migrate   # 모델 변경 시
make migrate-status
```

배포 시 `PORTAL_BUILD_VERSION`과 immutable commit SHA인
`PORTAL_COMMIT_SHA`를 주입한다. 로컬 개발에서 미주입된 SHA는 정직하게
`unknown`으로 표시되며, 두 값은 `/health` 응답과 시작 로그에서 확인한다.

## 테스트

`tests/integration/portal_api/` — 자산 등록, 버전 관리, 검토, 서비스, 배포,
배포판, 다운로드 이력, 평가, 관리자 설정, 수명주기, Knowledge 검색 등.
`conftest.py`가 격리된 in-memory 비동기 엔진을 직접 만들고
`Base.metadata.create_all`을 호출한다 — `init_db()`/Alembic을 거치지 않는다.

```
uv run pytest tests/integration/portal_api -q
uv run pytest tests/ -q   # 전체(e2e/security는 루트 pyproject addopts로 기본 제외)
```

## 이 모듈에서 반복해서 틀렸던 것

- `alembic.ini`에 non-ASCII 문자가 있으면 한국어 Windows(cp949)에서
  configparser가 `UnicodeDecodeError`로 죽는다 → 마이그레이션이 안 돌고 →
  테이블이 없어 `no such table` 500이 나고 → 브라우저에는 `Failed to
  fetch`/403으로 보인다. `alembic.ini`는 순수 ASCII로 유지한다. 모델 컬럼
  추가 시 반드시 `make migration name=...` → 생성 파일 검토 → `make migrate`.
- CORS `allow_origins`는 `localhost`와 `127.0.0.1`을 **둘 다** 넣어야 한다
  (`config.py` 주석 참고) — 서버 로그는 200인데 브라우저가 응답을 버리는
  형태로 나타나 원인 파악이 어렵다.
- `main.py`의 라우터 등록 순서: `reviews_router`가 `assets_router`보다
  먼저다. Starlette는 path+method를 전체 라우터에 걸쳐 등록 순서로
  매칭하므로, `assets_router`의 단일 세그먼트 catch-all
  (`GET /asset-versions/{version_id}`)이 `reviews_router`의 리터럴
  `GET /asset-versions/lifecycle`을 가려버린 적이 있다(`test_lifecycle.py`
  404로 발견).

## 완료 전 확인

- RBAC 403 경로가 `record_audit(result="DENIED")`도 함께 기록하는지
  (`rbac.py::require_permission`이 이미 이렇게 되어 있으니, 새 엔드포인트도
  이 헬퍼를 거치는지)
- 새 모델 컬럼을 추가했다면 `make migration`으로 마이그레이션 파일을 만들고
  생성 내용을 리뷰했는지
- APPROVED 버전을 제자리에서 수정하는 코드가 아닌지
  (`security_policy.is_mutable`은 DRAFT/CHANGES_REQUESTED에서만 True)
- 새 엔드포인트가 `packages/schemas/api/portal-openapi.yaml`과 필드명이
  일치하는지
- `require_service_version_approval` 기본값(`False`)을 임의로 바꾸지
  않았는지 — 의도된 PoC 결정이다(`config.py` 주석 참고, 이미 게시된 4개
  데모 챗봇을 깨뜨리지 않기 위함)
