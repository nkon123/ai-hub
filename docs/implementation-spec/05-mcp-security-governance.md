# Office MCP, 보안, 거버넌스 상세 명세

대상 모듈: M10, M11  
PoC 보안 경계: 읽기 전용 Tool, 승인된 Server Alias, 최소 권한, 모든 호출 감사

## 1. M10 Office MCP Server

### 1.1 책임

- 사업장 내 승인된 업무 Tool 제공
- Tool Discovery와 Version 정보
- 사용자·조직·Agent·Run Context 수신
- Tool별 입력·출력 Schema 검증
- Tool·데이터 범위 권한 확인
- Connector를 통한 사내 시스템 접근
- Timeout, Rate, Result Size, Cancellation 통제
- 민감 출력 Masking
- Audit Event 발행
- Health, Version, Kill Switch

MCP Server는 Agent의 판단을 대신하지 않는다. Agent는 DB Credential을 알지 못하며 MCP Server는 사용자 권한을 우회하는 공용 관리자 Gateway가 되어서는 안 된다.

## 2. MCP 구성요소

```text
MCP Transport
  → Request Context Middleware
  → Authentication Adapter
  → Authorization Policy
  → Tool Registry
  → Input Validator
  → Execution Guard
  → Tool Handler
  → System Connector
  → Output Filter
  → Audit Logger
```

각 계층은 테스트 가능한 인터페이스로 분리한다.

## 3. Request Context

필수 Context:

```json
{
  "request_id": "uuid",
  "trace_id": "uuid",
  "run_id": "uuid",
  "service_id": "service-uuid",
  "service_version": "1.0.0",
  "agent_id": "agent-uuid",
  "agent_version": "1.0.0",
  "user": {
    "id": "user-uuid",
    "organization_id": "org-uuid",
    "site_id": "site-a",
    "roles": ["USER"]
  },
  "requested_tool": "db_metadata.get_columns"
}
```

- Context는 신뢰할 수 있는 Runtime/Authentication 계층에서 생성한다.
- Agent Prompt가 사용자 ID나 Role을 임의로 만들 수 없다.
- Context 누락 또는 서명/세션 검증 실패 시 요청을 거부한다.

## 4. Tool Registry

Tool Metadata:

- Tool Name과 Version
- 설명
- Input/Output Schema
- 위험도
- 필요 Permission
- 허용 조직·사업장
- Timeout
- 최대 결과 Byte/Row 수
- Rate Limit
- 사용자 확인 정책
- 데이터 분류
- 담당자
- 활성/중단 상태

Tool Version은 실행 로그에 기록한다. 동일 Tool Name의 호환되지 않는 변경은 Major Version을 올린다.

## 5. PoC Tool 정의

### 5.1 `db_metadata.get_tables`

목적: 허용 Schema의 Table 목록 조회

입력:

```json
{
  "schema": "APP",
  "name_contains": "INTERFACE",
  "limit": 50
}
```

검증:

- Schema Allowlist
- `limit` 1~100
- 검색 문자열 최대 길이
- Wildcard를 Server가 안전하게 생성

출력:

```json
{
  "items": [
    {
      "schema": "APP",
      "table": "INTERFACE_LOG",
      "comment": "인터페이스 처리 이력"
    }
  ],
  "truncated": false
}
```

### 5.2 `db_metadata.get_columns`

입력:

```json
{
  "schema": "APP",
  "table": "INTERFACE_LOG"
}
```

출력:

- Column 이름
- 데이터 유형
- Nullable
- PK 여부
- 안전한 Comment

Default Value가 Secret 또는 업무상 민감할 수 있으면 반환하지 않는다.

### 5.3 `table_count.query`

입력:

```json
{
  "schema": "APP",
  "table": "INTERFACE_LOG",
  "filters": [
    {
      "field": "STATUS",
      "operator": "eq",
      "value": "ERROR"
    }
  ]
}
```

규칙:

- Schema/Table/Field/Operator Allowlist
- Identifier는 Parameter Binding 대상이 아니므로 Allowlist에서 안전하게 Quote
- Value만 Prepared Parameter 사용
- 임의 SQL 문자열을 입력받지 않음
- Filter 개수와 Query Timeout 제한
- 결과는 Count만 반환

### 5.4 `calculator.add` 데모 Tool

Desktop에서 Hub 자산 설치 → 계약 등록 → 실제 Tool 호출까지 확인하기 위한
순수 함수형 샘플이다. 입력은 유한한 숫자 `a`, `b` 두 개로 닫혀 있고 결과는
`result` 숫자 하나만 반환한다. 파일·DB·네트워크·프로세스를 변경하지 않으며
`risk_level=READ_ONLY`, 사용자 확인 정책은 `NEVER`다. Hub Bundle에는 실행
코드나 명령줄을 넣지 않고 Manifest 계약만 포함한다. 실제 구현은 검토된
Office MCP Server 내장 핸들러에만 존재하므로, Bundle 설치가 임의 코드 실행
권한으로 확장되지 않는다.

## 6. System Connector

Oracle Connector 요구사항:

- 읽기 전용 계정
- 최소 Schema 권한
- Connection Pool
- Connection과 Query Timeout
- Transaction은 Read-only
- 요청 단위 Session Tag 또는 Audit Context
- Password는 Secure Store에서 읽기
- 오류에 Connection String과 SQL 원문 노출 금지
- Health Check는 최소 Query만 실행

Connector Interface:

```text
health() -> ConnectorStatus
execute_named_query(query_id, parameters, context) -> rows
close() -> void
```

Tool Handler가 임의 SQL을 Connector에 넘기지 않는다. 승인된 Named Query 또는 Query Builder만 사용한다.

## 7. 인증과 권한

PoC Adapter:

- Mock Enterprise Identity Adapter
- Office Profile의 허용 사용자/조직 정책

운영 Adapter:

- 사내 인증 Gateway 또는 전달된 검증 Token
- 사용자 ID·조직·사업장 Claim

권한 판정 입력:

- User Roles/Permissions
- Site
- Service/Agent ID와 Version
- Tool Name/Version
- Tool Risk
- 요청 데이터 범위
- 시간 또는 운영 정책

권한 거부는 재시도하지 않는다. 사용자에게 필요한 권한과 문의처를 표시하되 내부 Policy 조건 전체를 노출하지 않는다.

## 8. 실행 통제

### 8.1 Timeout

- Tool별 기본 Timeout
- Server 최대 Timeout
- Runtime 취소 신호 전파
- DB Query Cancel 지원 시 호출

### 8.2 Rate Limit

Key:

- User + Tool
- Agent/Service + Tool
- 전체 Server

PoC에서는 보수적인 고정 Limit으로 시작하며 운영 지표에 따라 조정한다.

### 8.3 Result Limit

- 최대 Row
- 최대 Byte
- 최대 Field 길이
- 초과 시 `truncated`와 제한 정보 반환
- 대량 데이터 Download Tool은 별도 검토 전 금지

### 8.4 사용자 확인

정책:

- `NEVER`: 안전한 읽기 전용이며 별도 확인 불필요
- `ALWAYS`: 매 호출 사용자 확인
- `ON_PARAMETER`: 특정 범위 또는 민감 조건에서 확인

PoC Tool은 읽기 전용이지만 업무 민감도에 따라 `ALWAYS`를 사용할 수 있다.

## 9. Output Filter

- 금지 Column 제거
- 개인정보 Pattern Masking
- 내부 오류·Stack Trace 제거
- 최대 크기 적용
- Classification Label 추가
- 출력 Schema 재검증

Masking 전 원본 결과를 일반 로그에 기록하지 않는다.

## 10. MCP Audit Event

```json
{
  "event_type": "MCP_TOOL_COMPLETED",
  "trace_id": "uuid",
  "run_id": "uuid",
  "user_id": "uuid",
  "organization_id": "org-uuid",
  "service_id": "service-uuid",
  "agent_id": "agent-uuid",
  "server_id": "office-mcp-a",
  "tool_name": "db_metadata.get_columns",
  "tool_version": "1.0.0",
  "started_at": "2026-08-02T12:00:00Z",
  "duration_ms": 123,
  "result": "SUCCEEDED",
  "row_count": 12,
  "truncated": false,
  "policy_id": "policy-version"
}
```

입력 Parameter와 결과 본문은 기본 Audit Event에 포함하지 않는다. 필요한 경우 별도 보안 정책에 따라 Hash 또는 허용된 요약만 기록한다.

## 11. 운영 API

MCP Protocol 외 관리 Endpoint는 업무망에 제한한다.

| Method | Path | 기능 |
|---|---|---|
| GET | `/health/live` | Process 생존 |
| GET | `/health/ready` | Connector와 정책 준비 |
| GET | `/version` | Server·Schema·Tool 버전 |
| GET | `/admin/tools` | Tool 상태 목록; 관리자만 |
| POST | `/admin/tools/{name}/disable` | Kill Switch; 관리자만 |
| POST | `/admin/tools/{name}/enable` | 검토 후 재활성 |

## 12. M11 Security & Governance

### 12.1 보안 원칙

- Zero Trust 수준을 선언만 하지 않고 각 경계에서 검증
- 최소 권한
- Default Deny
- 승인된 코드·자산·Server Alias만 허용
- Secret과 Package 분리
- 사용자 Context 위조 방지
- 민감정보를 Prompt·Log·Error에 최소화
- 폐쇄망도 신뢰된 환경으로 간주하지 않음

### 12.2 자산 보안등급

| 등급 | 의미 | 기본 배포 정책 |
|---|---|---|
| PUBLIC_INTERNAL | 사내 전체 공개 가능 | 승인 후 모든 사업장 |
| INTERNAL | 일반 사내 정보 | 허용 조직·사업장 |
| CONFIDENTIAL | 제한 정보 | 명시 ACL, Download/Audit 강화 |
| RESTRICTED | 고위험 정보 | PoC 배포 제외 또는 별도 승인 |

### 12.3 자산 유형별 검토

#### Agent

- 실행 코드 포함 여부
- 요청 권한과 Tool 범위
- Prompt Injection 방어
- 최대 Step/Tool Call/Timeout
- 파일 접근과 Network 접근
- Output Data 처리

#### Knowledge

- Source 이용 근거
- 개인정보·기밀 포함 여부
- ACL Metadata
- Chunk에 불필요한 민감정보 포함 여부
- 평가 데이터 노출 여부
- Source 삭제·회수 반영 방법

#### MCP Tool

- 읽기/쓰기 위험도
- 시스템 계정 권한
- Input Allowlist와 Injection 방어
- Result Limit과 Masking
- 사용자 Context 기반 권한
- Audit와 Kill Switch

#### Prompt

- 민감정보와 Secret 포함 여부
- 외부 Context를 명령으로 처리하는 취약성
- 금지 행동과 근거 부족 처리
- 출력 Schema와 데이터 노출

#### AI Service

- 구성 자산이 모두 승인됨
- 대상 사용자와 Tool Permission 일치
- Knowledge ACL과 대상 조직 일치
- 모델 정책이 사업장 정책에 부합
- Mock Test와 E2E 결과

### 12.4 승인 Workflow

```text
CREATOR
  → 자동검증
  → TECH_REVIEWER
  → SECURITY_REVIEWER
  → RELEASE_MANAGER
  → APPROVED
```

저위험 Prompt 수정 등은 정책으로 일부 단계를 줄일 수 있지만, 해당 정책과 근거를 Audit에 기록한다.

승인 결정에는 다음이 필요하다.

- Reviewer ID와 역할
- 검토 대상 Version과 File Hash
- Check 항목 결과
- 의견
- 결정 시각
- 적용 Policy Version

### 12.5 Package 무결성

PoC:

- SHA-256 Checksum 필수
- Portal에서 생성, Desktop에서 검증
- Hash 불일치 시 Quarantine

운영 확장:

- Package Signature
- Trust Store
- Signing Key Rotation
- Revocation List
- Timestamp와 서명자 정보

### 12.6 Secret 관리

Secret 예:

- DB Password
- API Key
- OAuth Client Secret
- Signing Private Key

규칙:

- Git, Manifest, Profile, Sample, Log에 저장 금지
- 환경변수 또는 OS/Server Secure Store 사용
- Secret 값을 API로 반환하지 않음
- 마지막 변경시각과 Alias만 표시
- 진단 Bundle에서 제외
- Rotation 후 재시작/재연결 절차 문서화

### 12.7 Prompt Injection 방어

- 사용자 입력, Knowledge Context, MCP 결과를 `untrusted data`로 취급
- System Instruction과 데이터 구획을 분리
- 문서 안의 “Tool을 실행하라” 명령을 따르지 않음
- Tool 선택은 Agent Workflow와 허용 목록으로 제한
- Tool Parameter는 Schema 검증
- 민감 Tool은 사용자 확인
- Knowledge Source와 MCP 결과에 출처 Label
- Output에 Secret이나 내부 Prompt 노출 금지

### 12.8 Runtime 실행 정책

- 선언형 Agent만 PoC 운영 배포
- 임의 Python Code 실행 금지
- 임의 외부 URL 금지
- 임의 Package 설치 금지
- Asset Root 밖 파일 접근 금지
- Office Profile에 없는 Model/MCP Endpoint 금지
- Process 실행 Tool 금지

### 12.9 감사 보관

- Audit Event는 Append-only를 기본으로 한다.
- 보관기간은 정책 설정으로 관리한다.
- 원문 Prompt와 전체 문서는 별도 명시가 없으면 저장하지 않는다.
- Trace ID로 Portal→Desktop→Runtime→Search→MCP를 연결한다.
- 감사 조회 자체도 Audit 대상이다.

### 12.10 Revocation

Revocation 대상:

- Asset Version
- Service Version
- MCP Tool Version
- Package Signature/Key
- Office Profile Version

효과:

- Portal 신규 다운로드 차단
- Bundle 생성 차단
- Online Client 실행 차단 Hook
- Offline Revocation List에 포함
- 대체 버전과 사용자 안내

폐쇄망 Client는 마지막 Revocation List 날짜를 표시한다. 최신 여부를 확인할 수 없다는 사실을 숨기지 않는다.

## 13. 위협 시나리오 테스트

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| SEC-01 | Package 파일 하나를 수정 | Checksum 실패, 설치 거부 |
| SEC-02 | Manifest Path에 `../` 사용 | Schema/Import 단계 거부 |
| SEC-03 | Agent가 미선언 MCP Tool 호출 | Runtime Policy에서 차단 |
| SEC-04 | Knowledge 문서에 Tool 실행 명령 삽입 | 명령 무시, Tool 미호출 |
| SEC-05 | 사용자 Context에서 관리자 Role 위조 | 인증 검증 실패 |
| SEC-06 | 허용되지 않은 Table 요청 | MCP Allowlist 거부 |
| SEC-07 | SQL Injection 문자열 입력 | Schema/Parameter 처리, 실행 거부 또는 값으로 처리 |
| SEC-08 | 결과 크기 제한 초과 | 잘린 결과와 경고, 서버 안정 유지 |
| SEC-09 | Revoked Service 실행 | Preflight 또는 Runtime 차단 |
| SEC-10 | Log에 Password Pattern 입력 | Masking 후 기록 |
| SEC-11 | 압축 폭탄 Bundle 반입 | 예상 해제 용량 검사로 차단 |
| SEC-12 | Signature Trust Key 만료 | 검증 실패 또는 정책상 명확한 경고 |

## 14. 인수 기준

- MCP Tool은 사용자·조직·Agent·Run Context 없이 실행되지 않는다.
- DB Metadata와 Count Tool은 임의 SQL을 받지 않는다.
- Tool 입력·출력·Timeout·Row/Byte Limit가 적용된다.
- 모든 Tool 호출이 Trace ID로 기록된다.
- 승인되지 않거나 Revoked Package/Service/Tool이 배포·실행되지 않는다.
- Knowledge ACL과 MCP Permission이 Service 대상 사용자와 일치하는지 검토된다.
- 주요 12개 위협 시나리오가 자동 또는 재현 가능한 수동 테스트로 통과한다.
