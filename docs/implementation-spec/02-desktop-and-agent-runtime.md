# Desktop Client와 Agent Runtime 상세 명세

대상 모듈: M04, M05  
목표: 인터넷이 없는 Windows PC에서도 승인된 AI Service와 Agent를 설치하고 Ollama·Local Knowledge·Office MCP를 사용해 실행한다.

## 1. 프로세스 구조

권장 구조:

```text
PySide6 Desktop Client
       │
       ├── Local Runtime Process 관리
       │       └── loopback API/SSE
       │
       ├── Local Asset Directory
       ├── OS Secure Storage
       └── Local Diagnostic Logs

Local Agent Runtime
       ├── Package Loader
       ├── Service/Workflow Executor
       ├── LLM Adapter
       ├── Knowledge Search Client
       ├── MCP Client
       ├── Prompt Renderer
       ├── Policy Guard
       └── Structured Logger
```

Desktop UI Process와 Runtime Process를 분리한다. Runtime Crash가 UI 전체를 종료시키지 않아야 하며 Desktop이 Runtime 상태를 감시하고 재시작할 수 있어야 한다.

PoC에서 Process 분리가 과도하면 동일 Python 패키지를 사용하되, UI 계층이 Runtime 내부 클래스를 직접 조작하지 않고 `RuntimeFacade` 인터페이스만 사용한다.

## 2. 로컬 디렉터리

```text
company-ai-client/
├─ app/
├─ runtime/
├─ assets/
│  ├─ services/<service_id>/<version>/
│  ├─ agents/<asset_id>/<version>/
│  ├─ knowledge/<asset_id>/<version>/
│  ├─ prompts/<asset_id>/<version>/
│  └─ mcp-config/<asset_id>/<version>/
├─ profiles/
│  └─ active-office-profile.yaml
├─ state/
│  ├─ installations.db
│  └─ active-versions.json
├─ logs/
├─ cache/
└─ quarantine/
```

- 사용자가 선택한 파일을 제외하고 다른 사용자 디렉터리를 탐색하지 않는다.
- Package는 검증이 끝나기 전 `quarantine`에 둔다.
- 설치 완료 후 Active Pointer를 전환한다.
- Secret은 Asset Directory와 Profile YAML에 평문 저장하지 않는다.

## 3. M04 Desktop 화면 목록

| ID | 화면 | 목적 |
|---|---|---|
| D00 | 시작/초기화 | Runtime과 로컬 상태 DB 초기화 |
| D01 | 최초 설정 Wizard | Office Profile·Ollama·MCP·자산 경로 설정 |
| D02 | 홈/서비스 목록 | 설치된 AI Service와 Agent 선택 |
| D03 | Service/Agent 상세 | 목적·입력·의존성·버전·권한 확인 |
| D04 | Package 가져오기 | Offline Bundle/Package 검증·설치 |
| D05 | 설치 사전점검 | 모델·공간·Runtime·Knowledge·MCP 검사 |
| D06 | 대화/실행 | 질문·파일 입력, 실행 단계, 답변 표시 |
| D07 | 실행 상세 | 단계·Knowledge 출처·MCP Tool·시간 확인 |
| D08 | 로컬 자산 관리 | 설치 자산·버전·크기·의존성 관리 |
| D09 | 연결 상태 | Ollama·Knowledge·MCP Health 확인 |
| D10 | 설정 | Office Profile·모델·경로·로그 정책 |
| D11 | 로그/진단 | 오류 검색과 진단 Bundle 생성 |
| D12 | 업데이트/복구 | 새 Package 설치·Active 전환·Rollback |
| D13 | 정보/보안 | Client·Runtime 버전, Trust 상태, 라이선스 |

## 4. 화면별 기능

### D00 시작/초기화

시작 순서:

1. 단일 실행 Instance 확인
2. 로컬 설정 읽기
3. 설치 상태 DB Migration
4. Active Office Profile 검증
5. Runtime Process 시작 또는 연결
6. Runtime Health 확인
7. 설치 자산 Manifest의 최소 무결성 검사
8. 성공하면 D02, 미설정이면 D01로 이동

장애:

- 설정 파일 손상: 백업 복구 또는 초기화 선택
- Runtime 시작 실패: 재시도, 로그 위치, 안전 모드 제공
- 자산 손상: 해당 자산만 격리하고 앱은 계속 실행

### D01 최초 설정 Wizard

단계:

1. 설치 경로와 여유 공간
2. Office Profile 가져오기 또는 선택
3. Ollama Endpoint 확인
4. 설치된 Chat/Embedding 모델 확인
5. Office MCP Server 연결 확인
6. 기본 로그·보관 정책 확인
7. 전체 진단 결과와 저장

필드:

- Client 표시명, 사업장 ID
- Ollama Base URL; 기본은 loopback만 허용
- 기본 Chat Model Alias
- 기본 Embedding Model Alias
- MCP Server Alias와 URL
- Asset Root Directory
- 최대 동시 Run 수

Secret 필드는 저장 후 값을 다시 표시하지 않는다.

### D02 홈/서비스 목록

표시:

- 설치된 AI Service를 우선 표시
- 단독 Agent는 별도 Section에 표시
- 이름, 설명, 버전, 지원 상태, 최근 실행
- 준비됨/설정 필요/의존성 누락/중단됨 상태
- 모델·Knowledge·MCP의 전체 준비 상태

행동:

- Service 실행
- 상세 보기
- Package 가져오기
- 상태 재검사
- 최근 실행 재개 또는 결과 보기

### D03 Service/Agent 상세

표시:

- 업무 목적과 사용 예
- 입력 필드와 허용 파일
- 선택된 Agent, Knowledge, MCP Tool, Prompt
- 모델 정책과 현재 해석된 모델
- 요구 Runtime과 Client 버전
- Tool별 읽기/변경 위험도; PoC는 읽기 전용만 허용
- 설치 용량과 자산 버전
- 검증·승인·Checksum 상태

행동:

- 실행 전 사전점검
- 실행
- 버전 전환
- 제거; 다른 Service가 참조하면 차단

### D04 Package 가져오기

단계:

1. 파일 선택 또는 OS Drop Event 수신; Drop 지원은 선택이며 버튼 선택이 필수 경로
2. 파일을 Quarantine으로 복사
3. 압축 구조·예상 해제 용량 검사
4. Bundle Manifest 읽기
5. Checksum과 Signature 검사
6. Revocation과 승인 상태 검사
7. 의존성·Runtime·OS·모델 호환성 검사
8. 설치 계획과 용량 표시
9. 사용자 확인
10. 임시 설치
11. Smoke Test
12. Active 전환

표시해야 할 오류:

- 손상 또는 변조
- 지원하지 않는 Schema Version
- 중단·폐기된 자산
- 디스크 공간 부족
- 요구 Runtime/Client 불일치
- 동일 버전 이미 설치
- 충돌하는 의존성 버전
- 허용되지 않은 실행 파일

### D05 설치 사전점검

검사 항목:

- Client/Runtime 버전
- OS와 Architecture
- Chat·Embedding 모델 설치 여부
- Ollama Health
- Knowledge Index 존재와 호환 Embedding 모델
- MCP Server와 필요한 Tool 존재
- 사용자 또는 Office Profile 권한
- 디스크 여유 공간
- Package Checksum/Revocation
- 필수 Prompt와 Profile

각 항목은 `통과`, `경고`, `실패`와 해결 방법을 제공한다. 실패 항목이 있으면 실행 버튼을 비활성화한다.

### D06 대화/실행

구성:

- 상단: Service 이름, 버전, 현재 모델, 연결 상태
- 본문: 대화 또는 단일 작업 Form
- 입력: Service Definition에 선언된 Text/File/Choice/Date/Number Field
- 실행 상태: 준비, 분석, 지식 검색, Tool 실행, 답변 생성
- 답변: 본문, 출처, Tool 결과 요약, 경고

행동:

- 실행
- 취소
- 실패 단계부터 허용된 재시도
- 동일 입력으로 다시 실행
- 결과 복사/Markdown 저장
- 상세 실행 보기

규칙:

- Service가 파일을 허용하지 않으면 파일 첨부 UI를 표시하지 않는다.
- 파일은 Service의 허용 확장자·크기·개수만 받는다.
- Tool 호출 전 사용자 확인이 필요한 경우 실행 중 명확한 확인 Panel을 표시한다.
- 답변 생성 중에도 취소가 가능해야 한다.
- Citation을 클릭하면 허용된 문서 제목·섹션·발췌를 표시한다.
- 원문 접근 권한이 없으면 발췌를 표시하지 않는다.

### D07 실행 상세

표시:

- Run ID와 Trace ID
- 시작·종료·총 소요시간
- 사용 Service/Agent/Knowledge/Prompt/모델 버전
- Workflow 단계와 각 상태·시간
- Query Rewrite 결과; 민감정보 정책 적용
- Knowledge 검색 결과 순위·Source·Citation
- MCP Tool 이름·상태·소요시간·결과 요약
- Retry와 Fallback 이력
- 최종 상태와 오류코드

일반 사용자와 진단 권한 사용자가 보는 상세 수준을 분리한다.

### D08 로컬 자산 관리

필터:

- Service, Agent, Knowledge, Prompt, MCP Config
- Active/Inactive/Invalid/Revoked
- 버전, 크기, 설치일

행동:

- 상세 Manifest 보기
- Checksum 재검사
- Smoke Test
- Active Version 전환
- 사용하지 않는 버전 제거
- 의존 관계 보기

제거 전 참조 중인 Service와 진행 중인 Run을 확인한다.

### D09 연결 상태

항목:

- Runtime Process
- Ollama Endpoint
- Chat Model
- Embedding Model
- 각 Knowledge Index
- 각 MCP Server
- 필요한 MCP Tool

각 연결은 마지막 성공 시각, 응답시간, 버전, 오류코드, 재검사 버튼을 제공한다.

### D10 설정

Section:

- Office Profile
- 모델 Alias
- MCP Server Alias
- Asset/Log/Cache 경로
- 최대 동시 실행
- 로그 Level과 보관기간
- Proxy; 폐쇄망에서는 기본 비활성
- 개인정보 표시·진단 Bundle 정책

정책으로 고정된 값은 읽기 전용으로 표시하고 출처 정책명을 보여준다.

### D11 로그/진단

필터:

- 기간, Level, Run ID, Trace ID, 모듈, 오류코드

진단 Bundle:

- Client/Runtime 버전
- OS와 Python 정보
- Sanitized 설정
- 설치 자산 ID·버전·Hash
- Health 결과
- 선택 기간의 Sanitized Log
- 실제 Prompt·문서·DB 결과·Secret은 제외

### D12 업데이트/복구

- 새로운 Offline Bundle 가져오기
- 현재와 새 버전 Diff
- 호환성 사전검사
- 새 버전 임시 설치와 Smoke Test
- Active Pointer 전환
- 이전 버전 Rollback
- 실패 설치 정리

자동 인터넷 업데이트는 PoC 범위가 아니다.

### D13 정보/보안

- Client, Runtime, Schema 지원 버전
- Trust Store 상태와 마지막 Revocation List 날짜
- 라이선스와 오픈소스 고지
- 진단 경로
- 데이터 저장 위치

## 5. M05 Agent Runtime

### 5.1 Public Interface

권장 Local API:

| Method | Path | 기능 |
|---|---|---|
| GET | `/local/v1/health` | Runtime 상태와 버전 |
| GET | `/local/v1/services` | 실행 가능한 Service 목록 |
| GET | `/local/v1/services/{id}` | Service 상세와 준비 상태 |
| POST | `/local/v1/preflight` | 실행 전 의존성 검사 |
| POST | `/local/v1/runs` | 새 Run 시작 |
| GET | `/local/v1/runs/{run_id}` | Run 상태와 결과 |
| GET | `/local/v1/runs/{run_id}/events` | SSE 진행 이벤트 |
| POST | `/local/v1/runs/{run_id}/cancel` | 실행 취소 |
| POST | `/local/v1/runs/{run_id}/retry` | 허용된 재시도 |
| GET | `/local/v1/runs/{run_id}/trace` | 권한별 실행 상세 |
| POST | `/local/v1/packages/inspect` | Package 검사 |
| POST | `/local/v1/packages/install` | 검증된 Package 설치 |

Loopback API는 외부 Interface에 Bind하지 않는다. Desktop이 발급한 단기 Session Token을 요구한다.

### 5.2 Runtime 구성요소

#### Package Loader

- Service/Agent Manifest Schema 검사
- 지원 Schema Version 검사
- Checksum, Trust, Revocation 검사 결과 확인
- Dependency Snapshot 로딩
- Entrypoint와 Workflow Definition 해석
- 승인되지 않은 임의 Python Module Import 금지

#### Service Resolver

- Service Definition의 Agent·Knowledge·MCP·Prompt·모델 참조 해석
- 설치된 Version과 승인 Snapshot 일치 확인
- Office Profile 정책 적용
- 선택 의존성의 Default와 사용자 선택 적용
- 최종 Resolved Service를 Run Snapshot으로 고정

#### Workflow Executor

표준 단계:

```text
INPUT_VALIDATE
→ PREPARE
→ ANALYZE
→ KNOWLEDGE_SEARCH (0..n)
→ TOOL_CONFIRM (optional)
→ MCP_TOOL_CALL (0..n)
→ ANSWER_GENERATE
→ OUTPUT_VALIDATE
→ COMPLETE
```

- Agent별 Workflow는 허용 단계의 조합으로 정의한다.
- 단계별 Timeout과 Retry 정책을 가진다.
- 취소 신호를 Cooperative하게 전달한다.
- 단계 결과를 Run Context에 저장한다.
- Run Context의 민감 필드는 로그에서 제거한다.

#### LLM Adapter

공통 Interface:

```text
chat(messages, model_alias, options, cancellation) -> response
embed(texts, model_alias, options) -> vectors
health(model_alias) -> model_status
```

- Provider 고유 응답을 공통 Usage/FinishReason/Error로 변환한다.
- 모델 Alias를 사용하고 Package에 실제 Secret이나 Endpoint를 넣지 않는다.
- 모델별 Tool Calling 차이를 Agent Domain에 노출하지 않도록 Adapter에서 Capability를 보고한다.
- Tool Calling이 약한 로컬 모델은 Runtime의 명시적 Workflow와 Schema 기반 호출을 사용한다.

#### Knowledge Search Client

- Retrieval Profile과 사용자 ACL Context 전달
- 검색 결과의 `document_id`, `chunk_id`, `citation`, `score`, `content` 수신
- Context Token Budget 적용 결과를 검증
- 검색 실패 시 Agent 정책에 따라 답변 중단 또는 Knowledge 없이 진행

#### MCP Client

- Office Profile에 등록된 Server Alias만 사용
- Tool Discovery 결과와 Manifest 요구 Tool 일치 확인
- Input Schema 검사
- User/Organization/Agent/Run Context 전달
- Timeout, Cancellation, Result Size 제한
- Tool 결과를 공통 Envelope로 변환

#### Prompt Renderer

- Prompt Package Version을 Run Snapshot에 기록
- 선언된 변수만 주입
- 필수 변수 누락 시 실행 전 실패
- Knowledge Context와 Tool Result에 신뢰 경계 Markup 적용
- Prompt Injection 방어 System Instruction 포함

#### Output Validator

- Service Output Schema 검사
- Citation 필수 정책 확인
- 근거 부족 시 `INSUFFICIENT_EVIDENCE` 상태 지원
- 민감정보 Masking 적용

### 5.3 Run 상태

```text
CREATED → PREFLIGHT → RUNNING → SUCCEEDED
                    ├→ WAITING_FOR_USER
                    ├→ CANCELLED
                    └→ FAILED
```

`WAITING_FOR_USER`는 Tool 확인 또는 추가 입력에 사용한다. 무한 대기를 방지하기 위해 만료시간을 가진다.

### 5.4 Run Event

```json
{
  "event_id": "uuid",
  "run_id": "uuid",
  "sequence": 12,
  "timestamp": "2026-08-02T12:00:00Z",
  "type": "STEP_STARTED",
  "step": "KNOWLEDGE_SEARCH",
  "message": "승인된 지식 자산을 검색하고 있습니다.",
  "progress": 0.45,
  "data": {}
}
```

- Event 순서는 `sequence`로 보장한다.
- Desktop 재연결 시 마지막 Sequence 이후 Event를 재조회할 수 있어야 한다.
- Event Data에 전체 Prompt와 Secret을 포함하지 않는다.

### 5.5 오류와 Fallback

| 오류 | 기본 동작 |
|---|---|
| Chat Model 없음 | Preflight 실패 |
| Embedding Model 불일치 | Knowledge 검색 차단 |
| Knowledge Index 손상 | 해당 Knowledge 격리, Run 실패 |
| Query Rewrite 실패 | 원본 질의로 1회 검색 |
| MCP 연결 실패 | 필수 Tool이면 실패, 선택 Tool이면 경고 후 정책에 따라 계속 |
| Tool 권한 부족 | 재시도하지 않고 사용자 안내 |
| LLM Timeout | 정책상 허용 시 1회 재시도 |
| Output Schema 불일치 | 1회 Repair 시도 후 실패 |
| 사용자 취소 | 하위 LLM/Search/MCP 취소 전파 |

### 5.6 Agent/Service Runtime 인수 기준

- 동일 Service Version은 동일한 Resolved Dependency Snapshot을 사용한다.
- Ollama가 없거나 요구 Knowledge가 누락되면 실행 전에 실패한다.
- Knowledge Citation이 필요한 Service는 Citation 없는 답변을 성공으로 반환하지 않는다.
- 허용되지 않은 MCP Server와 Tool을 호출할 수 없다.
- Tool 확인 정책이 있는 경우 사용자 승인 전 호출하지 않는다.
- Desktop에서 Run 진행, 취소, 오류, 결과, 출처를 확인할 수 있다.
- 각 단계와 외부 호출은 동일 Trace ID로 기록된다.

