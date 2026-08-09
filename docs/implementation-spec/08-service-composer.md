# AI Service Composer 상세 명세

목표: 비개발자가 자유형 Drag & Drop Canvas나 Python 코드 없이, 포털에 승인된 자산을 단계적으로 선택해 실행 가능한 AI Service를 구성한다.

관련 모듈:

- M01: Composer 화면
- M02: Service Definition 저장·버전·검증 API
- M03: Service Package, Offline Bundle, Hosted Deployment
- M05: Service Definition 해석과 Local/Hosted 실행
- M06: Service Schema와 호환성 규칙
- M11: 권한·보안·승인
- M12: Mock Test와 E2E

## 1. 설계 원칙

1. 자유형 Canvas를 제공하지 않는다.
2. 승인된 자산만 선택할 수 있다.
3. 사용자가 임의 코드·URL·Package·Secret을 입력할 수 없다.
4. Agent Template이 요구하는 역할을 기반으로 필요한 입력을 안내한다.
5. 모든 선택은 Version과 대상 환경까지 명시한다.
6. 구성 오류는 저장 후가 아니라 선택 즉시 표시한다.
7. Portal에서 실제 운영 DB Tool을 실행하지 않는다.
8. Portal Preview는 등록된 Test/Approved Knowledge와 별도 Test Model Binding을 사용하며, MCP는 Mock 또는 승인된 Test Environment만 사용한다.
9. 승인된 Service Version은 불변이다.
10. Offline Bundle은 Service의 모든 필수 의존성을 포함한다.

## 2. Service 구성 방식

```text
서비스 기본정보
  + Agent Template
  + Knowledge Binding 0..n
  + MCP Tool Binding 0..n
  + Prompt Binding 1..n
  + Model/Execution Policy
  + Input Schema
  + Output Schema
  + Security/Limit Policy
= AI Service Definition
```

예:

```text
Nexacro 소스 분석 서비스
  = Nexacro 분석 Agent
  + Nexacro 공식문서 Knowledge
  + DB Metadata MCP Tool
  + 소스 분석 Prompt
  + 폐쇄망 Ollama 모델 정책
```

## 3. 진입 방식

- 새 Service 만들기
- 승인된 Agent 상세에서 `서비스로 구성`
- 기존 Service를 새 초안으로 복제
- 관리자가 제공한 Service Template에서 시작

Template은 초기값만 제공하며 기존 승인 버전을 수정하지 않는다.

## 4. Wizard 전체 구조

| 단계 | 화면명 | 결과 |
|---:|---|---|
| 1 | 기본정보 | 이름·목적·소유자·대상 사용자 |
| 2 | 실행환경 | 폐쇄망/Frontier·사업장·모델 정책 |
| 3 | Agent 선택 | Agent Version과 Capability |
| 4 | Knowledge 연결 | Agent Role별 Knowledge Binding |
| 5 | MCP Tool 연결 | Tool·권한·확인 정책 |
| 6 | Prompt 연결 | Prompt Role과 Version |
| 7 | 입력 정의 | 사용자 Form·파일 규칙 |
| 8 | 출력 정의 | 답변 형식·Citation·내보내기 |
| 9 | 제한·보안 | Timeout·호출수·데이터·대상 범위 |
| 10 | 구성 검증 | Dependency·Schema·Policy 결과 |
| 11 | Preview 테스트 | 실제 등록 Knowledge와 Mock MCP 실행 결과 |
| 12 | 요약·저장 | Manifest 미리보기·초안·검토 요청 |

단계 상단에는 현재 위치와 오류 수를 표시한다. 완료된 단계로 이동할 수 있지만 필수 선행정보가 바뀌면 이후 단계의 영향을 표시하고 재검증한다.

## 5. 단계별 상세

### 단계 1: 기본정보

필드:

- 서비스 표시명
- Service Slug
- 한 줄 설명
- 상세 목적
- 업무 카테고리
- 태그
- 소유 조직
- 주 담당자
- 지원 문의처
- 대상 사용자 역할
- 대상 사업장
- 보안등급

검증:

- Slug 유일성과 형식
- 이름 중복 경고
- 담당자와 조직 관계
- 대상 사업장이 보안등급을 허용하는지

도움말:

- “이 서비스로 사용자가 어떤 일을 완료하는가?”를 작성하도록 안내
- 기술 용어보다 업무 결과 중심 설명 권장

### 단계 2: 실행환경과 모델 정책

선택:

- 실행 Mode: Offline Local, Internal Server, Frontier Allowed
- 대상 Office Profile 1개 이상
- Chat Model Alias
- Embedding Model Alias; Knowledge 사용 시
- 모델 Fallback 허용 여부
- 외부 Network 사용 여부; 정책으로 고정 가능

표시:

- Office Profile별 실제 Model Identity
- 대상 환경의 Runtime/OS
- 모델 Capability: Chat, Structured Output, Context Limit
- 환경별 차이와 호환성 경고

규칙:

- Package에 실제 Endpoint와 Secret을 저장하지 않는다.
- Alias만 선택한다.
- 폐쇄망 대상에 외부 Provider Alias를 선택할 수 없다.

### 단계 3: Agent 선택

검색 필터:

- 승인됨
- 대상 환경 지원
- 업무 카테고리
- 필요한 Capability
- Runtime 호환

선택 후 표시:

- Agent 설명과 Version
- 입력·출력 Schema
- Knowledge Binding Role
- MCP Tool Binding Role
- Prompt Binding Role
- 필요한 Permission
- 최대 Step/Tool Call
- 테스트 결과와 알려진 제한

한 Service에는 PoC 기준 주 Agent 1개만 허용한다. 다중 Agent 조합은 확장 범위다.

Agent를 변경하면 기존 Knowledge/MCP/Prompt Binding을 재검증하고 호환되지 않는 연결을 제거하기 전에 사용자 확인을 받는다.

### 단계 4: Knowledge 연결

Agent가 선언한 Role별로 Section을 만든다.

예:

```text
Role: framework_manual (필수)
Role: company_source_guide (선택)
```

각 Binding 필드:

- Knowledge Asset/Version
- Retrieval Profile
- Required 여부; Agent 요구보다 완화 불가
- 기본 Metadata Filter
- 최대 Context Token
- Citation 표시명

선택 목록 정보:

- Knowledge 설명·Source 기준일
- 문서 수·청크 수
- Embedding Identity
- 지원 사업장
- 보안등급·ACL
- Recall@5와 P95 검색시간
- 승인·지원 상태

검증:

- Agent Role과 Capability
- Office Profile Embedding Alias
- Runtime Version
- 대상 사용자와 Knowledge ACL
- 서비스 보안등급이 Knowledge보다 낮지 않음
- 중단/폐기 Version 금지

### 단계 5: MCP Tool 연결

각 Binding 필드:

- Agent Tool Role
- MCP Server Alias
- Tool Name/Version
- 필수/선택
- 사용자 확인 정책
- 호출당 Timeout
- Run당 최대 호출 횟수
- 허용 Parameter 범위; Policy가 허용하는 경우

표시:

- Tool 설명
- Risk Level
- Input/Output Schema
- 필요 Permission
- 제공 사업장
- Data Classification
- 결과 제한

규칙:

- PoC는 READ_ONLY Tool만 선택 가능
- 대상 Office Profile에 없는 Server Alias 금지
- Service 대상 사용자에게 Permission이 없는 Tool은 금지
- Tool Parameter Default에 Secret 금지
- 임의 MCP URL 입력 금지

### 단계 6: Prompt 연결

Role 예:

- System
- Query Rewrite
- Analysis
- Tool Result Summary
- Final Answer

필드:

- Prompt Asset/Version
- Agent Role Mapping
- 허용된 Service-level 변수값

표시:

- 변수 Schema
- 지원 Model Capability
- Output Schema
- 안전 정책
- 테스트 결과

Prompt 본문을 편집하지 않는다. 수정이 필요하면 Prompt 자산의 새 Version을 만든다.

### 단계 7: 입력 정의

지원 Field:

- Text
- Multiline Text
- Number
- Boolean
- Single Choice
- Multi Choice
- Date
- File; Agent와 Policy가 허용할 때만

Field 속성:

- Key
- 사용자 Label
- 도움말
- Required
- Default; 비민감 값만
- Min/Max Length 또는 Value
- 정규식; 관리자 승인 Pattern만
- Choice 목록
- 파일 확장자·개수·크기
- Agent Input Mapping

검증:

- Key 유일성
- Agent Input Schema와 Type 일치
- 필수 Agent Input 누락 금지
- 파일 규칙이 Agent Capability와 Office Policy 이내
- Secret 또는 Credential 입력 Field 금지

### 단계 8: 출력 정의

설정:

- 사용자 표시 Section
- Markdown 허용
- Citation 필수
- Tool 결과 요약 표시
- Raw Tool Result 표시 금지/허용; 기본 금지
- JSON Download; Output Schema가 허용할 때
- Markdown Export
- 답변 최대 길이
- 근거 부족 메시지

Output Schema는 Agent Output Schema보다 느슨해질 수 없다.

### 단계 9: 제한·보안

설정 가능한 범위:

- 전체 실행 Timeout
- 최대 Knowledge 검색 횟수
- 최대 MCP Tool 호출 수
- 최대 Context Token
- 최대 첨부파일 크기
- 사용자 확인 정책
- 로그 Level
- 답변 보관 여부

정책으로 고정되는 항목:

- 외부 Network
- 허용 Tool Risk
- Package 서명 요구
- 보안등급
- Audit 필수 여부
- Secret 처리

사용자가 조직 정책보다 완화할 수 없다.

### 단계 10: 구성 검증

검증 Group:

1. Schema
2. Version/Dependency
3. Runtime/Model
4. Knowledge
5. MCP/Permission
6. Prompt/Input/Output
7. Security/Policy
8. Offline Bundle 가능성

결과 형식:

```text
통과: 24
경고: 2
실패: 1
```

오류는 해당 단계와 필드로 이동할 수 있어야 한다.

경고 예:

- 선택 Knowledge의 P95 검색시간이 목표 초과
- Optional MCP Tool이 일부 사업장에서 없음
- Frontier와 Offline 환경의 모델 Output Capability 차이

실패 예:

- 필수 Knowledge 누락
- 대상 사용자에게 Tool Permission 없음
- Embedding Identity 불일치
- 승인되지 않은 Prompt

### 단계 11: Preview 테스트

테스트 입력:

- Service Test Case 선택
- 사용자가 입력한 비민감 Test Value
- Mock User Role/Site

실행:

- 실제 Service Definition Resolver 사용
- 등록된 Test/Approved Knowledge Index 사용
- Mock MCP Server 사용
- Test Model 또는 허용된 Test Environment 사용
- 운영 Secret과 운영 DB 사용 금지

결과:

- 단계별 상태
- Resolved Dependency Snapshot
- Knowledge 검색 결과와 Citation
- Mock Tool 호출과 Parameter
- 최종 Output Schema
- 오류·경고
- 총 실행시간

Knowledge 검색 결과에는 실제 Chunk ID, 문서 위치와 Citation을 표시한다. MCP가 없는 Knowledge 챗봇은 실제 게시 Runtime Core와 동일한 경로로 Preview한다. 테스트 성공이 품질과 보안 승인을 대체하지 않는다.

### 단계 12: 요약·저장

표시:

- 기본정보
- 대상 환경
- Agent
- Knowledge
- MCP Tool
- Prompt
- 입력·출력
- 제한·권한
- 검증 결과
- Mock Test 결과
- 자동 생성 Service Definition YAML Preview

행동:

- 초안 저장
- 새 버전 초안 저장
- JSON/YAML Preview Download
- 검토 요청
- 승인 후 Hosted URL 게시 화면으로 이동

YAML Preview는 읽기 전용이다. 고급 사용자가 임의 수정한 파일을 다시 Upload하는 기능은 PoC에 포함하지 않는다.

## 6. Service Composer API

| Method | Path | 기능 |
|---|---|---|
| POST | `/api/v1/services` | Service 초안 생성 |
| GET | `/api/v1/services` | Service 검색 |
| GET | `/api/v1/services/{service_id}` | Service 상세 |
| POST | `/api/v1/services/{service_id}/versions` | 새 Version 초안 |
| GET | `/api/v1/service-versions/{version_id}` | Definition 조회 |
| PATCH | `/api/v1/service-versions/{version_id}` | 단계별 Draft 저장 |
| POST | `/api/v1/service-versions/{version_id}/resolve` | 의존성 해석 |
| POST | `/api/v1/service-versions/{version_id}/validate` | 전체 구성 검증 |
| POST | `/api/v1/service-versions/{version_id}/mock-tests` | Mock Test Job |
| GET | `/api/v1/service-versions/{version_id}/mock-tests` | Test 이력 |
| POST | `/api/v1/service-versions/{version_id}/preview-sessions` | 실제 Knowledge Preview Session |
| POST | `/api/v1/service-versions/{version_id}/submit` | 검토 요청 |
| POST | `/api/v1/service-versions/{version_id}/clone` | 새 초안 복제 |

PATCH는 부분 Draft 저장을 지원하되 서버는 전체 Definition을 다시 검증한다. 불완전 Draft는 저장할 수 있지만 검토 요청은 할 수 없다.

## 7. Draft 자동 저장

- 사용자가 Field를 변경한 후 짧은 Debounce로 저장
- 현재 Revision/ETag 사용
- 저장 중·저장됨·충돌 상태 표시
- 다른 Session 변경 시 자동 덮어쓰기 금지
- 충돌 시 현재/서버 변경을 비교하고 선택
- 민감 값을 Local Storage에 저장하지 않음

## 8. Version과 Diff

새 Service Version 검토 화면은 다음 Diff를 강조한다.

- Agent Version 변경
- Knowledge 추가·삭제·Version 변경
- Retrieval Profile 변경
- MCP Tool 추가·권한 증가·확인 정책 완화
- Prompt 변경
- 대상 사용자·사업장 확대
- 모델 정책 변경
- 입력 File 허용 확대
- Timeout/호출수 증가

고위험 Diff는 Security Review 필수로 자동 분류한다.

## 9. Service Template

Template 예:

- 문서 검색 서비스
- 문서 검색+읽기 전용 Tool 서비스
- 소스 분석 서비스
- 정형 보고서 생성 서비스

Template 구성:

- 기본 Agent Type
- 필요한 Binding Role
- 기본 Input/Output Schema
- 기본 제한 정책
- 필요한 Review 수준

Template은 승인 자산을 자동으로 고정하지 않고 사용자가 최신 승인 Version을 확인하도록 한다.

## 10. 접근성·사용성

- 단계 이동은 Keyboard로 가능
- Error Summary에서 문제 Field로 이동
- 기술 용어 옆에 업무 설명 제공
- `Knowledge`, `Tool`, `Agent`의 차이를 첫 사용 시 설명
- 선택 목록에는 이름뿐 아니라 목적·권한·지원환경 표시
- 호환되지 않는 선택지는 숨기기보다 비활성화하고 이유 표시
- 사용자가 잃을 변경이 있으면 명확히 확인
- 12단계를 한 화면에 모두 펼치지 않음

## 11. Service Composer 인수 기준

- 비개발자가 Canvas 없이 단계형 Form으로 Service를 만들 수 있다.
- Agent가 요구하는 모든 Knowledge/MCP/Prompt Role을 안내한다.
- 승인되지 않은 자산은 선택할 수 없다.
- 대상 Office Profile에서 실행 불가능한 조합을 차단한다.
- Knowledge ACL과 MCP Permission을 대상 사용자와 비교한다.
- Mock Test가 실제 Service Definition Resolver를 사용한다.
- 생성된 Service Package를 Offline Bundle에 포함하고 Desktop이 실행할 수 있다.
- Knowledge 챗봇 Quick Create가 표준 Agent/Prompt를 자동 연결한다.
- Preview가 실제 등록 Knowledge의 검색 결과와 Citation을 표시한다.
- 승인된 Service Version을 Hosted Deployment로 게시하고 내부 URL을 발급할 수 있다.
- 승인 Version 변경은 새 Version으로만 가능하다.
- Service Definition에는 임의 코드·URL·Secret이 포함되지 않는다.

## 12. Service Composer 요구사항 ID

| ID | 요구사항 | 검증 기준 |
|---|---|---|
| SVC-001 | 새 Service 초안을 생성한다. | 기본정보 저장 후 Draft ID가 생성됨 |
| SVC-002 | 기존 Service Version을 복제한다. | 원본 불변, 새 Draft 생성 |
| SVC-003 | 단계별 자동 저장을 제공한다. | Revision 충돌 없이 재진입 가능 |
| SVC-004 | 대상 사업장과 실행 Mode를 선택한다. | Office Profile 정책으로 검증 |
| SVC-005 | 승인된 Agent Version만 선택한다. | 비승인 Version 선택 불가 |
| SVC-006 | Agent의 필수 Knowledge Role을 표시한다. | 누락 시 검토 요청 차단 |
| SVC-007 | Knowledge와 Retrieval Profile을 연결한다. | Embedding/Runtime/ACL 호환성 통과 |
| SVC-008 | Agent의 필수 MCP Tool Role을 표시한다. | 누락 또는 Tool 없음 오류 |
| SVC-009 | Tool Server Alias·Version·권한을 연결한다. | 대상 사업장과 Permission 검증 |
| SVC-010 | READ_ONLY 이외 Tool을 PoC에서 차단한다. | 위험 Tool 선택 불가 |
| SVC-011 | Prompt Role별 승인 Version을 연결한다. | 변수·Model·Output 호환성 검사 |
| SVC-012 | Model Alias를 선택한다. | 실제 Endpoint/Secret 저장 없음 |
| SVC-013 | 사용자 입력 Form을 구성한다. | Agent Input Schema와 일치 |
| SVC-014 | 파일 입력 규칙을 제한한다. | 확장자·개수·크기 정책 적용 |
| SVC-015 | 출력과 Citation 정책을 구성한다. | Agent Output보다 느슨하지 않음 |
| SVC-016 | Timeout·Tool Call·Context 제한을 설정한다. | Office Policy 상한 적용 |
| SVC-017 | 전체 Dependency를 해석한다. | 고정된 Resolved Snapshot 생성 |
| SVC-018 | 구성 오류를 단계·필드별 표시한다. | Error에서 문제 Field 이동 가능 |
| SVC-019 | 실제 Test/Approved Knowledge와 Mock MCP로 Preview한다. | 운영 Tool 미사용, Knowledge Citation 확인 |
| SVC-020 | 단계별 Preview 실행 결과를 표시한다. | Search·Citation·Tool·Output 결과 확인 |
| SVC-021 | Service Definition YAML을 미리본다. | Schema와 저장 내용 일치 |
| SVC-022 | 검토 요청을 제출한다. | 검증·Mock Test 필수조건 통과 |
| SVC-023 | Version Diff를 표시한다. | Agent·Knowledge·Tool·Prompt·권한 Diff |
| SVC-024 | 고위험 변경을 보안 검토로 분류한다. | 권한 증가·Tool 추가 등 자동 감지 |
| SVC-025 | 승인 Service Package를 만든다. | Definition·Schema·Test·Checksum 포함 |
| SVC-026 | Offline Bundle에 전체 의존성을 포함한다. | Desktop Preflight 통과 |
| SVC-027 | 승인 Version을 수정하지 않는다. | 변경 요청 시 새 Version 생성 |
| SVC-028 | 임의 코드·URL·Secret 입력을 금지한다. | Client/Server 이중 검증 |
| SVC-029 | 권한 없는 자산의 존재를 노출하지 않는다. | 검색·직접 API 모두 차단 |
| SVC-030 | Service 실행이 전체 Trace ID로 연결된다. | Portal→Desktop→Search/MCP 감사 연결 |

Knowledge 챗봇 Quick Create, Hosted Preview와 URL 게시의 추가 요구사항은 [10-hosted-chatbot-publication.md](./10-hosted-chatbot-publication.md)의 `HOST-*`를 따른다.
