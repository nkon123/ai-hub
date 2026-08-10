from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings

_REPO_ROOT = Path(__file__).parent.parent.parent.parent.parent  # enterprise-ai-asset-hub/


class Settings(BaseSettings):
    # Portal Web(브라우저)이 이 API 를 직접 호출할 때 허용할 Origin 목록.
    # `localhost` 와 `127.0.0.1` 은 브라우저 CORS 에서 **서로 다른 Origin** 이라,
    # 하나만 허용하면 다른 주소로 접속한 사용자에게는 서버가 200 을 기록해도
    # 브라우저가 응답을 버려 "Failed to fetch" 로 보인다(실제로 겪은 증상).
    # 사내 PC 에서 호스트명이나 사설 IP 로 접속한다면 그 Origin 도 여기에
    # 추가해야 한다 — 환경 변수 PORTAL_CORS_ORIGINS 로 덮어쓸 수 있다.
    # main.py 에 하드코딩하지 않는 이유: 설정이 있는데 하드코딩이 그것을
    # 가려 버리는 실수를 이 저장소가 agent-runtime 에서 이미 한 번 겪었다.
    cors_origins: list[str] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

    database_url: str = "sqlite+aiosqlite:///./portal.db"
    storage_root: Path = Path("./storage")
    index_base: Path = _REPO_ROOT / "data" / "indexes"
    indexing_runtime_url: str = "http://localhost:8200"
    distribution_service_url: str = "http://localhost:8400"
    secret_key: str = "dev-secret-key-change-in-production"
    base_url: str = "http://localhost:8000"
    hosted_chat_base_url: str = "https://ai.company.local/chat"

    # P12 Knowledge 품질 (M09 evaluation_runner 연동). search-runtime is
    # called indirectly through evaluation_runner.HttpSearchClient, never
    # imported directly here (mirrors indexing_runtime_url's role for
    # _trigger_indexing).
    search_runtime_url: str = "http://localhost:8300"
    evaluation_timeout_seconds: float = 300.0
    # Evaluation Dataset storage doesn't exist yet (open-decisions.md D-055) —
    # PoC discovery convention: scan every `*/evaluation-dataset.json` under
    # this directory and match on the dataset's own `knowledge_asset_id`
    # field. Read-only; never written to by portal-api.
    evaluation_fixtures_root: Path = _REPO_ROOT / "fixtures" / "valid"
    # Quality Gate 임계값 정책 파일 — evaluation_runner.load_policy()에 그대로
    # 넘긴다 (임계값 자체는 evaluation_runner가 소유, 여기서는 경로만 앎).
    # `evaluation_runner.settings`(그 패키지의 비공개 설정 모듈)를 직접
    # import하지 않기 위해 경로를 portal-api 쪽에도 별도로 선언한다 — 이미
    # `index_base`에 적용된 것과 동일한 선례(distribution_service.config).
    evaluation_quality_gate_policy: Path = (
        _REPO_ROOT / "packages" / "evaluation-runner" / "config" / "quality-gate.yaml"
    )

    # D-041 후속 / open-decisions.md D-063 — ServiceVersion 자체 검토 체인의
    # 게시 Gate. **기본값 False는 의도된 PoC 결정이지 누락이 아니다**:
    # CLAUDE.md가 요구하는 발표 MVP 흐름("등록된 Knowledge로 챗봇을 빠르게
    # 구성하고, 실제 Knowledge Preview 테스트 후 내부 URL로 게시")과, 이미
    # 게시되어 있는 4개 ACTIVE 데모 챗봇(모두 ServiceVersion.status=DRAFT)을
    # 이 세션이 깨뜨리지 않기 위해서다. `True`로 켜면
    # `routers/services.py::_run_validation`이 ServiceVersion.status가
    # APPROVED가 아닌 배포/게시를 `DEPLOYMENT_VALIDATION_FAILED`로 거부한다.
    # `False`(기본)에서도 검증 결과에는 검토 상태가 항상 노출된다(숨기지
    # 않음) — 강제만 꺼져 있을 뿐이다. 운영 환경은 반드시 `True`로 전환해야
    # 한다.
    require_service_version_approval: bool = False

    # P15 관리자 설정 (01-portal-and-distribution.md §2 P15) — read-only
    # "정책·구성 현황" 화면이 실제 설정 파일을 요청 시점에 그대로 읽어오는 세
    # 경로. portal-api는 이 파일들을 소유한 모듈(M05/M09/M04)의 코드를 Import
    # 하지 않고 경로만 알아 직접 읽는다 — `evaluation_fixtures_root`/
    # `evaluation_quality_gate_policy`와 동일한 선례.
    office_profile_path: Path = (
        _REPO_ROOT
        / "services"
        / "agent-runtime"
        / "config"
        / "office-profile-default"
        / "office-profile.json"
    )
    knowledge_package_policy_path: Path = (
        _REPO_ROOT / "packages" / "knowledge-packager" / "config" / "package-policy.yaml"
    )
    # Desktop Offline Bundle 설치 정책(archive/executable 확장자 목록, Zip Bomb
    # 크기 상한) — `apps/desktop-client/electron/bundle-verify.ts`(M04)가 실제
    # 검증에 사용하는 것과 동일한 값을 portal-api(M02)가 표시하기 위한 공유
    # Contract. 과거에는 `bundle-verify.ts` TypeScript 소스 텍스트를 정규식으로
    # 파싱했으나(CLAUDE.md 원칙 2/3 위반 — 다른 모듈의 소스 "포맷"에 결합되어
    # 리포맷 한 번에도 깨질 수 있었다), `packages/schemas/policies/
    # bundle-install-policy.json`을 두 모듈이 각자 직접 읽는 데이터 Contract로
    # 옮겼다(`evaluation_fixtures_root`/`knowledge_package_policy_path`와 동일
    # 선례 — portal-api는 M04 코드를 Import하지 않고 경로만 안다). 스키마는
    # `packages/schemas/policies/bundle-install-policy.schema.json`.
    desktop_bundle_policy_path: Path = (
        _REPO_ROOT / "packages" / "schemas" / "policies" / "bundle-install-policy.json"
    )

    class Config:
        env_prefix = "PORTAL_"


settings = Settings()
