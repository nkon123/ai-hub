# Claude Code 구현 지침

이 저장소는 Enterprise AI Asset Hub PoC를 구현한다. 작업을 시작하기 전에 반드시 다음 문서를 읽는다.

1. `docs/implementation-spec/README.md`
2. 현재 작업 모듈의 상세 문서
3. `docs/implementation-spec/07-data-api-contracts.md`
4. `docs/implementation-spec/open-decisions.md`
5. `docs/implementation-spec/progress-log.md` — 모듈별 구현 현황 스냅샷. 전체 코드베이스를 다시 탐색하기 전에 먼저 확인하고, 의미 있는 변경 후에는 갱신한다.

## 제품 언어

- 사용자 화면과 신규 코드에서 `RAG`라는 용어를 사용하지 않는다.
- 대신 `Knowledge`, `지식 자산`, `지식 검색`, `Knowledge Package`를 사용한다.
- 신규 API, Schema Key, 폴더명도 `knowledge`를 사용한다.
- Langflow와 자유형 Drag & Drop Canvas는 구현하지 않는다.
- AI Service 구성은 단계형 Service Composer Wizard로 구현한다.
- 발표 MVP에는 등록된 Knowledge로 챗봇을 빠르게 구성하고, 실제 Knowledge Preview 테스트 후 내부 URL로 게시하는 흐름을 포함한다.

## 구현 원칙

1. 계약을 코드보다 먼저 작성한다.
2. 모듈 간 내부 폴더 직접 Import를 금지한다.
3. 공통 타입은 `packages/schemas` 또는 공개 SDK/API로 교환한다.
4. 한 PR은 하나의 기능 또는 하나의 계약 변경으로 제한한다.
5. 테스트 증거 없는 기능은 완료로 표시하지 않는다.
6. 실제 회사 Secret, 개인정보, 운영 DB 정보를 코드·Prompt·Fixture·Log에 넣지 않는다.
7. 승인되지 않은 임의 Python 실행, 외부 URL, Package 설치 기능을 만들지 않는다.
8. MCP PoC Tool은 읽기 전용만 구현한다.
9. 모든 주요 요청과 실행에는 Trace ID를 사용한다.
10. Loading, Empty, Error, Permission, Cancellation 상태를 정상 흐름과 함께 구현한다.

## 모듈 소유권

| ID | 경로 | 책임 |
|---|---|---|
| M01 | `apps/portal-web` | Portal UI, Catalog, Service Composer |
| M02 | `apps/portal-api` | Registry, Version, Review, Service/Deployment API |
| M03 | `services/distribution-service` | Repository, Download, Offline Bundle, Hosted Deployment Job |
| M04 | `apps/desktop-client` | Electron Desktop UI, Import, Installer (D-006) |
| M05 | `services/agent-runtime` | Local/Hosted Workflow, Streaming, LLM, Knowledge, MCP 조정 |
| M06 | `packages/schemas` | Manifest/Profile/Service Schema와 Validator |
| M07 | `services/indexing-runtime` | Knowledge Indexing |
| M08 | `services/search-runtime` | Knowledge Search |
| M09 | `packages/knowledge-packager`, `packages/evaluation-runner` | Package와 평가 |
| M10 | `services/office-mcp-server` | Tool, Connector, 실행 통제 |
| M11 | `packages/security-policy` | RBAC, 승인, 무결성, 감사 정책 |
| M12 | `tests`, CI, 문서 | 계약·통합·E2E·릴리스 |

다른 모듈의 변경이 필요하면 먼저 Contract 변경을 별도 PR로 제안한다.

### 모듈별 CLAUDE.md

각 모듈 루트에 그 모듈 전용 `CLAUDE.md`가 있다(예: `apps/portal-api/CLAUDE.md`,
`services/agent-runtime/CLAUDE.md`, `tests/CLAUDE.md`). 해당 모듈의 파일을
다룰 때 자동으로 함께 읽힌다. 코드 배치, 모듈 경계, 실행·테스트 명령, 그리고
그 모듈에서 실제로 반복해 틀렸던 것이 정리되어 있다.

이 파일(루트)의 규칙은 모듈 파일에 복사하지 않는다. 제품 언어, 구현 원칙,
코드 규칙, UI 구현 규칙, 완료 전 확인은 여기에만 두고 모듈 파일은 참조만
한다 — 양쪽에 같은 규칙을 두면 반드시 갈라진다.

## 구현 순서

### 1. 저장소 Bootstrap

- 위 경로의 최소 프로젝트 구조 생성
- Python/TypeScript 공통 개발 명령
- Lint, Type Check, Test, Secret Scan Hook
- Sample Fixture Directory

### 2. Contract 우선

- Asset/Agent/Knowledge/Prompt/MCP/Service/Office Profile Schema
- Portal OpenAPI
- Local Runtime API와 Event
- Knowledge Search Request/Response
- MCP Tool Schema와 Audit Context

### 3. Mock

- Portal Mock API
- Mock Knowledge Search
- Mock MCP Server
- Mock Ollama Adapter
- HR Policy Sample Knowledge

### 4. Core 구현

- Registry
- Knowledge Indexing/Search
- Agent Runtime
- MCP Server
- Bundle Builder

### 5. UI와 통합

- Portal
- Service Composer
- Knowledge 챗봇 Quick Create, Preview, URL 게시
- Desktop
- Offline Bundle E2E

### 6. 보안과 인수

- RBAC, Checksum, Audit, Revocation Hook
- Contract/Integration/E2E/Security Test
- Windows Installer와 Demo Runbook

## 코드 규칙

- Python Domain Model과 API Model을 분리한다.
- API/Schema Field는 명세의 이름을 그대로 사용한다.
- Enum과 오류코드는 중앙 정의를 사용한다.
- 새 의존성을 추가할 때 이유와 폐쇄망 설치 방법을 문서화한다.
- 함수와 클래스는 한 가지 책임을 가진다.
- 외부 Library 타입을 Module Public Contract로 직접 노출하지 않는다.
- Provider/Vector Store/MCP Connector는 Adapter Interface 뒤에 둔다.
- 승인 Version을 수정하는 Update 코드를 만들지 않는다.
- 사용자가 제공한 파일명으로 파일 경로를 만들지 않는다.
- Log에 Prompt 원문, 문서 전체, DB 결과, Secret을 기본 저장하지 않는다.

## UI 구현 규칙

- 기술 명칭보다 업무 목적을 먼저 표시한다.
- 모든 Form Field에 Label과 Validation Message를 제공한다.
- 호환되지 않는 선택지는 이유와 함께 비활성화한다.
- 승인·반려·중단·폐기는 확인과 사유를 요구한다.
- 긴 Job은 진행률, 단계, 재시도 가능 여부를 표시한다.
- Service Composer는 Wizard이며 Canvas나 코드 편집기가 아니다.
- Hosted Chat URL은 사용자가 임의 주소를 입력하지 않고 플랫폼이 검증된 Slug로 발급한다.
- Portal API는 모델을 직접 호출하지 않으며 Preview/게시 실행은 별도 Hosted Agent Runtime을 사용한다.
- Desktop은 Runtime 장애 시 종료되지 않고 복구 안내를 제공한다.

## 에이전트용 스크립트 인벤토리

에이전트는 **먼저 여기를 보고**, 없을 때만 명령을 직접 조합한다. 존재를 모르면
매번 인라인으로 다시 짜게 되고, 그때마다 파싱이 조금씩 달라진다.

| 명령 | 용도 | 입력 | 출력 |
|---|---|---|---|
| `node scripts/agent/verify-change.mjs --suites <a,b>` | 검증 스위트 실행 + 기준선 대비 증감 | `--suites`(python/desktop/ruff/contract/typecheck-desktop/typecheck-portal-web/all), `--baseline`, `--save-baseline`, `--verbose` | JSON `{ok, suites:[{suite,exitCode,ok,counts,delta}], failed:[]}`. 전체 덤프 없음 |

`verify-change` 사용 규율:

1. **작업 시작 전에 기준선을 찍는다** — `--save-baseline <경로>`. 안 찍으면
   나중에 증가분이 내 것인지 다른 세션 것인지 구분할 수 없다.
2. 작업 후 같은 스위트를 `--baseline <경로>`로 돌린다.
3. **판정은 여전히 사람/에이전트 몫이다**: `delta.passed`가 내가 추가한 테스트
   수와 **일치하는가**. 일치하지 않으면 다른 변경이 섞인 것이다.
4. 종료 코드 **3은 파싱 실패**다 — 명령이 아예 안 돌았거나 출력 형식이 바뀐
   것이다. 조용히 0으로 넘어가지 않는다. 숫자가 안 나왔는데 통과로 보고하지 마라.
5. 이 스크립트는 **의존성이 없다**(Node 내장만). 폐쇄망에서 그대로 돈다.
   테스트: `node --test scripts/agent/verify-change.test.mjs`

## 완료 전 확인

- 요구사항 ID 또는 명세 Section이 PR에 연결되어 있는가
- 정상·빈 결과·오류·권한·취소를 테스트했는가
- Contract와 Fixture를 수정했는가
- 실제 Secret/업무 데이터가 없는가
- Trace ID와 Sanitized Log가 있는가
- 다른 모듈을 직접 Import하지 않았는가
- Offline 환경에서 필요한 의존성을 설명했는가
- 문서와 코드가 일치하는가

불명확한 결정은 추측하여 운영 기능으로 구현하지 말고 `docs/implementation-spec/open-decisions.md`에 기록한다.
