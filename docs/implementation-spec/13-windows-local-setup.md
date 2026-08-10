# Windows 로컬 PC 구동 Runbook (외부 연동 없음)

대상 모듈: 전체(M01~M12 중 PoC 실행에 필요한 부분)
대상 환경: 회사 Windows 10/11 PC, **외부 AI/네트워크 연동 없음**(폐쇄망 또는 폐쇄망에 준하는 격리 PC), Ollama 로컬 실행
문서 상태: 이 저장소의 실제 코드/테스트를 근거로 작성. **이 PC에서 직접 실행해 확인하지 못한 항목은 "미검증"으로 명시**하며, 추측으로 명령을 지어내지 않는다.

## 0. 이 문서를 쓰기 전에

- `docs/implementation-spec/README.md`, `07-data-api-contracts.md`, `open-decisions.md`를 먼저 읽는다(CLAUDE.md 지침).
- 이 문서는 macOS 개발 머신에서 **Windows 대상 PC에 무엇이 필요한지**를 코드/설정을 근거로 정리한 것이며, 실제 Windows 실행 세션에서 발견되는 차이는 이 문서와 `open-decisions.md`에 반영해야 한다.
- **회사 정책상 이 저장소를 준비한 macOS 개발 머신에서는 새 패키지 다운로드가 금지되어 있다.** 아래 절차 중 `uv sync`/`pnpm install`이 실제로 네트워크 설치를 수행하는 검증은 **Windows 대상 PC에서 처음 실행하는 사람이 직접 확인**해야 한다.

## 1. 사전 준비물

| 항목 | 버전 | 비고 |
|---|---|---|
| Windows | 10/11 x64 | `open-decisions.md` D-005 |
| Python | **3.11 이상** | 루트 `pyproject.toml` `requires-python = ">=3.11"`. 개발 환경(macOS)은 3.14로 검증했으나, Windows에서의 3.11~3.14 사이 호환성은 **미검증** — 문제가 생기면 우선 3.12 LTS 계열로 시도 |
| uv | 개발 환경에서 검증한 버전: **0.12.1** | Python 패키지 관리(D-031). `pip install uv` 또는 공식 설치 스크립트로 설치. Windows용 정확한 설치 절차는 이 문서 작성 시점에 실행해 확인하지 않았음 — **미검증**, `uv`의 Windows 공식 문서를 따를 것 |
| Node.js | 개발 환경에서 검증한 버전: **v24.18.0** | 루트 `package.json`/`apps/*/package.json`에 `engines` 고정이 없어 정확한 하한은 명세되어 있지 않다. Next.js 15/React 19 계열 요구사항을 만족하는 LTS(18.18+ 또는 20+)면 동작할 것으로 예상하나 **Windows에서의 실행은 미검증** |
| pnpm | **9.0.0** | 루트 `package.json`의 `packageManager: "pnpm@9.0.0"`으로 고정됨. `corepack enable` 후 `corepack prepare pnpm@9.0.0 --activate` 권장 |
| Ollama (Windows) | 최신 안정판 | 로컬 LLM 서버. Windows 네이티브 설치본(.exe) 사용 — WSL 불필요 |
| Git | 임의 | 저장소를 옮겨오는 방식에 따라 불필요할 수도 있음(zip 반입 등) |

Windows에는 `make`가 없으므로, 이 문서와 `scripts/windows/*.ps1`이 `Makefile`의 dev/health-check/migrate 타겟을 대체한다. **각 스크립트는 Makefile의 해당 타겟과 정확히 같은 명령을 실행하도록 작성했지만, 이 PowerShell 스크립트 자체는 실제 Windows PowerShell에서 실행해 검증한 적이 없다 — 처음 실행 시 문제가 있으면 스크립트를 열어 내부 명령(Makefile 타겟과 동일)을 직접 실행해도 된다.**

### 1.1 PowerShell 실행 정책

기본 정책(`Restricted`)에서는 `.ps1` 스크립트 실행이 차단된다. 관리자 권한 없이 현재 사용자 범위에서만 허용하려면(회사 PC에서 보통 이 방식이 승인받기 쉽다):

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

이 명령의 승인 여부는 회사 보안 정책에 따라 다르다 — **거부되면 각 스크립트를 `powershell -ExecutionPolicy Bypass -File <script>.ps1`로 개별 실행**한다(`scripts/windows/start-all.ps1`은 이미 이 방식으로 자식 창을 띄운다).

## 2. Ollama 모델 준비

이 PoC가 실제로 호출하는 모델은 `services/agent-runtime/config/office-profile-default/office-profile.json`에 정의되어 있다.

| 모델 | 용도 | 참고 크기(대략) |
|---|---|---|
| `exaone3.5:7.8b` | Chat(답변 생성) | 약 4.5~5GB급(78억 파라미터, 기본 양자화 기준 — **Ollama 라이브러리 페이지의 실제 고시 크기를 우선**하고 이 표는 참고치로만 사용) |
| `qwen3-embedding:0.6b` | Embedding(색인/검색) | 약 0.6~1GB급(6억 파라미터) |

```powershell
ollama pull exaone3.5:7.8b
ollama pull qwen3-embedding:0.6b
```

- 두 모델을 합쳐 **최소 6~7GB 이상의 디스크 여유 공간**을 확보해 둔다(정확한 수치는 pull 시 Ollama가 표시하는 크기를 확인).
- `12-poc-acceptance-report.md`는 이 두 모델 외에 `qwen2.5-coder:3b`도 개발 세션에서 확인된 적이 있다고 기록하지만, 현재 `office-profile.json`이 참조하는 것은 위 두 모델뿐이다 — 추가로 pull할 필요는 없다.
- **폐쇄망에서 `ollama pull`이 동작하려면 Ollama 자체가 외부 레지스트리에 접근해야 한다.** 완전히 외부 연동이 차단된 PC라면, 모델을 접근 가능한 다른 경로(사내 미러, 이동식 매체로 받은 모델 파일)로 먼저 받아 `ollama create`/모델 디렉터리 복사 등으로 반입해야 한다 — 이 저장소는 그 반입 절차 자체를 제공하지 않는다(Ollama 자체의 기능 범위 밖).

## 2.5 uv 설치 (Windows에 uv가 없는 경우)

현장에서 실제로 마주친 상황이다 — Windows PC에 `uv`가 설치되어 있지 않다. 아래 순서로 시도한다.

**① `pip install uv` (권장)**

```powershell
python -m pip install uv
uv --version
```

`uv`는 PyPI에 배포되므로, **Python 패키지를 받을 수 있는 환경이면 이 경로가 가장 확실하다** — 다른 의존성과 같은 인덱스/미러를 그대로 쓴다. 설치 후 `uv` 명령이 PATH에서 잡히지 않으면 `python -m uv`로 대체할 수 있다.

**② 그 외 경로** (①이 막혔을 때)

| 방법 | 명령 | 필요한 접근 |
|---|---|---|
| winget | `winget install --id=astral-sh.uv -e` | Microsoft 저장소 |
| 공식 스크립트 | `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 \| iex"` | `astral.sh` |
| 단독 실행 파일 | GitHub Releases의 `uv-x86_64-pc-windows-msvc.zip` | `github.com` |

**③ uv를 전혀 설치할 수 없는 경우 — pip 대체 절차**

이 저장소의 Python 패키지들은 서로를 **이름으로만** 참조하고(`ai-asset-schemas`, `security-policy`, `observability`), 그 이름은 `[tool.uv.sources] workspace = true`로 해석된다. 이건 **uv 전용 기능**이라, 그냥 `pip install -r`을 하면 pip이 `ai-asset-schemas`를 PyPI에서 찾다가 실패한다.

따라서 로컬 패키지를 **의존 순서대로 먼저 editable 설치**해야 한다.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# 1단계 — 다른 워크스페이스 패키지에 의존하지 않는 것
pip install -e packages/schemas
pip install -e packages/observability

# 2단계 — schemas에만 의존
pip install -e packages/security-policy
pip install -e packages/evaluation-runner
pip install -e packages/knowledge-packager

# 3단계 — 위 패키지들에 의존
pip install -e services/agent-runtime
pip install -e services/indexing-runtime
pip install -e services/search-runtime
pip install -e services/distribution-service
pip install -e services/office-mcp-server
pip install -e apps/portal-api
```

주의할 점:

- 순서를 지키지 않으면 pip이 워크스페이스 패키지 이름을 PyPI에서 찾다가 실패한다.
- 이후 문서의 모든 `uv run <명령>`은 가상환경을 활성화한 상태에서 `<명령>`으로 바꿔 실행한다(예: `uv run alembic upgrade head` → `alembic upgrade head`).
- `uv.lock`이 고정한 정확한 버전이 아니라 각 `pyproject.toml`의 범위(`>=`)로 해석되므로, uv를 쓸 때와 **의존성 버전이 달라질 수 있다**. 재현성이 떨어지므로 어디까지나 최후 수단이다.
- **이 대체 절차는 실행해 검증하지 않았다**(개발 머신은 네트워크 설치가 금지되어 있음). 위 의존 순서는 각 `pyproject.toml`의 `[tool.uv.sources]`를 읽어 도출한 것이다.

## 3. 저장소 설치

```powershell
# 저장소 루트에서
uv sync --all-packages
pnpm install
```

- `uv sync --all-packages`는 `pyproject.toml`의 uv workspace 전체(apps/portal-api, services/*, packages/*)를 설치한다.
- **PDF/Word Knowledge 색인 지원(D-073)**: `services/indexing-runtime/pyproject.toml`에 `pypdf`, `python-docx`를 의존성으로 추가했다. 이 두 패키지는 **개발 macOS 머신에서는 한 번도 설치/lock되지 않았다**(정책상 네트워크 설치 금지) — Windows PC에서 `uv sync --all-packages`를 실행하는 시점이 **최초로 lock이 갱신되는 시점**이다. 사내 PyPI 미러/인덱스가 `uv`의 기본 인덱스 URL과 다르면 `UV_INDEX_URL` 환경 변수(또는 `pip.ini`/`uv.toml`의 index 설정)로 미러를 가리켜야 한다 — 이 설정 방법은 사내 미러의 실제 구성에 따라 달라지므로 이 문서에서 구체적 값을 지어내지 않는다.
  - `pypdf`: 순수 Python, BSD-3-Clause, OS/아키텍처 무관 단일 wheel.
  - `python-docx`: 순수 Python, MIT. 유일한 런타임 의존성 `lxml`은 win_amd64용 사전 빌드 wheel을 제공하므로 별도 C 빌드 도구 없이 설치 가능하다(미러에 lxml wheel도 함께 반입되어 있어야 함).
  - 두 패키지가 없어도 indexing-runtime 자체는 정상 기동하고 Markdown/Text Knowledge는 그대로 색인된다 — PDF/DOCX 파일을 실제로 색인하려 할 때만 "PDF 로더에 필요한 pypdf가 설치되어 있지 않습니다" 같은 명확한 한국어 오류로 실패한다(크래시가 아님). 상세: `services/indexing-runtime/src/indexing_runtime/loaders/`.
- `pnpm install`은 `apps/portal-web`, `apps/desktop-client`를 포함한 pnpm workspace 전체를 설치한다.

## 4. DB 마이그레이션

```powershell
.\scripts\windows\migrate.ps1
```

Makefile의 `migrate` 타겟(`cd apps/portal-api && uv run alembic upgrade head`)과 동일하다. 저장소를 처음 반입했을 때, 또는 이후 코드 업데이트로 `apps/portal-api`의 모델이 바뀌었을 때 실행한다. `apps/portal-api/portal.db`(SQLite)가 없으면 새로 생성된다.

## 5. 서비스 기동

### 5.1 Ollama

```powershell
ollama serve
```

이미 Windows 서비스로 백그라운드 상시 실행 중이면 별도로 띄울 필요 없다(Ollama 설치 시 기본 동작이 그렇다 — Windows에서의 정확한 기본값은 Ollama 자체 문서 참고).

### 5.2 나머지 7개 서비스 — 한 번에

```powershell
.\scripts\windows\start-all.ps1
```

`Makefile`의 `dev-portal-api`/`dev-agent-runtime`/`dev-indexing-runtime`/`dev-search-runtime`/`dev-distribution-service`/`dev-office-mcp-server`/(`pnpm --filter portal-web dev`)를 각각 새 PowerShell 창에서 실행한다. 로그를 서비스별로 분리해서 보기 위함이다.

| 서비스 | 포트 | 스크립트 |
|---|---|---|
| portal-api (M02) | 8000 | `start-portal-api.ps1` |
| agent-runtime (M05) | 8100 | `start-agent-runtime.ps1` |
| indexing-runtime (M07) | 8200 | `start-indexing-runtime.ps1` |
| search-runtime (M08) | 8300 | `start-search-runtime.ps1` |
| distribution-service (M03) | 8400 | `start-distribution-service.ps1` |
| office-mcp-server (M10) | 8500 | `start-office-mcp-server.ps1` |
| portal-web (M01) | 3000 | `start-portal-web.ps1` |

개별 서비스만 띄우거나 재시작하고 싶으면 위 스크립트를 개별 실행해도 된다(`start-all.ps1`은 이 7개를 순서대로 새 창에서 호출하는 것뿐, 특별한 조율 로직은 없다).

`uv run uvicorn ... --reload`는 파일 변경 감지를 위해 `watchfiles`를 사용한다 — uvicorn/watchfiles 모두 Windows를 공식 지원하지만, **이 PoC에서 Windows상 `--reload` 동작 자체를 실행해 확인하지는 않았다**. 문제가 있으면 `--reload` 플래그를 빼고 실행해도 개발 편의성만 잃을 뿐 기능에는 영향 없다.

### 5.3 종료

각 PowerShell 창에서 `Ctrl+C`로 프로세스를 멈춘 뒤 창을 닫는다. `start-all.ps1`은 7개의 독립 프로세스를 띄울 뿐 일괄 종료 기능은 제공하지 않는다.

## 6. 검증

### 6.1 Health Check

```powershell
.\scripts\windows\health-check.ps1
# Ollama와 필요한 두 모델까지 함께 확인하려면:
.\scripts\windows\health-check.ps1 -IncludeOllama
```

`Makefile`의 `health-check` 타겟과 동일한 7개 엔드포인트(office-mcp-server는 `/health`가 아니라 `/health/live`)를 확인한다. 실패한 항목이 있으면 해당 서비스의 PowerShell 창 로그를 먼저 확인한다.

### 6.2 종단 시나리오 — 지식 등록 → 인덱싱 → 챗봇 대화

이 저장소의 실제 화면 흐름을 그대로 따른다(코드 기준, `apps/portal-web/app/knowledge/new`, `apps/portal-web/app/chatbots/new`):

1. 브라우저에서 `http://localhost:3000` 접속.
2. 좌측 메뉴 또는 "자산 등록"에서 **지식 등록**(`/knowledge/new`)으로 이동해 Markdown/Text(또는 이번에 추가한 PDF/DOCX, §3 참고) 문서를 업로드하고 제출한다.
3. 제출 시 portal-api가 indexing-runtime(`:8200`)의 `/indexing/v1/jobs`를 호출해 색인을 트리거한다 — 자산 상세 화면에서 색인 상태(청크 수 등)가 채워지는지 확인한다. 실패하면 `indexing-runtime` 창의 로그와 `data/indexes/<version_id>/index-meta.json` 존재 여부를 확인한다.
4. **챗봇 빠른 구성**(`/chatbots/new`)으로 이동해 방금 등록한(승인 대기 상태라도 Preview는 허용됨) Knowledge를 선택하고 챗봇을 설정한다.
5. Preview 단계에서 실제 질문을 입력해 스트리밍 답변과 인용(Citation)이 나오는지 확인한다 — 이 호출 경로가 agent-runtime(`:8100`) → search-runtime(`:8300`) → Ollama(`:11434`, `exaone3.5:7.8b`) 전체를 실제로 태운다.
6. Preview가 최소 1회 성공해야 게시 단계로 진행할 수 있다(Gate). 게시 후 발급된 내부 URL(`/chat/<slug>`)로 접속해 다시 대화되는지 확인한다.

이 흐름이 한 번이라도 macOS 개발 세션에서 종단 검증된 기록은 `docs/implementation-spec/progress-log.md`(2026-08-03 항목, "실제 브라우저 + 실제 Ollama로 지식 등록→인덱싱→Preview→게시→URL 접속 전 구간 종단 검증 완료")에 있다 — 다만 그 검증은 macOS에서 수행된 것이며, **Windows PC에서의 재현은 이 문서 작성 시점에 아직 수행되지 않았다.**

## 7. Desktop Client 실행 (M04)

Desktop Client는 Electron 앱이다. Portal/Hosted Chat과 별개로, **로컬(폐쇄망) 실행** 경로를 검증하는 용도다.

```powershell
cd apps\desktop-client
pnpm dev
```

`package.json`의 `dev` 스크립트는 `tsc -p tsconfig.electron.json && concurrently -k -n vite,electron "vite" "electron ."`이다 — Vite 개발 서버(Renderer)와 Electron 앱(Main)을 동시에 띄운다. Electron 창이 처음 뜨면 왼쪽 메뉴의 **"최초 설정"**(D01 Wizard)에서 Client 표시명·사업장 ID·Ollama Endpoint·기본 Chat/Embedding Model Alias·Office MCP Server Alias/URL을 확인·저장한다 — 아무것도 입력하지 않아도 이 문서 5절의 기본 포트(Ollama `127.0.0.1:11434`, Office MCP Server `127.0.0.1:8500`)로 동작한다(설정 전 기존 동작과 동일). 이후에는 **"설정"**(D10) 메뉴에서 언제든 같은 값을 다시 바꿀 수 있다. 앱 내 연결 상태 화면(`connections.ts`)은 이 설정값(미설정 시 기본값)을 사용해 Ollama·Local Agent Runtime(`127.0.0.1:8100`, 이 값은 설정 화면에 없음)·Office MCP Server를 각각 Health-check한다 — 5절에서 agent-runtime과 office-mcp-server를 먼저 띄워 두어야 정상으로 표시된다.

**보안 규칙**: Ollama Base URL은 기본적으로 loopback 주소(127.0.0.1/localhost)만 저장할 수 있다 — 원격 Ollama를 쓰려면 설정 화면에서 "외부 Ollama 허용"을 명시적으로 켜야 한다(사내 보안 정책상 권장하지 않음). "최대 동시 Run 수" 필드는 오늘 이 값을 바꿔도 실제 동작이 달라지지 않아(단일 창·단일 대화, Local Agent Runtime에 동시성 제한 없음) 읽기 전용으로 고정 표시된다 — 상세 사유는 `open-decisions.md` D-074 참고.

- **이 PoC 세션(macOS)에서는 Electron 앱을 한 번도 실제로 기동한 적이 없다**(사내 정책상 서명되지 않은 바이너리가 macOS Gatekeeper/XProtect에 격리됨, `progress-log.md` M04 항목 참고). 따라서 `pnpm dev`가 Windows에서 실제로 Electron 창을 띄우는지는 **미검증**이며, 지금까지의 M04 검증은 전부 코드/단위 테스트(`pnpm --filter desktop-client test`) 수준이다.
- Windows 설치 패키지(NSIS)를 만들려면 `pnpm run dist:win`(electron-builder)을 사용한다 — 코드 서명 관련 세부사항은 `docs/implementation-spec/11-desktop-packaging-and-distribution.md` 참고.

## 8. 문제 해결

| 증상 | 원인 후보 | 조치 |
|---|---|---|
| 특정 서비스 창이 "Address already in use" 등으로 즉시 종료 | 포트 충돌(다른 프로세스가 같은 포트 점유) | Windows에서 `netstat -ano \| findstr :8000` 등으로 점유 PID 확인 후 종료, 또는 `--port`를 바꿔 임시 회피(다른 서비스가 그 포트를 호출하도록 설정도 함께 바꿔야 함 — 임시방편) |
| `health-check.ps1`에서 한 서비스만 계속 실패 | 그 서비스가 기동 중 예외로 멈춰 있음("wedged") | 해당 서비스 창의 로그 확인. 재현 불가한 뻗음이면 그 창만 `Ctrl+C` 후 스크립트 재실행 — 다른 서비스는 건드릴 필요 없음(서비스 간 독립 프로세스) |
| 챗봇 Preview가 답변을 못 받아옴/느림 | Ollama 모델 미설치, 또는 Ollama 자체가 안 떠 있음 | `.\scripts\windows\health-check.ps1 -IncludeOllama`로 모델 두 개(`exaone3.5:7.8b`, `qwen3-embedding:0.6b`)가 모두 확인되는지 점검. 없으면 §2의 `ollama pull` 재실행 |
| 지식 등록 후 색인이 영영 "처리 중"으로 안 바뀜 | indexing-runtime이 죽었거나(뻗음), INDEX_BASE 문제 | indexing-runtime 창 로그 확인. `INDEX_BASE` 환경 변수를 별도로 설정하지 않았다면 저장소 루트의 `data\indexes`가 기본값이다(D-073으로 수정 — 이전에는 이 값이 특정 macOS 개발자의 절대경로로 하드코딩되어 있어 다른 PC에서는 반드시 `INDEX_BASE`를 수동 지정해야 했던 결함이 있었다. 지금은 기본값 자체가 저장소 상대경로라 별도 지정 없이도 동작해야 한다) |
| PDF/DOCX 파일을 색인하면 "pypdf가 설치되어 있지 않습니다"/"python-docx가 설치되어 있지 않습니다" 오류 | §3에서 `uv sync --all-packages`가 그 패키지를 실제로 설치하지 못함(미러 인덱스 미설정 등) | `uv pip list`(또는 indexing-runtime의 가상환경에서 `python -c "import pypdf, docx"`)로 실제 설치 여부 확인 후, 사내 미러 인덱스 설정을 재점검 |
| `portal.db` 관련 컬럼 오류(`no such column`) | 마이그레이션 미적용 | `.\scripts\windows\migrate.ps1` 실행. 그래도 안 되면 `uv run alembic current`/`uv run alembic heads`로 현재 리비전과 최신 리비전이 일치하는지 비교(`Makefile`의 `migrate-status` 타겟과 동일) |
| PowerShell에서 `.ps1` 실행이 거부됨(빨간 오류) | 실행 정책이 `Restricted` | §1.1 참고. 조직 정책상 `Set-ExecutionPolicy`가 막혀 있으면 `powershell -ExecutionPolicy Bypass -File <script>.ps1`로 개별 실행 |
| Desktop Electron 창이 뜨지 않음 | §7 참고 — 이 경로는 이번 세션 기준 미검증 | `pnpm dev`의 콘솔 출력(Vite/Electron 각각의 로그, `-n vite,electron` 접두사로 구분됨)을 그대로 공유해 원인 분석 필요 |

## 8.1 외부 연동 점검 결과 (실측)

이 PoC를 **인터넷이 차단된 사내망에서 실행할 때 외부로 나가는 연결이 있는지**를 코드 기준으로 점검한 결과다.

| 대상 | 결과 |
|---|---|
| 7개 서비스(portal-api/agent-runtime/indexing/search/distribution/office-mcp)의 런타임 HTTP 호출 | 전부 `localhost` — 외부 호출 없음 |
| LLM·임베딩 | 로컬 Ollama(`127.0.0.1:11434`) — 외부 API 없음 |
| `apps/portal-web/app`, Desktop 렌더러의 외부 URL·CDN·웹폰트 | 없음 (웹폰트는 D-050에 따라 CDN 대신 시스템 폰트 스택 사용) |
| **Next.js 텔레메트리** | **기본값이 Enabled 였음** — `next telemetry status`로 실측 확인 |

**Next.js 텔레메트리만 실제 문제였고, 저장소 차원에서 껐다.** 익명 통계를 `telemetry.nextjs.org`로 보내려 시도하므로 폐쇄망에서는 매 기동마다 무의미하게 실패하고 보안 검토 대상이 된다. `next telemetry disable`은 개발자 홈 디렉터리의 전역 설정에 기록되어 **저장소를 복제한 다른 PC에는 적용되지 않으므로**, `apps/portal-web/next.config.mjs`와 `scripts/windows/start-portal-web.ps1` 양쪽에서 `NEXT_TELEMETRY_DISABLED=1`을 설정한다.

확인 방법:

```powershell
cd apps\portal-web
npx next telemetry status   # Status: Disabled 이어야 한다
```

주의: 위 명령이 보고하는 값은 **전역 설정** 기준이라 여전히 Enabled로 보일 수 있다. 실제 기동 시에는 위 두 곳의 환경변수가 우선하므로, 확실히 하려면 사내 PC에서 한 번 `npx next telemetry disable`도 함께 실행해 두면 된다.

## 9. 이 문서가 다루지 않는 것

- 사내 PyPI/npm 미러의 실제 주소·인증 방식(조직마다 다름 — 이 문서에서 임의로 지어내지 않음).
- Ollama 모델을 완전 오프라인(레지스트리 접근조차 불가)으로 반입하는 정확한 절차(Ollama 자체 기능 범위).
- Windows 방화벽/보안 소프트웨어가 `localhost` 바인딩을 차단하는 경우의 대응(회사 보안팀 정책에 따라 달라짐).

## 10. 관련 결정 기록

- D-073 (`open-decisions.md`): indexing-runtime `INDEX_BASE` 하드코딩 수정, PDF/DOCX Loader 추가, Windows 실행 스크립트 신설 — 이 문서와 함께 기록됨.
