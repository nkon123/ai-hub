# Knowledge 챗봇 테스트·URL 게시 상세 명세

목표: 포털에 등록된 Knowledge를 선택하여 비개발자가 챗봇을 구성하고, 실제 Knowledge 기반 대화를 중간에 테스트한 후, 승인된 구성을 사내 사용자가 접속할 수 있는 고유 URL로 게시한다.

이 문서의 URL 게시 기능은 인터넷 공개를 의미하지 않는다. PoC 기본값은 사내 인증을 거친 내부 URL이며, 발표용 Demo Token은 비민감 샘플 Knowledge에만 제한적으로 허용한다.

관련 모듈:

- M01: Knowledge 챗봇 빠른 만들기, Preview, 게시 설정, Hosted Chat UI
- M02: Service/Deployment Registry, 게시·세션 Metadata API
- M03: Deployment Job, 불변 Snapshot 조립, 활성 Version 전환
- M05: Hosted Agent Runtime과 Streaming Chat API
- M06: Chatbot/Deployment Schema와 Validator
- M08: 게시된 Knowledge 검색과 Citation
- M11: 사용자·Service·Knowledge ACL, Rate Limit, 감사
- M12: Preview·게시·URL 접속 E2E와 발표 Runbook

## 1. 발표용 필수 시나리오

```text
Knowledge 등록
  → 자동검증·인덱스 준비
  → Knowledge 챗봇 만들기
  → 등록 Knowledge 선택
  → 챗봇 이름·안내문·추천 질문 설정
  → 실제 Knowledge로 Preview 대화
  → 답변과 Citation 확인
  → 게시 설정·검증
  → 게시 Job 성공
  → 고유 URL 발급
  → 새 브라우저에서 URL 접속
  → 질문·Streaming 답변·Citation 확인
```

발표 완료 조건:

1. 등록된 Knowledge Version이 선택 목록에 보인다.
2. 선택한 Knowledge를 기반으로 Preview 질문에 답한다.
3. Preview와 게시된 챗봇이 동일한 Service Version Snapshot을 사용한다.
4. 게시 성공 후 복사 가능한 URL이 표시된다.
5. 새 브라우저 또는 시크릿 창에서 해당 URL에 접속할 수 있다.
6. 게시된 챗봇이 답변과 문서 Citation을 표시한다.
7. 권한 없는 사용자와 존재하지 않는 URL을 안전하게 처리한다.

## 2. 시스템 구조

```text
Creator
  │
  ▼
AI Asset Portal
  ├─ Knowledge Registry
  ├─ Knowledge Chatbot Quick Create
  ├─ Preview UI
  └─ Publish/Deployment UI
          │
          ▼
Portal API ──> Deployment Registry
          │
          ▼
Distribution/Deployment Worker
  ├─ Service Version 고정
  ├─ Knowledge/Prompt/Model 의존성 Snapshot
  ├─ 정책·Checksum 검증
  └─ Hosted Runtime 활성화
          │
          ▼
https://ai.company.local/chat/{deployment_slug}
          │
          ▼
Hosted Chat UI ──> Hosted Agent Runtime
                         ├─> Knowledge Search Runtime
                         └─> Approved Model Endpoint
```

Portal API가 직접 모델을 호출하거나 답변을 생성하지 않는다. Preview와 게시 실행은 공통 Agent Runtime Core를 사용하는 별도 Hosted Agent Runtime이 담당한다.

## 3. Desktop Client와의 관계

URL 게시와 폐쇄망 Desktop 실행은 동일한 Service Definition을 소비하지만 배포 Target이 다르다.

| Target | 실행 위치 | 접근 방식 | 주요 목적 |
|---|---|---|---|
| `HOSTED_INTERNAL` | 중앙 사내망 Hosted Runtime | `/chat/{slug}` | URL로 공유하는 Knowledge 챗봇 |
| `DESKTOP_OFFLINE` | 사용자 PC Local Runtime | Electron/PySide6 Client | 완전 폐쇄망 로컬 실행 |
| `DESKTOP_CONNECTED` | 사용자 PC 또는 사업장 Runtime | Desktop Client | 로컬 파일·Office MCP 결합 |

Service Definition과 Package Schema를 공통으로 사용하고, Endpoint·Secret·실제 모델 주소는 Deployment Profile 또는 Office Profile에서 주입한다.

## 4. Knowledge 챗봇 빠른 만들기

전체 Service Composer의 단축 경로로 `Knowledge 챗봇 만들기`를 제공한다. 시스템이 승인된 표준 Knowledge Chat Agent와 기본 Prompt를 자동 연결하므로 사용자는 Agent 구조를 이해하지 않아도 된다.

```text
사용자 선택
  Knowledge Version 1..n
  + 챗봇 이름·설명·추천 질문
  + 허용된 Model Alias
  + 답변·Citation 정책
  + 접근 대상

시스템 자동 연결
  Standard Knowledge Chat Agent
  + Standard Query Rewrite Prompt
  + Standard Grounded Answer Prompt
  + Hosted Runtime Policy
```

빠른 만들기 단계:

| 단계 | 화면명 | 필수 입력 | 결과 |
|---:|---|---|---|
| 1 | Knowledge 선택 | 등록·검증된 Knowledge Version | 검색 대상 고정 |
| 2 | 챗봇 설정 | 이름, Slug, 설명, 환영문, 추천 질문 | Chat UI Metadata |
| 3 | 답변 정책 | Model Alias, Prompt Template, Citation, 답변 제한 | 실행 정책 |
| 4 | Preview 테스트 | 질문, Test User Context | 실제 검색·답변 결과 |
| 5 | 게시 설정 | 접근정책, 대상 조직·사업장, 게시 Version | Deployment 초안 |
| 6 | 게시 결과 | 최종 검증, 게시 Job | 고유 URL |

고급 사용자는 전체 Service Composer에서 Agent, 다중 Knowledge, MCP Tool, Prompt를 직접 구성할 수 있다. 발표 시나리오는 빠른 만들기를 기본 진입점으로 사용한다.

## 5. Knowledge 선택 규칙

Preview 선택 가능:

- 소유자가 등록하고 자동검증을 통과한 `VALIDATED` Version
- 승인된 `APPROVED` Version
- 현재 사용자가 읽을 수 있는 Knowledge
- Hosted Runtime이 접근할 수 있는 Index Artifact를 가진 Version

게시 가능:

- `APPROVED` Knowledge Version만 허용
- Knowledge ACL과 Chatbot 대상 사용자의 교집합이 비어 있지 않아야 함
- Embedding Model Alias와 Search Runtime 호환성 통과
- 중단·회수·폐기 Knowledge Version 게시 금지
- Source/Index/평가 정보와 Checksum이 완전해야 함

선택 화면 표시 항목:

- 이름·설명·Version·소유 조직
- 문서 수·청크 수·마지막 인덱싱 시각
- 검색 품질 지표와 알려진 제한
- 보안등급·허용 조직·사업장
- 지원 Search Runtime과 Embedding Alias
- Preview 가능/게시 가능 상태와 불가 사유

## 6. Preview 테스트

### 6.1 목적

Mock 화면 확인이 아니라 등록된 Knowledge가 실제 질문에서 적절한 문서를 검색하고 근거 있는 답변을 만드는지 게시 전에 검증한다.

### 6.2 실행 원칙

- 선택한 Knowledge Version의 실제 Test/Approved Index를 사용한다.
- 게시될 Service Definition Resolver와 Agent Runtime Core를 그대로 사용한다.
- 운영용 Prompt·Model Alias의 Test Environment Binding을 사용한다.
- MCP Tool은 발표용 Knowledge 챗봇에서 사용하지 않는다.
- MCP 포함 Service Preview는 기본적으로 Mock MCP만 허용한다.
- Preview Run은 제작자와 허용된 검토자에게만 보인다.
- Preview는 게시 URL과 분리된 짧은 수명의 Session으로 실행한다.

### 6.3 Preview 화면

좌측:

- 현재 Service Draft 이름과 Revision
- 선택 Knowledge와 Version
- Model Alias와 Prompt Version
- Test User Role·Organization·Site
- 저장된 대표 Test Case

중앙:

- 새 대화
- 질문 입력
- Streaming 답변
- 추천 후속 질문
- Citation 목록
- 검색 근거 펼치기

우측 Debug Panel; CREATOR/REVIEWER만 표시:

- Query Rewrite 결과
- 검색된 Chunk ID·제목·점수·페이지
- 적용된 Metadata/ACL Filter
- Context Token 사용량
- 모델·검색·전체 Latency
- Trace ID
- 오류·경고

### 6.4 Test Case 저장

각 Test Case:

- `name`
- `question`
- `test_user_context`
- `expected_source_ids` 또는 `expected_document_ids`
- `must_include_terms`
- `must_not_include_terms`
- `citation_required`
- `created_by/created_at`

검증 결과:

- 기대 Source가 Top-K에 포함되는지
- 답변에 Citation이 있는지
- 답변이 검색 Context에 근거하는지
- 접근 불가 문서가 결과에 포함되지 않는지
- P95 목표시간과 1회 실행시간
- 오류·Timeout 여부

### 6.5 게시 Gate

PoC 게시 최소 조건:

1. 전체 구성 검증 성공
2. Preview 1회 이상 성공
3. 대표 Test Case 3개 중 필수 Case 전부 성공
4. Citation 필수 정책 성공
5. Knowledge/Service Version이 게시 가능 상태
6. 접근정책과 ACL 검증 성공

## 7. 게시 설정

필드:

- Deployment 표시명
- Deployment Slug
- Target Environment: `DEV`, `DEMO`, `INTERNAL`
- 접근 정책: `INTERNAL_AUTHENTICATED`, `DEMO_TOKEN`
- 허용 조직·사업장·역할
- 시작 화면 환영문
- 추천 질문 최대 5개
- 사용자 피드백 사용 여부
- 대화 보관 정책
- 동시 Session·분당 요청·입력 글자 제한
- 게시할 Service Version

Slug 규칙:

- 소문자 영문, 숫자, 하이픈만 허용
- Environment 내 유일
- 예약어 금지
- 변경 시 기존 URL을 자동 Redirect하지 않음
- 삭제된 Slug 재사용은 보안정책의 유예기간 이후만 허용

발급 URL 예:

```text
https://ai.company.local/chat/hr-policy-guide
```

사용자가 외부 URL을 입력하는 기능은 제공하지 않는다. Base URL은 운영환경 설정이며, 사용자는 검증된 Slug만 선택한다.

## 8. 게시 수명주기

```text
DRAFT
  → VALIDATING
  → DEPLOYING
  → ACTIVE
      ├→ UPDATING → ACTIVE
      ├→ SUSPENDED → ACTIVE
      └→ RETIRED

VALIDATING/DEPLOYING → FAILED → 재시도 또는 DRAFT
```

규칙:

- `ACTIVE` Deployment는 하나의 불변 Service Version을 가리킨다.
- Service Version 변경은 새 Deployment Revision으로 수행한다.
- Update 실패 시 기존 Active Revision을 유지한다.
- Suspend 시 새 Chat Session 생성을 즉시 차단한다.
- 기존 Stream 종료정책은 Grace Period 후 강제 종료를 기본으로 한다.
- Knowledge나 Service가 긴급 회수되면 연결된 Deployment를 자동 Suspend 후보로 표시한다.
- 게시 완료 전 Health Check와 대표 질문 Smoke Test를 실행한다.

## 9. Hosted Chat 화면

Route:

```text
/chat/:deploymentSlug
```

표시:

- 챗봇 이름·설명·소유 조직
- 환영문과 추천 질문
- 대화 메시지
- Streaming 상태
- 답변 Citation
- 새 대화
- 피드백; 설정 시
- 데이터 사용 및 주의 문구
- 지원 문의처

상태:

- Loading: Deployment Metadata와 인증 확인
- Ready: 질문 가능
- Streaming: 중복 전송 방지, 취소 제공
- No Evidence: 근거를 찾지 못했음을 명확히 표시
- Permission Denied: Knowledge 존재나 제목을 노출하지 않음
- Suspended: 서비스 일시 중단과 문의처 표시
- Not Found: Slug 존재 여부를 구분하지 않는 안전한 메시지
- Runtime Error: 사용자 메시지와 Trace ID, 재시도 제공

Citation 행동:

- 문서 제목, 섹션, 페이지 또는 Source 위치 표시
- 현재 사용자에게 허용된 Source만 표시
- 원문 열기는 별도 권한 확인 후 수행
- Citation 없는 생성 답변은 정책에 따라 차단하거나 경고

## 10. API 계약

### 10.1 Preview

| Method | Path | 기능 |
|---|---|---|
| POST | `/api/v1/service-versions/{version_id}/preview-sessions` | Preview Session 생성 |
| GET | `/api/v1/preview-sessions/{session_id}` | Preview 설정·상태 조회 |
| POST | `/api/v1/preview-sessions/{session_id}/messages` | 질문 실행 |
| GET | `/api/v1/preview-runs/{run_id}/events` | SSE 실행 이벤트 |
| POST | `/api/v1/preview-runs/{run_id}/cancel` | 실행 취소 |
| POST | `/api/v1/service-versions/{version_id}/test-cases` | Test Case 저장 |
| POST | `/api/v1/service-versions/{version_id}/test-suite-runs` | 게시 전 Test Suite 실행 |

### 10.2 Deployment 관리

| Method | Path | 기능 |
|---|---|---|
| POST | `/api/v1/service-versions/{version_id}/deployments` | Deployment 초안 생성 |
| GET | `/api/v1/deployments/{deployment_id}` | 설정·상태·발급 URL 조회 |
| PATCH | `/api/v1/deployments/{deployment_id}` | Draft 게시 설정 수정 |
| POST | `/api/v1/deployments/{deployment_id}/validate` | 게시 전 검증 |
| POST | `/api/v1/deployments/{deployment_id}/publish` | 게시 Job 시작 |
| GET | `/api/v1/deployments/{deployment_id}/jobs/{job_id}` | 게시 진행률 조회 |
| POST | `/api/v1/deployments/{deployment_id}/suspend` | 접속 중단 |
| POST | `/api/v1/deployments/{deployment_id}/resume` | 검증 후 재개 |
| POST | `/api/v1/deployments/{deployment_id}/revisions` | 새 Service Version으로 Update |
| POST | `/api/v1/deployments/{deployment_id}/rollback` | 이전 정상 Revision 복구 |

### 10.3 Hosted Chat Runtime

| Method | Path | 기능 |
|---|---|---|
| GET | `/chat-api/v1/chatbots/{slug}` | 허용된 Chatbot Metadata 조회 |
| POST | `/chat-api/v1/chatbots/{slug}/sessions` | Chat Session 생성 |
| POST | `/chat-api/v1/sessions/{session_id}/messages` | 질문 등록·Run 시작 |
| GET | `/chat-api/v1/runs/{run_id}/events` | SSE Token·Citation·완료·오류 이벤트 |
| POST | `/chat-api/v1/runs/{run_id}/cancel` | 실행 취소 |
| POST | `/chat-api/v1/messages/{message_id}/feedback` | 선택적 피드백 저장 |

SSE Event 최소 목록:

- `run.started`
- `search.started`
- `search.completed`
- `answer.delta`
- `citation.added`
- `run.completed`
- `run.failed`
- `run.cancelled`

## 11. 데이터 모델

### 11.1 ServiceDeployment

- `id`
- `display_name`
- `slug`
- `environment`
- `access_policy`
- `target_orgs/target_sites/target_roles`
- `status`
- `active_revision_id`
- `created_by/created_at`
- `published_by/published_at`
- `suspended_by/suspended_at/suspend_reason`
- `last_health_status/checked_at`
- `public_url`; 서버가 계산한 내부 URL

### 11.2 DeploymentRevision

- `id`
- `deployment_id`
- `revision_number`
- `service_version_id`
- `service_definition_hash`
- `resolved_dependency_snapshot`
- `runtime_release`
- `deployment_profile_id`
- `test_suite_run_id`
- `status`
- `created_at/activated_at`

### 11.3 ChatSession

- `id`
- `deployment_revision_id`
- `user_context_hash`
- `status`
- `created_at/last_activity_at/expires_at`
- `message_count`
- `trace_id`

질문 원문과 답변 원문의 저장 여부는 보관정책을 따른다. 기본 Audit에는 원문을 저장하지 않는다.

## 12. 보안·운영 규칙

- 기본 접근정책은 사내 인증 사용자만 허용한다.
- Service Target과 Knowledge ACL을 요청마다 다시 검사한다.
- URL을 안다는 이유만으로 Knowledge 접근을 허용하지 않는다.
- `DEMO_TOKEN`은 만료·회수·사용범위·요청량 제한을 가진다.
- 비민감 Sample Knowledge가 아닌 경우 익명 Demo Token을 금지한다.
- Runtime에는 승인된 Service Definition Snapshot만 로딩한다.
- Model Endpoint·Secret은 Deployment Environment에서 주입한다.
- 질문 길이, 파일, Session, Rate, Context, Timeout을 제한한다.
- Prompt Injection 문구가 Knowledge ACL 또는 Tool 권한을 변경할 수 없다.
- HTML/Markdown 출력은 Sanitizing 후 렌더링한다.
- Trace에는 Deployment/Revision/Service/Knowledge/User/Run ID를 연결한다.
- Suspend·Rollback·권한 거부·실행 실패를 Audit에 기록한다.

## 13. 모듈별 구현 경계

| 모듈 | 구현 | 구현하지 않음 |
|---|---|---|
| M01 | Quick Create, Preview, Publish 화면, Hosted Chat UI | 모델 직접 호출, ACL 판정 |
| M02 | Deployment Metadata, Slug 유일성, 상태 API | Runtime 실행, Knowledge 검색 |
| M03 | Snapshot 조립, Publish Job, 활성 Revision 전환 | Chat 답변 생성 |
| M05 | Hosted Chat Run, Streaming, Model/Search 조정 | 게시 승인, 자산 Registry |
| M06 | Deployment·Session·Event Schema | Runtime 상태 저장 |
| M08 | Knowledge 검색·ACL Filter·Citation Context | Chat UI, 배포 상태 전환 |
| M11 | 접근정책·토큰·Rate·Audit Policy | 화면 상태 관리 |
| M12 | Fixture, E2E, Smoke, Demo Runbook | 기능별 운영 구현 |

## 14. 오류 코드

- `CHATBOT_KNOWLEDGE_REQUIRED`
- `CHATBOT_KNOWLEDGE_NOT_PUBLISHABLE`
- `CHATBOT_PREVIEW_NOT_PASSED`
- `CHATBOT_TEST_SUITE_FAILED`
- `DEPLOYMENT_SLUG_CONFLICT`
- `DEPLOYMENT_VALIDATION_FAILED`
- `DEPLOYMENT_PUBLISH_FAILED`
- `DEPLOYMENT_NOT_ACTIVE`
- `DEPLOYMENT_SUSPENDED`
- `DEPLOYMENT_REVISION_UNAVAILABLE`
- `CHAT_SESSION_EXPIRED`
- `CHAT_RATE_LIMITED`
- `CHAT_INPUT_TOO_LARGE`
- `CHAT_ACCESS_DENIED`
- `CHAT_RUNTIME_UNAVAILABLE`
- `CHAT_NO_EVIDENCE`

## 15. 요구사항 ID

| ID | 요구사항 | 완료 기준 |
|---|---|---|
| HOST-001 | 등록 Knowledge로 챗봇 빠른 만들기를 제공한다. | Agent를 수동 선택하지 않고 Draft 생성 |
| HOST-002 | Knowledge Version의 Preview/게시 가능 상태를 구분한다. | 선택 목록에 상태와 불가 사유 표시 |
| HOST-003 | 챗봇 이름·Slug·환영문·추천 질문을 설정한다. | 저장 후 Preview UI에 동일하게 반영 |
| HOST-004 | 표준 Agent와 Prompt를 자동 연결한다. | 생성 Definition의 고정 Version 확인 |
| HOST-005 | 실제 등록 Knowledge로 Preview한다. | 검색 Chunk와 Citation 확인 |
| HOST-006 | Preview가 게시 Runtime Core를 사용한다. | 동일 Fixture Contract Test 통과 |
| HOST-007 | 질문별 검색·답변 Trace를 표시한다. | 제작자 Debug Panel에 Trace ID 제공 |
| HOST-008 | 대표 Test Case를 저장·재실행한다. | 3개 Case 결과와 이력 조회 |
| HOST-009 | 게시 Gate를 서버에서 검증한다. | Gate 실패 시 Publish API 거부 |
| HOST-010 | Deployment Slug를 유일하게 발급한다. | 충돌 요청에 표준 오류 반환 |
| HOST-011 | Service/Dependency 불변 Snapshot을 만든다. | Revision에서 Hash와 고정 Version 조회 |
| HOST-012 | 게시를 비동기 Job으로 실행한다. | 단계·진행률·실패·재시도 표시 |
| HOST-013 | 게시 후 내부 Chat URL을 발급한다. | `/chat/{slug}` 링크 복사 가능 |
| HOST-014 | URL에서 Chatbot Metadata를 안전하게 조회한다. | 권한·중단·없음 상태 처리 |
| HOST-015 | Chat Session을 생성하고 질문을 실행한다. | Session별 Run ID 생성 |
| HOST-016 | 답변을 SSE로 Streaming한다. | Delta·Citation·완료 Event 수신 |
| HOST-017 | 답변에 Knowledge Citation을 표시한다. | 문서·섹션·페이지 위치 확인 |
| HOST-018 | 근거 부족 응답을 명확히 처리한다. | 추측 답변 대신 No Evidence 상태 |
| HOST-019 | 조직·사업장·역할·Knowledge ACL을 강제한다. | UI 우회 API도 접근 거부 |
| HOST-020 | Demo Token을 만료·회수·제한한다. | 만료/회수 Token 요청 거부 |
| HOST-021 | Deployment를 Suspend·Resume한다. | 새 Session 차단과 복구 확인 |
| HOST-022 | 새 Revision Update 실패 시 기존 Version을 유지한다. | 장애 중 기존 URL 정상 동작 |
| HOST-023 | 이전 정상 Revision으로 Rollback한다. | 활성 Version과 Audit 변경 확인 |
| HOST-024 | 게시 후 Health/Smoke Test를 수행한다. | 실패 시 Active 전환 차단 |
| HOST-025 | Chat 입력·요청량·Timeout을 제한한다. | 초과 요청 표준 오류와 Audit |
| HOST-026 | Chat HTML/Markdown을 Sanitizing한다. | XSS 보안 Test 통과 |
| HOST-027 | 질문·답변 원문 저장을 보관정책으로 통제한다. | 기본 Audit에 원문 없음 |
| HOST-028 | 게시·실행·중단을 Trace와 Audit으로 연결한다. | Deployment→Run→Search 추적 가능 |
| HOST-029 | 새 브라우저에서 게시 URL E2E를 검증한다. | 로그인→질문→Citation 전체 통과 |
| HOST-030 | 발표용 Demo Runbook과 복구 절차를 제공한다. | 10분 시연과 실패 대체 절차 검증 |

## 16. PoC 제외 범위

- 외부 인터넷에 익명 공개되는 범용 챗봇 Hosting
- 사용자 지정 Domain과 TLS 인증서 자동 발급
- 챗봇별 별도 Source Code·Container 생성
- 자유형 화면 Builder와 CSS/JavaScript 입력
- 미승인 Knowledge의 일반 사용자 게시
- URL만으로 권한을 대체하는 영구 공유 링크
- 게시 챗봇의 쓰기형 MCP Tool 실행
