# Windows 로컬 PC 구동 Runbook (외부 연동 없음)

대상 모듈: 전체(M01~M12 중 PoC 실행에 필요한 부분)
대상 환경: 회사 Windows 10/11 PC, **외부 AI/네트워크 연동 없음**(폐쇄망 또는 폐쇄망에 준하는 격리 PC), Ollama 로컬 실행
문서 상태: 이 저장소의 실제 코드/테스트를 근거로 작성. **이 PC에서 직접 실행해 확인하지 못한 항목은 "미검증"으로 명시**하며, 추측으로 명령을 지어내지 않는다.

## 0. 이 문서를 쓰기 전에

- `docs/implementation-spec/README.md`, `07-data-api-contracts.md`, `open-decisions.md`를 먼저 읽는다(CLAUDE.md 지침).
- 이 문서는 macOS 개발 머신에서 **Windows 대상 PC에 무엇이 필요한지**를 코드/설정을 근거로 정리한 것이며, 실제 Windows 실행 세션에서 발견되는 차이는 이 문서와 `open-decisions.md`에 반영해야 한다.
- **회사 정책상 이 저장소를 준비한 macOS 개발 머신에서는 새 패키지 다운로드가 금지되어 있다.** 아래 절차 중 `install-pip.ps1`/`pnpm install`이 실제로 네트워크 설치를 수행하는 검증은 **Windows 대상 PC에서 처음 실행하는 사람이 직접 확인**해야 한다.

## 1. 사전 준비물

| 항목 | 버전 | 비고 |
|---|---|---|
| Windows | 10/11 x64 | `open-decisions.md` D-005 |
| Python | **3.11 이상** | 루트 `pyproject.toml` `requires-python = ">=3.11"`. 개발 환경(macOS)은 3.14로 검증했으나, Windows에서의 3.11~3.14 사이 호환성은 **미검증** — 문제가 생기면 우선 3.12 LTS 계열로 시도 |
| pip | Python 에 기본 포함 | Python 의존성 설치. **Windows 로컬 실행에 uv 는 필요하지 않다** — 사유는 §2.5 참고. `uv` 는 개발 머신에서 `requirements.txt` 를 재생성할 때만 쓴다 |
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

### 2.1 임베딩 모델을 바꾸고 싶을 때 (D-075)

기본 임베딩 모델(`qwen3-embedding:0.6b`)은 indexing-runtime과 search-runtime 양쪽에 각각 환경 변수로 설정되어 있다 — 코드에 하드코딩되어 있지 않다.

| 서비스 | 환경 변수 | 기본값 | 의미 |
|---|---|---|---|
| indexing-runtime | `INDEXING_EMBED_MODEL` | `qwen3-embedding:0.6b` | **새로** 색인할 때 문서 청크를 임베딩할 모델. 색인이 끝나면 이 값이 그 색인의 `index-meta.json`(`embed_model` 필드)에 그대로 기록된다 |
| search-runtime | `SEARCH_EMBED_MODEL` | `qwen3-embedding:0.6b` | **폴백 전용.** 검색 대상 색인이 `index-meta.json`에 `embed_model`을 기록하지 않은(이 필드가 생기기 전에 만들어진) 구버전 색인일 때만 쓰인다 |

**반드시 알아야 할 것 — 검색은 색인 자체가 기록한 모델을 우선 사용하지, `SEARCH_EMBED_MODEL`을 강제로 쓰지 않는다.** search-runtime이 질의를 임베딩할 때 실제로 쓰는 모델은 `services/search-runtime/src/search_runtime/hybrid.py`의 `resolve_embed_model()`이 대상 Knowledge 색인의 `index-meta.json`을 읽어 결정한다 — `SEARCH_EMBED_MODEL`은 그 파일이 없거나 `embed_model` 필드가 없는 옛날 색인에만 쓰이는 폴백이다. 이렇게 나눈 이유: 오래 떠 있는 search-runtime 프로세스 하나가 서로 다른 시점/설정으로 만들어진 여러 Knowledge 색인을 동시에 서비스할 수 있기 때문에, "지금 이 순간 설정된 기본값"이 "이 색인이 실제로 만들어질 때 쓰인 모델"과 같다고 가정할 수 없다.

**모델을 바꾸는 절차:**

1. `ollama pull <새 모델>`로 새 임베딩 모델을 준비한다.
2. `INDEXING_EMBED_MODEL=<새 모델>`을 설정하고 indexing-runtime을 재기동한다. **이 시점부터 새로 색인되는 Knowledge만** 새 모델을 쓴다 — 기존 색인은 자기 `index-meta.json`에 기록된 원래 모델을 그대로 유지한다.
3. 기존 Knowledge를 새 모델로 옮기려면 **재색인이 필요하다**(Portal에서 해당 Knowledge를 다시 업로드/색인). 임베딩이 다른 모델 사이에는 비교할 수 없으므로, `index-meta.json`만 고쳐 쓰는 방법은 없다 — 벡터 자체를 새로 만들어야 한다.
4. search-runtime은 재기동이 필요 없다 — 다음 검색 요청부터 바뀐 색인의 `embed_model`을 자동으로 읽어 그 모델로 질의를 임베딩한다. (다만 `SEARCH_EMBED_MODEL` 폴백값도 새 기본과 맞춰 두는 것을 권장 — §8의 "임베딩 모델 불일치" 행 참고)
5. **`SEARCH_QUERY_INSTRUCT_PREFIX`도 함께 검토한다.** 기본값은 Qwen3-Embedding 전용 관례(D-046)로 튜닝되어 있다. Qwen3 계열이 아닌 모델로 바꾸면 이 접두사가 오히려 검색 품질을 해칠 수 있으므로, `services/search-runtime/src/search_runtime/settings.py`의 `EMBED_MODEL`/`DEFAULT_QUERY_INSTRUCT_PREFIX` 문서 주석을 읽고 필요하면 `SEARCH_QUERY_INSTRUCT_PREFIX=""`(또는 새 모델에 맞는 값)로 함께 바꾼다. 두 설정은 서로 다른 환경 변수이며 코드가 자동으로 연동해주지 않는다.

### 2.2 기존 색인의 BM25 파일을 안전한 포맷으로 변환하기 (D-054)

`services/indexing-runtime`이 Knowledge를 색인할 때 만드는 `bm25.json`(BM25 검색용 통계 파일)은 2026-08-10부터 실행 불가능한 plain JSON이다. 그 이전에 만들어진 색인은 `bm25.pkl`이라는 **Python pickle**을 대신 갖고 있는데, pickle은 그 자체로 실행 가능한 코드다 — 신뢰할 수 없는 곳에서 온 `bm25.pkl`을 `pickle.load`하면 임의 코드 실행으로 이어질 수 있다(자세한 배경은 `open-decisions.md` D-054).

**운영자가 해야 할 일** — 기존 `data/indexes/` 아래의 각 Knowledge 색인 디렉터리에 대해, 재임베딩 없이 제자리에서 변환한다:

```powershell
# data/indexes/ 아래 각 색인 디렉터리(= AssetVersion id)에 대해 1회 실행
uv run --project services/indexing-runtime convert-bm25-format data\indexes\<AssetVersion id>
```

- **Idempotent** — 이미 변환된 색인(=이미 `bm25.json`만 있는 경우)에 다시 실행해도 안전하며, `"action": "already_converted"`로 보고하고 아무것도 바꾸지 않는다.
- 변환은 원본 `bm25.pkl`의 BM25 점수와 재구성된 결과를 대조 확인한 뒤에만 원본을 지운다 — 검증에 실패하면 `bm25.pkl`은 그대로 남고 명령이 오류로 종료된다(파일이 훼손된 채 방치되지 않는다).
- 변환 후에는 **재색인이 필요 없다** — 검색 결과(citation·score)는 변환 전후 완전히 동일하다.
- **이 변환 전에는 search-runtime이 여전히 `bm25.pkl`을 읽을 수 있다**(`SEARCH_ALLOW_LEGACY_PICKLE_BM25` 기본값 `true` — 매 요청마다 `search.bm25.legacy_pickle_fallback` WARNING 로그를 남긴다). 즉 이 절차를 당장 실행하지 않아도 검색은 계속 동작하지만, `data/indexes/`가 이후 Offline Bundle로 반출될 가능성이 있다면 반출 전에 변환해 두는 것을 권장한다 — `services/distribution-service`는 색인 디렉터리를 있는 그대로 Bundle에 복사하므로, 변환해 두면 그 이후 만들어지는 모든 Bundle이 자동으로 안전한 포맷을 갖는다.
- 게시된 4개 데모 챗봇을 포함해 오늘 존재하는 모든 색인에 대해 이 절차를 실행하는 것은 세션 소유자(운영자)의 몫이다 — 이 저장소의 개발 세션은 `data/indexes/`를 읽기 전용으로 취급했다.

같은 방식으로, D-062(§3.8 접근 통제)의 `stamp-classification` CLI를 아직 실행하지 않은 색인이 있다면 두 CLI 모두 재임베딩 없이 순서 상관없이 실행할 수 있다(`stamp-classification`은 `bm25.json`이 있으면 그것을, 없으면 여전히 `bm25.pkl`을 안전하게 다룬다):

```powershell
uv run --project services/indexing-runtime stamp-classification data\indexes\<AssetVersion id> --classification INTERNAL
```

## 2.6 Node 의존성과 폐쇄망 반입 (Desktop 채팅의 Markdown 렌더링 포함)

Node 의존성은 `pnpm install` 로 설치하며 `pnpm-lock.yaml` 이 버전을 고정한다.
폐쇄망 PC 에는 npm 레지스트리 접근이 없을 수 있으므로, **인터넷이 되는 곳에서
받아 통째로 옮기는 것**이 기본 절차다.

```powershell
# (1) 인터넷이 되는 PC 에서 — 저장소 루트
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = "1"   # Electron 바이너리는 별도 반입(§7)
pnpm install --frozen-lockfile
pnpm store prune                            # 쓰지 않는 캐시 정리
```

옮기는 방법은 둘 중 하나다.

| 방법 | 무엇을 옮기나 | 비고 |
|---|---|---|
| `node_modules` 통째 복사 | 저장소 루트와 각 워크스페이스의 `node_modules` | 가장 단순하다. 대상 PC 의 OS/아키텍처가 같아야 한다 |
| pnpm store 반입 | `pnpm store path` 가 알려주는 디렉터리 | 대상 PC 에서 `pnpm install --offline` 이 이 store 만 보고 설치한다. 여러 저장소를 반입할 때 유리하다 |

`pnpm install --offline` 은 네트워크를 아예 시도하지 않으므로, 반입이 빠졌으면
조용히 옛 상태로 도는 대신 **실패한다** — 이 PoC 에서 원하는 동작이다.

### Desktop 채팅의 Markdown 렌더링 (2026-08-14 추가)

`apps/desktop-client` 가 `react-markdown` 과 `remark-gfm` 을 쓴다. 모델 답변이
제목·목록·표·코드블록을 자유롭게 쓰는데 그것을 평문으로 보여주면 읽기 어렵기
때문이다(루트 `CLAUDE.md`: 새 의존성은 이유와 폐쇄망 설치 방법을 문서화한다).

- **순수 JavaScript 패키지**다. 네이티브 빌드나 별도 바이너리 다운로드가 없으므로
  위 절차 그대로 반입된다 — Electron 바이너리처럼 따로 챙길 것이 없다.
- 렌더링은 `src/screens/AnswerMarkdown.tsx` 한 곳에서만 한다. 그 파일은 두 가지를
  의도적으로 하지 않는다: **raw HTML 활성화**(`rehype-raw` 를 넣지 않는다 — 모델이
  만든 텍스트를 HTML 로 실행시키는 경로가 된다)와 **이동 가능한 링크 생성**
  (Electron 렌더러에서 링크를 열면 SPA 문서 자체가 대체된다). 링크는 주소를 함께
  보여주되 클릭 대상이 아니고, 이미지는 대체 텍스트만 남긴다.

## 2.5 Python 의존성 설치 (pip)

**Windows 로컬 실행은 pip 만 쓴다.** uv 는 필요하지 않다.

> 왜 pip 인가: uv 는 pip 을 내부적으로 호출하지 않는 별도 구현이라 `pip.ini` 의
> 사내 미러 설정을 읽지 않고, 기본적으로 자체 번들 루트 인증서를 쓴다. 실제
> 반입 과정에서 `chromadb`·`ecdsa` 가 uv 로만 실패하고 pip 으로는 설치되는
> 현상이 있었다. 사내망에서는 pip 이 이미 미러·인증서 설정을 갖고 있으므로
> 그 경로를 그대로 쓰는 편이 확실하다.

### 한 줄 설치

```powershell
.\scripts\windows\install-pip.ps1
```

이 스크립트가 하는 일:

1. `.venv` 생성 (이미 있으면 재사용)
2. `pip` 업그레이드
3. `requirements.txt` 설치 — 외부 패키지 108개, **버전 고정**
4. 워크스페이스 내부 패키지 11개를 `pip install -e ... --no-deps` 로 설치

설치 후 가상환경을 활성화한다.

```powershell
.\.venv\Scripts\Activate.ps1
```

### 스크립트 없이 pip 만으로 (권장 대안)

**스크립트는 편의 도구일 뿐이다.** 아래 명령을 직접 실행해도 결과는 같고, 스크립트에서 문제가 생기면 이쪽이 더 확실하다.

### 수동으로 하려면

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

# 워크스페이스 내부 패키지 — PyPI 에 없으므로 로컬 경로에서 설치한다.
# --no-deps 가 필요하다: 이 패키지들은 서로를 이름으로만 참조하는데
# (portal-api 가 `ai-asset-schemas` 를 요구) 그 이름은 PyPI 에 없으므로,
# --no-deps 없이 설치하면 pip 이 PyPI 에서 찾다가 실패한다. 외부 의존성은
# 위 requirements.txt 에서 이미 전부 설치되므로 건너뛰어도 빠지는 것이 없다.
python -m pip install -e packages/schemas            --no-deps
python -m pip install -e packages/observability      --no-deps
python -m pip install -e packages/security-policy    --no-deps
python -m pip install -e packages/evaluation-runner  --no-deps
python -m pip install -e packages/knowledge-packager --no-deps
python -m pip install -e services/agent-runtime      --no-deps
python -m pip install -e services/indexing-runtime   --no-deps
python -m pip install -e services/search-runtime     --no-deps
python -m pip install -e services/distribution-service --no-deps
python -m pip install -e services/office-mcp-server  --no-deps
python -m pip install -e apps/portal-api             --no-deps
```

### 설치 확인

가장 빠른 방법은 점검 스크립트다. 아무것도 바꾸지 않고 상태만 보고한다.

```powershell
.\scripts\windows\doctor.ps1
```

Python / .venv / 파이썬 패키지 / 워크스페이스 패키지 / Node / pnpm / portal-web 의존성 / Ollama 서버와 모델 / 서비스 포트를 한 번에 확인하고, 빠진 항목마다 무엇을 실행해야 하는지 알려준다.

수동으로 확인하려면:


```powershell
python -c "import fastapi, chromadb, sqlalchemy; print('외부 OK')"
python -c "import ai_asset_schemas, security_policy, observability, portal_api; print('워크스페이스 OK')"
python -c "import pypdf, docx; print('PDF/DOCX 로더 OK')"
```

### requirements.txt 를 다시 만들어야 할 때

의존성을 바꾼 뒤에는 uv 가 있는 개발 머신에서 아래로 재생성한다. 사내 PC 에서는 필요 없다.

```bash
uv export --format requirements-txt --all-packages --no-emit-workspace --no-hashes > requirements.txt
```

### 설치가 실패하면

| 증상 | 확인 |
|---|---|
| 특정 패키지에서 연결 실패 | `pip config list` 로 사내 미러 인덱스가 설정되어 있는지 확인 |
| `requirements.txt 설치 실패` | 스크립트가 자동으로 **한 줄씩 재시도해 실패한 패키지 목록**을 출력한다. 그 목록을 보고 아래를 판단한다 |
| 고정 버전이 미러에 없음 | 사내 미러가 PyPI 전체를 미러링하지 않으면 정확한 버전(`==`)이 없을 수 있다. `python -m pip index versions <패키지명>` 으로 확인하고, 없으면 `install-pip.ps1 -Loose` 로 버전 고정 없이 설치한다(재현성은 떨어진다) |
| 인증서 오류 | 사내 프록시 루트 CA 가 Windows 인증서 저장소에 있는지 확인 |
| `lxml` 빌드 실패 | 미러에 win_amd64 사전 빌드 wheel 이 있는지 확인(소스 빌드 시 C 도구 필요) |
| `UnicodeDecodeError: 'cp949' codec can't decode byte 0xe2` | Windows 한국어 환경의 기본 인코딩(cp949)으로 UTF-8 파일을 읽어 발생한다. `alembic.ini` 는 순수 ASCII 로 유지하도록 수정했고, 스크립트는 `PYTHONUTF8=1` 을 설정한다. 스크립트 없이 직접 실행할 때 같은 오류가 나면 `$env:PYTHONUTF8 = "1"` 을 먼저 설정한다. (`.py` 소스는 PEP 3120 에 따라 항상 UTF-8 로 읽히므로 영향받지 않는다) |
| `electron postinstall failed` / `RequestError: read ECONNRESET` | Electron 실행 바이너리(약 100MB)를 GitHub 에서 내려받다 막힌 것이다. **Portal 에는 Electron 이 필요 없다** - `.\\scripts\\windows\\install-node.ps1` 을 쓰거나 `$env:ELECTRON_SKIP_BINARY_DOWNLOAD = "1"` 설정 후 `pnpm install` 을 실행한다. Desktop 렌더러(Vite)는 이 상태에서도 동작하고, Electron 앱 자체를 띄울 때만 바이너리가 필요하다 |
| 화면은 뜨는데 `Failed to fetch` (서버 로그에는 200) | 브라우저 접속 주소와 portal-api 의 CORS 허용 Origin 이 다르다. `localhost` 와 `127.0.0.1` 은 CORS 에서 **서로 다른 Origin** 이라, 서버는 200 을 기록해도 브라우저가 응답을 버린다. 기본 허용은 `http://localhost:3000` 과 `http://127.0.0.1:3000` 이다. 호스트명이나 사설 IP 로 접속한다면 `PORTAL_CORS_ORIGINS` 환경 변수에 그 주소를 추가한다 |
| `No module named pip` | venv 에 pip 이 없다. **네트워크 없이 복구된다**: `.venv\\Scripts\\python.exe -m ensurepip --upgrade`. 그래도 안 되면 `python -m venv --clear .venv` 로 재생성하고, 시스템 Python 에도 pip 이 없다면 Python 재설치 시 pip 포함 옵션을 확인한다 |
| `ai-asset-schemas 를 찾을 수 없음` | 워크스페이스 패키지 설치에서 `--no-deps` 를 빠뜨렸는지 확인 |

### PowerShell 출력의 한글이 깨질 때

`.ps1` 파일은 모두 **UTF-8 BOM + CRLF** 로 저장되어 있다. Windows PowerShell 5.1(Windows 기본)은 BOM 이 없으면 파일을 시스템 코드페이지(한국어 Windows 는 CP949)로 읽어 한글 문자열이 깨지기 때문이다. `.gitattributes` 가 체크아웃 시 이 상태를 유지한다.

그래도 깨진다면 **콘솔 쪽** 문제다. 순서대로 확인한다.

```powershell
# 1) 현재 코드페이지 확인 (949 = CP949, 65001 = UTF-8)
chcp

# 2) UTF-8 로 전환 — 현재 창에만 적용된다
chcp 65001
```

`chcp 65001` 후에도 네모(□)나 물음표로 보인다면 **콘솔 글꼴**이 한글을 지원하지 않는 것이다. 창 제목 우클릭 → 속성 → 글꼴에서 `맑은 고딕`, `굴림체`, `NanumGothicCoding` 등으로 바꾼다(`Consolas` 는 한글 글리프가 없다).

**Windows Terminal** 을 쓰면 위 문제가 대부분 발생하지 않는다. 사내 PC 에 설치할 수 있다면 그쪽을 권한다.

> 파일을 편집할 때 주의: 메모장 등으로 `.ps1` 을 열어 저장하면 BOM 이 사라질 수 있다. 그러면 다시 한글이 깨진다. VS Code 에서는 하단 상태바의 인코딩을 `UTF-8 with BOM` 으로 유지한다.

### 스크립트가 알아서 알려준다

`scripts/windows/` 의 기동 스크립트들은 실행 전에 사전 점검을 한다(`_preflight.ps1`). 빠진 것이 있으면 원시 오류(`ModuleNotFoundError`, `'pnpm'을 찾을 수 없습니다`) 대신 **원인과 실행할 명령**을 한국어로 출력하고 멈춘다.

| 점검 | 어떻게 판단하나 | 없으면 |
|---|---|---|
| Python / `.venv` | `.venv\Scripts\python.exe` 우선, 없으면 현재 환경 | 설치 안내 후 종료 |
| 파이썬 패키지 | `python -c "import X"` — **실행 파일(.exe) 존재 여부가 아니다** | `install-pip.ps1` 안내 후 종료 |
| 워크스페이스 패키지 | 동일 | `--no-deps` 설명과 함께 안내 후 종료 |
| pnpm / portal-web 의존성 | `pnpm` 명령과 `node_modules\.bin\next` | `corepack enable` / `pnpm install` 안내 후 종료 |
| 포트 중복 | 해당 포트 LISTEN 여부 | **경고만** (이미 떠 있을 수 있으므로 판단은 사용자 몫) |
| Ollama·모델 | `:11434/api/tags` | **경고만** (서비스는 기동되고 실제 대화/색인에서 실패) |

`start-all.ps1` 은 7개 창을 띄우기 **전에** 한 번 점검한다 — 창 7개가 전부 같은 이유로 실패하는 것을 막기 위해서다.

`start-portal-web.ps1` 은 portal-api(:8000)가 아직 없으면 경고한다. Next 가 브라우저 요청을 :8000 으로 넘기므로(§ next.config.mjs rewrite), portal-api 가 없으면 화면은 뜨지만 데이터가 비어 보이기 때문이다.

| `.venv\\Scripts\\` 에 `uvicorn.exe`/`next` 가 안 보임 | **정상일 수 있다.** 기동 스크립트는 `python -m uvicorn`, `pnpm --filter portal-web dev` 로 부르므로 실행 파일(.exe)이 없어도 동작한다. 실제로 확인할 것은 `python -c "import uvicorn"` 이 되는지다 |

## 3. 저장소 설치

```powershell
# 저장소 루트에서 - Python 은 §2.5 에서 이미 설치했다
.\scripts\windows\install-node.ps1
```

**`pnpm install` 을 직접 실행하면 Electron 단계에서 막힐 수 있다.** `apps/desktop-client` 의 postinstall 이 Electron 실행 바이너리(약 100MB)를 GitHub Releases 에서 내려받는데, 사내망에서는 `RequestError: read ECONNRESET` 로 실패하는 경우가 많다.

**Portal 을 띄우는 데 Electron 은 필요 없다.** 위 스크립트는 기본적으로 Electron 바이너리 내려받기를 건너뛰고 나머지를 모두 설치한다. Portal(:3000)과 Desktop 렌더러(Vite, **:5173** — `vite.config.ts`가 `strictPort`로 고정)는 그대로 동작하며, Electron 앱 자체를 띄울 때만 바이너리가 필요하다.

직접 실행한다면 아래와 같다.

```powershell
# Electron 바이너리만 건너뛰고 전체 설치
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = "1"
pnpm install

# 또는 Portal 관련 패키지만 설치
pnpm install --filter portal-web...

# 사내에 Electron 미러가 있다면
$env:ELECTRON_MIRROR = "https://<사내미러>/electron/"
pnpm install
```


- **PDF/Word Knowledge 색인 지원(D-073)**: `services/indexing-runtime/pyproject.toml`에 `pypdf`, `python-docx`를 의존성으로 추가했다. 두 패키지는 `requirements.txt` 에 고정 버전으로 포함되어 있다. **2026-08-15 실측 정정**: 개발 macOS 머신에도 이미 설치되어 있다(pypdf 6.15.0, python-docx 1.2.0). 이 문서에 오래 남아 있던 "개발 머신에는 설치된 적이 없다"는 서술은 사실이 아니었고, 그 서술을 근거로 작성된 작업 지시가 실제와 어긋난 적이 있다 — Windows PC 가 **최초 설치 시점**이라는 전제도 함께 무효다. Windows PC 에서의 설치 절차 자체(아래 미러 확인)는 그대로 유효하다. 설치가 실패하면 `pip config list` 로 사내 미러 인덱스 설정을 확인한다(미러 주소는 조직마다 다르므로 이 문서에서 구체적 값을 지어내지 않는다).
  - `pypdf`: 순수 Python, BSD-3-Clause, OS/아키텍처 무관 단일 wheel.
  - `python-docx`: 순수 Python, MIT. 유일한 런타임 의존성 `lxml`은 win_amd64용 사전 빌드 wheel을 제공하므로 별도 C 빌드 도구 없이 설치 가능하다(미러에 lxml wheel도 함께 반입되어 있어야 함).
  - 두 패키지가 없어도 indexing-runtime 자체는 정상 기동하고 Markdown/Text Knowledge는 그대로 색인된다 — PDF/DOCX 파일을 실제로 색인하려 할 때만 "PDF 로더에 필요한 pypdf가 설치되어 있지 않습니다" 같은 명확한 한국어 오류로 실패한다(크래시가 아님). 상세: `services/indexing-runtime/src/indexing_runtime/loaders/`.
- `pnpm install`은 `apps/portal-web`, `apps/desktop-client`를 포함한 pnpm workspace 전체를 설치한다.

## 4. DB 마이그레이션

```powershell
.\scripts\windows\migrate.ps1
```

apps/portal-api 에서 `alembic upgrade head` 를 실행한다. 저장소를 처음 반입했을 때, 또는 이후 코드 업데이트로 `apps/portal-api`의 모델이 바뀌었을 때 실행한다. `apps/portal-api/portal.db`(SQLite)가 없으면 새로 생성된다.

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

`uvicorn ... --reload`는 파일 변경 감지를 위해 `watchfiles`를 사용한다 — uvicorn/watchfiles 모두 Windows를 공식 지원하지만, **이 PoC에서 Windows상 `--reload` 동작 자체를 실행해 확인하지는 않았다**. 문제가 있으면 `--reload` 플래그를 빼고 실행해도 개발 편의성만 잃을 뿐 기능에는 영향 없다.

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

### 7.1 설치한 Knowledge를 실제로 검색에 활성화하기 (D-079)

**"설치됨"은 "검색 가능"이 아니다.** Desktop이 ZIP을 15단계 검증 후 설치하면 색인 파일은 그 PC의 사용자 폴더(`%APPDATA%\Enterprise AI Asset Hub\assets\knowledge\...`)에 들어가지만, search-runtime은 자기 `INDEX_BASE` 트리만 검색한다. 그래서 활성화하지 않은 Knowledge는 오류 없이 **영원히 0건**을 반환한다 — 이것이 D-079가 닫은 공백이다.

활성화는 search-runtime의 관리 API(`POST /search/v1/local-indexes`)로 이루어지며, 이 API는 **기본적으로 꺼져 있다.**

| 서비스 | 환경 변수 | 기본값 | 의미 |
|---|---|---|---|
| search-runtime | `SEARCH_LOCAL_INDEX_ROOTS` | (비어 있음 = 기능 꺼짐) | 외부에 설치된 색인을 등록할 수 있는 상위 디렉터리 목록(`os.pathsep` 구분). 비어 있으면 모든 등록 요청이 403 `local_indexes_disabled`로 거절된다 |
| search-runtime | `SEARCH_LOCAL_INDEX_REGISTRY` | `INDEX_BASE` 옆의 `local-indexes.json` | 등록 내역 저장 파일. 재기동 후에도 활성화 상태가 유지된다 |

**Desktop이 있는 PC에서 search-runtime을 띄울 때:**

```powershell
$env:SEARCH_LOCAL_INDEX_ROOTS = "$env:APPDATA\Enterprise AI Asset Hub\assets"
```

```bash
# macOS/Linux
export SEARCH_LOCAL_INDEX_ROOTS="$HOME/Library/Application Support/Enterprise AI Asset Hub/assets"
```

**중앙에 배포된 search-runtime에는 이 값을 설정하지 않는다.** 기본값(비어 있음)이 곧 "이 서비스가 새로 접근할 수 있는 파일 경로가 늘어나지 않는다"는 뜻이다. 설정하더라도 등록은 그 루트 안쪽으로만 허용되고, 경계 검사는 symlink를 해석한 뒤에 수행하므로 루트 안에 심어 둔 링크로 바깥 디렉터리를 등록할 수 없다.

**활성화가 거절되는 대표적인 경우 (모두 명시적 오류로 반환되며, 조용한 0건이 되지 않는다):**

| `details.reason` | 뜻과 대처 |
|---|---|
| `local_indexes_disabled` | 위 `SEARCH_LOCAL_INDEX_ROOTS`가 설정되지 않았다 |
| `bm25_legacy_pickle_only` | 색인에 `bm25.json` 없이 legacy `bm25.pkl`만 있다. **배포 채널로 들어온 pickle은 이 서비스가 절대 로드하지 않는다**(D-054) — §2.2 절차로 변환한 뒤 다시 반출/설치한다 |
| `index_meta_knowledge_id_mismatch` | 색인 폴더의 `index-meta.json`이 다른 `knowledge_id`를 기록하고 있다. 잘못된 색인을 가리키고 있다는 뜻이므로 등록하지 않는다(D-060) |
| `central_index_exists` | 같은 `knowledge_id` 색인이 이미 이 서비스의 `INDEX_BASE`에 있다. **중앙 색인이 항상 우선**하며, 외부 색인이 그것을 덮어쓸 수 없다 |
| `path_outside_allowed_roots` | 허용 루트 밖의 경로다 |

**실측(2026-08-13, macOS)**: 현재 저장소의 `data/indexes/d9e660b7-...`(재택근무 정책 Knowledge) 색인은 아직 `bm25.pkl`만 가지고 있어 **그대로는 활성화되지 않는다** — `bm25_legacy_pickle_only`로 거절되는 것을 실제 서비스로 확인했다. `convert-bm25-format`으로 변환한 사본은 등록에 성공했고, 같은 질의(`장비 지원은 무엇이 있나요?`)가 활성화 전 0건 → 활성화 후 실제 Citation 1건(`장비 지원` 섹션, similarity 0.53) → 비활성화 후 다시 0건으로 바뀌는 것까지 확인했다. **Offline Bundle로 반출하기 전에 §2.2 변환을 먼저 수행할 것.**

**이건 이 색인 하나만의 문제가 아니었다(2026-08-13 오전, 전수 조사)**: `data/indexes/` 아래 존재하던 5개 색인을 전부 확인한 결과, 그 시점에는 **예외 없이 전부 `bm25.pkl`만 있고 변환된 `bm25.json`이 없었다.** 그리고 `87827bf9-…`는 청크 18개 전부 `classification`이 기록되지 않아 D-062(미분류 자산 fail-closed)에 걸려 어떤 클리어런스로도 결과를 반환하지 않았다.

**같은 날 오후, 사용자 승인을 받아 두 조치를 실행해 해소했다(D-081, `open-decisions.md` 참고)**: 5개 색인 전부에 `convert-bm25-format`을 실행했고(전부 `"action": "converted"`를 보고, 재실행 시 전부 `"already_converted"`로 멱등성 확인), `87827bf9-…`는 사용자가 결정한 **INTERNAL** 등급으로 `stamp-classification`을 실행했다(청크 18개 전부). 현재 상태:

| 색인(AssetVersion id) | bm25 포맷 (2026-08-13 조치 후) | 청크 classification |
|---|---|---|
| `43d83955-…` | `bm25.json` (변환 완료) | CONFIDENTIAL (청크 64개) |
| `87827bf9-…` | `bm25.json` (변환 완료) | **INTERNAL (청크 18개, 이 세션에서 신규 stamp)** |
| `a038442d-…` | `bm25.json` (변환 완료) | INTERNAL (청크 11개) |
| `d9e660b7-…` | `bm25.json` (변환 완료) | INTERNAL (청크 4개) |
| `hr-policy-v1` | `bm25.json` (변환 완료) | INTERNAL (청크 4개) |

이제 이 5개 색인은 그대로 반출해도 `bm25_legacy_pickle_only`로 거절되지 않는다. 변환이 검색 결과 자체를 바꾸지 않는다는 것도 별도 포트에서 자체 기동한 search-runtime으로 실측했다 — `d9e660b7`, 질의 `장비 지원은 무엇이 있나요?`, clearance INTERNAL: 변환 전후 모두 인용 1건·섹션 `장비 지원`·similarity 0.5265(차이 0.0000). `87827bf9-…`의 분류 차단 해소도 실측했다 — 같은 조건에서 스탬프 전 0건 → 후 5건(최상위 섹션 `AX를 위한 LLM 입문 자료 짧은 요약`, similarity 0.8991). 조치 전 `data/indexes/` 전체를 세션 scratchpad(임시 디렉터리이며 영구 rollback 수단으로 취급하지 않는다)에 백업했다.

**위 절차(`convert-bm25-format`/`stamp-classification`)는 이 5개 색인에 대해서는 이미 끝났지만, 앞으로 새로 만들어지는(또는 다른 PC에 있는) 색인에는 여전히 그대로 적용된다** — indexing-runtime이 새로 만드는 색인은 기본적으로 `bm25.json`을 생성하므로 보통은 필요 없지만, 구버전 파이프라인으로 만들어졌거나 이관된 색인이라면 §2.2 변환을 거쳐야 하고, classification이 기록되지 않은 색인은 `stamp-classification`으로 등급을 부여해야 검색된다. 아래 §8 표의 "챗봇/검색이 오류 없이 항상 '근거 없음'" 항목은 이 증상이 다른 색인에서 재발했을 때 그대로 쓸 수 있는 진단 가이드다.

**아직 해소되지 않은 것**: Desktop 앱이 이 PC에 이미 설치해 둔 사본(`~/Library/Application Support/desktop-client/assets/knowledge/2f157a86-…/1.0.0/index`, macOS 기준)은 여전히 `bm25.pkl`만 있다 — 그 `knowledge_id`(`d9e660b7-…`)가 중앙 `INDEX_BASE`에 이미 있어 `central_index_exists`로 어차피 등록이 거절되므로 지금 변환해도 이득이 없어 의도적으로 범위 밖에 뒀다. 그리고 실행 중이던 `:8300` search-runtime 프로세스는 여전히 D-079 라우트가 없는 구버전이라 활성화 요청이 404 나며, 운영자가 재시작해야 해소된다 — 이번 조치에서 라이브 서비스 재시작은 하지 않았다.

search-runtime은 Desktop과 **같은 PC**에 있어야 한다 — 등록 요청이 전달하는 것은 그 PC의 로컬 절대 경로이므로, 원격 search-runtime은 그 디렉터리를 읽을 수 없다.

### 7.2 macOS 개발 세션에서 스택 제어하기 (`scripts/macos/dev-stack.sh`)

이 문서의 나머지는 Windows 대상 PC 배포 절차이지만, 이 저장소를 준비·검증하는 macOS 개발 머신에서는 7개 서비스를 매번 개별 명령으로 띄우고 내리는 대신 한 스크립트로 제어할 수 있다. `scripts/windows/start-all.ps1`/`health-check.ps1`의 macOS 대응물이며, 이쪽은 시작뿐 아니라 종료까지 한 진입점에서 지원한다.

```bash
scripts/macos/dev-stack.sh <start|stop|restart|status> [서비스 이름...]
```

서비스 이름을 생략하면 7개 전체(portal-api/agent-runtime/indexing-runtime/search-runtime/distribution-service/office-mcp-server/portal-web)를 대상으로 한다. 실행 명령 자체는 `Makefile`의 `dev-*` 타겟과 동일하되 `--reload`는 뺀다 — reloader가 감시용 부모와 실제 요청을 처리하는 자식 프로세스를 분리해 PID·포트 관리를 불안정하게 만들기 때문이다. 이 스크립트로 띄운 스택은 코드가 바뀌면 `restart`로 통째로 다시 띄우는 것을 전제로 하므로 파일 감시가 필요 없다.

- **`start`는 포트가 이미 점유돼 있으면 거부한다**(점유 중인 PID와 시작 시각을 표시) — 죽은 줄 알았던 프로세스 위에 새 인스턴스를 덧띄우는 사고를 막기 위함이다.
- **`stop`은 PID 파일만 믿지 않는다** — 포트 소유자 PID와 명령줄 패턴을 함께 찾아 SIGTERM을 보내고, 그래도 남아 있으면 SIGKILL로 강제 종료하며, 그래도 포트가 비지 않으면 실패로 종료한다(조용히 넘어가지 않는다).
- **`status`가 이 스크립트의 핵심이다.** 각 서비스가 실제로 응답하는 `commit_sha`를 저장소 현재 HEAD와 나란히 보여준다 — portal-api/distribution-service/search-runtime 세 서비스만 이 필드를 갖고 있어(`PORTAL_`/`DISTRIBUTION_`/`SEARCH_` 접두사의 `BUILD_VERSION`/`COMMIT_SHA` 환경변수로 주입) 확인할 수 있고, 나머지 세(agent-runtime/indexing-runtime/office-mcp-server)는 코드에 그 필드 자체가 없어 "미지원"으로 명시한다(빈 칸이 아니라 명시적 표시 — 실제 한계이지 누락이 아니다). 200을 반환해도 커밋이 HEAD와 다르면 "오래된 코드"로 눈에 띄게 표시한다 — 바로 위 §7.1 끝에 기록된 것처럼, 재시작하지 않은 구버전 search-runtime이 새 라우트를 404로 거부하던 사고를 다음에는 로그를 뒤지지 않고 즉시 알아챌 수 있게 하려는 목적이다.
- search-runtime을 이 스크립트로 띄울 때는 `SEARCH_LOCAL_INDEX_ROOTS`를 위 §7.1 기본값(`$HOME/Library/Application Support/desktop-client/assets`)으로 자동 주입한다(이미 설정된 값이 있으면 그것을 우선한다).
- PID/로그는 저장소 루트의 `.dev-stack/`(gitignored)에 쌓인다.
- Ollama(:11434)는 `status`에서 확인만 하고, 이 스크립트가 시작/중지하지 않는다.
- DB 마이그레이션은 자동 적용하지 않는다 — `status`가 최신이 아니면 경고만 하고, 적용은 `make migrate`를 사용자가 직접 실행해야 한다.

## 8. 문제 해결

| 증상 | 원인 후보 | 조치 |
|---|---|---|
| 특정 서비스 창이 "Address already in use" 등으로 즉시 종료 | 포트 충돌(다른 프로세스가 같은 포트 점유) | Windows에서 `netstat -ano \| findstr :8000` 등으로 점유 PID 확인 후 종료, 또는 `--port`를 바꿔 임시 회피(다른 서비스가 그 포트를 호출하도록 설정도 함께 바꿔야 함 — 임시방편) |
| `health-check.ps1`에서 한 서비스만 계속 실패 | 그 서비스가 기동 중 예외로 멈춰 있음("wedged") | 해당 서비스 창의 로그 확인. 재현 불가한 뻗음이면 그 창만 `Ctrl+C` 후 스크립트 재실행 — 다른 서비스는 건드릴 필요 없음(서비스 간 독립 프로세스) |
| 챗봇 Preview가 답변을 못 받아옴/느림 | Ollama 모델 미설치, 또는 Ollama 자체가 안 떠 있음 | `.\scripts\windows\health-check.ps1 -IncludeOllama`로 모델 두 개(`exaone3.5:7.8b`, `qwen3-embedding:0.6b`)가 모두 확인되는지 점검. 없으면 §2의 `ollama pull` 재실행 |
| 지식 등록 후 색인이 영영 "처리 중"으로 안 바뀜 | indexing-runtime이 죽었거나(뻗음), INDEX_BASE 문제 | indexing-runtime 창 로그 확인. `INDEX_BASE` 환경 변수를 별도로 설정하지 않았다면 저장소 루트의 `data\indexes`가 기본값이다(D-073으로 수정 — 이전에는 이 값이 특정 macOS 개발자의 절대경로로 하드코딩되어 있어 다른 PC에서는 반드시 `INDEX_BASE`를 수동 지정해야 했던 결함이 있었다. 지금은 기본값 자체가 저장소 상대경로라 별도 지정 없이도 동작해야 한다) |
| PDF/DOCX 파일을 색인하면 "pypdf가 설치되어 있지 않습니다"/"python-docx가 설치되어 있지 않습니다" 오류 | §2.5 의 설치가 그 패키지를 실제로 설치하지 못함(미러 인덱스 미설정 등) | `python -c "import pypdf, docx"`로 실제 설치 여부 확인 후, 사내 미러 인덱스 설정을 재점검 |
| `portal.db` 관련 컬럼 오류(`no such column`) | 마이그레이션 미적용 | `.\scripts\windows\migrate.ps1` 실행. 그래도 안 되면 `alembic current`/`alembic heads`로 현재 리비전과 최신 리비전이 일치하는지 비교(가상환경 활성화 후 apps/portal-api 에서 실행) |
| PowerShell에서 `.ps1` 실행이 거부됨(빨간 오류) | 실행 정책이 `Restricted` | §1.1 참고. 조직 정책상 `Set-ExecutionPolicy`가 막혀 있으면 `powershell -ExecutionPolicy Bypass -File <script>.ps1`로 개별 실행 |
| Desktop Electron 창이 뜨지 않음 | §7 참고 — 이 경로는 이번 세션 기준 미검증 | `pnpm dev`의 콘솔 출력(Vite/Electron 각각의 로그, `-n vite,electron` 접두사로 구분됨)을 그대로 공유해 원인 분석 필요 |
| 챗봇 답변의 근거(citation)가 이상하게 관련 없어 보임(오류는 없음) | 임베딩 모델 불일치(D-075) — Knowledge 색인을 만든 모델과 검색이 실제로 쓴 모델이 다르면 코사인 유사도 자체가 의미를 잃어 조용히 품질만 나빠진다 | search-runtime 로그에서 `search.embed_model.fallback`(색인에 `embed_model` 기록이 없어 `SEARCH_EMBED_MODEL` 폴백을 썼음) 또는 `search.embed_model.mismatch`(색인 기록과 `SEARCH_EMBED_MODEL` 설정이 서로 다름 — 색인 쪽이 우선 적용됨) 로그 라인을 확인. `POST /search/v1/query` 응답의 `embed_model_applied`/`embed_model_source` 필드로도 실제 적용된 모델을 바로 확인할 수 있다. §2.1 절차대로 재색인했는지 점검 |
| 챗봇/검색이 오류 없이 항상 "근거 없음"(citation 0건) | 분류(classification) 미기록 — D-062가 미분류 청크를 fail-closed로 숨긴다. §7.1의 `87827bf9-…` 실측 사례와 동일 원인 | `SEARCH_ALLOW_UNKNOWN_CLASSIFICATION`을 임시로 `true`로 켜서 같은 질의 결과가 늘어나는지 비교하거나, Portal의 검색 품질 테스트(§7.1, `search-preview`)가 `no_result_reason: CLASSIFICATION_ABOVE_CLEARANCE`를 보고하는지 확인. 원인이 맞으면 `stamp-classification`으로 조치(어떤 등급을 스탬프할지는 사람의 결정 — `open-decisions.md` D-081) |

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
- D-075 (`open-decisions.md`): 임베딩 모델을 `INDEXING_EMBED_MODEL`/`SEARCH_EMBED_MODEL` 설정으로 분리, search-runtime이 검색 시 자기 설정이 아니라 대상 색인의 `index-meta.json`에 기록된 `embed_model`을 우선 사용하도록 수정 — §2.1 참고.
- D-054 (`open-decisions.md`): `bm25.pkl`(Python pickle, 실행 가능한 포맷)을 `bm25.json`(비실행 JSON)으로 교체 — §2.2 참고. 기존 색인은 `convert-bm25-format`으로 운영자가 직접 변환해야 한다.
- D-079 (`open-decisions.md`): Desktop이 설치한 Knowledge 색인을 search-runtime에 등록해야 실제로 검색된다(`SEARCH_LOCAL_INDEX_ROOTS`) — §7.1 참고. 계약은 `packages/schemas/api/knowledge-local-index.schema.json`.
