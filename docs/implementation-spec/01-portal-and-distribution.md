# Portal, Registry, Distribution 상세 명세

대상 모듈: M01, M02, M03  
사용자 표기 원칙: `RAG` 대신 `Knowledge` 또는 `지식 자산`을 사용한다.

## 1. M01 Portal UI & Catalog

### 1.1 책임

- 승인된 AI 자산과 AI Service를 탐색할 수 있는 Web UI
- 제작자의 자산 등록·버전 관리·검토 요청 UI
- 검토자의 승인·반려·의견 기록 UI
- Offline Bundle 요청과 결과 확인 UI
- 단계형 AI Service Composer UI
- Knowledge 챗봇 Quick Create, 실제 Preview, 내부 URL 게시 UI
- 게시된 Hosted Chat 화면
- 평가 결과, 감사 로그, 수명주기 상태 표시

M01은 서버 권한 판정, 파일 저장, Manifest 검증을 직접 구현하지 않는다. 모든 결정은 M02/M03/M11 API 결과를 사용한다.

### 1.2 화면 공통 규칙

모든 화면은 다음 상태를 명시적으로 제공한다.

- Loading: 주요 레이아웃을 유지하는 Skeleton 또는 진행 표시
- Empty: 데이터가 없는 이유와 다음 행동 제공
- Error: 사용자 메시지, 재시도, Trace ID 제공
- Permission Denied: 필요한 역할과 문의 경로 표시
- Partial Failure: 일부 정보만 실패했을 때 화면 전체를 차단하지 않음
- Unsaved Changes: 입력 중 이동 시 확인
- Long Job: Job 진행률, 현재 단계, 취소 가능 여부 제공

버튼 규칙:

- 한 화면의 주요 행동은 하나만 강조한다.
- 삭제·중단·폐기는 대상 이름을 다시 확인한다.
- 승인·반려에는 확인 Dialog와 의견 입력을 제공한다.
- 서버 응답 전 중복 제출을 방지한다.

### 1.3 Portal 화면 목록

| ID | 화면 | Route 예시 | 사용자 | 핵심 목적 |
|---|---|---|---|---|
| P00 | 로그인/접근 거부 | `/login`, `/forbidden` | 전체 | 인증 진입과 권한 부족 안내 |
| P01 | 홈 대시보드 | `/` | 전체 | 내 작업과 주요 자산으로 빠르게 이동 |
| P02 | 자산 카탈로그 | `/assets` | 전체 | Agent·Knowledge·MCP·Prompt·Service 검색 |
| P03 | 자산 상세 | `/assets/:assetId` | 전체 | 설명·버전·의존성·호환성·품질 확인 |
| P04 | 자산 유형 선택 | `/assets/new` | CREATOR | 새 자산 유형 선택 |
| P05 | 자산 등록 Wizard | `/assets/new/:type` | CREATOR | Metadata·Manifest·파일·테스트 등록 |
| P06 | 버전 관리 | `/assets/:assetId/versions` | CREATOR | 새 버전·변경이력·검토 요청 |
| P07 | 내 자산 | `/my/assets` | CREATOR | 작성·검토 중·반려 자산 관리 |
| P08 | 검토함 | `/reviews` | REVIEWER | 대기 검토 검색·우선순위 확인 |
| P09 | 검토 상세 | `/reviews/:reviewId` | REVIEWER | 자동검사·Diff·보안·테스트 검토 |
| P10 | 다운로드/Bundle 요청 | `/distributions/new` | USER/CREATOR | 온라인 또는 폐쇄망 배포 요청 |
| P11 | Bundle 작업 상세 | `/distributions/:jobId` | 요청자/관리자 | 진행률·파일·검증 결과 확인 |
| P12 | Knowledge 품질 | `/knowledge/:assetId/quality` | 전체/REVIEWER | 검색 품질·평가 질문·버전 비교 |
| P13 | 다운로드 이력 | `/downloads` | USER/AUDITOR | 내가 받은 자산과 감사 이력 확인 |
| P14 | 감사 로그 | `/audit` | AUDITOR/ADMIN | 사용자·자산·행위별 추적 |
| P15 | 관리자 설정 | `/admin` | ADMIN | 사용자·역할·사업장·정책 관리 |
| P16 | 수명주기/회수 | `/admin/lifecycle` | RELEASE_MANAGER | 중단·폐기·대체 버전 지정 |
| P17 | AI Service 목록 | `/services` | 전체 | 구성된 업무 서비스 검색·실행 준비 |
| P18 | Service Composer | `/services/new`, `/services/:id/edit` | CREATOR | 승인된 자산으로 서비스 구성 |
| P19 | Service 상세·검증 | `/services/:serviceId` | 전체/REVIEWER | 구성 요약·호환성·Mock 테스트·버전 확인 |
| P20 | Knowledge 챗봇 빠른 만들기 | `/chatbots/new` | CREATOR | 등록 Knowledge로 표준 챗봇 구성 |
| P21 | 챗봇 Preview | `/services/:serviceId/preview` | CREATOR/REVIEWER | 실제 Knowledge 검색·답변·Citation 테스트 |
| P22 | 게시·Deployment | `/services/:serviceId/publish`, `/deployments/:id` | CREATOR/RELEASE_MANAGER | 게시 검증·진행률·URL·중단·Rollback |
| P23 | Hosted Chatbot | `/chat/:deploymentSlug` | 허용 사용자 | 게시된 Knowledge 챗봇 대화 |

## 2. 화면별 기능 정의

### P00 로그인/접근 거부

표시:

- 제품명과 환경명(개발/테스트/운영)
- 사내 인증 진입 버튼
- 개발 환경에서는 명시적으로 표시된 Test User 선택 기능
- 인증 실패 이유의 안전한 사용자 메시지
- Trace ID와 지원 문의 경로

행동:

- 로그인 성공 후 원래 요청한 경로로 이동
- 세션 만료 시 작성 중인 비민감 Form Draft를 보존하고 재로그인
- 권한 부족 화면에서 이전 화면 또는 홈으로 이동

금지:

- 운영 환경의 로컬 계정 임의 생성
- URL Parameter만으로 역할 변경
- 인증 오류에 내부 인증 서버 정보 노출

### P01 홈 대시보드

표시:

- 내가 설치/다운로드 가능한 추천 Service와 Agent
- 내가 작성 중인 자산 수
- 내 검토 대기 건수
- 최근 다운로드와 Bundle Job 상태
- 회수·지원 종료 등 중요 공지

행동:

- 자산 카탈로그, Service Composer, 검토함, 최근 Job으로 이동
- 역할이 없는 Section은 숨기되 서버 권한은 별도로 확인

대시보드는 임의 KPI를 만들지 않는다. 실제 Registry와 Audit 데이터만 표시한다.

### P02 자산 카탈로그

검색 대상:

- AI Service
- Agent Package
- Knowledge Package
- MCP Tool Package
- Prompt Package
- Office Profile은 일반 사용자 검색에서 제외하고 관리자 또는 제작자에게만 표시

필터:

- 자산 유형
- 승인 상태
- 지원 실행환경: 폐쇄망/Ollama/Frontier AI
- 사업장
- 업무 카테고리
- 작성 조직
- 보안등급
- 지원 중/지원 종료
- 검증 상태

목록 항목:

- 이름, 한 줄 설명, 유형, 최신 승인 버전
- 지원 환경, 담당 조직, 마지막 변경일
- 승인·중단·폐기 상태
- 필수 권한 또는 제한 표시

행동:

- 검색어와 필터를 URL Query에 유지
- 정렬: 관련도, 최신순, 이름순, 다운로드순
- 페이지 이동 후 뒤로 가기 시 위치와 필터 유지
- 접근할 수 없는 자산은 존재 자체를 노출하지 않는 정책을 기본으로 함

### P03 자산 상세

공통 Tab:

1. 개요
2. 버전
3. 의존성
4. 호환성
5. 품질/테스트
6. 변경이력
7. 설치/사용법
8. 권한과 보안

유형별 추가 정보:

- Agent: Workflow 요약, 입력/출력, 필요한 Knowledge/MCP/Prompt, 필요한 Runtime
- Knowledge: Source 범위, 문서 버전, 청킹·Embedding·검색 Profile, 청크 수, 평가 결과
- MCP Tool: 입력/출력 Schema, 위험도, 필요 권한, 제공 사업장, Timeout, 데이터 범위
- Prompt: 변수, 지원 모델, 출력 Schema, 테스트 결과
- Service: 구성 자산, 모델 정책, 입력 Form, 출력 형식, 대상 사업장

주요 행동:

- 승인 버전 다운로드
- Offline Bundle 요청
- 새 버전 만들기
- 검토 요청
- 지원 중단 또는 폐기 요청
- 의존 자산 상세로 이동

### P04 자산 유형 선택

카드가 아니라 간결한 목록으로 다음을 설명한다.

- Agent: 업무 흐름과 판단 로직
- Knowledge: 사전에 가공·검증된 검색 지식
- MCP Tool: 사내 시스템 기능
- Prompt: 모델 지침
- AI Service: 기존 자산을 조합한 완성된 업무 서비스

각 유형은 필요한 사전 준비, 예상 파일, 검토 범위를 표시한다.

### P05 자산 등록 Wizard

공통 단계:

1. 기본정보
2. 지원 환경과 소유권
3. Manifest 입력 또는 업로드
4. 패키지 파일 업로드
5. 의존성 확인
6. 자동검증 결과
7. 문서·변경이력
8. 초안 저장 또는 검토 요청

기본정보 필드:

- 자산명, Slug, 유형, 설명, 업무 카테고리, 태그
- 소유 조직, 주 담당자, 지원 문의처
- 보안등급, 허용 사업장, 허용 사용자 범위
- 라이선스/출처 정보

검증:

- 이름·Slug 중복
- 버전 형식
- Manifest Schema
- Package 파일 목록과 Manifest 일치
- 금지 확장자·경로 이동 문자·압축 폭탄
- 누락 의존성·순환 의존성·호환 버전
- Secret Pattern과 실행 코드 정책

업로드는 재개 가능한 방식이 이상적이나 PoC에서는 Job과 진행률, 실패 재시도를 최소 요구한다.

### P06 버전 관리

기능:

- 최신 승인 버전에서 새 초안 생성
- Version 입력과 SemVer 가이드
- 이전 버전과 Manifest/Dependency/Permission Diff
- Changelog 작성
- 자동검증 재실행
- 검토 요청과 취소
- 승인 버전 수정 금지
- Deprecated 버전의 대체 버전 지정

### P07 내 자산

구분:

- 작성 중
- 자동검증 실패
- 검토 대기
- 반려
- 승인됨
- 지원 종료 예정

각 행은 다음 행동을 제공한다.

- 초안 편집
- 검증 결과 보기
- 반려 의견 보기
- 새 버전 만들기
- 담당자 변경 요청

### P08 검토함

필터:

- 기술/보안/배포 검토 단계
- 자산 유형
- 보안등급
- 제출 조직
- 대기 기간
- 자동검증 실패 여부

목록:

- 제출자, 자산, 버전, 요청일
- 필요한 검토 유형
- 고위험 변경 표시: 새 실행 코드, 권한 증가, 새 MCP Tool, 새 외부 연결

### P09 검토 상세

검토 Section:

- 기본정보와 변경 목적
- Manifest Diff
- 파일 목록과 Checksum
- 의존성 그래프와 취약점 검사 결과
- 필요 권한 Diff
- 자동 테스트 결과
- Knowledge 품질 결과
- MCP 입력·출력·Allowlist
- 설치·Rollback 문서
- 이전 검토 의견

행동:

- 의견 추가
- 수정 요청
- 반려
- 현재 단계 승인
- 최종 배포 승인

승인 시 검토자가 확인한 Check 항목과 의견을 Audit Log에 저장한다.

### P10 다운로드/Bundle 요청

입력:

- 배포 대상 자산과 버전
- 배포 방식: 온라인 단일 패키지/Offline Bundle
- 대상 사업장과 Office Profile
- 대상 OS와 Runtime 버전
- 선택 기능 포함 여부

표시:

- 자동 포함되는 Agent, Knowledge, MCP 설정, Prompt, Model 요구사항
- 예상 파일 크기
- 누락된 의존성
- 라이선스·보안 경고

행동:

- 의존성 재계산
- Bundle 생성 Job 제출
- 승인되지 않은 버전은 선택 불가

### P11 Bundle 작업 상세

상태:

- Queued, Resolving, Collecting, Verifying, Packaging, Signing, Succeeded, Failed, Cancelled

표시:

- 진행률과 현재 단계
- 포함 자산과 버전
- 전체 크기와 Checksum
- 실패 코드와 재시도 가능 여부
- 다운로드 만료 시각

행동:

- 허용된 단계에서 취소
- 동일 조건으로 재시도
- 결과 다운로드
- Bundle Manifest 보기

### P12 Knowledge 품질

표시:

- Source 문서 수와 버전
- Parsed 문서, Parent, Child 수
- Chunk 전략과 크기
- Embedding 모델과 차원
- Vector/BM25/Hybrid 설정
- Recall@1, Recall@5, MRR
- 검색 P50/P95 시간
- 평가 질문별 기대 문서와 검색 결과
- 이전 버전 대비 변화
- 알려진 제한사항

검토자는 평가 질문을 추가하거나 기준 미달 사유를 기록할 수 있다. 운영 사용자가 원문 전체를 볼 권한이 없다면 평가 결과에서도 문서 내용을 마스킹한다.

### P13 다운로드 이력

사용자에게는 본인의 다운로드와 Bundle 요청만 표시한다. AUDITOR는 권한 범위 내 전체 이력을 검색할 수 있다.

필드:

- 사용자, 조직, 자산/Bundle, 버전, 방식
- 요청·완료 시각
- 대상 사업장
- Client IP 또는 기기 정보의 최소 감사값
- 성공·실패·거부 이유

### P14 감사 로그

필터:

- 기간, 사용자, 조직, 자산, Trace ID, 행위, 결과
- Portal, Desktop, Runtime, Knowledge Search, MCP 출처

민감한 Prompt, 문서 본문, DB 결과는 목록에 표시하지 않는다. 원본 로그 접근은 별도 권한을 요구한다.

### P15 관리자 설정

하위 화면:

- 사용자·역할 매핑
- 조직·사업장
- Office Profile
- 허용 모델과 Endpoint Alias
- 자산 크기·확장자 정책
- 승인 Workflow
- 보안등급과 보관기간
- Package Trust/Signature 설정

실제 Secret 값은 화면에서 재표시하지 않는다. 저장 성공 여부와 마지막 갱신 정보만 표시한다.

### P16 수명주기/회수

행동:

- 신규 다운로드 중단
- 특정 버전 Suspended
- Deprecated와 대체 버전 설정
- Retired 처리
- 긴급 Revocation
- 영향받는 Service와 Bundle 조회

긴급 회수는 사유, 승인자, 효력 시각이 필수다.

### P17 AI Service 목록

표시:

- 서비스 이름, 업무 목적, 최신 승인 버전
- 사용 Agent, Knowledge, 주요 MCP Tool
- 폐쇄망/Frontier 지원 여부
- 대상 사업장과 사용자
- 품질·보안 검증 상태

행동:

- 상세 보기
- 내 환경용 Bundle 요청
- 새 Service 구성
- 기존 Service를 새 초안으로 복제
- Knowledge 챗봇 빠른 만들기
- 승인 Service를 내부 URL로 게시

### P18 Service Composer

자세한 기능은 [08-service-composer.md](./08-service-composer.md)를 따른다.

Wizard 단계:

1. 서비스 기본정보
2. 대상 환경과 모델 정책
3. Agent 선택
4. Knowledge 연결
5. MCP Tool과 권한 연결
6. Prompt 연결
7. 입력·출력 정의
8. 호환성·보안 검증
9. Preview 구성 테스트; 실제 등록 Knowledge, Mock MCP
10. 요약·Manifest 미리보기·초안 저장

화면에는 Canvas, 자유 연결선, 임의 코드 입력 기능을 제공하지 않는다.

### P19 Service 상세·검증

Tab:

- 서비스 개요
- 구성 자산
- 입력/출력
- 모델·환경 정책
- 권한과 Tool
- 검증 결과
- 버전과 변경이력
- 배포와 Bundle
- Hosted Deployment와 발급 URL

구성 자산은 이름뿐 아니라 고정된 버전 범위와 현재 해석된 버전을 함께 표시한다.

### P20 Knowledge 챗봇 빠른 만들기

전체 Composer의 단축 경로다. 사용자는 Knowledge Version, 이름, 환영문, 추천 질문, Model Alias, Citation 정책, 대상 사용자만 설정한다. 시스템은 승인된 표준 Knowledge Chat Agent와 Prompt Version을 자동 연결한다.

Knowledge 목록은 Preview 가능과 게시 가능 상태를 구분하고, 문서·청크 수, 품질, 보안등급, Version, 선택 불가 사유를 표시한다. 상세 단계와 검증은 [10-hosted-chatbot-publication.md](./10-hosted-chatbot-publication.md)를 따른다.

### P21 챗봇 Preview

- 선택한 실제 Test/Approved Knowledge Index로 질문 실행
- Streaming 답변과 Citation 표시
- CREATOR/REVIEWER용 검색 Chunk, 점수, Filter, Latency, Trace Debug Panel
- 대표 Test Case 저장·재실행
- 게시 Gate 통과 여부와 수정할 단계 안내

### P22 게시·Deployment

- Slug, 환경, 접근정책, 대상 조직·사업장·역할 설정
- Service/Knowledge 승인 상태, Preview, Test Suite, ACL, Runtime 호환성 검증
- 게시 Job 단계와 진행률 표시
- 성공 시 `/chat/{slug}` URL 복사·새 창 열기
- 활성 Version, Health, 최근 Smoke Test, Audit 확인
- Suspend, Resume, 새 Revision 게시, Rollback

사용자는 임의 Base URL을 입력할 수 없다. 환경별 Base URL은 플랫폼 설정이고 Slug만 검증하여 받는다.

### P23 Hosted Chatbot

- 사내 인증 또는 제한된 Demo Token 진입
- 이름, 설명, 환영문, 추천 질문, 지원 문의처
- 질문, Streaming 답변, 취소, 새 대화
- 문서·섹션·페이지 Citation과 권한 확인된 원문 열기
- Loading, No Evidence, Permission, Suspended, Not Found, Runtime Error 상태
- 선택적 피드백과 데이터 사용 안내

## 3. M02 Portal API & Asset Registry

### 3.1 핵심 도메인

- Asset
- AssetVersion
- AssetFile
- Dependency
- ReviewRequest/ReviewDecision
- ServiceDefinition/ServiceVersion
- ServiceDeployment/DeploymentRevision
- ChatSession/ChatRun Metadata
- DistributionRequest/BundleJob
- DownloadRecord
- Organization/Site/UserRole
- AuditEvent

정확한 필드는 [07-data-api-contracts.md](./07-data-api-contracts.md)를 따른다.

### 3.2 필수 API

| Method | Path | 기능 | 주요 권한 |
|---|---|---|---|
| GET | `/api/v1/assets` | 검색·필터·페이지 목록 | USER |
| POST | `/api/v1/assets` | 자산 초안 생성 | CREATOR |
| GET | `/api/v1/assets/{asset_id}` | 자산 상세 | 접근 가능 사용자 |
| PATCH | `/api/v1/assets/{asset_id}` | 초안 Metadata 수정 | 소유 CREATOR |
| GET | `/api/v1/assets/{asset_id}/versions` | 버전 목록 | 접근 가능 사용자 |
| POST | `/api/v1/assets/{asset_id}/versions` | 새 버전 초안 | 소유 CREATOR |
| GET | `/api/v1/asset-versions/{version_id}` | 버전·Manifest·의존성 | 접근 가능 사용자 |
| POST | `/api/v1/asset-versions/{version_id}/validate` | 자동검증 Job | CREATOR |
| POST | `/api/v1/asset-versions/{version_id}/submit` | 검토 요청 | CREATOR |
| GET | `/api/v1/reviews` | 검토 목록 | REVIEWER |
| POST | `/api/v1/reviews/{review_id}/decisions` | 승인·반려·수정요청 | 해당 REVIEWER |
| POST | `/api/v1/assets/{asset_id}/deprecate` | 지원 종료 설정 | RELEASE_MANAGER |
| POST | `/api/v1/asset-versions/{version_id}/suspend` | 버전 중단 | RELEASE_MANAGER |
| POST | `/api/v1/services` | Service Definition 초안 생성 | CREATOR |
| PATCH | `/api/v1/service-versions/{version_id}` | Service 구성 수정 | 소유 CREATOR |
| POST | `/api/v1/service-versions/{version_id}/resolve` | 의존성·호환성 해석 | CREATOR |
| POST | `/api/v1/service-versions/{version_id}/mock-test` | Mock 구성 테스트 Job | CREATOR |
| POST | `/api/v1/service-versions/{version_id}/preview-sessions` | 실제 Knowledge Preview Session | CREATOR/REVIEWER |
| POST | `/api/v1/service-versions/{version_id}/deployments` | Hosted Deployment 초안 | CREATOR |
| POST | `/api/v1/deployments/{deployment_id}/publish` | 게시 Job 시작 | RELEASE_MANAGER |
| POST | `/api/v1/deployments/{deployment_id}/suspend` | Hosted URL 중단 | RELEASE_MANAGER |
| POST | `/api/v1/deployments/{deployment_id}/rollback` | 이전 Revision 복구 | RELEASE_MANAGER |
| POST | `/api/v1/distributions` | 다운로드/Bundle 요청 | USER |
| GET | `/api/v1/jobs/{job_id}` | Job 상태 | 요청자/관리자 |
| GET | `/api/v1/downloads` | 다운로드 이력 | USER/AUDITOR |
| GET | `/api/v1/audit-events` | 감사 검색 | AUDITOR |

### 3.3 Registry 규칙

- `asset_id + version`은 유일하다.
- 승인 버전은 불변이다.
- 자산 삭제 대신 상태 전환을 사용한다.
- 승인되지 않은 버전은 일반 검색과 다운로드에 노출하지 않는다.
- 의존성은 `asset_id`, 허용 Version Range, 필수/선택, 용도를 가진다.
- 순환 의존성을 거부한다.
- Service Definition은 승인된 Asset Version을 해석할 수 있어야 한다.
- 최신 버전을 무조건 자동 선택하지 않는다. 승인 시점의 해석 결과를 Snapshot으로 저장한다.
- Asset File과 Object Path는 Registry Transaction과 일관성을 유지한다.

### 3.4 검색 규칙

- 권한 필터를 검색 조건보다 먼저 적용한다.
- 전체 텍스트 검색은 이름, 설명, 태그, 담당조직을 포함한다.
- 보안등급과 사업장 범위가 다른 자산의 존재를 Unauthorized 사용자에게 노출하지 않는다.
- 정렬은 안정적이어야 하며 같은 값이면 `asset_id`로 Tie-break한다.

### 3.5 수명주기

```text
DRAFT → VALIDATING → READY_FOR_REVIEW → IN_REVIEW
                                      ├→ CHANGES_REQUESTED → DRAFT
                                      ├→ REJECTED
                                      └→ APPROVED → DEPRECATED → RETIRED
                                                   └→ SUSPENDED
```

- `SUSPENDED`는 긴급 중단이며 신규 배포를 금지한다.
- 기존 설치본 실행 차단은 Online 정책 조회 가능 여부에 따라 달라지므로 Runtime Hook으로 분리한다.
- 폐쇄망에서는 최신 Revocation List를 Offline Bundle과 함께 배포한다.

## 4. M03 Distribution & Hosted Deployment

### 4.1 Storage Adapter

인터페이스:

```text
put(stream, metadata) -> stored_object
get(object_id, range?) -> stream
head(object_id) -> metadata
delete_unreferenced(object_id)
verify(object_id, expected_hash) -> result
```

PoC File System Adapter 요구사항:

- 사용자 입력 파일명을 실제 저장 경로로 사용하지 않는다.
- `object_id` 기반 디렉터리에 저장한다.
- Path Traversal을 차단한다.
- 원본 파일명은 Metadata로만 보존한다.
- 임시 Upload는 검증 성공 후 원자적으로 확정한다.

### 4.2 Offline Bundle 구성

```text
service-or-agent-bundle-1.0.0.zip
├─ bundle-manifest.yaml
├─ assets/
│  ├─ services/
│  ├─ agents/
│  ├─ knowledge/
│  ├─ prompts/
│  └─ mcp-config/
├─ profiles/
│  └─ office-profile.yaml
├─ policies/
│  └─ revocation-list.json
├─ checksums.sha256
├─ signature.json              # 운영 확장
└─ install-guide.md
```

Bundle Manifest는 다음을 포함한다.

- Bundle ID와 생성 시각
- 요청자와 대상 사업장
- 포함 자산 ID·버전·파일 Hash·크기
- Runtime·OS·모델 요구사항
- 설치 순서
- 선택/필수 의존성
- 금지 또는 중단된 버전 여부
- 전체 예상 설치 용량

### 4.3 의존성 해석

1. Root Asset 또는 Service Version을 입력받는다.
2. 승인 Snapshot을 읽는다.
3. 필수 의존성을 재귀적으로 순회한다.
4. 버전 Range와 대상 환경의 호환성을 검사한다.
5. 동일 자산이 여러 버전으로 요구되면 충돌을 반환한다.
6. Office Profile이 허용하지 않는 모델·MCP를 거부한다.
7. 결과를 정렬된 Install Plan으로 반환한다.

### 4.4 Bundle Job

단계:

```text
RESOLVING → COLLECTING → VERIFYING → PACKAGING → SIGNING → SUCCEEDED
```

실패 시 다음을 제공한다.

- 실패 단계
- 오류코드
- 영향을 받은 자산
- 재시도 가능 여부
- 정리된 임시파일 수

### 4.5 Import 검증

Desktop과 동일한 검증 Library 또는 Contract Fixture를 사용한다.

- ZIP 구조
- 압축 해제 예상 용량
- 중첩 압축 금지 정책
- Checksum 일치
- Signature/Trust 상태
- Manifest Schema
- Runtime/OS/모델 호환성
- Revocation List
- 파일 확장자와 실행 코드 정책
- 설치 대상 경로 여유 공간

### 4.6 Rollback

- 새 버전은 임시 디렉터리에 먼저 설치한다.
- 모든 검증이 성공하면 Active Pointer를 전환한다.
- 실패하면 임시 디렉터리를 정리한다.
- 이전 Active Version은 설정된 보관 개수만 유지한다.
- Knowledge Index가 사용 중이면 즉시 삭제하지 않고 참조가 끝난 후 정리한다.

### 4.7 Hosted Deployment Job

1. 승인된 Service Version과 Resolved Dependency Snapshot을 읽는다.
2. Preview/Test Suite, Knowledge ACL, Runtime/Model 호환성을 검증한다.
3. Deployment Revision에 Service Definition Hash와 모든 고정 Version을 저장한다.
4. Hosted Runtime이 Revision을 로드할 수 있게 배포 Artifact를 준비한다.
5. Health Check와 대표 질문 Smoke Test를 실행한다.
6. 성공한 Revision만 Active Pointer로 원자적으로 전환한다.
7. 실패하면 기존 Active Revision을 유지하고 Job 오류를 기록한다.
8. 게시 URL은 환경 Base URL과 Registry가 승인한 Slug로 계산한다.

Hosted Chat 실행과 답변 생성은 M05가 담당하며 M03은 실행하지 않는다.

## 5. Portal 인수 기준

- USER가 승인된 Service와 자산만 검색할 수 있다.
- CREATOR가 Package를 등록하고 자동검증 오류를 필드 단위로 확인할 수 있다.
- REVIEWER가 Manifest·권한·테스트 Diff를 보고 승인 또는 반려할 수 있다.
- 승인된 Service를 대상으로 Offline Bundle을 생성할 수 있다.
- Service Composer가 Agent·Knowledge·MCP·Prompt·모델 호환성 오류를 저장 전에 표시한다.
- 승인되지 않은 자산, 중단된 버전, 접근 권한 없는 자산은 다운로드할 수 없다.
- 주요 행위가 Audit Log에 Trace ID와 함께 기록된다.
- 등록 Knowledge로 Preview한 챗봇을 승인 후 내부 URL로 게시할 수 있다.
- 새 브라우저에서 게시 URL에 접속하여 Streaming 답변과 Citation을 확인할 수 있다.
