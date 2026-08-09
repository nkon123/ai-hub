# 공통 데이터 모델과 API 계약

이 문서는 M01~M12가 공유하는 식별자, 상태, Database Entity, API Envelope, Event, 오류코드를 정의한다.

## 1. 공통 식별자

| 필드 | 형식 | 설명 |
|---|---|---|
| `asset_id` | UUID String | 자산의 영구 ID |
| `asset_version_id` | UUID String | 특정 자산 버전 ID |
| `service_id` | UUID String | AI Service 영구 ID |
| `service_version_id` | UUID String | Service Version ID |
| `file_id` | UUID String | 저장 파일 ID |
| `job_id` | UUID String | 비동기 Job ID |
| `run_id` | UUID String | Agent 실행 ID |
| `trace_id` | UUID String | 시스템 간 추적 ID |
| `review_id` | UUID String | 검토 요청 ID |
| `audit_event_id` | UUID String | 감사 Event ID |

Client가 임의로 승인된 ID를 확정하지 않는다. Offline Runtime이 만드는 Run ID는 로컬에서 생성 가능하다.

## 2. 공통 시간과 사용자

- API DateTime은 ISO-8601 UTC 문자열
- DB는 Timezone-aware UTC
- 화면만 사용자 Timezone으로 변환
- 생성·수정 Entity는 `created_at`, `created_by`, `updated_at`, `updated_by`를 가진다.
- 삭제 대신 `status`와 `retired_at`을 사용한다.

## 3. 주요 Entity

### 3.1 Asset

| 필드 | 타입 | 필수 | 설명 |
|---|---|---:|---|
| id | UUID | Y | Asset ID |
| type | Enum | Y | AGENT/KNOWLEDGE/MCP_TOOL/PROMPT/OFFICE_PROFILE |
| name | String | Y | 유일 Slug |
| display_name | String | Y | 사용자 표시명 |
| description | Text | Y | 목적·범위 |
| category | String | Y | 업무 분류 |
| owner_org_id | UUID | Y | 소유 조직 |
| owner_user_id | UUID | Y | 주 담당자 |
| classification | Enum | Y | 보안등급 |
| visibility | Enum | Y | 조직/사업장 범위 정책 |
| lifecycle_status | Enum | Y | Asset 수준 상태 |
| latest_approved_version_id | UUID | N | 최신 승인 버전 |

### 3.2 AssetVersion

| 필드 | 타입 | 필수 | 설명 |
|---|---|---:|---|
| id | UUID | Y | Version ID |
| asset_id | UUID | Y | Asset 참조 |
| version | String | Y | SemVer |
| schema_version | String | Y | Manifest Schema Version |
| status | Enum | Y | DRAFT 등 |
| manifest | JSON | Y | 검증된 Manifest Snapshot |
| manifest_hash | String | Y | Manifest Hash |
| changelog | Text | Y | 변경 내용 |
| validation_job_id | UUID | N | 자동검증 Job |
| approved_at | DateTime | N | 최종 승인 시각 |
| deprecated_at | DateTime | N | 지원 종료 시각 |
| replacement_version_id | UUID | N | 대체 버전 |

Unique: `(asset_id, version)`

### 3.3 AssetFile

| 필드 | 타입 | 설명 |
|---|---|---|
| id | UUID | File ID |
| asset_version_id | UUID | Version |
| relative_path | String | Package 상대경로 |
| original_file_name | String | 표시용 원래 파일명 |
| storage_object_id | String | Repository Object ID |
| sha256 | String | Hash |
| size_bytes | Integer | 크기 |
| mime_type | String | MIME |
| scan_status | Enum | 검사 상태 |

### 3.4 Dependency

| 필드 | 타입 | 설명 |
|---|---|---|
| source_version_id | UUID | 의존하는 Version |
| target_asset_id | UUID | 대상 Asset |
| target_version_range | String | 허용 Version |
| kind | Enum | AGENT/KNOWLEDGE/MCP_TOOL/PROMPT/PROFILE |
| role | String | Service/Agent 내 역할 |
| required | Boolean | 필수 여부 |
| resolved_version_id | UUID | 승인 시 해석 Snapshot |

### 3.5 Service와 ServiceVersion

Service는 Asset과 유사하지만 사용자가 실행하는 조합 단위이므로 별도 Entity로 관리한다.

Service:

- id
- name/display_name/description
- owner_org/user
- classification
- target_sites/roles
- lifecycle_status
- latest_approved_version_id

ServiceVersion:

- id, service_id, version
- schema_version
- status
- service_definition JSON
- definition_hash
- resolved_dependencies JSON Snapshot
- mock_test_job_id
- preview_test_suite_run_id
- validation_result
- approved_at
- replacement_version_id

### 3.5.1 ServiceDeployment와 DeploymentRevision

ServiceDeployment는 사용자가 접속하는 안정된 Slug와 접근정책을 관리하고, DeploymentRevision은 실제 실행할 불변 Service Version Snapshot을 관리한다.

ServiceDeployment:

- id, display_name, slug, environment
- access_policy
- target_orgs/target_sites/target_roles
- status
- active_revision_id
- created_by/created_at
- published_by/published_at
- suspended_by/suspended_at/suspend_reason
- last_health_status/checked_at

DeploymentRevision:

- id, deployment_id, revision_number
- service_version_id
- service_definition_hash
- resolved_dependency_snapshot
- runtime_release/deployment_profile_id
- test_suite_run_id
- status
- created_at/activated_at

`public_url`은 사용자 입력을 저장하지 않고 Environment Base URL과 검증된 Slug로 서버가 계산한다.

### 3.6 ReviewRequest

| 필드 | 설명 |
|---|---|
| id | Review ID |
| subject_type | ASSET_VERSION/SERVICE_VERSION |
| subject_id | 대상 ID |
| stage | TECHNICAL/SECURITY/RELEASE |
| status | PENDING/APPROVED/REJECTED/CHANGES_REQUESTED/CANCELLED |
| requested_by/at | 요청자·시각 |
| assigned_to | 담당 검토자 |
| policy_version | 적용 정책 |

ReviewDecision:

- review_id
- decision
- reviewer_id
- comments
- checklist_result JSON
- subject_hash
- decided_at

### 3.7 Job

| 필드 | 설명 |
|---|---|
| id | Job ID |
| type | VALIDATE_ASSET/BUILD_BUNDLE/MOCK_TEST/EVALUATE_KNOWLEDGE 등 |
| status | QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELLED |
| progress | 0~1 |
| current_step | 현재 단계 |
| requested_by | 요청자 |
| input | 민감정보가 제거된 입력 Snapshot |
| result | 결과 Artifact 참조 |
| error | 공통 Error Envelope |
| started_at/finished_at | 시각 |

### 3.8 Distribution/Download

DistributionRequest:

- root_type: ASSET_VERSION/SERVICE_VERSION
- root_id
- mode: ONLINE/OFFLINE_BUNDLE
- target_site_id
- office_profile_version_id
- requested_by
- bundle_job_id

DownloadRecord:

- distribution_id
- file_id 또는 bundle_id
- user_id/org/site
- requested_at/completed_at
- result
- trace_id

### 3.9 User/Organization/Site

User:

- external_identity_id
- display_name
- organization_id
- active

RoleAssignment:

- user_id
- role
- scope_type: GLOBAL/ORGANIZATION/SITE/ASSET
- scope_id

Site:

- id, name
- network_mode: OFFLINE/INTERNAL/FRONTIER_ALLOWED
- active_office_profile_version_id
- classification_limit

### 3.10 AuditEvent

| 필드 | 설명 |
|---|---|
| id | Event ID |
| timestamp | UTC |
| event_type | 행위 코드 |
| actor_type/id | 사용자/서비스 |
| organization_id/site_id | 범위 |
| resource_type/id/version | 대상 |
| trace_id/run_id/job_id | 연결 ID |
| result | SUCCESS/DENIED/FAILED |
| policy_id | 적용 정책 |
| metadata | 민감정보 제거 요약 |

## 4. 상태 정의

### 4.1 Asset/Service Version

| 상태 | 의미 | 허용 행동 |
|---|---|---|
| DRAFT | 제작 중 | 편집·삭제·검증 |
| VALIDATING | 자동검증 중 | 조회·취소 |
| CHANGES_REQUESTED | 수정 필요 | 편집·재검증 |
| READY_FOR_REVIEW | 제출 가능 | 검토 요청 |
| IN_REVIEW | 검토 중 | 의견·승인·반려 |
| REJECTED | 반려 종료 | 새 초안 복제 |
| APPROVED | 배포 가능 | 다운로드·Bundle·Deprecated |
| SUSPENDED | 긴급 중단 | 관리자 조회·대체 지정 |
| DEPRECATED | 지원 종료 예정/완료 | 기존 조회·대체 안내 |
| RETIRED | 폐기 | 감사 조회만 |

### 4.2 Local Installation

| 상태 | 의미 |
|---|---|
| QUARANTINED | 검증 전 |
| VERIFYING | Hash/Schema/Policy 검사 |
| STAGED | 임시 설치 완료 |
| ACTIVE | 실행에 사용 |
| INACTIVE | 설치되어 있으나 미사용 |
| INVALID | 손상 또는 호환 실패 |
| REVOKED | 회수 정책 적용 |

### 4.3 Agent Run

| 상태 | 의미 |
|---|---|
| CREATED | 생성 |
| PREFLIGHT | 사전검사 |
| RUNNING | 실행 중 |
| WAITING_FOR_USER | 사용자 확인/입력 대기 |
| SUCCEEDED | 성공 |
| FAILED | 실패 |
| CANCELLED | 취소 |

## 5. API Request 규칙

### 5.1 Header

- `Authorization`: 환경별 인증 Adapter
- `X-Request-ID`: Client 제공 가능, 없으면 Server 생성
- `X-Trace-ID`: 신뢰 경계에서 생성/전달
- `Content-Type: application/json`
- 파일 Upload는 별도 Multipart 또는 Upload Session

### 5.2 Idempotency

다음 API는 `Idempotency-Key`를 지원한다.

- Asset Version 생성
- Review Decision
- Distribution/Bundle 요청
- Package Install
- Agent Run 생성

같은 Key와 다른 Payload가 오면 충돌 오류를 반환한다.

### 5.3 목록 응답

```json
{
  "items": [],
  "page": 1,
  "page_size": 20,
  "total": 0,
  "sort": "updated_at:desc"
}
```

### 5.4 단일 응답

Resource를 바로 반환한다. 불필요한 `data` 중첩은 사용하지 않는다. 오류만 공통 Error Envelope를 사용한다.

### 5.5 동시성

- 편집 Entity는 `etag` 또는 `revision`을 가진다.
- PATCH는 `If-Match`를 사용한다.
- 충돌 시 `RESOURCE_REVISION_CONFLICT`를 반환한다.
- 승인 중인 Version은 Creator가 수정할 수 없다.

## 6. 파일 Upload 계약

대용량 파일을 고려한 권장 흐름:

1. `POST /uploads`로 Session 생성
2. Chunk 또는 단일 Stream Upload
3. Server가 크기·Hash 계산
4. `POST /uploads/{id}/complete`
5. 자동검증 Job
6. Asset Version에 File 연결

PoC 단일 Upload를 구현해도 상태와 진행률, 크기 제한, 실패 정리를 제공한다.

금지:

- Client 제공 MIME만 신뢰
- 파일명을 경로로 직접 사용
- 압축 해제 전 예상 크기 검사 생략
- 실패 임시파일 무기한 보관

## 7. Job Event

```json
{
  "job_id": "uuid",
  "sequence": 4,
  "status": "RUNNING",
  "step": "VERIFYING",
  "progress": 0.65,
  "message": "패키지 무결성을 검사하고 있습니다.",
  "timestamp": "2026-08-02T12:00:00Z"
}
```

Portal은 Polling으로 시작할 수 있으며 추후 SSE로 교체 가능하다. API Contract는 Event 형태를 유지한다.

## 8. 오류코드 분류

### 공통

- `VALIDATION_ERROR`
- `AUTHENTICATION_REQUIRED`
- `PERMISSION_DENIED`
- `RESOURCE_NOT_FOUND`
- `RESOURCE_REVISION_CONFLICT`
- `RATE_LIMITED`
- `DEPENDENCY_UNAVAILABLE`
- `INTERNAL_ERROR`

### Asset/Package

- `ASSET_VERSION_CONFLICT`
- `ASSET_STATE_TRANSITION_INVALID`
- `PACKAGE_SCHEMA_INVALID`
- `PACKAGE_CHECKSUM_MISMATCH`
- `PACKAGE_SIGNATURE_INVALID`
- `PACKAGE_REVOKED`
- `ASSET_VERSION_REVOKED` — P16 긴급 Revocation(사유·승인자·효력 시각을 가진
  `asset_version_revocations` 레코드)이 효력을 발휘 중(`effective_at` ≤ 현재
  시각)인 버전에 대한 신규 Bundle 생성 또는 다운로드 요청. `PACKAGE_REVOKED`
  (SUSPENDED/RETIRED 수명주기 상태)와 별개의 직교(orthogonal) 게이트 —
  APPROVED 상태의 버전도 긴급 회수 대상이 될 수 있다.
- `PACKAGE_PATH_UNSAFE`
- `PACKAGE_SIZE_LIMIT_EXCEEDED`
- `DEPENDENCY_MISSING`
- `DEPENDENCY_VERSION_CONFLICT`
- `DEPENDENCY_CYCLE`

### Service Composer

- `SERVICE_BINDING_REQUIRED`
- `SERVICE_AGENT_INCOMPATIBLE`
- `SERVICE_KNOWLEDGE_INCOMPATIBLE`
- `SERVICE_TOOL_NOT_ALLOWED`
- `SERVICE_MODEL_NOT_AVAILABLE`
- `SERVICE_OUTPUT_CONTRACT_MISMATCH`
- `SERVICE_MOCK_TEST_FAILED`

### Hosted Chat/Deployment

- `CHATBOT_KNOWLEDGE_REQUIRED`
- `CHATBOT_KNOWLEDGE_NOT_PUBLISHABLE`
- `CHATBOT_PREVIEW_NOT_PASSED`
- `CHATBOT_TEST_SUITE_FAILED`
- `DEPLOYMENT_SLUG_CONFLICT`
- `DEPLOYMENT_VALIDATION_FAILED`
- `DEPLOYMENT_PUBLISH_FAILED`
- `DEPLOYMENT_NOT_ACTIVE`
- `DEPLOYMENT_SUSPENDED`
- `CHAT_SESSION_EXPIRED`
- `CHAT_RATE_LIMITED`
- `CHAT_ACCESS_DENIED`
- `CHAT_RUNTIME_UNAVAILABLE`
- `CHAT_NO_EVIDENCE`

### Runtime

- `RUNTIME_VERSION_INCOMPATIBLE`
- `RUNTIME_PREFLIGHT_FAILED`
- `RUNTIME_CANCELLED`
- `MODEL_UNAVAILABLE`
- `MODEL_TIMEOUT`
- `OUTPUT_SCHEMA_INVALID`
- `INSUFFICIENT_EVIDENCE`

### Knowledge

- `KNOWLEDGE_PROFILE_INVALID`
- `KNOWLEDGE_EMBEDDING_MISMATCH`
- `KNOWLEDGE_INDEX_CORRUPT`
- `KNOWLEDGE_ACCESS_DENIED`
- `KNOWLEDGE_SEARCH_TIMEOUT`
- `KNOWLEDGE_NO_RESULTS`

### MCP

- `MCP_SERVER_UNAVAILABLE`
- `MCP_TOOL_NOT_FOUND`
- `MCP_TOOL_DISABLED`
- `MCP_INPUT_INVALID`
- `MCP_PERMISSION_DENIED`
- `MCP_EXECUTION_TIMEOUT`
- `MCP_RESULT_LIMIT_EXCEEDED`

## 9. API 보안 규칙

- Object ID를 안다고 접근할 수 없어야 한다.
- 모든 Resource Query에 Scope Filter를 적용한다.
- Role과 Scope를 서버에서 계산한다.
- Audit Metadata는 사용자 입력을 그대로 신뢰하지 않는다.
- Error Detail은 허용된 Field만 반환한다.
- CORS는 허용 Portal Origin으로 제한한다.
- Local Runtime API는 Loopback과 Session Token을 사용한다.
- Admin API는 별도 Role과 Network 정책을 요구한다.

## 10. Event/Log 상관관계

```text
Portal Request ID
      └─ Trace ID
          ├─ Validation/Bundle Job ID
          ├─ Download Record
          └─ Deployment ID/Revision/Publish Job

Hosted Chat Run ID
      └─ Trace ID
          ├─ Deployment Revision ID
          ├─ Service Version ID
          └─ Knowledge Search ID

Desktop Run ID
      └─ Trace ID
          ├─ Knowledge Search ID
          └─ MCP Request ID
```

각 모듈은 자신이 생성한 ID와 전달받은 Trace ID를 로그에 기록한다.

## 11. Database Migration

- Migration은 순방향과 Rollback 정책을 문서화한다.
- 운영 데이터 삭제 Migration은 별도 승인한다.
- JSON Manifest는 원본 Snapshot으로 보관하되 검색에 필요한 핵심 Field는 Column으로 정규화한다.
- 개발 Seed에는 Sample Organization/Site/User/Asset만 포함한다.
- 실제 운영 사용자·사업장·Secret을 Seed에 포함하지 않는다.

## 12. 계약 인수 기준

- OpenAPI, JSON Schema, DB Entity 명칭이 동일한 용어를 사용한다.
- 사용자 화면과 신규 API에서 `RAG` 문자열이 노출되지 않는다.
- Error Code는 중복되지 않고 소유 모듈이 명확하다.
- 승인된 Version의 Manifest와 Resolved Dependency Snapshot은 수정할 수 없다.
- Service Composer, Bundle Builder, Desktop, Runtime이 동일 Service Definition Fixture를 해석한다.
- Preview와 Hosted Chat Runtime이 동일 Service Definition/Deployment Revision Fixture를 해석한다.
- 모든 주요 흐름이 Trace ID로 연결된다.
