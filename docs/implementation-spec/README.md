# Enterprise AI Asset Hub 상세 개발 명세

문서 상태: 구현 기준선(Baseline) 1.0  
대상: Claude Code 및 12명 연구회 개발자  
목표 환경: 중앙 사내망, Frontier AI 사용 가능 사업장, 외부 AI가 차단된 폐쇄망 사업장  
관련 계획서: `outputs/019f5e57-b26d-7c81-9cf1-e78d14ed33e0/enterprise_ai_asset_hub_12_member_plan.xlsx`  
계획서의 기존 명칭보다 이 명세의 Knowledge/AI Service 용어와 기능 정의가 우선한다.

## 1. 문서 사용 방법

이 문서는 프로젝트의 최상위 요구사항과 구현 경계를 정의한다. Claude Code는 구현 전에 루트의 `CLAUDE.md`와 이 문서를 읽고, 작업하는 모듈의 상세 문서를 추가로 읽어야 한다.

상충하는 내용의 우선순위는 다음과 같다.

1. 사용자가 현재 대화에서 명시한 요구사항
2. 루트 `CLAUDE.md`
3. 이 문서와 같은 디렉터리의 상세 명세
4. Excel 작업계획서
5. 코드의 기존 동작

명세가 불명확할 때 임의로 기능을 넓히지 않는다. `docs/implementation-spec/open-decisions.md`에 결정 항목을 기록하고, 안전한 Mock 또는 인터페이스까지만 구현한다.

## 2. 상세 문서 목록

| 문서 | 담당 범위 |
|---|---|
| [01-portal-and-distribution.md](./01-portal-and-distribution.md) | M01 Portal UI, M02 Portal API/Registry, M03 Distribution/Offline Bundle |
| [02-desktop-and-agent-runtime.md](./02-desktop-and-agent-runtime.md) | M04 Desktop Client, M05 Agent Runtime/LLM Adapter |
| [03-package-standards.md](./03-package-standards.md) | M06 Manifest, Package Schema, Indexing/Retrieval/Office Profile |
| [04-knowledge-platform.md](./04-knowledge-platform.md) | M07 Knowledge Indexing, M08 Knowledge Search, M09 Knowledge Package/Evaluation |
| [05-mcp-security-governance.md](./05-mcp-security-governance.md) | M10 Office MCP Server, M11 Security/Governance/Audit |
| [06-quality-delivery.md](./06-quality-delivery.md) | M12 QA, 통합, CI, 릴리스, 인수 테스트 |
| [07-data-api-contracts.md](./07-data-api-contracts.md) | 공통 데이터 모델, API 규약, 오류, 이벤트, 상태 모델 |
| [08-service-composer.md](./08-service-composer.md) | 드래그앤드롭 없는 단계형 AI Service Composer와 Service Package |
| [09-functional-requirements-matrix.md](./09-functional-requirements-matrix.md) | 12개 모듈 기본 144개와 Hosted Chat 30개 기능의 요구사항·완료 기준 추적 |
| [10-hosted-chatbot-publication.md](./10-hosted-chatbot-publication.md) | 등록 Knowledge 챗봇의 실제 Preview 테스트, 게시, 내부 URL 실행 |
| [11-desktop-packaging-and-distribution.md](./11-desktop-packaging-and-distribution.md) | M04 Desktop Windows 설치 패키징(electron-builder/NSIS), 코드 서명, 폐쇄망 반입 절차 |
| [12-poc-acceptance-report.md](./12-poc-acceptance-report.md) | M12 PoC 인수 보고서 — 테스트 결과·품질·성능·보안·제한사항과 Go/Conditional Go/No-Go 판단 자료 |
| [open-decisions.md](./open-decisions.md) | 구현 전 확정하거나 PoC 가정으로 관리할 항목 |
| [progress-log.md](./progress-log.md) | 모듈별 구현 현황 스냅샷 — 재탐색 없이 참고하는 진행 기록 |
| [claude-code-kickoff-prompt.md](./claude-code-kickoff-prompt.md) | Claude Code에 처음 전달할 실행 요청 Prompt |

## 3. 제품 정의

Enterprise AI Asset Hub는 Portal 자체가 모든 AI 실행을 담당하는 단일 서비스가 아니다. 다음 자산을 표준화하고 검토·배포하며, Desktop Local Runtime 또는 별도 Hosted Agent Runtime 등 대상 환경에 맞는 실행 계층에서 사용하는 분산형 플랫폼이다.

- Agent Package: 업무 흐름, Prompt 참조, Knowledge/MCP 의존성, 권한 선언
- Knowledge Index Package: 문서 가공 결과, 청크, 검색 인덱스, 평가 결과
- MCP Tool Package: 사내 시스템 기능을 제공하는 승인된 Tool
- Prompt Package: 질의 재작성, 분석, 답변 생성에 사용하는 버전형 지침
- Office Profile: 사업장별 모델·MCP 주소·자산 경로·정책
- AI Service Package: Agent, Knowledge, MCP Tool, Prompt, 모델 정책을 하나의 서비스로 조합한 선언형 패키지

핵심 원칙은 다음과 같다.

1. Portal은 Control Plane으로 자산을 관리하며, 실제 AI 실행은 Desktop Local Runtime 또는 별도 Hosted Agent Runtime이 담당한다.
2. 폐쇄망에서는 승인된 패키지를 파일로 반입하여 로컬 실행한다.
3. Agent Workflow는 공통으로 유지하고 모델·Knowledge·MCP 연결은 Profile로 교체한다.
4. 실행 코드는 신뢰할 수 있는 패키지만 허용한다.
5. MCP PoC는 읽기 전용 Tool만 제공한다.
6. Knowledge는 Vector DB만 배포하지 않고 재현에 필요한 청크·Profile·평가를 함께 배포한다.
7. 사용자 화면에는 `RAG`라는 용어를 사용하지 않고 `Knowledge`, `지식 자산`, `지식 검색`을 사용한다.
8. Langflow와 자유형 Drag & Drop Canvas는 포함하지 않는다.
9. 대신 승인된 자산을 단계형 Wizard로 조합하는 AI Service Composer를 제공한다.
10. 발표 MVP에서는 등록 Knowledge로 챗봇을 구성하고 실제 Preview 후 내부 URL로 게시할 수 있어야 한다.

### 3.1 용어 기준

| 사용 용어 | 의미 |
|---|---|
| Knowledge | 검색 가능한 사내 지식 자산 전체 |
| Knowledge Source | 원본 또는 파싱된 문서 |
| Knowledge Index | 청크, Vector/BM25 Index |
| Knowledge Profile | 인덱싱·검색 설정 |
| Knowledge Package | Source 정보, Index, Profile, 평가를 포함한 배포 자산 |
| AI Service | 사용자가 실행하는 완성된 업무 단위 |
| Service Definition | Agent·Knowledge·MCP·Prompt·모델 정책의 조합 선언 |

신규 코드, API, Schema, 폴더명은 `knowledge`를 기본 용어로 사용한다. 외부 라이브러리의 고유 클래스명이나 표준 기술 설명에서만 `retrieval` 또는 해당 라이브러리의 기존 명칭을 허용한다.

## 4. 사용자와 역할

| 역할 코드 | 역할 | 주요 권한 |
|---|---|---|
| `USER` | 일반 사용자 | 승인된 자산 조회·다운로드, 허용된 Agent 실행 |
| `CREATOR` | 자산 제작자 | 자산 초안 등록, 새 버전 업로드, 검토 요청 |
| `TECH_REVIEWER` | 기술 검토자 | 구조·호환성·테스트 결과 검토 |
| `SECURITY_REVIEWER` | 보안 검토자 | 권한·코드·데이터·의존성 검토 |
| `RELEASE_MANAGER` | 배포 관리자 | 최종 승인, 배포 채널 지정, 중단·폐기 |
| `AUDITOR` | 감사자 | 변경·승인·다운로드·실행 로그 읽기 |
| `ADMIN` | 플랫폼 관리자 | 사용자·역할·정책·저장소·사업장 설정 관리 |

한 사용자는 여러 역할을 가질 수 있다. 모든 권한 검사는 서버에서 수행하며 화면 숨김만으로 권한을 통제하지 않는다.

## 5. 시스템 컨텍스트

```text
                        [중앙 사내망]

사용자 ──> AI Asset Portal ──> Portal API ──> Asset Registry DB
                    │               │
                    │               ├──> Asset Repository
                    │               ├──> Approval / Audit
                    │               └──> Offline Bundle Builder
                    │
                    └── 승인된 패키지 다운로드/반출

사용자 ──> /chat/{slug} ──> Hosted Agent Runtime
                                  ├──> Central Knowledge Search
                                  └──> Approved Model Endpoint

──────────────────────────────────────────────────────────────

                  [폐쇄망 또는 사업장 사용자 PC]

AI Desktop Client ──> Local Agent Runtime ──> Ollama
                              │              └──> Local Knowledge
                              └──> Office MCP Server ──> 사내 시스템

                  [AI 사용 가능 사업장]

Portal/Desktop ──> Agent Runtime ──> 승인된 Frontier AI/Knowledge
                         └──> Office/Central MCP ──> 사내 시스템
```

## 6. 핵심 사용자 흐름

### 6.1 자산 제작·승인·배포

1. `CREATOR`가 자산 유형을 선택한다.
2. Manifest와 패키지 파일을 등록한다.
3. Portal API가 Schema, 파일 확장자, 크기, Checksum, 의존성을 검사한다.
4. 자동 검증을 통과하면 초안 버전이 생성된다.
5. 제작자가 기술 검토를 요청한다.
6. 기술 검토자는 문서·테스트·호환성을 확인한다.
7. 보안 검토자는 실행 코드·권한·비밀정보·의존성을 확인한다.
8. Release Manager가 배포를 승인한다.
9. 승인 버전은 불변으로 잠긴다.
10. 포털이 Checksum을 발급한다. 운영 단계에서는 전자서명도 발급한다.
11. 사용자는 온라인 다운로드 또는 Offline Bundle 생성을 요청한다.
12. 모든 단계는 Audit Log에 기록된다.

### 6.2 폐쇄망 설치·실행

1. 사용자가 승인된 Offline Bundle을 반입한다.
2. Desktop Client가 Bundle Manifest와 Checksum을 검사한다.
3. 설치 전 Runtime, Ollama 모델, Knowledge 용량, MCP 연결을 검사한다.
4. 의존성 순서대로 Prompt/Knowledge/Agent/Service/Office Profile을 설치한다.
5. 사용자가 Agent를 선택하고 질문 또는 허용된 파일을 입력한다.
6. Agent Runtime이 Workflow를 로딩한다.
7. Knowledge Search Runtime이 Local Knowledge를 검색하고 Citation이 포함된 Context를 반환한다.
8. 필요 시 Office MCP Server의 허용 Tool을 호출한다.
9. Agent Runtime이 검색 문서와 Tool 결과만 근거로 답변한다.
10. Desktop Client가 답변, 출처, 실행 단계, 오류를 표시한다.

### 6.3 Knowledge 생성·배포

1. 제작자가 Source Document와 Indexing Profile을 준비한다.
2. Indexing Runtime이 문서를 로드·정제·청킹한다.
3. Ollama Embedding으로 Child 청크를 임베딩한다.
4. Chroma Vector Index와 BM25 Index를 생성한다.
5. `chunks.jsonl`, `parents.jsonl`, Source Manifest, 통계를 생성한다.
6. Evaluation Runner가 대표 질문으로 Recall@K, MRR, 검색시간을 측정한다.
7. 기준을 통과하면 Knowledge Index Package를 만든다.
8. Portal의 검토·승인 절차를 거쳐 배포한다.

### 6.4 AI Service 구성·배포

1. 제작자가 `서비스 만들기`를 선택한다.
2. 기본정보와 대상 사용자·사업장을 입력한다.
3. 승인된 Agent Template을 선택한다.
4. Agent가 요구하는 역할별로 Knowledge Package를 연결한다.
5. 필요한 MCP Tool을 선택하고 Tool별 권한과 사용자 확인 정책을 정한다.
6. 시스템·질의재작성·답변용 Prompt Package를 연결한다.
7. 폐쇄망 Ollama 또는 승인된 Frontier AI 중 허용 모델 정책을 선택한다.
8. 입력 필드, 출력 형식, 파일 허용 규칙을 설정한다.
9. 포털이 버전·Runtime·모델·Knowledge·MCP·Prompt 호환성을 검증한다.
10. 등록된 Test/Approved Knowledge와 Test Model Binding으로 Preview 테스트를 실행한다. MCP는 Mock을 사용한다.
11. 성공한 구성을 `Service Definition` 초안으로 저장한다.
12. 검토·승인 후 `AI Service Package`로 배포한다.
13. Offline Bundle 생성 시 참조된 모든 의존 자산을 함께 포함한다.

Service Composer는 자유형 코드를 생성하지 않는다. 사용자는 승인된 자산과 허용된 설정만 조합할 수 있다. 실제 사내 데이터와 Tool을 사용하는 실행은 Desktop/Agent Runtime에서 수행하며, Portal의 Preview는 별도 Hosted Test Runtime으로 제한한다.

### 6.5 Knowledge 챗봇 Preview·URL 게시

1. 제작자가 `Knowledge 챗봇 만들기`를 선택한다.
2. 등록·검증된 Knowledge Version을 선택한다.
3. 시스템이 표준 Knowledge Chat Agent와 승인 Prompt를 자동 연결한다.
4. 챗봇 이름, 환영문, 추천 질문, Model Alias, Citation 정책을 설정한다.
5. 실제 등록 Knowledge로 질문을 실행하고 검색 근거와 Citation을 확인한다.
6. 필수 Test Case와 게시 Gate를 통과한다.
7. 승인된 Service Version과 의존성의 불변 Snapshot으로 게시 Job을 실행한다.
8. 플랫폼이 `/chat/{deployment_slug}` 형식의 내부 URL을 발급한다.
9. 사내 인증 사용자가 새 브라우저에서 URL에 접속하여 대화한다.
10. 답변 Streaming, Citation, 권한, Rate Limit, Audit을 Hosted Agent Runtime이 처리한다.

세부 기준은 [10-hosted-chatbot-publication.md](./10-hosted-chatbot-publication.md)를 따른다. URL 게시 기능은 외부 인터넷 익명 공개가 아니라 사내 인증 기반 내부 Hosting이 기본값이다.

## 7. 권장 기술 기준선

정확한 라이브러리 버전은 저장소 초기화 시 호환성 검증 후 Lockfile에 고정한다.

| 영역 | 권장 기준선 |
|---|---|
| Portal Web | React, TypeScript, Vite, 접근 가능한 컴포넌트 구조 |
| Portal API | Python 3.12, FastAPI, Pydantic, SQLAlchemy, Alembic |
| Registry DB | PostgreSQL; 단위 테스트에서는 SQLite 허용 |
| Asset Repository | PoC는 파일 시스템 Adapter, 운영은 사내 Object Storage Adapter |
| Desktop Client | Python 3.12, PySide6 |
| Local Runtime API | FastAPI loopback service 또는 명시적 Python service interface |
| Hosted Chat Runtime | Agent Runtime Core의 서버 Mode, SSE Streaming, 중앙 Knowledge Search Adapter |
| Agent Runtime | Python, Framework Adapter로 LangGraph 사용 가능; 도메인 계층은 Framework에 직접 종속하지 않음 |
| Knowledge | Ollama Embedding, Chroma, BM25, Profile 기반 전략 선택 |
| MCP | 표준 MCP 요청·응답을 따르는 Python 서버; Tool 구현과 Transport 분리 |
| Test | pytest, Vitest, Playwright, Contract Test, Windows Desktop Smoke Test |
| 품질 | Python lint/type check, TypeScript lint/type check, 비밀정보 검사, 의존성 검사 Hook |

## 8. 권장 모노레포 구조

```text
ai_asset_hub/
├─ CLAUDE.md
├─ apps/
│  ├─ portal-web/                 # M01
│  ├─ portal-api/                 # M02
│  └─ desktop-client/             # M04
├─ services/
│  ├─ distribution-service/       # M03
│  ├─ agent-runtime/              # M05
│  ├─ indexing-runtime/           # M07
│  ├─ search-runtime/             # M08
│  └─ office-mcp-server/          # M10
├─ packages/
│  ├─ schemas/                    # M06
│  ├─ python-sdk/                 # 공통 Python 계약
│  ├─ typescript-sdk/             # Portal 계약 타입
│  ├─ knowledge-packager/         # M09
│  ├─ evaluation-runner/          # M09
│  ├─ security-policy/            # M11
│  └─ test-fixtures/              # M12
├─ infra/
│  ├─ compose/
│  ├─ migrations/
│  └─ offline/
├─ sample-assets/
│  ├─ hello-agent/
│  ├─ hr-policy-knowledge/
│  ├─ sample-prompts/
│  └─ mock-mcp-tools/
├─ tests/
│  ├─ contract/
│  ├─ integration/
│  ├─ e2e/
│  └─ security/
└─ docs/
   └─ implementation-spec/
```

다른 모듈의 내부 폴더를 직접 Import하지 않는다. 공용 타입은 `packages/schemas`, SDK 또는 공개 API를 통해서만 사용한다.

## 9. 12개 모듈 경계

| ID | 모듈 | 책임 | 명시적 비책임 |
|---|---|---|---|
| M01 | Portal UI & Catalog | 포털 화면, Service Composer, Quick Create, Preview·Hosted Chat UI | DB 직접 접근, 모델 직접 호출 |
| M02 | Portal API & Registry | 자산·Service·Deployment 메타데이터, 버전·상태·검색 API | ZIP 조립, Agent 실행 |
| M03 | Distribution & Deployment | 저장소·다운로드·Offline Bundle·Hosted 게시 Job | Chat 답변 생성, Knowledge 검색 |
| M04 | Desktop Client | 로컬 설치·실행 UI·상태·로그 | Workflow 판단 로직 |
| M05 | Agent Runtime & LLM Adapter | Local/Hosted Workflow, Streaming, 모델, Knowledge, MCP 조정 | 문서 인덱싱, 게시 승인 |
| M06 | Package Spec & Profiles | Asset/Service Manifest, Profile Schema·Validator | 자산 승인 결정, Runtime 실행 |
| M07 | Knowledge Indexing Runtime | 문서 처리·청킹·임베딩·색인 | 최종 답변 생성 |
| M08 | Knowledge Search Runtime | Rewrite·검색·결합·Context·Citation | 자산 Portal 등록, Agent Workflow |
| M09 | Knowledge Package & Evaluation | 패키지 조립·평가·Data Card | 검색 알고리즘 구현 자체 |
| M10 | Office MCP Server | Tool·Connector·입력검증·실행 통제 | Agent 판단, 사용자 UI |
| M11 | Security/Governance/Audit | 권한·승인·무결성·감사·회수 정책 | 각 업무 기능 구현 |
| M12 | QA/Integration/Docs | 계약·통합·인수 테스트, CI, 문서 | 다른 모듈의 기능 소유 |

## 10. 공통 기능 요구사항

### 10.1 식별자와 버전

- 모든 자산은 변경되지 않는 `asset_id`를 가진다.
- 버전은 `major.minor.patch` 형식이다.
- 승인된 버전의 파일과 Manifest는 수정할 수 없다.
- 수정이 필요하면 새 버전을 만든다.
- 파일, Source Document, Chunk에는 안정적인 Hash 기반 ID를 사용한다.
- 모든 시간은 저장 시 UTC, 표시 시 사용자 시간대로 변환한다.

### 10.2 오류 응답

모든 HTTP API는 다음 Envelope를 사용한다.

```json
{
  "error": {
    "code": "ASSET_VERSION_CONFLICT",
    "message": "동일한 자산 버전이 이미 존재합니다.",
    "trace_id": "trace-uuid",
    "details": {
      "asset_id": "asset-uuid",
      "version": "1.2.0"
    }
  }
}
```

- 사용자 메시지에는 비밀번호, SQL, Stack Trace, 내부 경로를 노출하지 않는다.
- 상세 오류는 민감정보를 제거한 후 구조화 로그에 기록한다.
- 재시도 가능한 오류와 불가능한 오류를 코드로 구분한다.

### 10.3 목록 API

- `page`, `page_size`, `sort`, `q`, `filters`를 지원한다.
- 기본 `page_size`는 20, 최대 100이다.
- 응답은 `items`, `page`, `page_size`, `total`을 포함한다.
- 검색 결과는 사용자에게 허용된 자산만 포함한다.

### 10.4 비동기 작업

Bundle 생성, 대용량 업로드 검증, Knowledge 인덱싱, 평가와 같이 오래 걸리는 작업은 Job으로 모델링한다.

```text
QUEUED → RUNNING → SUCCEEDED
                 ├→ FAILED
                 └→ CANCELLED
```

Job은 진행률, 현재 단계, 시작/종료 시각, 오류코드, 결과 Artifact를 가진다.

### 10.5 감사

다음 행위는 반드시 Audit Log에 남긴다.

- 로그인·실패·권한 거부
- 자산 생성·수정·검토 요청·승인·반려·중단·폐기
- 파일 업로드·다운로드·Bundle 생성
- Desktop Package Import·검증 실패·설치·삭제
- Agent 실행·취소·오류
- Knowledge 검색과 MCP Tool 호출의 요약 정보
- 정책·사용자·역할 변경

Prompt 원문, 전체 문서, DB 전체 결과는 기본 로그에 남기지 않는다.

## 11. 비기능 요구사항

| ID | 항목 | 기준 |
|---|---|---|
| NFR-01 | 보안 | 최소 권한, 서버 측 권한검사, 비밀정보 분리, Checksum 검증 |
| NFR-02 | 폐쇄망 | 인터넷 없이 설치·실행·진단 가능 |
| NFR-03 | 재현성 | Lockfile, Manifest, Profile, Hash로 동일 빌드 재현 |
| NFR-04 | 관측성 | 요청·Job·Agent Run·MCP Tool을 Trace ID로 연결 |
| NFR-05 | 접근성 | Portal은 키보드 사용, 명확한 라벨, 충분한 대비 제공 |
| NFR-06 | 안정성 | 취소·Timeout·재시도·부분 실패 복구 제공 |
| NFR-07 | 호환성 | Windows 10/11 Desktop PoC, 중앙 서버는 컨테이너 실행 가능 |
| NFR-08 | 성능 | Portal 목록 P95 2초 이내, 로컬 검색 P95 2초 이내를 PoC 목표로 측정 |
| NFR-09 | 확장성 | 파일 저장소·LLM·Vector DB·인증은 Adapter 교체 가능 |
| NFR-10 | 유지보수 | 모듈 간 직접 Import 금지, 계약 테스트, 작은 PR |

성능 기준은 하드코딩된 성공 조건이 아니라 PoC 측정 기준선이다. 대상 PC 사양과 문서 크기를 평가 결과에 함께 기록한다.

## 12. PoC 필수 범위

- Portal 자산 카탈로그, 상세, 등록, 버전, 단순 승인, 다운로드
- 파일 시스템 Asset Repository
- Offline Bundle 생성과 Checksum
- PySide6 Desktop Client의 Import, Agent 목록, 채팅, 상태, 로그
- Agent Runtime의 Ollama, Local Knowledge, MCP Client, Citation
- Manifest/Profile Schema와 Validator
- Recursive, Markdown, Parent-Child 청킹
- Vector, BM25, Hybrid RRF 검색
- Knowledge Package와 평가 질문, Recall@5, 검색시간
- 단계형 AI Service Composer와 Service Manifest 검증
- 등록 Knowledge 챗봇 Quick Create, 실제 Preview, 내부 URL 게시와 Hosted Chat
- Office MCP의 Oracle Mock 또는 승인된 읽기 전용 Connector
- DB Metadata와 Table Count Tool
- 역할 기반 Portal 접근, 승인 상태, 감사 로그
- 계약 테스트와 대표 E2E 시나리오

## 13. PoC 제외 범위

- Langflow, 자유형 Drag & Drop Canvas, 임의 코드 실행이 가능한 범용 중앙 Playground
- 외부 인터넷 익명 챗봇 Hosting과 사용자 지정 Domain 자동 발급
- 사용자 임의 Python 실행
- 쓰기·변경·삭제형 MCP Tool
- 자동 원격 Desktop 업데이트
- 완전한 PKI와 회사 전자서명 인프라 통합
- Graph 기반 지식 검색, Semantic Chunking, LLM Reranking
- 여러 Vector DB의 동시 지원
- 중앙에서 폐쇄망 Client 사용량을 실시간 수집하는 기능
- 전사 SSO의 실제 운영 연동; PoC는 인증 Adapter와 개발용 사용자로 검증

## 14. 구현 순서

### Phase 0: 저장소와 계약

- 모노레포 디렉터리와 공통 개발 명령 생성
- M06 Manifest/Profile Schema 확정
- M02 OpenAPI 초안, M05 Local Runtime API, M08 Search Contract, M10 MCP Tool Schema 확정
- Sample Asset과 Mock 생성
- CI에서 Schema와 Contract Test 실행

### Phase 1: 독립 코어

- Portal Registry/API와 Mock Portal UI
- Knowledge Indexing Runtime과 HR Policy Sample Knowledge
- Search Runtime과 검색 평가
- MCP Server와 Mock DB Tool
- Agent Runtime의 Ollama·Knowledge·MCP Adapter
- Service Composer의 단계형 구성·호환성 검증·Service Package 생성

### Phase 2: 사용자 흐름

- Portal 등록·검토·다운로드 화면
- Bundle 생성·검증
- Desktop Import·Preflight·채팅·상태 화면
- Agent 전체 실행 흐름

### Phase 3: 보안·품질·배포

- RBAC·Audit·Checksum·Revocation Hook
- Contract·Integration·E2E·Security Test
- Windows Installer와 오프라인 설치 가이드
- 데모와 인수 보고서

## 15. 최종 인수 시나리오

다음 시나리오가 한 환경에서 재현되어야 PoC를 완료로 본다.

1. Portal에 HR 규정 Knowledge와 규정 검색 Agent를 등록한다.
2. Manifest와 Profile 자동 검증을 통과한다.
3. 기술 검토와 배포 승인을 완료한다.
4. Agent, Knowledge, Prompt, Service Definition, Office Profile이 포함된 Offline Bundle을 만든다.
5. Bundle을 폐쇄망 Test PC에 복사한다.
6. Desktop Client가 Checksum과 호환성을 검사한다.
7. 필요한 Ollama 모델과 MCP 연결 상태를 확인한다.
8. 사용자가 “아이 돌봄 때문에 장기간 쉬는 제도는?”이라고 질문한다.
9. Search Runtime이 Hybrid 검색으로 육아휴직 규정을 찾는다.
10. Agent Runtime이 문서 근거와 출처를 포함해 답변한다.
11. DB Metadata가 필요한 두 번째 질문에서 읽기 전용 MCP Tool을 호출한다.
12. Portal·Desktop·Runtime·MCP 로그가 동일 Trace ID로 연결된다.
13. 승인되지 않은 변조 Bundle은 설치가 거부된다.
14. 모든 테스트 결과와 제한사항이 인수 보고서에 기록된다.

## 16. 공통 Definition of Done

기능은 다음 조건을 모두 만족해야 완료다.

- 요구사항 ID와 구현 코드 또는 테스트가 연결된다.
- 정상·빈 결과·권한 부족·입력 오류·외부 장애를 처리한다.
- 단위 테스트가 존재한다.
- 다른 모듈과 연결되는 경우 Contract Test가 존재한다.
- 사용자 화면은 Loading·Empty·Error·Permission 상태를 제공한다.
- 로그에 Trace ID가 있고 민감정보가 포함되지 않는다.
- 새 설정과 환경변수가 문서화되어 있다.
- Sample 또는 Fixture로 독립 실행할 수 있다.
- 교차 검토자가 테스트 증거를 확인한다.
- 변경된 API/Schema/Manifest 문서가 코드와 일치한다.
