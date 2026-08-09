# PoC 인수 보고서

문서 상태: 갱신판 — 2026-08-09 세션 재검증 기준
대상 모듈: M12 (QA/Integration/Docs)
근거 문서: `README.md`, `progress-log.md`, `open-decisions.md`, `06-quality-delivery.md` §13, `09-functional-requirements-matrix.md`

이 문서는 초안 이후 여러 세션에 걸쳐 "UPDATE (날짜)" 블록을 원문 위에 계속 덧붙이는 방식으로 갱신되어 왔다. 그 결과 문서 앞부분(특히 §3 제외 기능)이 실제로는 이미 구현된 것을 "미구현"이라 말하고, 뒷부분(§5 E2E 결과)이 이미 존재하는 `tests/e2e/`·`tests/security/`를 "존재하지 않는다"고 말하는 모순이 쌓였다. 이번 개정은 그 레이어를 걷어내고 **현재 시점 기준으로 다시 쓴 것**이다 — 다만 지금도 유효한 과거의 발견(회귀 사고, 임계값 튜닝 경위 등)은 삭제하지 않고 결정 id(D-0xx)로 인용해 감사 추적을 남긴다. 상세 경위는 `open-decisions.md`와 `progress-log.md` 원문을 참고한다.

## 0. 이 문서를 읽는 방법 — 라벨 정의

이 보고서는 모든 동작 확인 항목에 아래 세 라벨 중 하나를 명시한다. 라벨이 없는 "동작함" 서술은 없다.

- **자동 테스트 검증** — `tests/` 아래 실제로 존재하고 현재 통과하는 테스트로 커버됨. 회귀가 발생하면 CI/로컬 테스트 실행 시 잡힌다.
- **수동 검증(세션 내)** — 개발 세션 중 실제 살아있는 서비스에 대해 사람이 직접 실행해 확인함(근거를 함께 명시). 자동 테스트가 없으므로 이후 코드 변경이 이를 깨뜨려도 아무 것도 알려주지 않는다. **이 라벨 안에서도 "지금 이 순간 응답 중인 바로 그 프로세스에 대해 확인했는가"와 "같은 코드를 별도 임시 인스턴스에 띄워 확인했는가"는 다르다** — 후자는 §4에서 "재기동 대기"로 별도 표시한다.
- **미검증** — 코드는 존재하나 실행/확인된 적이 없거나, 애초에 구현되지 않았다.

라벨을 보고서 스스로에게 유리하게 올려 붙이지 않는다. 특히 브라우저에서 직접 눌러본 것이 아니라 임시 인스턴스에 curl로 확인한 것은 "수동 검증(세션 내)"이라도 §4/§5에서 그 조건을 함께 밝힌다.

## 1. 목표와 범위

`docs/implementation-spec/README.md` §3에 정의된 대로, Enterprise AI Asset Hub는 Portal이 모든 AI 실행을 담당하는 단일 서비스가 아니라 Agent/Knowledge/MCP Tool/Prompt/Office Profile/AI Service Package를 표준화·검토·배포하고, 실제 실행은 Desktop Local Runtime 또는 별도 Hosted Agent Runtime이 담당하는 분산형 플랫폼이다.

이번 PoC의 목표는 README §15 "최종 인수 시나리오" 14단계와 CLAUDE.md가 요구하는 "발표 MVP"(등록된 Knowledge로 챗봇을 빠르게 구성 → 실제 Preview 테스트 → 내부 URL로 게시)를 한 개발 환경에서 재현하는 것이다. §12 PoC 필수 범위는 다음을 포함한다.

- Portal 자산 카탈로그·상세·등록·버전·단순 승인·다운로드
- 파일 시스템 Asset Repository, Offline Bundle 생성과 Checksum
- Electron(D-030) Desktop Client의 Import/Agent 목록/채팅/상태/로그
- Agent Runtime의 Ollama/Local Knowledge/MCP Client/Citation
- Manifest/Profile Schema와 Validator
- Recursive/Markdown/Parent-Child 청킹, Vector/BM25/Hybrid RRF 검색
- Knowledge Package와 평가(Recall@5, 검색시간)
- 단계형 AI Service Composer와 Service Manifest 검증
- 등록 Knowledge 챗봇 Quick Create·실제 Preview·내부 URL 게시와 Hosted Chat
- Office MCP의 읽기 전용 Connector(Mock 또는 승인된 것), 역할 기반 접근, 감사 로그
- 계약 테스트와 대표 E2E 시나리오

이 보고서 자체가 **개발자 1인 macOS 워크스테이션에서 Mock/Fixture 데이터로 수행한 PoC 검증 결과**이며, 운영 준비도(Production Readiness) 평가가 아니다. 실 사용자, 실 사내 데이터, 실 네트워크/폐쇄망 장비, 실 SSO는 어디에도 관여하지 않았다.

## 2. 구현된 모듈·화면·API

`progress-log.md`의 모듈별 현황표를 근거로 한 요약이다(상세 진행 이력은 원문 참고). 더 이상 스텁 상태인 모듈은 없다(파일 수: `knowledge-packager` 13, `evaluation-runner` 12, `security-policy` 6, `schemas` 3, `observability` 4, `agent-runtime` 17, `indexing-runtime` 13, `search-runtime` 6, `distribution-service` 7, `office-mcp-server` 15, `portal-api` 34, `desktop-client` 27).

| 모듈 | 상태 | 핵심 구현 |
|---|---|---|
| M01 `apps/portal-web` | 부분 구현 | 23개 화면(`page.tsx`). 대시보드, 자산 카탈로그/검색/필터, 자산 상세(버전 이력·인덱싱 정보·청크 태그 편집), Knowledge 등록 폼, 버전 관리(P06), 내 자산(P07), 검토함/검토 상세, 게시 관리(중단/재개/롤백), 감사 로그, **10단계 AI Service Composer(P18, `/services/new`)**·Service 목록/상세(P17/P19), 3→4단계 Knowledge 챗봇 Quick Create Wizard(지식 선택→설정→Preview→게시), `/chat/[slug]` Hosted Chat 화면, **Knowledge 품질(P12)**·**수명주기/회수(P16)**·**다운로드 이력(P13)**·**관리자 설정(P15, 읽기 전용)** 화면. Tailwind v4 디자인 시스템 적용. 아래 §3에서 지적하듯 P00(로그인/접근거부)과 P04/P05(범용 자산 유형 선택+등록 Wizard)에 대응하는 전용 라우트는 없다 |
| M02 `apps/portal-api` | 부분 구현 | 자산 CRUD/등록/검토(TECHNICAL→SECURITY→RELEASE 순차 승인)/Service·Deployment/게시·중단·재개·롤백/감사(AuditEvent) API. RBAC을 주요 엔드포인트에 적용. Alembic 마이그레이션(D-043). **ServiceVersion 자체 검토 체인(D-063)**, **Knowledge 평가 저장/조회(P12, `routers/evaluations.py`)**, **수명주기·긴급 회수(P16, `routers/reviews.py`/`revocations`)**, **다운로드 이력(P13, Client IP 최소 감사값 D-064)**, **관리자 설정 읽기 전용 조회(P15, D-065)** 신규 |
| M03 `services/distribution-service` | 구현됨(PoC 수준) | Path Traversal 차단 Storage Adapter, 의존성 해석기, Offline Bundle ZIP 조립(§4.2 레이아웃), RESOLVING→…→SUCCEEDED 단계 머신, 긴급 Revocation Enforcement(P16), **`included_assets[]`에 `asset_version_id` 분리 기록(D-060)** |
| M04 `apps/desktop-client` | 부분 구현(**이 머신에서 Electron 실행 이력 없음**) | Electron 기반. 홈(설치 자산 목록), Bundle 가져오기+사전점검(Zip-slip/심볼릭링크/Zip Bomb/Checksum/Manifest/Revocation 검증), 연결 상태(Ollama/Local Runtime Health), **대화 실행(D06)·실행 상세(D07)·MCP 확인 Panel(D-061)** 화면 신규 추가. 전부 코드·단위 테스트·Vite 브라우저/`curl` 기준으로만 검증했고, Electron 앱으로서 기동된 적은 한 번도 없다(§4 참고) |
| M05 `services/agent-runtime` | 부분 구현 | Local Run API(`/local/v1/runs` + SSE), Hosted Chat API(`/chat-api/v1/*`), Ollama/Search/MCP Adapter, Hallucination Guard(D-036), `MCP_TOOL_CALL` Workflow 단계(D-052), **`WAITING_FOR_USER` 확인/거부/만료 상태 머신(D-061)** |
| M06 `packages/schemas` | 완료(PoC 수준) | Manifest/Profile/API Schema 전체 + Validator. **신규 `policies/`**(`bundle-install-policy.json`) — M02/M04가 서로의 소스를 파싱하지 않고 공유 Contract를 직접 읽도록 정리(D-065 후속 리팩터) |
| M07 `services/indexing-runtime` | 상당 부분 구현 | 로드→Parent-Child 청킹→Ollama 임베딩→Chroma+BM25 색인. `.md/.markdown/.txt`만 지원(PDF/DOCX 없음). Recursive/Markdown/Parent-Child 3종 청킹 전략(D-053). **색인 시점 Classification 스탬핑 + `stamp-classification` CLI(D-062)** |
| M08 `services/search-runtime` | 구현됨 | Hybrid(BM25+Vector+RRF), 관련도 임계값(D-046). **§3.8 Filter/ACL — 강제 Classification 필터(요청에서 재정의 불가), UNKNOWN 레거시 Chunk Fail-closed 기본 정책(D-062)** |
| M09 `packages/evaluation-runner`, `packages/knowledge-packager` | 둘 다 구현됨(PoC 수준) | Recall@K/MRR/Latency/forbidden_hit_rate 계산, Quality Gate, 버전 비교, Data Card 생성. Package Assembler(§4.1) 7개 검증(Manifest 파일 목록/Record 수 대사/Child→Parent 참조 무결성/Chunk ID 일치/Profile Model Identity/Secret Pattern/Checksum), 실물 데이터로 FATAL 검출·정리(relativization) 실증(D-054). `bm25.pkl`은 절대 unpickle하지 않는 안전한 opcode-level 파서로 검증 |
| M10 `services/office-mcp-server` | 상당 부분 구현 | READ_ONLY Tool Registry, `db_metadata.get_tables/get_columns`, `table_count.query`, 권한/실행통제/Output Filter/Audit/Kill Switch. M05의 `WAITING_FOR_USER` 도입(D-061) 이후에도 자기 자신의 §8.4 정책을 독립적으로 재검증(M10 자체 코드 변경 없음) |
| M11 `packages/security-policy` | 구현됨(PoC 수준) | Role/Permission Matrix(7역할), 상태 전이표, 검토 단계 체인. **Classification enum + Clearance 비교(D-062, M07/M08 공용)**, **Secret Redaction 헬퍼(D-065)** |
| M12 `tests` | 부분 구현 | 아래 §5 참고. `tests/e2e/`·`tests/security/` 모두 존재하고 CI에서 별도 마커로 실행 가능 |

## 3. 제외 기능

README §13 PoC 제외 범위(그대로 미구현): Langflow/자유형 Drag&Drop, 외부 인터넷 익명 챗봇 Hosting, 사용자 임의 Python 실행, 쓰기형 MCP Tool, 자동 원격 Desktop 업데이트, 완전한 PKI/전자서명, Graph 기반 검색/Semantic Chunking/LLM Reranking, 다중 Vector DB 동시 지원, 폐쇄망 사용량 실시간 수집, 전사 SSO 실연동.

이 외에 PoC 범위 내였으나 실제로 미구현/부분 구현으로 남은 항목(progress-log 근거) — 이 절은 이전 버전 문서가 "미구현"으로 기록했던 항목 중 이후 실제로 구현이 완료된 것들을 바로잡는다.

- **Service Composer(비-Knowledge 서비스용)는 이제 존재한다.** 이전 버전 문서는 "Knowledge 챗봇 전용 Wizard만 구현되었고 범용 서비스 구성 Wizard는 없다"고 기록했으나, 2026-08-06 `app/services/new/`에 10단계 AI Service Composer(기본정보→모델정책→Agent→Knowledge→MCP→Prompt→제한·보안→구성검증→Preview→요약·저장)가 구현되었고 실제로 서비스를 만들어 `POST /api/v1/services`→`POST /service-versions/{id}/validate`(5개 검사 전부 통과)까지 브라우저에서 검증되었다(**수동 검증(세션 내)**). Service Definition Schema에 입력/출력 정의 필드 자체가 없어 명세 §5의 단계 7·8(입력/출력 정의)은 화면에 "스키마에 필드 없음"이라는 사유와 함께 비활성 표시된다 — 이것은 생략이 아니라 존재하지 않는 계약을 지어내지 않은 것이다. `mcp_bindings`도 MCP Tool이 Portal Registry에 등록되어 있지 않아(D-034) 항상 빈 배열이며 그 사유가 화면에 명시된다.
- **Desktop 채팅 실행 화면(D06/D07)도 이제 존재한다.** 2026-08-08 `ChatScreen.tsx`/`RunDetailPanel.tsx`/`ConfirmationPanel.tsx`가 추가되어 실행/취소/재시도/Citation 표시/MCP Tool 확인까지 코드·단위 테스트·Vite 브라우저(`curl` 병행)로 검증됐다. 다만 §4에서 설명하는 이유로 **Electron 앱 자체에서는 한 번도 확인되지 않았다** — "구현됨"과 "Desktop에서 동작 확인됨"은 다른 주장이다. D01(최초 설정 Wizard), D03(Service/Agent 상세), D08(자산 관리 상세), D10~D13은 여전히 미구현이다.
- **`packages/knowledge-packager`는 완료되어 있다.** `tests/unit/knowledge_packager/`(82개)와 실제 재택근무 정책 인덱스(`d9e660b7-ca76-4f46-899e-2e1621bac139`) 대상 `package-knowledge build`/`verify`로 **자동 테스트 검증 + 수동 검증(세션 내)** 모두 확보됐다(§4.1 7개 검증이 실물 데이터에서 FATAL을 실제로 검출·`--relativize-source-paths`로 정리함을 확인, D-054). 남은 **미검증/미구현**: ACL Test·Package Smoke Test는 여전히 Gate 밖(D-045, 대상 데이터셋 부재), `bm25.pkl`의 비실행 직렬화 포맷 전환(D-054, 현재는 안전한 opcode-level 파서로 우회), Chroma HNSW 세그먼트 바이너리(`data_level0.bin`)의 미초기화 메모리 유출은 의도적으로 미해결 상태로 FATAL 유지 — 즉 **실제 데이터로는 완전히 클린한 Package를 오늘 시점에 만들 수 없다.**
- **Windows Desktop Installer 실제 빌드/서명**: `electron-builder.yml` 설정 파일만 존재하고 실제 `.exe` 빌드나 코드 서명은 실행되지 않았다(인증서 부재 D-048, 사내 npm 미러 부재).
- **ONLINE 단일 다운로드 모드, Bundle Signature/PKI**: 명시적으로 범위 밖(D-016).
- **ServiceVersion 자체의 검토/승인 Workflow**: 구현되어 있다(D-063) — AssetVersion과 동일한 TECHNICAL→SECURITY→RELEASE 체인을 `POST /service-versions/{id}/submit`으로 시작할 수 있다. **의도적으로 남겨둔 PoC↔운영 공백**: 이 체인을 통과하지 않아도 게시가 가능하다 — 신규 설정 `require_service_version_approval`(기본 `False`)이 강제 여부를 결정하며, 기본값 False는 CLAUDE.md의 발표 MVP 흐름과 이미 게시된 4개 ACTIVE 데모 챗봇(전부 ServiceVersion.status=DRAFT)을 보존하기 위한 **의도된 선택**이지 누락이 아니다. 운영 전환 시 이 설정을 `True`로 켜야 "승인된 Service만 배포"가 실제로 강제된다.
- **Desktop→Local Agent Runtime 실제 채팅 연동**은 코드로는 존재하지만(D06), agent-runtime의 CORS 허용 목록이 Desktop Origin(Vite `:5174`, 패키징된 Electron의 `file://`/`null` Origin)을 포함하지 않아(D-035) **브라우저 기반 렌더러에서는 오늘 시점에 전혀 동작하지 않는다**(D-059, 신규 발견). agent-runtime:8100은 재시작 금지 대상이라 이번 세션에서 이 CORS 목록을 고치지 않았다.
- **MCP Tool 사용자 확인(`WAITING_FOR_USER`)**: 구현되어 있다(D-061) — `ALWAYS`/`ON_PARAMETER` Tool도 이제 무조건 거부되지 않고 승인/거부/만료 흐름을 탄다. 다만 아래 §4가 설명하듯 지금 응답 중인 라이브 agent-runtime:8100은 이 코드보다 오래된 버전이라 **이 기능은 라이브 스택에서는 아직 재확인되지 않았다.**
- **의존성 취약점 스캔 Hook, 침투 테스트**: 전혀 구현/실행되지 않음(§8 참고).

## 4. 실행 환경과 설치 절차

이 보고서를 작성한 시점 실행 환경은 다음과 같다(모두 read-only 확인, 서버 재시작 없음).

- OS: macOS(darwin) 개발 워크스테이션 1대. 배포 목표(D-005)는 Windows 10/11이며 별도로 검증되지 않음.
- Python 패키지 관리: `uv`(D-031), Node/TS 패키지 관리: `pnpm`.
- 로컬에서 이미 기동 중이던 서비스와 `/health` 응답(모두 200, 이 세션에서 재시작하지 않음):

  | 서비스 | 포트 | 상태 |
  |---|---|---|
  | portal-api (M02) | 8000 | ok |
  | agent-runtime (M05) | 8100 | ok |
  | indexing-runtime (M07) | 8200 | ok |
  | search-runtime (M08) | 8300 | ok |
  | distribution-service (M03) | 8400 | ok |
  | office-mcp-server (M10) | 8500 | ok |
  | Ollama | 11434 | 응답함, 모델 `exaone3.5:7.8b`(Chat)·`qwen3-embedding:0.6b`(Embedding)·`qwen2.5-coder:3b` 확인 |
  | portal-web (M01) | 3000 | 응답함(200) |
  | desktop-client Vite 개발 서버 | 5174 | **이 세션 시점 기동되어 있지 않음**(연결 거부) |

- Desktop Client(M04, Electron)는 **이 머신에서 한 번도 앱으로 기동된 적이 없다.** `apps/desktop-client/node_modules/electron/dist/`에 실행 바이너리가 없다(LICENSE/version 파일만 존재) — macOS XProtect가 2026-08-04 postinstall 단계에서 공개 인터넷 GitHub 배포본을 악성코드로 오탐해 격리·삭제한 사건이 원인이다. 이후 모든 D06/D07/D-061 화면 검증은 Electron 브릿지 없이 Vite(`:5174`) 단독 구동 + Playwright 브라우저 + `curl`로만 수행됐다. 이 보고서에서 "Desktop 앱 실행"이 필요한 모든 항목은 미검증으로 표기한다.

### 재기동 대기 — "구현·검증됨"과 "라이브 스택에 반영됨"의 구분

위 8개 포트의 프로세스는 **이 세션 이전부터 떠 있었고, 재시작 금지 제약(bundle/asset DB·인덱스 read-only 포함) 때문에 이번 세션의 최신 코드를 반영하지 않은 채로 계속 응답해왔다.** 즉 아래 기능들은 코드 수준에서는 구현·테스트되어 있지만, **"방금 curl로 확인한 8000/8100/8300 프로세스가 그 코드를 실행 중"이라는 의미의 검증은 아니다** — 별도 임시 포트(:8003/:8102/:8202/:8302 등)에 새 인스턴스를 띄워 확인했거나, 브라우저 화면 자체는 눌러보지 않았다.

- **P12 Knowledge 품질, P16 수명주기·회수, P07 내 자산, ServiceVersion 검토 UI, P13 다운로드 이력, P15 관리자 설정**: 백엔드는 임시 `:8003` 인스턴스(동일 `portal.db`, 포트만 다름)에 대해 `curl`로 검증했다. 화면 자체를 브라우저에서 라이브 portal-api(:8000)/portal-web(:3000)에 대해 눌러본 적은 없다 — 즉 API 계약과 RBAC은 **수동 검증(세션 내)**, UI happy path는 **미검증**이다.
- **Desktop 대화(D06/D07), MCP 확인 Panel(D-061)**: 임시 `agent-runtime:8102`(및 3초 타임아웃 확인용 `:8103`) 인스턴스에 대해 Playwright + `curl`로 검증했다. 라이브 `agent-runtime:8100`은 여전히 D-052 이전 코드라 CORS(D-059)와 `WAITING_FOR_USER`(D-061) 둘 다 반영되어 있지 않다 — 실제로 `make e2e-test`를 라이브 `:8100`에 대해 실행하면 `test_e2e_02_user_confirmation_required_then_allowed`/`test_e2e_02_user_denies_confirmation_and_run_ends_cleanly` 2건이 "실행 중 agent-runtime이 `WAITING_FOR_USER` 확인 흐름(D-061) 이전 버전"이라는 사유로 skip된다(이번 세션에 재확인, §5.3 참고).
- **Knowledge Search ACL(D-062)**: 임시 `:8202`/`:8302` 인스턴스 + 스크래치패드 복사 인덱스로 검증했다(`data/indexes/`는 손대지 않음). 라이브 `search-runtime:8300`은 이 필터링 코드 이전 버전이며, **이 기능이 실제로 효력을 갖는 순간(재기동 시) 게시된 4개 데모 챗봇을 포함한 기존 인덱스 전부가 Classification 메타데이터 없음(UNKNOWN)으로 Fail-closed 되어 검색 결과 0건이 된다** — 재기동 전 운영자가 `stamp-classification` CLI를 실제 `data/indexes/`에 실행해야 한다. 이번 세션은 재기동 금지 제약에 따라 이 실행을 하지 않았다.

이 구분은 지엽적이지 않다 — 데모를 보는 사람이 "P12 화면이 브라우저에서 이렇게 동작한다"를 확인한 적은 이 보고서 기준으로 없다는 뜻이다.

- 설치 절차 문서화 수준: `Makefile`에 `migrate`/`migration`/`migrate-status`/`dev-*` 타겟이 있고, Alembic으로 스키마를 관리한다(D-043). 폐쇄망 의존성 반입 절차는 `11-desktop-packaging-and-distribution.md` §5에 문서화되어 있으나 **실제 폐쇄망 장비에서 실행/검증된 적은 없다** — 전부 같은 개발망 macOS 워크스테이션에서 문서만 작성됐다.

## 5. E2E 결과

### 5.1 자동 E2E/보안 테스트 스위트

`tests/e2e/`와 `tests/security/`는 모두 존재하며, 이 저장소가 처음으로 갖춘 **Fake/Mock이 아니라 실제로 기동 중인 서비스(portal-api:8000, agent-runtime:8100, indexing-runtime:8200, search-runtime:8300, distribution-service:8400, office-mcp-server:8500, Ollama:11434)에 대해 실행되는** 자동 테스트 스위트다. `tests/e2e/`를 만든 직접적 계기는 2026-08-06의 회귀 사고였다: Chunking 변경으로 문서가 4개 Chunk에서 1개로 붕괴해 게시된 챗봇이 실제 질문("장비 지원은 무엇이 있나요?")에 0 Citation으로 응답했지만, Chunker 단위 테스트 60개와 평가 Quality Gate는 모두 PASS를 유지했다 — Fake 기반 테스트로는 이 결함을 잡을 수 없었다는 것이 실측으로 확인된 사례다. `tests/security/`는 이후 세션에 신설되어 05-mcp-security-governance.md §12/§13(위협 시나리오)을 대상으로 하는 동일한 실행 모델의 교차-서비스 보안 스위트다.

현재 저장소의 `tests/` 디렉터리 구성:

```
tests/contract
tests/e2e                          (06-quality-delivery.md §8 E2E-01~10)
tests/security                     (05-mcp-security-governance.md §12/§13)
tests/integration/agent_runtime
tests/integration/portal_api
tests/unit/distribution_service
tests/unit/evaluation_runner
tests/unit/indexing_runtime
tests/unit/knowledge_packager
tests/unit/observability
tests/unit/office_mcp_server
tests/unit/search_runtime
tests/unit/security_policy
```

**실행 모델**: `tests/e2e/conftest.py`/`tests/security/conftest.py`의 세션 범위 Liveness Gate가 필요한 서비스의 Health를 세션 시작 시 한 번 점검하고, 하나라도 응답하지 않으면 전체 스위트를 Skip한다(Fail이 아님 — Ollama 없는 CI 환경을 오염시키지 않기 위함). 모든 테스트가 `@pytest.mark.e2e`/`@pytest.mark.security`로 표시되고, 루트 `pyproject.toml`의 `addopts = "-m 'not e2e and not security'"`가 기본 실행에서 이를 제외한다. 별도 실행은 `make e2e-test`/`make security-test`를 사용한다.

**실측 결과(이 보고서 작성 중 직접 재실행)**:

| 스위트 | 명령 | 결과 |
|---|---|---|
| 기본(오프라인) 스위트 | `uv run pytest tests/ -q` | **699 passed, 92 deselected** |
| ↳ `tests/contract` | | 23 |
| ↳ `tests/unit` | | 487 (`security_policy` 77, `distribution_service` 43, `evaluation_runner` 49, `observability` 20, `office_mcp_server` 110, `search_runtime` 35, `indexing_runtime` 71, `knowledge_packager` 82) |
| ↳ `tests/integration` | | 189 (`agent_runtime` 32, `portal_api` 157) |
| E2E(실 서비스 대상) | `make e2e-test` | **15 passed, 13 skipped**(~42초) |
| 보안(실 서비스 대상) | `make security-test` | **63 passed, 1 skipped**(~17초) |
| Desktop 단위(Vitest) | `pnpm --filter desktop-client test` | **66 passed** (Electron 자체는 기동하지 않음 — `bundle-verify.ts`/`bundle-install.ts` 순수 함수) |
| Lint | `uv run ruff check .` | **0 errors** |
| Contract | `make contract-test` | **23 passed** |
| TypeScript | `pnpm --filter portal-web typecheck` / `pnpm --filter desktop-client typecheck` | clean |

`699 passed`는 `tests/e2e`·`tests/security`를 제외한 것이며(`addopts`), `make e2e-test`/`make security-test`로 별도 실행한 결과가 각각 15/13과 63/1이다. `tests/e2e`·`tests/security`는 기본 스위트와 겹치지 않으므로 그대로 합산하면 이 저장소가 보유한 테스트는 총 791개(699 + 28 + 64)다.

**데이터 위생**: `tests/e2e`/`tests/security`는 `apps/portal-api/portal.db`의 기존 시딩 데이터(Knowledge 3종, Service 6종, 게시된 Deployment 4종 — Slug `remote-work-guide`/`langchain`/`remote-work-approved`/`unapproved-test`)를 전혀 삭제·재생성·재인덱싱하지 않으며, 이 4개 Deployment의 상태도 변경하지 않는다. 대신 매 테스트가 `e2e-`/고유 접미사로 자기만의 Asset/Service/Deployment를 새로 만들어 반복 실행할수록 누적된다(재실행 가능성을 위한 의도된 동작) — 운영 전 별도 정리(Cleanup Job 또는 수동 삭제)가 필요하다는 점은 §11에 남긴다.

### 5.2 최종 인수 시나리오 14단계 (README §15)

| # | 시나리오 | 라벨 | 근거 |
|---|---|---|---|
| 1 | Portal에 HR 규정 Knowledge와 규정 검색 Agent 등록 | 수동 검증(세션 내) | Knowledge를 실제로 등록(`POST /api/v1/assets`)해 인덱싱까지 확인. Agent는 Registry에 등록되지 않고(D-034) 정적 config로만 존재 — "Agent 등록"은 해당 사항 없음 |
| 2 | Manifest/Profile 자동 검증 통과 | 자동 테스트 검증 | `tests/contract`(23개, Schema Validator 대상) |
| 3 | 기술 검토와 배포 승인 완료 | 자동 테스트 검증 + 수동 검증(세션 내) | `tests/integration/portal_api`로 TECHNICAL→SECURITY→RELEASE 체인 커버, 실제 3단계 승인(다른 역할 토큰)을 브라우저/API로 검증한 기록(2026-08-03) |
| 4 | Agent/Knowledge/Prompt/Service Definition/Office Profile이 포함된 Offline Bundle 생성 | 수동 검증(세션 내) | 승인된 재택근무 Knowledge로 실제 번들 생성·다운로드·`unzip`+`shasum -a 256 -c` 무결성 확인. Agent/Prompt는 Registry 부재로 정적 사본 포함(D-044) |
| 5 | Bundle을 폐쇄망 Test PC에 복사 | 미검증 | 폐쇄망 Test PC 자체가 없음 — 전 과정이 동일 개발망 macOS 1대에서 수행됨 |
| 6 | Desktop Client가 Checksum/호환성 검사 | 자동 테스트 검증(부분) | `electron/bundle-verify.ts`의 순수 함수(Checksum/Manifest/Runtime 호환성 등)는 Vitest 44개로 커버. Electron 바이너리 부재로 **실제 Desktop 앱을 통한 종단 실행은 미검증**(§4) |
| 7 | 필요한 Ollama 모델과 MCP 연결 상태 확인 | 수동 검증(세션 내) | `curl`로 Ollama(exaone3.5:7.8b, qwen3-embedding:0.6b)와 office-mcp-server(:8500) Health 직접 확인. Desktop UI(`ConnectionsScreen`)를 통한 확인은 미검증(§4) |
| 8 | "아이 돌봄 때문에 장기간 쉬는 제도는?" 질문 | 미검증(정확히 이 문구로는) | 실제 검증된 질문 세트는 재택근무 정책 대상 WFH-001~006이며, 육아휴직 관련 문서/질문에 대한 실행 기록은 없다(대상 코퍼스에 해당 문서가 없음). 동일한 종류의 자유 질의 자체는 다른 문서로 수동 검증됨(§5.3 E2E-09) |
| 9 | Search Runtime이 Hybrid 검색으로 관련 규정 검색 | 자동 테스트 검증 + 수동 검증(세션 내) | `tests/unit/search_runtime`(35개) + 실제 search-runtime(:8300)으로 재택근무 정책 문서 Recall@5 100% 확인(§6). 육아휴직 문서 자체는 이 데이터셋에 없음 |
| 10 | Agent Runtime이 문서 근거·출처 포함 답변 | 수동 검증(세션 내) | 실제 Ollama 스트리밍 답변 + 정확한 Citation을 브라우저에서 확인(2026-08-03). Desktop 경로는 CORS 문제로 브라우저에서 차단되어 미검증(D-059, §4) |
| 11 | DB Metadata 질문에서 읽기 전용 MCP Tool 호출 | 수동 검증(세션 내) + 자동 테스트 검증(부분) | `tests/integration/agent_runtime`(32개) + 실제 office-mcp-server(:8500)에 `db_metadata.get_columns` 직접 호출, SQL Injection 시도(`MCP_INPUT_INVALID`) 거부 확인. Desktop UI를 통한 실행 경로는 미검증(§4, D-058 — 정식 Tool 선택 UI 자체가 없음) |
| 12 | Portal·Desktop·Runtime·MCP 로그가 동일 Trace ID로 연결 | 수동 검증(세션 내), Desktop 제외 | agent-runtime→search-runtime→office-mcp-server 로그가 동일 `trace_id`/`run_id`로 연결됨을 확인, `tests/security/test_security_08_trace_correlation.py`(4개)로 거부/허용 MCP 호출 양쪽의 Trace 연결을 자동 검증. **Desktop 경로는 Desktop이 이 Trace 체인에 참여한 적이 없어 포함되지 않음** |
| 13 | 변조된 Bundle 설치 거부 | 자동 테스트 검증(부분) | `tests/e2e/test_e2e_03_package_tamper.py`가 실 distribution-service로 만든 Bundle을 변조해 `bundle-verify.ts`의 검증 로직(Python 이식)으로 정확히 그 파일만 mismatched로 식별됨을 확인. **Bundle 생성→변조→Desktop Import 거부까지의 종단 흐름은 미검증**(Desktop 실행 불가, §4) |
| 14 | 모든 테스트 결과와 제한사항이 인수 보고서에 기록 | 이 문서로 충족 | — |

### 5.3 10개 E2E 시나리오 (06 §8)

각 시나리오는 "현재 시스템이 실제로 지원하는 부분은 실 서비스 대상 자동 테스트로 커버하고, 지원하지 않는 부분은 조용히 생략하지 않고 `pytest.skip(이유)`로 명시한다"는 원칙으로 설계되어, 대부분 "자동 테스트 검증(부분) + 미검증(Skip, 사유 명시)"의 혼합 라벨을 갖는다. 아래는 이번 세션에 `uv run pytest tests/e2e tests/security -m "e2e or security" -q -rs`로 재실행해 확인한 실제 Skip 사유다.

| ID | 시나리오 | 라벨 | 비고 |
|---|---|---|---|
| E2E-01 | Knowledge Service 정상 흐름(등록→Bundle→Desktop Import→질의→Citation→Audit) | **자동 테스트 검증(부분) + 미검증(Skip, 사유 명시)** | `test_e2e_01_knowledge_service.py`: 등록→인덱싱→3단계 승인→게시 Gate→Bundle 생성→실 질의→Citation `section` 일치→Audit/Run 공유 `trace_id`까지 종단 통과. "Agent/Prompt 등록"(D-034, Registry 부재)과 "Desktop Import"(Electron Gatekeeper 격리)는 각각 별도 Skip 테스트로 사유 명시 |
| E2E-02 | MCP 포함 Service(Mock MCP→선택→Desktop 실행→확인→호출→감사) | **자동 테스트 검증(부분) + 미검증(Skip, 사유 명시 — 그 중 2건은 "라이브 재기동 대기")** | `test_e2e_02_mcp_service.py`: 실 `standard-db-agent` Run이 `db_metadata.get_columns`를 호출해 SSE Event 발생과 office-mcp-server Admin Audit의 동일 `trace_id` 조회를 확인. **`WAITING_FOR_USER` 승인/거부 2건은 라이브 agent-runtime:8100이 D-061 이전 코드라 skip**("실행 중 agent-runtime이 WAITING_FOR_USER 확인 흐름 이전 버전입니다 — agent-runtime을 재기동하면 이 테스트가 실행됩니다") — 별도 `:8102` 인스턴스로는 통과 확인됨(§4). "Portal을 통한 Tool 등록"(D-049)과 "Desktop 실행"은 별개 사유로 Skip |
| E2E-03 | Package 변조(Checksum 실패→Quarantine) | **자동 테스트 검증(부분) + 미검증(Skip, 사유 명시)** | 변조 전 Clean, 변조 후 정확히 그 파일만 mismatched로 식별됨을 확인. Desktop의 실제 Quarantine 상태 전이는 Electron 불가로 Skip — 감지 로직 자체는 검증됨 |
| E2E-04 | 의존성 누락(부분 설치 없음) | **자동 테스트 검증(부분) + 미검증(Skip, 사유 명시)** | Knowledge 자산 파일 1개를 제거한 뒤 재검증 — `missing=[해당 파일]`로 정확히 식별됨. "부분 설치 없음"은 Desktop 설치 원자성 문제라 Skip |
| E2E-05 | 권한 거부(목록 비노출/직접 API 거부/MCP 거부) | **자동 테스트 검증 + 미검증(Skip, 사유 명시 — 실제 기능 공백)** | CREATOR의 자기 검토 결정/Audit 조회/게시 시도, SECURITY_REVIEWER의 MCP 직접 호출까지 4건 모두 403+감사 DENIED로 통과. **"HR 권한 없는 사용자에게 Service가 목록에서 비노출/접근 거부"는 실제 미구현 공백**(`GET /api/v1/services` 등이 `target_orgs`/`target_roles` 컬럼을 읽기 필터에 반영하지 않음, D-022) |
| E2E-06 | Runtime 장애 복구(강제종료→감지→재시작→정상실행) | **자동 테스트 검증(부분) + 미검증(Skip, 사유 명시)** | 실 agent-runtime 강제 종료는 작업 지침상 금지 — 닫힌 포트 호출이 깔끔한 `TransportError`로 실패함과, 이어서 실 agent-runtime에 새 Run이 정상 성공함을 확인. Desktop의 장애 감지 UI/실제 재시작은 Skip |
| E2E-07 | Knowledge Version 회귀(Recall 미달→승인 차단) | **자동 테스트 검증(부분) + 미검증(Skip, 사유 명시)** | `evaluation-runner`로 실 search-runtime에 두 번 평가 — 실 승인 Knowledge(정상 통과)와 의도적으로 색인이 없는 후보(Recall@5=0.0, Gate 실패, "게시 차단" 권고) 모두 실측. "Portal 승인 절차가 이 Gate 결과를 실제로 참조해 차단"하는 배선은 없음(Skip, 실제 공백 — `routers/reviews.py`에 evaluation-runner 호출자가 없음) |
| E2E-08 | Revocation(중단→신규 Bundle 차단→기존 실행 차단) | **자동 테스트 검증(부분) + 해당 없음(Skip, 사유 명시)** | 자신만의 새 Deployment 게시 후 `GET /chat-api/v1/chatbots/{slug}`가 200 → 중단 즉시 404 → 재개 후 다시 200. "신규 Bundle 생성 차단"은 `POST /api/v1/distributions`가 ASSET_VERSION/SERVICE_VERSION Root 기준이라 Deployment 단위 개념이 아니므로 Skip |
| E2E-09 | 등록 Knowledge 챗봇 URL 게시 전 과정 | **자동 테스트 검증** | 신규 HR 문서 등록→인덱싱→3단계 승인→Quick Create→Preview 질문 3개 실 실행(Citation `section` 일치)→게시 Gate→게시→`/chat/{slug}` 발급→별도 미인증 Client로 SSE 확인→`DEPLOYMENT_PUBLISHED` Audit 조회까지 단일 테스트로 종단 통과(~22초). 2026-08-06 회귀와 동일한 유형("장비 지원" 질문·Citation 검증)의 실패를 잡아낼 수 있는 형태 |
| E2E-10 | Hosted Chat 게시 실패와 Rollback | **자동 테스트 검증(부분) + 미검증(Skip, 사유 명시)** | Revision 1 게시 → 미승인(DRAFT) Knowledge를 참조하는 별도 ServiceVersion 게시 시도가 400으로 거부되면서 기존 URL은 계속 200 → 재게시로 진짜 두 번째 Revision 생성 → Rollback으로 Revision 1 복구까지 확인. **실제 API 공백**: "같은 Deployment/Slug를 다른 Knowledge를 참조하는 새 ServiceVersion으로 업데이트"하는 endpoint(`POST /deployments/{id}/revisions`는 GET만 존재)가 없어 원문 그대로의 "Revision 2가 다른 Knowledge를 참조" 케이스는 Skip |

## 6. Knowledge 품질 결과

`uv run evaluate-knowledge run --dataset fixtures/valid/hr-policy-knowledge/evaluation-dataset.json --knowledge-id d9e660b7-ca76-4f46-899e-2e1621bac139 --knowledge-version 1.0.0`을 살아있는 search-runtime(:8300) 대상으로 재실행하면(가장 최근 재확인 2026-08-06):

```
Recall@1             : 100.0%
Recall@5             : 100.0%
MRR                  : 1.000
검색 결과 없음 비율   : 16.7%
P50 Latency          : 98ms
P95 Latency          : 1176ms
평균 Context Token    : 46
금지 문서 오검색 비율 : 0.0%

Quality Gate: PASS (recall_at_5_min, p95_latency_ms_max, forbidden_hit_rate_max 전부 PASS)
```

Gate 기준은 `packages/evaluation-runner/config/quality-gate.yaml`에서 읽었다(`recall_at_5_min: 0.80`, `p95_latency_ms_max: 2000`, `forbidden_hit_rate_max: 0.0`).

**이 숫자에 반드시 함께 읽어야 할 제한사항(축소·생략 금지):**

1. **평가 데이터셋이 `review_status: AI_GENERATED_UNREVIEWED`다.** `04-knowledge-platform.md` §4.3 원칙("생성형 AI가 만든 질문은 사람 검토 없이 기준 데이터로 사용하지 않는다")에 따라, 이 숫자는 **업무 전문가 검토를 거치기 전까지 공식 품질 기준으로 사용할 수 없다.**
2. **표본이 매우 작다.** 대상 Knowledge는 문서 1건(재택근무 정책, 4개 청크)이고 평가 케이스는 6건(Ground Truth 보유 5건, out-of-scope 1건)뿐이다. 100% Recall은 통계적으로 신뢰구간을 논할 수 있는 규모가 아니라 스모크 신호(smoke signal)에 가깝다. 2026-08-07의 청킹 회귀 사고(§5.1)가 이 표본의 한계를 실제로 증명한 사례다 — 단위 테스트 60개와 이 Gate가 모두 PASS인 동안 실제 챗봇은 응답하지 못하고 있었다.
3. **금지 문서 오검색 비율 0%는 관련도 임계값(D-046, `min_relevance_score`=0.42) 도입 이후의 값이다** — 도입 전(2026-08-03)에는 16.7%로 실패했다.
4. `검색 결과 없음 비율 16.7%`는 6건 중 1건(WFH-006, 의도적 범위 밖 질문)이 결과 없음으로 처리된 것으로, 설계된 동작이며 결함이 아니다.
5. 이 데이터셋으로는 Classification ACL(D-062)이 실제로 콘텐츠를 걸러내는지 측정할 수 없다 — 이 인덱스 자체가 아직 Classification 스탬핑을 거치지 않은 레거시 인덱스다.

## 7. 성능 결과

아래는 위 평가 실행이 **실제로 측정한 지연시간**이며, 부하 테스트(Load Test) 결과가 아니다. 동시 사용자, 지속 부하, 대용량 인덱스 조건에서 측정된 적이 없다.

- 검색(Knowledge Search) P50: 98ms, P95: 1176ms — README §11 NFR-08 목표("로컬 검색 P95 2초 이내를 PoC 목표로 측정")를 이 1회 실행 기준으로는 충족.
- Portal 목록 API의 P95 2초 이내 목표(NFR-08 전반부)는 별도로 측정하지 않았다.
- 측정 조건: 문서 1건·청크 4개 규모의 인덱스, 단일 요청씩 순차 실행(동시성 없음), 개발자 macOS 워크스테이션 1대. 이 수치는 "이 작은 인덱스에서, 이 하드웨어로, 동시 부하 없이 측정한 1회 결과"로만 해석해야 하며, 운영 규모 용량 산정에 사용할 수 없다.
- Classification ACL(D-062)의 강제 필터가 추가된 이후의 지연시간 재측정은 하지 않았다 — 필터가 RRF 융합 이후 top_k 후보에만 적용되는 포스트-필터라 이론적으로는 큰 영향이 없을 것으로 예상되나 실측하지 않았다(미검증).

## 8. 보안 테스트 결과

### 8.1 자동화된 보안 관련 단위/통합 테스트

- `tests/unit/office_mcp_server/`(110개) — SQL Injection/입력 검증 거부, RBAC/Allowlist, 민감정보 Masking, Kill Switch, Timeout/Rate/Row/Byte Limit, Audit Event.
- `tests/unit/distribution_service/`(43개) — Zip-slip·심볼릭 링크 탈출·Checksum 검증, 긴급 Revocation Enforcement(P16, +4).
- `apps/desktop-client/electron/__tests__/`(66개, Vitest) — Zip-slip/심볼릭 링크/Zip Bomb/Checksum 검증의 순수 함수 단위 테스트, D-060(자산 식별자 분리) 회귀 테스트 포함.
- `tests/unit/security_policy/`(77개) — 권한 매트릭스, 버전 상태 전이/불변성, 검토 단계 체인, **Classification 16개(D-062)**, **Secret Redaction 5개(D-065)**.
- `tests/unit/indexing_runtime/`(71개, 신규 포함) — 청킹 3종, **Classification 스탬핑 10개(D-062)**.
- `tests/unit/search_runtime/`(35개) — Hybrid 검색, **Access Control/ACL Filtering 27개(D-062)**.
- `tests/integration/portal_api/`(157개) — 검토 워크플로 RBAC, 게시 Gate, 승인 버전 불변성·중단/재개/롤백, **평가 저장/조회 15개(P12)**, **다운로드 이력 10개(P13)**, **관리자 설정 8개(P15)**, **ServiceVersion 검토 12개(D-063)**.

이 테스트들은 `uv run pytest tests/ -q`(§5.1)의 699개 안에 포함되어 함께 통과한다.

### 8.2 `tests/security/` — 교차-서비스·종단 보안 속성

위 8.1의 단위/통합 테스트는 각 계층을 격리된 상태로 검증하지만, `tests/security/`는 "그 통제가 **실제로 살아있는 시스템을 통해** 끝까지 관철되는가"를 검증한다 — §5.1의 청킹 회귀가 보여주듯 이 구분이 실제로 중요했던 전례가 있다.

| 파일 | 검증하는 속성 |
|---|---|
| `test_security_01_authentication.py` | 인증이 실제로 강제되는가 — Authorization 헤더 누락/Garbage Token/미등록 Token/Basic Scheme 모두 portal-api에서 401 |
| `test_security_02_authorization_bypass.py` | 서버측 권한 검사를 클라이언트가 우회할 수 없는가 — 리뷰 결정/게시/중단/Audit 조회/자산 생성 5개 Endpoint를 CREATOR/AUDITOR 토큰으로 직접 공격, 응답이 `PERMISSION_DENIED` 형태이고 500/Stack Trace가 아님을 확인 |
| `test_security_03_privilege_escalation.py` | 요청 본문을 통한 권한 상승이 불가능한가 — Manifest `owner.creator_id` 위조, MCP `RequestContext`(`extra="forbid"`), agent-runtime의 `user_context`로 MCP Audit Identity를 바꿀 수 없음. **1건 skip**: office-mcp-server를 agent-runtime 없이 직접 호출하는 caller는 `audit_context.user.roles`를 자체 주장할 수 있고 이를 검증할 신뢰 계층이 없음(D-015) — Sanctioned 경로(agent-runtime 경유)는 이 취약점이 없음을 별도로 증명 |
| `test_security_04_approved_immutable.py` | 승인된 자산이 불변인가 — 승인·게시된 Knowledge의 `PATCH .../chunk-tags`가 409, 미승인 Knowledge의 Bundle 요청/게시가 400, 재결정이 409 |
| `test_security_05_injection_rejected.py` | MCP 경계에서 Injection이 거부되는가 — SQL 메타문자·`--`·`;`·`' OR '1'='1`·Cyrillic 유사문자가 `schema`/`table`/`field`/`operator`에서 전부 `MCP_INPUT_INVALID`, 동일 문자열이 `filters[].value`(Prepared Parameter 대상)에서는 안전한 불투명 데이터로 정상 처리됨 |
| `test_security_06_no_secret_leak.py` | Secret/내부 정보가 유출되지 않는가 — 401/403/404/409/400/422 실패 응답 본문에 Traceback/절대경로/SQL/실제 Bearer Token 없음, Hosted Chat의 미존재/중단 Slug가 완전히 동일한 오류 본문 반환(무존재-오라클 없음) |
| `test_security_07_denial_audited.py` | 거부(DENIED)가 감사되는가 — DENIED 행이 감사 조회에 존재하고 요청 원문을 담지 않음, MCP DENIED Audit Event에 `input`/`output`/`parameters` 필드 자체가 없음 |
| `test_security_08_trace_correlation.py` | 보안 이벤트에도 Trace ID 연결이 유지되는가 — 거부/허용 MCP 호출 모두 동일 Trace ID로 조회되고, 서로 다른 두 호출의 Trace ID가 교차 오염되지 않음 |

`make security-test` 실측: **63 passed, 1 skipped**. Net-neutrality 재확인: 실행 전후 `assets`/`services`/`service_deployments`/`data/indexes` 개수와 5개 시딩 Deployment 상태가 동일함을 확인했다.

### 8.3 명시적으로 수행되지 않은 것

- **침투 테스트(모의해킹)는 전혀 수행되지 않았다.** `tests/security/`는 자동화된 계약형 보안 테스트 스위트이며 실제 공격 기법을 사용한 모의해킹이 아니다.
- **의존성 취약점 스캔은 전혀 수행되지 않았다.**
- **PKI/코드 서명은 구현되지 않았다**(D-016, D-048) — Package는 Checksum(SHA-256)만 가지며 전자서명이 없다.
- `05-mcp-security-governance.md`의 위협 시나리오 SEC-01~12 중 다수가 `tests/security/`와 `tests/e2e/`로 실질적으로 커버되지만, 항목별 SEC-ID 전용 추적표는 없다. SEC-05(사용자 Context 위조)는 직접 MCP 호출 경로에 실제 공백이 남아 있고, SEC-12(Signature Trust Key 만료)는 PKI 자체가 미구현이라 애초에 테스트 대상이 없다.
- 실제 SSO/OIDC 연동은 없다(D-001, 개발용 Test Identity Adapter만 존재).
- **Classification ACL(D-062)이 막는 것은 "요청 Body를 통한 등급 상향"이지 "신원 사칭"이 아니다.** 신원 계층이 없어(D-015) `access_context.clearance`는 호출자가 주장하는 값이며 세션/인증과 대조 검증되지 않는다 — 완전한 접근 통제 보증이 아니다.

## 9. 사용자 평가

**수행된 사용자 평가는 없다.** `06-quality-delivery.md` §9가 요구하는 5개 Persona(일반 사용자/자산 제작자/기술 검토자/보안 검토자/폐쇄망 PC 운영자) 대상 사용자 인수 테스트는 계획만 있고 실행되지 않았다. Knowledge 평가 데이터셋(§6)에 대한 업무 전문가 검토도 이루어지지 않았다(`review_status: AI_GENERATED_UNREVIEWED`). 이 보고서에 등장하는 모든 "확인/검증"은 개발자 본인이 세션 중 스스로 조작하고 관찰한 것이며, 제3자 또는 실제 업무 사용자의 피드백이 아니다.

## 10. 알려진 제한과 위험

- **Desktop 앱 실행 경로 전체가 이 머신에서 미검증**이다(§4) — Electron 런타임 바이너리 자체가 없어, D06/D07/확인 Panel까지 코드는 구현되었어도 Electron으로서 동작하는지는 확인할 수 없다.
- **agent-runtime의 CORS 정책이 Desktop 브라우저 렌더러를 차단한다**(D-059, 신규) — `allow_origins=["http://localhost:3000"]`만 허용되어 Desktop Vite(`:5174`)와 패키징된 Electron의 `file://`/`null` Origin 모두 오늘 시점 차단 대상이다. 살아있는 agent-runtime:8100을 재시작하지 않기 위해 이번 세션에서 고치지 않았다.
- **라이브 스택이 최신 코드를 반영하지 않는다**(§4 "재기동 대기") — `WAITING_FOR_USER`(D-061), Classification ACL(D-062)가 특히 그렇다. Classification ACL은 재기동하는 순간 게시된 4개 데모 챗봇을 포함한 기존 인덱스가 전부 Fail-closed로 검색 결과 0건이 되므로, **재기동 전 `stamp-classification` CLI 실행이 필수**이며 아직 실행되지 않았다.
- **Knowledge 평가 데이터셋이 AI 생성·미검토 상태**이고 표본이 극히 작다(문서 1건, 6케이스) — 통과하는 Quality Gate는 스모크 신호일 뿐 품질 보증이 아니며, 2026-08-07 청킹 회귀가 이를 실증했다.
- **ServiceVersion 승인 게이트는 기본 OFF**(D-063) — `require_service_version_approval=False`가 기본값이며, 이 상태에서는 미승인 ServiceVersion도 게시할 수 있다. CLAUDE.md 발표 MVP 흐름과 이미 게시된 4개 데모 챗봇(전부 DRAFT)을 보존하기 위한 의도된 결정이지만, 운영 전환 시 켜지 않으면 "승인된 Service만 배포"는 형식적으로만 존재한다.
- **Agent/Prompt가 Portal Registry에 등록되지 않는다**(D-034) — 정적 config 사본을 Bundle에 포함하는 방식이라, Registry가 구현되기 전까지 Agent/Prompt의 버전 관리·검토·승인은 형식적으로만 존재한다. Service Composer의 `mcp_bindings`가 항상 빈 배열인 것도 같은 이유(MCP Tool Registry 미연동, D-049).
- **신원 계층이 없다**(D-015) — search-runtime의 `access_context.clearance`와 office-mcp-server의 `audit_context.user.roles`는 호출자가 주장하는 값이며 세션/인증과 대조 검증되지 않는다. Classification ACL(D-062)은 그 주장이 요청 Body를 통해 조용히 상향될 수 없게 만드는 메커니즘일 뿐, 완전한 접근 통제 보증이 아니다.
- **Service 가시성 ACL이 없다**(D-022, E2E-05) — `GET /api/v1/services` 등이 `target_orgs`/`target_roles`로 목록을 좁히지 않는다. 컬럼은 있지만 읽기 API가 이를 필터링하지 않는 실제 기능 공백이다.
- **Portal 승인 절차가 Knowledge Quality Gate를 참조하지 않는다**(E2E-07) — 평가 결과가 나쁘더라도 검토/승인 자체를 막지 않는다.
- **office-mcp-server의 `ALWAYS`/`ON_PARAMETER` Tool 확인 흐름은 구현됐지만(D-061) 라이브 스택에는 반영되지 않았다**(위 참고).
- **HNSW 바이너리가 빌드 호스트의 절대경로를 Knowledge Package에 유출한다**(D-054) — `--relativize-source-paths`로 상당 부분을 정리할 수 있지만 `data_level0.bin`의 미초기화 메모리 유출은 의도적으로 미해결(FATAL 유지) — 실물 데이터로는 완전히 클린한 Package를 오늘 시점에 만들 수 없다.
- **PDF/DOCX 문서 로더가 없다** — 필요한 라이브러리가 설치되어 있지 않고 이 머신은 인터넷에서 임의로 새 패키지를 받는 것이 금지되어 있어(사내 미러 필요), `.md/.markdown/.txt`만 지원한다.
- **Windows 배포 전체가 미검증**이다 — 빌드는 macOS Cross-build 설정 파일만 존재하고, 실제 Windows 빌드/서명/설치/Smoke Test는 수행된 적이 없다(D-047/D-048 모두 미결정).
- **폐쇄망 실제 검증이 전혀 없다** — 모든 검증이 인터넷이 연결된 동일 개발망 macOS 1대에서 이루어졌다.
- **의존성 취약점 스캔, 침투 테스트 모두 없다.**

## 11. 운영 전 추가 결정

`open-decisions.md`에는 D-001~D-066(총 66건)이 기록되어 있다. 이 PoC를 실제 업무에 투입하기 전 반드시 결정해야 하는 항목을 발췌한다(전체는 원문 참고).

| ID | 항목 | 운영 전 결정 필요 |
|---|---|---|
| D-001 | Portal 인증 | 사내 SSO/OIDC/SAML 연동 방식 |
| D-003 | 파일 저장소 | 사내 Object Storage/NAS 전환 |
| D-008 | 실행 코드 Package | Sandbox/Code Signing 정책(PoC는 운영 배포 자체를 금지) |
| D-013 | Knowledge 품질 기준 | 업무별 Recall/지연 기준(현재는 PoC 목표치만 존재, 미검토 데이터셋 기반) |
| D-014/D-015 | MCP Connector/인증 | 실제 DB/시스템 범위, 사내 인증 Context 전달 방식(신원 계층 자체가 없음) |
| D-016 | Package Signature | PKI/서명키 운영 체계 |
| D-022 | 조직·사업장 권한 | 실제 HR/권한 시스템 연동, Service 가시성 ACL 실제 집행(E2E-05) |
| D-026/D-027 | Hosted Chat URL/인증 | 실 Domain·Reverse Proxy·TLS, 실 SSO/OIDC |
| D-034 | Registry 생략(Agent/Prompt) | M02 Agent/Prompt/MCP Tool Registry 구현 후 실제 조회로 전환 — Service Composer `mcp_bindings`도 함께 해소 |
| D-041/D-044/D-063 | ServiceVersion 검토 Workflow | 체인 자체는 구현됨(D-063) — 운영 전 `require_service_version_approval=True`로 전환하고 기존 4개 데모 챗봇을 실제로 검토·승인 처리 |
| D-045 | 평가 데이터셋 검토 상태 | 업무 전문가 검토(`EXPERT_REVIEWED`) 전환, 표본 확장 |
| D-047 | Desktop Runtime/Ollama 동봉 방식 | 3개 선택지(Extra Resources/별도 설치 프로그램/Golden Image) 중 확정 |
| D-048 | Windows 코드 서명 인증서 | 인증서 종류(OV/EV)·발급·HSM 운영 체계 확정 |
| D-054 | Knowledge Package의 빌드 호스트 경로/HNSW 유출 | `bm25.pkl` 비실행 직렬화 포맷 전환, `data_level0.bin` 미초기화 메모리 유출 해소(Chroma 업스트림 이슈) |
| D-059 | agent-runtime CORS | Desktop이 실제로 쓰는 Origin(들)을 허용 목록에 반영, Hosted/Local 모드별 정책 분리 검토 |
| D-061 | `WAITING_FOR_USER` 라이브 반영 | 라이브 agent-runtime:8100 재기동 후 `make e2e-test`로 재확인, Manifest Fixture 2건(D-049 잔여) 작성 |
| D-062 | Classification ACL 라이브 반영 | 라이브 indexing/search-runtime 재기동 **전** 기존 인덱스 전부에 `stamp-classification` 실행 필수, 실 신원 계층과 결합 |
| D-064/D-065 | P13/P15 | 실 사용자 디렉터리·조직/사업장 저장소·보관기간 정책·PKI가 생기면 P15를 편집 가능한 화면으로 전환 |
| (신규) | 자동 E2E/보안 테스트는 있으나 CI 미연결 | CI 파이프라인에 `make e2e-test`/`make security-test`를 실제로 연결, 침투 테스트·의존성 스캔 도입 |

## 12. Go / Conditional Go / No-Go

이 절은 결정을 내리는 것이 아니라, **사람이 결정을 내리기 위한 입력**이다.

**오늘 시점에 실제로 동작이 확인된 것**: Knowledge 등록→인덱싱→검토/승인 3단계 체인→Offline Bundle 생성/무결성→Knowledge 챗봇 Quick Create→실제 Ollama 기반 Preview 대화(Citation 포함)→게시→내부 `/chat/{slug}` URL 접속→SSE 스트리밍 응답, 10단계 AI Service Composer로 실제 Service를 만들고 5개 검증을 통과시키는 것, agent-runtime이 office-mcp-server를 실제로 호출해 읽기 전용 DB Metadata Tool을 실행하고 SQL Injection을 거부하는 경로, 그리고 이제는 이 상당 부분이 `tests/e2e`/`tests/security`(78개, 자동)로 회귀 방지가 걸려 있다.

**오늘 시점에 확인되지 않았거나 구조적으로 비어 있는 것**: Desktop을 경유하는 모든 시나리오(Electron 바이너리 부재로 재확인 자체가 불가능), agent-runtime의 CORS 정책이 막고 있는 Desktop 브라우저 실행 경로(D-059), 라이브 스택에 아직 반영되지 않은 `WAITING_FOR_USER`/Classification ACL(재기동 필요, §4), Service 가시성 ACL(D-022), Portal 승인 절차와 Quality Gate의 연결(E2E-07), Windows 실제 빌드/서명, 폐쇄망 실장비 검증, 실 SSO, 업무 전문가가 검토한 평가 데이터셋, 사용자 평가 전반, 침투 테스트·의존성 스캔.

이를 근거로 한 권고는 **Conditional Go — 발표/데모 목적의 PoC로는 진행 가능하나, 실 업무 데이터·실 사용자 투입 전 아래가 최소 조건**이다. 이전 판(초안)의 조건 중 "자동 E2E/보안 테스트 스위트를 구축한다"는 이번 재검증으로 충족되었으므로 제외하고, 대신 이번에 새로 확인된 구조적 공백을 반영해 갱신한다.

1. **라이브 스택을 최신 코드로 재기동한다** — 단, Classification ACL(D-062) 특성상 재기동 **전에** `stamp-classification` CLI를 기존 인덱스 전부(게시된 4개 데모 챗봇 포함)에 실행해야 한다. 재기동 후 `make e2e-test`(D-061의 2건 skip이 해소되는지)와 P12/P13/P15/P16/ServiceVersion 검토 UI의 브라우저 happy path를 실제로 확인한다.
2. **agent-runtime의 CORS 허용 목록에 Desktop Origin을 추가한다(D-059)** — 그렇지 않으면 Desktop 채팅 실행은 Electron이 기동되더라도 브라우저 기반 렌더러에서 계속 막힌다.
3. **Desktop Client를 실제로 실행 가능한 상태로 복구한다** — Electron 바이너리 확보(사내 미러 경유), D06/D07/확인 Panel과 인수 시나리오 5~13단계를 Desktop 경로로 실제 재현·검증한다.
4. **Knowledge 평가 데이터셋을 업무 전문가가 검토해 `EXPERT_REVIEWED`로 전환**하고, 표본을 문서 1건/6케이스보다 유의미하게 확장한다(D-045). 2026-08-07 회귀 사고는 작은 데이터셋의 한계를 이미 실증했다.
5. **Service 가시성 ACL(D-022)을 실제로 집행**하고, Portal 승인 절차가 Quality Gate 결과를 실제로 참조해 차단하도록 배선한다(E2E-07).
6. **실 사내 SSO/OIDC 연동(D-001/D-027)과 실 조직·사업장 권한(D-022)**을 최소 하나의 실 연동 경로로 검증한다 — 이것이 없으면 Classification ACL과 MCP `audit_context`의 "주장된 신원"이 실제 검증된 신원으로 바뀌지 않는다(D-015).
7. **`require_service_version_approval=True`로 전환**하고 기존 4개 데모 챗봇을 실제로 검토·승인 처리한다(D-063).
8. **Windows Installer 코드 서명(D-048)과 실제 Windows 빌드/Smoke Test를 완료**한다.
9. **폐쇄망 실장비 최소 1대에서 Offline Bundle Import부터 채팅 실행까지 종단 재현**한다.
10. **최소한의 의존성 취약점 스캔과 침투 테스트를 1회 이상 수행**하고, `tests/e2e`/`tests/security`를 CI 파이프라인에 실제로 연결한다.
11. **Knowledge Package의 빌드 호스트 경로/HNSW 유출(D-054)을 해소**해, 실물 데이터로 완전히 클린한 Package를 만들 수 있는 상태로 만든다.

위 조건이 충족되지 않은 상태에서 실제 업무 데이터·비개발자 사용자에게 노출하는 것은 권고하지 않는다. 이 문서에 기록된 "동작함"은 모두 개발자 1인이 개발망에서 수기로 확인한 결과이며, 그 이상의 보증을 의미하지 않는다. 특히 1번(재기동 대기) 조건은 **지금 당장 코드를 새로 짜지 않아도 되는, 가장 값싸게 해소 가능한 조건**이라는 점을 강조한다 — 이미 구현·테스트된 기능이 라이브 스택에서 아직 확인되지 않았을 뿐이다.
