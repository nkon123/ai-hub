# 품질, 통합, CI, 릴리스 상세 명세

대상 모듈: M12  
목표: 바이브코딩으로 생성된 코드를 “작성됨”이 아니라 “검증됨” 상태로 만들고 12개 모듈을 지속적으로 통합한다.

## 1. 품질 전략

테스트 계층:

```text
정적검사
  → 단위 테스트
  → Schema/Contract 테스트
  → 모듈 통합 테스트
  → Desktop/Portal E2E
  → Security Test
  → Offline 설치 Smoke Test
  → 사용자 인수 테스트
```

각 기능 PR은 가능한 가장 낮은 계층에서 실패를 잡아야 한다. 모든 검증을 E2E에 의존하지 않는다.

## 2. 저장소 공통 명령

저장소 초기화 시 실제 명령을 루트 Task Runner로 통일한다. 예시:

```text
make bootstrap
make lint
make typecheck
make test
make contract-test
make integration-test
make e2e-test
make security-test
make package-samples
make verify-all
```

Windows 개발자를 위해 동등한 PowerShell Script 또는 Python Task Runner를 제공한다. 문서와 CI는 같은 명령을 사용해야 한다.

## 3. Test Fixture

필수 Fixture:

- `hello-agent`: Knowledge와 MCP 없이 답변하는 최소 Agent
- `hr-policy-knowledge`: Markdown 규정, Parent-Child, Chroma/BM25
- `policy-search-service`: Agent+Knowledge+Prompt 조합
- `db-analysis-service`: Knowledge+Mock MCP 조합
- `mock-office-profile`: Ollama와 Mock MCP Alias
- `mock-mcp-server`: DB Metadata와 Table Count
- `invalid-packages`: 누락 Manifest, 잘못된 Hash, Path Traversal, Revoked Version
- `security-prompts`: Prompt Injection과 데이터 유출 시도

Fixture에 실제 회사 Secret, 개인정보, 운영 DB Schema를 포함하지 않는다.

## 4. 모듈별 필수 테스트

### M01 Portal UI

- 목록 Loading/Empty/Error/Permission
- 검색어·필터 URL 유지
- Asset Type별 상세 Section
- 등록 Wizard Validation과 Draft 보존
- 승인/반려 중복 제출 방지
- Service Composer 단계 이동과 오류 표시
- Keyboard Navigation과 Form Label
- API 실패 시 Trace ID 표시

### M02 Portal API

- Asset CRUD와 Version Uniqueness
- 승인 버전 불변성
- 수명주기 허용/금지 전환
- 권한별 검색 결과
- Dependency 순환·누락·충돌
- Service Definition Snapshot
- Pagination/Sort 안정성
- Audit Event 발행

### M03 Distribution

- Dependency 해석
- Bundle 구조와 Install Order
- Checksum 생성·검증
- 중단 자산 Bundle 거부
- 압축 폭탄·Path Traversal
- 부분 실패 정리
- Import→Install→Rollback

### M04 Desktop

- 최초 설정
- Runtime 시작 실패 복구
- Package Quarantine·Import
- Preflight 결과 표시
- Chat 실행·취소·재시도
- Tool 사용자 확인
- 자산 참조 중 제거 차단
- 진단 Bundle 민감정보 제외
- Windows Installer Smoke Test

### M05 Agent Runtime

- Service/Agent Manifest Loading
- Dependency Resolution
- Workflow 정상·분기·실패
- LLM/Search/MCP Adapter Mock
- Timeout·Cancel 전파
- Output Schema Repair/Failure
- Citation 필수 정책
- 허용되지 않은 Tool/Endpoint 차단
- Event Sequence와 재연결

### M06 Package Standards

- 모든 정상 Sample Schema 통과
- 필수 Field 누락
- 잘못된 SemVer
- Path Traversal
- Secret Pattern
- Profile 범위 오류
- Service Binding 누락/호환 불일치
- 이전 Schema Fixture 호환

### M07 Knowledge Indexing

- Loader Encoding과 Include/Exclude
- Recursive/Markdown/Parent-Child
- Stable ID
- Child→Parent 참조
- Embedding Batch/Retry/Cancel
- Chroma Record 대사
- BM25 Index 영속화
- 동일 입력 재현성
- 증분과 전체 Build 동등성; 확장 기능 구현 시

### M08 Knowledge Search

- Rewrite 성공/실패 Fallback
- Vector/BM25 단독
- Hybrid RRF 순위
- Metadata Filter
- ACL 강제
- Parent Expansion
- Deduplication
- Context Budget
- Citation
- Index/Embedding 불일치

### M09 Knowledge Evaluation

- Evaluation Dataset Schema
- Recall@K/MRR 계산
- Latency 측정
- 동일 Dataset 버전 확인
- Version 비교
- Regression Gate
- Package File/Record 대사
- Data Card 필수 Section

### M10 MCP

- Context 누락
- Permission 거부
- Tool Schema
- Table/Field Allowlist
- Prepared Parameter
- Timeout/Cancel
- Rate/Row/Byte Limit
- Masking
- Connector 장애
- Audit Event
- Kill Switch

### M11 Security

- RBAC Matrix
- 승인 Workflow
- Checksum/Signature Hook
- Revocation
- Secret 검사
- Prompt Injection
- Log Masking
- 감사 조회 권한
- 위협 시나리오 SEC-01~SEC-12

### M12 Integration

- API/Schema Contract Fixture
- Portal→Bundle
- Bundle→Desktop Import
- Desktop→Runtime
- Runtime→Knowledge Search
- Runtime→MCP
- End-to-End Trace ID
- Offline 재설치
- 실패 복구
- Demo Runbook

## 5. Contract Test

Contract 대상:

| ID | 제공 | 소비 | Contract |
|---|---|---|---|
| C01 | M02 | M01 | Portal OpenAPI |
| C02 | M02 | M03 | Asset/Version/Dependency API |
| C03 | M02/M11 | M01/M03 | Lifecycle와 RBAC |
| C04 | M03 | M04 | Offline Bundle Layout |
| C05 | M05 | M04 | Local Runtime API/Event |
| C06 | M06 | M05 | Agent Manifest |
| C07 | M08 | M05 | Knowledge Search Request/Response |
| C08 | M10 | M05 | MCP Tool Schema와 Error |
| C09 | M06 | M07 | Indexing Profile |
| C10 | M06 | M08 | Retrieval Profile |
| C11 | M07 | M08 | Knowledge Index Layout |
| C12 | M07 | M09 | Build Result/Statistics |
| C13 | M08 | M09 | Search Trace/Evaluation Input |
| C14 | M10/M11 | M05 | Auth/Audit Context |
| C15 | M01/M02/M06 | M05 | Service Definition |

원칙:

- 제공자가 Contract와 정상/오류 예제를 제공한다.
- 소비자가 예제를 자신의 테스트에 사용한다.
- Breaking Change는 Contract Version을 올린다.
- Contract PR을 구현 PR보다 먼저 병합한다.

## 6. CI 단계

### Pull Request

1. 변경 파일과 소유 모듈 확인
2. Secret Scan
3. Format/Lint
4. Type Check
5. 관련 Unit Test
6. Schema/Contract Test
7. 취약 의존성 검사 Hook
8. Sample Build
9. 변경 문서 확인

### Main Branch

- 전체 Unit/Contract Test
- 핵심 Integration Test
- Sample Package 생성·검증
- Portal API와 Web Build
- Runtime/Knowledge/MCP Package Build
- Test Report 보관

### Release Candidate

- 전체 E2E
- Security Test
- Knowledge Evaluation
- Windows Desktop Installer Smoke Test
- Offline Bundle Import Test
- License/Dependency Report
- Release Manifest와 Checksum

## 7. PR 규칙

PR 본문 필수 항목:

- 요구사항 ID
- 변경 목적
- 영향 모듈과 Contract
- AI가 생성한 범위
- 개발자가 직접 검토한 항목
- 테스트 명령과 결과
- 화면 변경 Screenshot; 해당 시
- 보안·데이터 영향
- Rollback 방법

금지:

- 테스트 없는 대규모 생성 코드
- 관련 없는 모듈 동시 수정
- 검토되지 않은 새 의존성
- 실제 Secret/업무 데이터 첨부
- Contract 문서와 다른 임시 Field

## 8. E2E 시나리오

### E2E-01 Knowledge Service 정상 흐름

1. HR Knowledge Package 등록
2. Policy Agent와 Prompt 등록
3. Service Composer에서 구성
4. Mock Test 통과
5. 검토·승인
6. Offline Bundle 생성
7. Desktop Import/Preflight
8. 질의 실행
9. 기대 문서 Citation 확인
10. Portal/Runtime/Search Audit 연결

### E2E-02 MCP 포함 Service

1. Mock Office MCP와 Metadata Tool 등록
2. Service에 선택 Tool 연결
3. Desktop 실행
4. 사용자 확인
5. Tool 호출 성공
6. 결과 요약과 Audit 확인

### E2E-03 Package 변조

1. 승인 Bundle 생성
2. 파일 한 Byte 수정
3. Desktop Import
4. Checksum 실패
5. Quarantine 유지
6. Audit와 사용자 메시지 확인

### E2E-04 의존성 누락

1. Knowledge 파일을 Bundle에서 제거
2. Import 검증 실패
3. 어떤 자산·파일이 누락됐는지 표시
4. 부분 설치 없음 확인

### E2E-05 권한 거부

1. HR 권한 없는 사용자로 Service 조회
2. 정책에 따라 목록에서 비노출 또는 접근 거부
3. 직접 URL/API 요청도 서버에서 거부
4. MCP Tool 호출도 거부

### E2E-06 Runtime 장애 복구

1. 실행 중 Runtime 강제 종료
2. Desktop이 장애 감지
3. 실패 Run과 Trace 표시
4. Runtime 재시작
5. 새 Run 정상 실행

### E2E-07 Knowledge Version 회귀

1. 1.0 평가 기준 저장
2. 1.1 후보 생성
3. 동일 Dataset 평가
4. Recall 기준 미달
5. 승인 차단과 비교 Report 확인

### E2E-08 Revocation

1. Service Version 승인·설치
2. Portal에서 Suspended/Revoked
3. 신규 Bundle 생성 차단
4. Online Policy Hook 또는 새 Offline Revocation List 적용 후 실행 차단

### E2E-09 등록 Knowledge 챗봇 URL 게시

1. Sample HR Knowledge 등록·인덱싱·승인
2. Knowledge 챗봇 빠른 만들기에서 해당 Version 선택
3. 표준 Agent·Prompt 자동 연결 확인
4. 실제 Knowledge Preview 질문 3개 실행
5. 기대 문서 검색과 Citation 확인
6. 게시 Gate 통과 후 Deployment Job 실행
7. `/chat/{slug}` URL 발급 확인
8. 새 브라우저에서 사내 Test Identity로 접속
9. 질문·SSE 답변·Citation 확인
10. Portal→Deployment→Run→Search Trace와 Audit 확인

### E2E-10 Hosted Chat 게시 실패와 Rollback

1. 정상 Revision 1을 Active로 게시
2. 호환되지 않는 Knowledge를 참조한 Revision 2 게시 시도
3. 검증 또는 Smoke Test 실패 확인
4. 기존 URL이 Revision 1로 계속 응답하는지 확인
5. 정상 Revision 2 게시 후 Revision 1로 Rollback
6. Active Pointer와 Audit 확인

## 9. 사용자 인수 테스트

대상 Persona:

- 일반 비개발자 사용자
- 자산 제작자
- 기술 검토자
- 보안 검토자
- 폐쇄망 PC 운영자

평가:

- 설명 없이 Service를 찾고 실행할 수 있는가
- Package Import 오류를 스스로 이해할 수 있는가
- Citation을 보고 근거를 확인할 수 있는가
- Service Composer에서 구성 누락을 이해하고 수정할 수 있는가
- 등록 Knowledge로 챗봇을 만들고 Preview 후 URL로 게시할 수 있는가
- URL로 접속한 사용자가 Citation을 확인할 수 있는가
- 검토자가 변경·권한·평가 결과를 판단할 수 있는가
- 운영자가 진단 Bundle로 문제를 전달할 수 있는가

## 10. 릴리스 Artifact

- Portal Web/API Image 또는 설치 Package
- DB Migration
- Desktop Installer
- Local Runtime Package
- Knowledge Indexing/Search Package
- Office MCP Server Package
- Schema/SDK Package
- Sample Assets
- Offline Bundle Sample
- Checksums
- Release Notes
- 설치/운영/복구 가이드
- Test/Evaluation/Security Report
- Open Source Notice

## 11. 버전 정책

- Package와 Schema는 SemVer
- Breaking API/Schema 변경은 Major
- 호환 기능 추가는 Minor
- 버그와 문서 수정은 Patch
- Release Candidate는 명시적 Pre-release 허용
- 승인된 Asset Version은 재빌드하여 덮어쓰지 않음
- 동일 Version의 Binary Hash가 달라지면 공급망 오류로 처리

## 12. 완료 기준 Dashboard

각 모듈에 대해 다음 상태를 추적한다.

- Contract: Draft/Approved
- Unit Test: Pass/Fail
- Contract Test: Pass/Fail
- Integration Test: Pass/Fail
- Security Review: Not Required/Pending/Pass/Fail
- Documentation: Draft/Complete
- Blocker
- Demo Ready

완료율은 코드 파일 수가 아니라 요구사항과 테스트 상태로 계산한다.

## 13. 인수 보고서

최종 보고서 Section:

1. 목표와 범위
2. 구현된 모듈·화면·API
3. 제외 기능
4. 실행 환경과 설치 절차
5. E2E 결과
6. Knowledge 품질 결과
7. 성능 결과
8. 보안 테스트 결과
9. 사용자 평가
10. 알려진 제한과 위험
11. 운영 전 추가 결정
12. Go/Conditional Go/No-Go
