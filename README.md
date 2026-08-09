# Enterprise AI Asset Hub

사내 AI 자산(Knowledge / Agent / Prompt / MCP Tool)을 **등록 → 검토·승인 → 배포 → 실행**까지 통제하는 플랫폼의 **PoC**입니다. 폐쇄망(인터넷 차단) 환경을 전제로 설계했습니다.

> **이 저장소의 상태**: 발표·데모용 PoC입니다. 실업무 데이터·실사용자 투입 전 충족해야 할 조건이 남아 있습니다 — [인수 보고서](docs/implementation-spec/12-poc-acceptance-report.md) §12를 먼저 읽어주세요.

---

## 무엇을 하는가

1. **지식 등록** — 문서를 올리면 자동으로 청킹·임베딩되어 검색 인덱스가 만들어진다
2. **검토·승인** — 기술 → 보안 → 릴리스 3단계 순차 검토. 승인된 버전은 수정할 수 없다
3. **챗봇 구성** — 승인된 Knowledge로 챗봇을 구성하고, 실제 대화로 Preview한 뒤 내부 URL로 게시
4. **폐쇄망 배포** — Offline Bundle을 만들어 반출하거나, Desktop Client가 사내 Portal에서 직접 설치
5. **운영 통제** — 중단·폐기·긴급 회수, 감사 로그, 다운로드 이력

모든 실행은 **로컬 LLM(Ollama)** 을 사용하며, 런타임에 사내망 밖으로 나가는 호출이 없습니다.

---

## 구성

전체 구조·데이터 흐름·거버넌스 상태 전이는 **[시스템 구조 문서](docs/architecture.md)** 를 참고하세요 (GitHub에서 바로 렌더링됩니다).

| 모듈 | 경로 | 책임 |
|---|---|---|
| M01 | `apps/portal-web` | Portal UI (Next.js 14) — 25개 화면 |
| M02 | `apps/portal-api` | Registry, 검토, 게시, 수명주기 API (FastAPI) |
| M03 | `services/distribution-service` | Offline Bundle 생성·무결성·다운로드 |
| M04 | `apps/desktop-client` | 폐쇄망 Desktop Client (Electron + React) |
| M05 | `services/agent-runtime` | Workflow, 스트리밍, LLM/Knowledge/MCP 조정 |
| M06 | `packages/schemas` | Manifest/Profile/Service Schema와 Validator |
| M07 | `services/indexing-runtime` | 문서 로딩·청킹·임베딩·인덱싱 |
| M08 | `services/search-runtime` | Hybrid 검색(Vector + BM25 + RRF), ACL |
| M09 | `packages/knowledge-packager`, `packages/evaluation-runner` | 패키지 조립, 검색 품질 평가 |
| M10 | `services/office-mcp-server` | 읽기 전용 MCP Tool, 실행 통제 |
| M11 | `packages/security-policy` | RBAC, 상태 전이, 보안등급, 감사 정책 |
| M12 | `tests`, `docs` | 계약·단위·통합·E2E·보안 테스트 |

**포트**: portal-web `:3000` · portal-api `:8000` · agent-runtime `:8100` · indexing `:8200` · search `:8300` · distribution `:8400` · office-mcp `:8500` · Ollama `:11434`

---

## 시작하기

**필요 사항**: Python ≥ 3.11 + [uv](https://docs.astral.sh/uv/), Node + pnpm 9, [Ollama](https://ollama.com)

```bash
# 1) 의존성
make install

# 2) Ollama 모델 (약 5.4GB)
ollama pull exaone3.5:7.8b        # 대화
ollama pull qwen3-embedding:0.6b  # 임베딩

# 3) DB 마이그레이션
make migrate

# 4) 서비스 기동 (각각 별도 터미널)
make dev-portal-api dev-agent-runtime dev-indexing-runtime \
     dev-search-runtime dev-distribution-service dev-office-mcp-server dev-portal-web

# 5) 확인
make health-check
```

`http://localhost:3000` 접속 → **지식 등록** → **챗봇 만들기** 순서로 진행하면 종단 흐름을 볼 수 있습니다.

> **Windows에서 로컬 실행**: [`docs/implementation-spec/13-windows-local-setup.md`](docs/implementation-spec/13-windows-local-setup.md)에 PowerShell 스크립트(`scripts/windows/`)와 전체 절차가 있습니다.

---

## 개발

```bash
make test           # 오프라인 기본 스위트
make lint           # ruff
make typecheck      # mypy + tsc
make contract-test  # Schema/OpenAPI 계약
make security-test  # 실서비스 대상 보안 종단 테스트
```

E2E·보안 스위트는 **실제로 서비스가 떠 있어야** 실행되며, marker로 분리해 기본 실행에서는 제외됩니다(오프라인 유지). 서비스가 없으면 실패가 아니라 사유를 명시한 skip으로 빠집니다.

**현재 검증 현황** (2026-08-10 실측)

| 스위트 | 결과 |
|---|---|
| 기본(오프라인) | 750 passed, 2 skipped |
| Desktop (vitest) | 263 passed |
| 계약 | 23 passed |
| E2E / 보안 | 실서비스 대상, marker 분리 |
| lint | 0 errors |

Skip은 모두 **사유가 명시**되어 있습니다(예: `pypdf` 미설치, Electron 미기동).

---

## 문서

명세는 [`docs/implementation-spec/`](docs/implementation-spec/)에 있습니다.

- [`README.md`](docs/implementation-spec/README.md) — 명세 전체 지도
- `01`~`10` — 모듈별 상세 명세
- [`11-desktop-packaging-and-distribution.md`](docs/implementation-spec/11-desktop-packaging-and-distribution.md) — Windows 설치 파일 빌드·서명
- [`12-poc-acceptance-report.md`](docs/implementation-spec/12-poc-acceptance-report.md) — **인수 보고서**
- [`13-windows-local-setup.md`](docs/implementation-spec/13-windows-local-setup.md) — Windows 로컬 실행
- [`open-decisions.md`](docs/implementation-spec/open-decisions.md) — 미결 결정 73건
- [`progress-log.md`](docs/implementation-spec/progress-log.md) — 모듈별 구현 현황

인수 보고서는 모든 항목을 **자동 테스트 검증 / 수동 검증 / 미검증** 세 가지로 구분해 표시합니다. 무엇이 실제로 확인되었고 무엇이 아닌지 그 문서에서 확인하세요.

---

## 알려진 한계

PoC 단계에서 의도적으로 남겨둔 것들입니다. 전체 목록과 근거는 [인수 보고서 §10](docs/implementation-spec/12-poc-acceptance-report.md)에 있습니다.

- **신원 계층 없음** — 사내 SSO 미연동(D-001). search-runtime과 MCP Server에 인증이 없어, 권한 등급(`clearance`)과 MCP 역할은 *주장된 값*이지 검증된 값이 아닙니다. 보안등급 기반 접근 제어(D-062)는 **메커니즘**이지 완결된 통제가 아닙니다.
- **Desktop 실기동 미검증** — 개발 장비(macOS)에서 Electron이 Gatekeeper에 격리되어 한 번도 실행되지 못했습니다. Desktop 로직은 순수 모듈 단위 테스트로만 검증되어 있습니다.
- **ServiceVersion 승인 게이트 기본 OFF** (D-063) — 발표 MVP의 "빠른 구성·게시" 흐름을 위한 의도적 선택입니다. 운영에서는 켜야 합니다.
- **평가 데이터셋 미검토** (D-045) — 생성형 AI가 만든 초안 상태(`AI_GENERATED_UNREVIEWED`)라 공식 품질 기준이 아닙니다.
- **침투 테스트·의존성 취약점 스캔 미수행**.

---

## 원칙

- 계약(Schema/OpenAPI)을 코드보다 먼저 작성한다
- 모듈 간 내부 폴더 직접 Import를 금지한다
- 테스트 증거 없는 기능을 완료로 표시하지 않는다
- 실제 Secret·개인정보·운영 DB 정보를 코드·Prompt·Fixture·Log에 넣지 않는다
- MCP Tool은 읽기 전용만 구현한다
- 확보되지 않은 값은 지어내지 않고 "미기재"로 표시한다

자세한 내용은 [`CLAUDE.md`](CLAUDE.md).
