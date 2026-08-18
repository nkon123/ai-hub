# Security Policy (M11)

RBAC, 승인 Workflow, Version 상태 머신, Classification 기반 접근 제어,
Secret 모양 값 탐지. Framework-free 순수 정책 패키지 — FastAPI/SQLAlchemy 등
어떤 웹 프레임워크도 import하지 않는다. `apps/portal-api`(M02)가 인가/워크플로
판정을 위해 이 패키지의 공개 API만 소비하고, 이 패키지는 M02나 다른 모듈로
역참조하지 않는다.

## 먼저 읽을 것

- `docs/implementation-spec/05-mcp-security-governance.md` §12 (M11 Security
  & Governance), 특히 §12.3 자산 유형별 검토, §12.4 승인 Workflow, §12.9 감사
  보관, §12.10 Revocation
- `docs/implementation-spec/README.md` §4 (사용자와 역할)
- `docs/implementation-spec/01-portal-and-distribution.md` §3.5 (수명주기
  상태도)
- `docs/implementation-spec/04-knowledge-platform.md` §2.7 (Metadata), §3.8
  (Filter와 ACL) — Classification/강제 ACL Filter 판정 규칙의 근거

## 코드 배치

- `roles.py` — `Role`(7개: USER/CREATOR/TECH_REVIEWER/SECURITY_REVIEWER/
  RELEASE_MANAGER/AUDITOR/ADMIN), `Permission` enum, `ROLE_PERMISSIONS` 매트릭스,
  `has_permission`/`require_permission`, `PermissionDeniedError`.
- `transitions.py` — `VersionStatus` enum, `ALLOWED_TRANSITIONS`,
  `MUTABLE_STATUSES`, `is_mutable`. **승인 버전 불변성이 실제로 강제되는
  지점**: `MUTABLE_STATUSES`는 `DRAFT`/`CHANGES_REQUESTED`만 포함하므로
  `APPROVED` 이후 상태는 `is_mutable()`이 항상 `False`를 반환한다.
- `review.py` — `Stage`(TECHNICAL → SECURITY → RELEASE), `ReviewDecisionType`
  (APPROVE/REJECT/REQUEST_CHANGES), `ReviewStatus`, `STAGE_PERMISSION`,
  `resolve_review_decision` — 순수 함수, DB/IO 없음. REJECT는 어느 단계에서든
  체인 전체를 종료(REJECTED), REQUEST_CHANGES는 CHANGES_REQUESTED로 되돌리고
  새 Stage를 열지 않으며, APPROVE는 다음 Stage로 진행하거나(RELEASE가
  마지막) 최종 APPROVED로 확정한다.
- `classification.py` — `Classification` enum(PUBLIC_INTERNAL/INTERNAL/
  CONFIDENTIAL/RESTRICTED/UNKNOWN), `clearance_covers` — `UNKNOWN`은 실제
  등급이 아니라 "모른다"를 뜻하며 `allow_unknown_classification` 정책 값으로만
  처리된다(비교 대상 아님).
- `redaction.py` — `looks_like_secret`/`redact_if_secret`. P15 관리자 설정
  화면이 실제 Secret 값을 재표시하지 않기 위한 것.
- 공개 API는 `__init__.py`의 `__all__` 전체 — 위 5개 파일의 모든 심볼이
  top-level에서 재노출된다.

## 이 모듈의 경계

`pyproject.toml` dependencies: `ai-asset-schemas` 하나뿐.

- `apps/portal-api`(M02)가 `Role`/`Permission`/`VersionStatus`/`Stage`/
  `Classification`/`redact_if_secret` 등을 공개 API로 소비한다.
- `services/indexing-runtime`(M07)은 인덱싱 시점에 `Classification`을
  청크 Metadata에 스탬프하기 위해, `services/search-runtime`(M08)은 강제
  ACL Filter 판정(`clearance_covers`)을 위해 이 패키지의 공개 API만 쓴다 —
  둘 다 내부 폴더 직접 Import가 아니다.
- `PermissionDeniedError`/`InvalidTransitionError`는 항상 순수 Python
  Exception이다 — `fastapi.HTTPException`을 이 패키지에서 raise하지 않는다.
  HTTP 응답으로의 변환은 M02 `rbac.py`가 유일하게 담당한다.

## 테스트

`tests/unit/security_policy/` — `test_classification.py`,
`test_redaction.py`, `test_review.py`, `test_roles.py`, `test_transitions.py`.

```
uv run pytest tests/unit/security_policy -q
```

## 완료 전 확인

- 새 `Permission`을 추가했다면 관련된 모든 `Role`의 `ROLE_PERMISSIONS`
  항목에 반영했는지, 그리고 다른 어떤 역할에도 걸리지 않아야 한다면
  `ADMIN`에게만 가는지(`_ALL_PERMISSIONS`를 통해서만 도달)
- `VersionStatus` 전이를 추가/변경했다면 `ALLOWED_TRANSITIONS`와
  `MUTABLE_STATUSES`가 "승인 버전은 불변" 규칙을 깨지 않는지
- 새 코드가 FastAPI/SQLAlchemy 등 프레임워크를 import하지 않는지
  (framework-free 원칙)
- `Stage`/`ReviewDecisionType`을 바꿨다면 M02의 `routers/reviews.py`가 여전히
  이 계약과 맞는지
