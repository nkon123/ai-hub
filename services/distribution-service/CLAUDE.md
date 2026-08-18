# distribution-service (M03)

Offline Bundle(오프라인 설치 ZIP)을 조립하는 서비스. FastAPI, 포트 8400. 엔드포인트는
`GET /health`와 `POST /bundle/v1/jobs` 두 개뿐이다. portal-api(M02)가 유일한 호출자이며, Registry
DB 조회를 전부 마친 뒤(`BundleJobRequest.items`가 이미 DB-join된 사실들) 이 서비스를 호출한다 —
이 서비스는 DB 연결이 없다.

**모듈 소유권 표는 이 모듈을 "Repository, Download, Offline Bundle, Hosted Deployment Job"으로
표기하지만, 실제로 코드가 있는 것은 Offline Bundle 조립뿐이다.** 아래 "구현 현황"을 반드시 먼저
읽는다.

## 먼저 읽을 것

- `docs/implementation-spec/01-portal-and-distribution.md` §4 전체 — §4.1 Storage Adapter,
  §4.2 Offline Bundle 구성, §4.3 의존성 해석, §4.4 Bundle Job, §4.5 Import 검증(Desktop 측),
  §4.6 Rollback(Desktop 측), §4.7 Hosted Deployment Job(미구현 — 아래 참고)
- `packages/schemas/manifests/bundle-manifest.schema.json`,
  `packages/schemas/policies/bundle-install-policy.schema.json`

## 구현 현황 (정직하게 구분)

**구현됨:**
- §4.1 Storage Adapter — `storage.py::FileSystemStorageAdapter`. `object_id`(UUID 강제) 기반
  디렉터리(`root/{object_id}/payload.bin` + `metadata.json`), `safe_join()`으로 Path Traversal
  차단, 임시 파일 작성 후 `os.replace()`로 원자적 확정.
- §4.3 의존성 해석 — `resolver.py::resolve()`. 필수 의존성 누락(`DEPENDENCY_MISSING`), 버전 충돌
  (`DEPENDENCY_VERSION_CONFLICT`), 긴급 회수(`AssetVersionRevokedError`), SUSPENDED/RETIRED 차단
  (`PackageRevokedError`), 정렬된 Install Order 계산까지 구현. 버전 Range/Office Profile
  모델·MCP 허용 검사(§4.3 4/6단계)는 Office Profile Registry가 아직 없어 **문서화된 no-op**이다.
- §4.4 Bundle Job — `bundler.py`(`collect`/`build_zip_bytes`/`verify`/`package`) +
  `main.py::create_bundle_job`. 단계: RESOLVING → COLLECTING → VERIFYING → PACKAGING → SUCCEEDED.
  **SIGNING 단계는 스펙에 있지만 의도적으로 건너뛴다** — `signature.json`을 만들지 않는다(D-016:
  PoC는 Checksum 필수, Signature는 Hook만). ZIP 안의 디렉터리 엔트리에 실행 권한(0o755)을 명시
  부여하는 처리가 있다(`_dir_zip_info` — zipfile 기본값은 압축 해제 후 `drw-------`가 되어 Bundle을
  통째로 못 쓰게 만든다).

**아직 스텁/미구현:**
- **§4.5 Import 검증** — 이 서비스에 없다. "Desktop과 동일한 검증 Library 또는 Contract Fixture를
  사용한다"고 스펙에 적혀 있지만, 그 공유 검증 로직은 distribution-service 안에 구현되어 있지 않다.
- **§4.6 Rollback**(임시 디렉터리 설치 → 검증 성공 시 Active Pointer 전환) — 이 서비스에 없다.
  Desktop Client(M04) 쪽 책임으로 보이나 확인된 코드가 없다.
- **§4.7 Hosted Deployment Job** — 코드가 전혀 없다(`main.py`에 관련 라우트 없음, 다른 5개
  소스 파일에도 없음). Deployment Revision, Active Pointer 전환, Health Check/Smoke Test,
  게시 Slug 계산 중 어느 것도 이 서비스에 구현되어 있지 않다.
- **Download(다운로드 엔드포인트)** — 이 서비스에 없다. 실제로는 portal-api(M02)의
  `GET /api/v1/distributions/{id}/download`(`apps/portal-api/src/portal_api/routers/
  distributions.py`)가 `bundle_path`(공유 파일시스템 절대경로)를 직접 `FileResponse`로 스트리밍한다
  — M03이 별도 다운로드 API를 노출하지 않는다는 뜻이다.
- **Repository**(자산 저장소 조회 API) — 이 서비스에 조회용 엔드포인트가 없다. `storage.py`는
  내부적으로 파일을 저장/조회하는 Adapter일 뿐, 외부에 노출된 Repository API가 아니다.

## 코드 배치

`src/distribution_service/`: `main.py`(FastAPI, `/bundle/v1/jobs`), `config.py`(`Settings`,
env prefix `DISTRIBUTION_`), `contracts.py`(portal-api ↔ 이 서비스 간 내부 계약 —
`packages/schemas/api/portal-openapi.yaml`에는 없다, service-to-service 전용), `resolver.py`,
`bundler.py`, `storage.py`. 소스 파일이 이 6개뿐이며 부트스트랩 잔재 디렉터리는 없다.

## 이 모듈의 경계

`pyproject.toml` dependencies: `ai-asset-schemas`, `observability`, `pyyaml`(bundle-manifest.yaml/
office-profile.yaml 직렬화), `pydantic-settings`. 다른 서비스의 `src/` 내부를 import하지 않는다 —
`config.py::agent_runtime_config_root`가 가리키는 것은 `services/agent-runtime/config/`의
**정적 설정 파일**뿐이며, `agent_runtime` Python 패키지를 import하지 않는다(D-034 Standard
Agent/Prompt Local Copy 예외 처리). DB 연결이 없으므로 Registry 조회는 전부 portal-api가
`BundleJobRequest`에 이미 채워 넣은 값을 신뢰한다.

## 실행

`make dev-distribution-service` (`cd services/distribution-service && uv run uvicorn
distribution_service.main:app --reload --port 8400`)

배포 시 `DISTRIBUTION_BUILD_VERSION`과 immutable commit SHA인
`DISTRIBUTION_COMMIT_SHA`를 주입한다. 로컬 개발에서 미주입된 SHA는 정직하게
`unknown`으로 표시되며, 두 값은 `/health` 응답과 시작 로그에서 확인한다.

## 테스트

`tests/unit/distribution_service/` — `uv run pytest tests/unit/distribution_service/ -v`.
`test_bundler.py`, `test_resolver.py`, `test_revocation_enforcement.py`(긴급 회수/SUSPENDED/
RETIRED 차단), `test_storage.py`(Path Traversal/원자적 쓰기)로 나뉜다.

## 완료 전 확인

- 자산/Manifest에서 온 문자열로 경로를 만드는 코드를 추가했다면 `storage.safe_join()` 또는
  `bundler._sanitize_segment()`를 반드시 거치는가(사용자 제공 파일명으로 저장 경로를 만들지
  않는다 — 루트 CLAUDE.md 코드 규칙)
- ZIP에 새 디렉터리 Prefix를 추가했다면 `_dir_zip_info()`로 실행 권한을 명시했는가(zipfile
  기본값은 해제 후 접근 불가능한 디렉터리를 만든다)
- §4.7 Hosted Deployment Job처럼 스펙에는 있지만 코드가 없는 영역을 구현했다면, 이 문서의
  "구현 현황"을 함께 갱신했는가(구현 상태와 문서가 갈라지면 이 문서의 가치가 없어진다)
- `resolve()`가 통과시킨 대상만 `collect()`/`build_zip_bytes()`에 들어가는가 — SUSPENDED/RETIRED/
  긴급 회수 항목이 §4.3 검사를 우회해 Bundle에 섞여 들어가지 않는가
