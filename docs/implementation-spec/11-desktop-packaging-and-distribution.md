# Desktop 패키징과 폐쇄망 배포 상세 명세

대상 모듈: M04(`apps/desktop-client`), M03(`services/distribution-service`)
관련 문서: `02-desktop-and-agent-runtime.md`(M04 화면/프로세스 구조), `01-portal-and-distribution.md` §4(Offline Bundle 구성/Import 검증), `06-quality-delivery.md`(Windows Installer Smoke Test), `open-decisions.md`(D-005/D-006/D-016/D-030/D-047/D-048)

## 0. 이 문서가 다루는 두 가지 서로 다른 문제

이 문서를 작성하게 된 계기는 하나지만, 실제로는 **성격이 다른 두 문제**를 다룬다. 이후 절에서 계속 구분해서 언급하므로 먼저 명확히 한다.

1. **개발 워크스테이션 문제 (해결됨, 재발 방지가 목표)**: `apps/desktop-client`에서 `pnpm install` 실행 시 Electron의 postinstall 스크립트가 GitHub에서 macOS용 Electron 런타임 바이너리를 내려받았고, Gatekeeper 관점에서 서명되지 않은 이 바이너리를 macOS XProtect가 악성코드로 오탐해 휴지통으로 격리한 사건이 이 회사 지급 macOS 개발 PC에서 실제로 발생했다. 이것은 **개발자가 로컬에서 앱을 실행/디버깅하기 위한 개발용 Electron 런타임**의 문제이며, 아래 §5에서 재발 방지 절차를 다룬다.
2. **배포 대상 문제 (D-005로 이미 결정됨)**: 실제 배포 대상은 **Windows 10/11 x64**이고, 최종 산출물은 macOS 앱이 아니라 **Windows 설치 파일(NSIS `.exe`)**이다. 서명되지 않은 `.exe`는 Windows SmartScreen("알 수 없는 게시자")과 사내 EDR에 의해 차단되거나 경고를 유발할 수 있다. 사내 채널로 배포되는 Authenticode 서명된 `.exe`는 이 문제를 겪지 않는다. 이것은 §3(코드 서명)에서 다룬다.

두 문제를 혼동하지 않는다: ①은 "개발 중 macOS에서 무엇이 깨졌는가"이고, ②는 "운영 중 Windows에서 무엇을 갖춰야 하는가"이다.

## 1. 빌드 절차

### 1.1 어디서 빌드하는가

**권장: Windows PC 또는 Windows CI Runner에서 빌드한다.** macOS/Linux에서 electron-builder로 Windows 대상을 Cross-build하는 것 자체는 기술적으로 가능하지만,

- Wine 등 추가 Cross-build 툴체인이 필요하고 폐쇄망 전제와 상충한다.
- **Authenticode 서명(§3)은 Windows의 `signtool.exe` 또는 Windows 전용 서명 도구에 의존하므로 macOS/Linux에서는 사실상 수행할 수 없다** (서드파티 우회 방법이 있으나 PoC 범위 밖이며 권장하지 않는다).

따라서 이 프로젝트는 macOS Cross-build를 지원 경로로 채택하지 않는다. CI 러너를 둔다면 Windows Runner(예: GitHub Actions `windows-latest`의 사내 등가물 또는 사내 Windows CI Agent)를 사용한다.

### 1.2 빌드 단계

`apps/desktop-client/package.json`의 실제 스크립트 기준:

1. `pnpm install --offline` (§4 참고 — 반드시 사내 미러 대상)
2. `pnpm --filter desktop-client run build`
   - `vite build` → Renderer를 `dist/renderer/`에 생성 (`vite.config.ts`의 `base: "./"` 덕분에 `file://`로 로드 가능한 상대 경로 사용)
   - `tsc -p tsconfig.electron.json` → Main/Preload를 `dist/electron/`에 컴파일 (`main.js`, `preload.js` 등)
3. `pnpm --filter desktop-client run dist:win` (= `pnpm run build && electron-builder --win --x64`)
   - `apps/desktop-client/electron-builder.yml` 설정을 사용
   - 산출물은 `apps/desktop-client/release/`에 생성됨 (`dist/`가 아님 — `dist/`는 위 2번 단계의 결과물이며 electron-builder의 입력이므로, 출력 디렉터리를 겹치지 않게 `directories.output: release`로 분리했다)
   - NSIS 설치 파일 이름 패턴: `AI Asset Hub 데스크톱-Setup-<version>-x64.exe` (`artifactName` 설정)

이 세션에서는 위 1~3단계를 **실행하지 않았다** (다운로드 금지 제약). `pnpm --filter desktop-client typecheck`만 재확인해 설정 변경이 기존 TypeScript 빌드를 깨지 않았음을 확인했다.

### 1.3 electron-builder 설정 파일 선택

`apps/desktop-client/electron-builder.yml`을 신설했다 (package.json의 `"build"` 키가 아니라 별도 파일). 이유:

- `package.json`은 이미 이 패키지의 scripts/dependencies의 단일 진실 소스이며, JSON은 주석을 지원하지 않아 서명 placeholder에 대한 설명(왜 이 필드가 비어있는지, 어떤 환경변수가 채우는지)을 남길 수 없다.
- electron-builder는 프로젝트 루트의 `electron-builder.yml`을 별도 설정 없이 자동 인식한다.

## 2. NSIS 옵션과 근거

`electron-builder.yml`의 `nsis:` 블록에 인라인 주석으로 각 선택의 근거를 남겼다. 요약:

| 옵션 | 값 | 사내 관리 PC 환경에서의 근거 |
|---|---|---|
| `oneClick` | `false` | 일반 원클릭 설치 대신 마법사형으로 전환 — 단, electron-builder의 NSIS 템플릿은 이 설정과 무관하게 항상 `/S`(무인 설치), `/D=<경로>`(설치 경로 지정, 마지막 인자·따옴표 없이)를 지원하므로 SCCM/Intune 무인 배포와 대화형 설치를 동시에 만족한다 |
| `perMachine` | `true` | SCCM/Intune 푸시는 보통 SYSTEM 또는 프로비저닝 계정으로 실행되어, Per-user 설치 시 실제 로그인 사용자가 아닌 SYSTEM 프로필에 설치되는 잘 알려진 문제가 있다. 또한 IT 자산 인벤토리(프로그램 추가/제거, Intune "감지된 앱")는 Machine-scope 설치를 전제로 한다. 공유/키오스크형 PC에서 모든 로그인 사용자가 하나의 설치를 공유해야 하는 상황과도 부합한다 |
| `allowElevation` | `true` | Per-machine은 관리자 권한이 필요하므로, 대화형(비-SCCM) 설치 시 일반 사용자가 UAC 프롬프트로 승격해 설치를 완료할 수 있게 한다 |
| `allowToChangeInstallationDirectory` | `true` | IT가 사내 표준 설치 경로 정책을 가질 수 있으므로 대상 경로를 지정할 수 있게 열어둔다 |
| `deleteAppDataOnUninstall` | `false` | D04/D05가 반입·검증·설치한 Offline Bundle 자산(`assets/`), 설치 자산 목록(`state/installations.db` 상당), 로그가 제거 시 유실되면 폐쇄망 PC에서 재반입이 번거롭다 — 버전 업그레이드(제거 후 재설치)에서도 보존되어야 한다 |
| `runAfterFinish` | `false` | 무인 설치(`/S`)는 상호작용 세션이 없을 수 있고, IT가 배포한 설치를 최초 실행까지 자동으로 트리거하는 것은 일반적으로 바람직하지 않다 |
| `differentialPackage` | `false` | Publish/자동 업데이트 서버가 없는 PoC이므로 Delta 패키지 생성은 불필요한 산출물이다 |
| `unicode` | `true` | 제품명·바로가기 이름이 한글(`AI Asset Hub 데스크톱`)이므로 필수 |

## 3. 코드 서명

### 3.1 왜 필요한가

- **Windows SmartScreen**: 평판이 없는 서명되지 않은 실행 파일은 "Windows에서 PC를 보호했습니다" 경고와 함께 "추가 정보 → 실행" 우회 클릭을 요구한다. 대량 사내 배포에서 이는 헬프데스크 문의를 유발하고, 최종 사용자가 정당한 설치 파일과 악성코드를 구분하기 어렵게 만든다.
- **사내 EDR**: 다수의 엔드포인트 보호 제품이 서명되지 않은 실행 파일 실행을 정책적으로 차단하거나 격리한다. 이는 오늘 이 워크스테이션에서 발생한 XProtect 격리(§0-1)와 **원인은 다르지만 결과가 유사한** 문제다 — 신뢰 서명이 없으면 어떤 플랫폼의 보호 계층이든 차단·격리를 시도할 수 있다는 점은 동일하다.

### 3.2 회사가 준비해야 하는 것

- **Authenticode 코드 서명 인증서**. 옵션:
  - **OV(Organization Validation) 인증서**: 저렴하고 빠르게 발급되지만, 신규 인증서는 SmartScreen 평판이 없어 초기에는 여전히 경고가 뜰 수 있다(평판은 배포·실행 횟수가 누적되며 서서히 쌓인다).
  - **EV(Extended Validation) 인증서**: 발급 즉시 SmartScreen 평판을 얻지만(즉시 신뢰), 비용이 높고 **하드웨어 토큰(USB) 또는 HSM에만 발급**되어 `.pfx` 파일로 내보낼 수 없다 — 이는 서명 방식(§3.3)에 직접 영향을 준다.
- 인증서가 HSM/토큰 기반이면, 빌드 머신에 해당 미들웨어(예: SafeNet, Yubico 등 발급 기관이 요구하는 드라이버)가 설치되어 있어야 한다.
- 사내 타임스탬프 서버 정책이 있다면 사용, 없다면 공개 RFC3161 타임스탬프 서버(예: DigiCert)를 사용해 인증서 만료 후에도 서명이 유효하도록 한다.

### 3.3 빌드 파이프라인이 소비하는 환경 변수 / 설정

`apps/desktop-client/electron-builder.yml`의 `win:` 블록에 두 경로를 주석으로 남겨두었다. 이 저장소에는 실제 값을 **절대 커밋하지 않는다**(CLAUDE.md: 실제 Secret 미포함).

| 서명 방식 | 빌드 머신이 제공 | 비고 |
|---|---|---|
| `.pfx`로 내보낼 수 있는 OV 인증서 | 환경변수 `CSC_LINK`(파일 경로 또는 URL), `CSC_KEY_PASSWORD`(내보내기 암호) | electron-builder가 **별도 설정 없이 자동으로 읽는다** — `electron-builder.yml`에 이 값을 위한 필드를 두지 않는 것이 의도한 설계다 |
| HSM/토큰 기반 EV 인증서(이미 Windows 인증서 저장소에 설치됨) | `win.certificateSubjectName` 또는 `win.certificateSha1`(인증서 지문), `win.rfc3161TimeStampServer` | `electron-builder.yml`에 주석 처리된 형태로 자리만 잡아두었다. 실제 값은 저장소 파일을 손으로 고치지 않고, **빌드 파이프라인이 템플릿 치환 또는 CLI 인자로 주입**해야 한다 |

서명 단계는 **빌드 머신에서만 실행되며 이 저장소의 코드로 구현되지 않는다** — 저장소에는 "이 필드가 무엇을 기대하는지"만 존재한다.

### 3.4 검증하지 못한 것

- 위 두 서명 경로 모두 실제 인증서 없이는 electron-builder를 실행해 검증할 수 없었다 (다운로드/설치 금지 제약과 별개로, 애초에 회사 인증서 자체가 아직 없다 — `open-decisions.md` D-047 참고).
- `win.certificateSubjectName`/`certificateSha1` 필드명이 사용 중인 electron-builder 메이저 버전(`^24.13.3`으로 고정, 실제 설치는 하지 않음)에서 정확히 동작하는지는 electron-builder를 실행해보지 않고는 100% 확인할 수 없다. 필드명은 electron-builder 공식 Windows 옵션 문서 기준으로 작성했으나, 실제 서명 시도 시 버전별 차이가 있다면 조정이 필요할 수 있다.

## 4. 폐쇄망 반입 절차

Desktop Installer(§1)와 M03이 만드는 Offline Bundle(`*.zip`, `01-portal-and-distribution.md` §4.2)은 **서로 다른 산출물이며 반입 순서가 있다**.

### 4.1 두 산출물의 관계

```text
1) Desktop Installer (.exe)         2) Offline Bundle (.zip)
   apps/desktop-client                 services/distribution-service가 생성
   = "실행 환경 자체"를 설치            (bundle-manifest.yaml, assets/, profiles/,
                                        policies/revocation-list.json,
                                        checksums.sha256, install-guide.md)
                                     = "그 위에서 실행할 AI Service/Agent/
                                        Knowledge/Prompt/MCP Config" 묶음
```

Desktop Installer는 **한 번**(또는 버전 업그레이드 시) 설치하면 되고, Offline Bundle은 **자산이 추가·갱신될 때마다 반복적으로** 반입한다.

### 4.2 반입 순서

1. **매체 준비 (인터넷 연결 구간)**: 서명된 Desktop Installer(`.exe`)와 승인된 Offline Bundle(`.zip`)을 각각 준비한다. 둘 다 사내 보안 절차(예: 매체 반입 심사, 백신 검사)를 거쳐 이동식 매체 또는 사내 파일 전송 시스템으로 옮긴다.
2. **Desktop Installer 설치 (대상 PC, 최초 1회 또는 업그레이드 시)**: `AI Asset Hub 데스크톱-Setup-<version>-x64.exe`를 실행한다. 대화형 설치(UAC 승격) 또는 SCCM/Intune을 통한 `/S` 무인 설치 중 하나를 선택한다(§2 참고). 설치가 끝나면 `electron/main.ts`의 `resolveInstallRoot(app.getPath("userData"))`가 로컬 자산 디렉터리(`02-desktop-and-agent-runtime.md` §2의 `company-ai-client/` 레이아웃에 대응)를 초기화한다.
3. **Local Agent Runtime/Ollama 준비 (대상 PC)** — §6에서 다루는 미해결 결정에 따라 방식이 달라진다. 현재는 Desktop Installer가 이를 자동으로 준비하지 않으므로, 이 단계가 선행되지 않으면 D09 연결 상태 화면(`electron/connections.ts`)이 두 항목 모두 실패로 표시된다.
4. **Offline Bundle 반입 (대상 PC, D04)**: Desktop 앱의 "가져오기" 화면(`src/screens/ImportScreen.tsx`)에서 파일 선택 다이얼로그(`bundle:pickFile` IPC)로 `.zip`을 선택한다. `electron/bundle-install.ts` → `electron/bundle-verify.ts`가 순서대로 다음을 검증한다:
   - ZIP 구조(`bundle-manifest.yaml`, `checksums.sha256` 존재)
   - Zip-slip/심볼릭 링크 경로 안전성
   - 중첩 압축 금지
   - 실행 파일 확장자 금지 정책
   - 압축 해제 예상 용량(Zip Bomb 방어)
   - 설치 대상 여유 공간
   - **`checksums.sha256` 대비 실제 파일 SHA-256 일치**(`checkChecksums`) — 1바이트라도 변조되면 여기서 `FAIL`
   - Manifest Schema 유효성
   - Revocation List 대조
   - Runtime/OS 호환성(경고만, 설치를 막지 않음)
   - Signature/Trust(D-016에 따라 현재는 `WARN` 고정 — PoC 범위에서 서명 검증 미구현, Checksum만으로 무결성 확인)
5. **검증 통과 후 설치**: 사용자 확인 후 실제 설치 디렉터리로 전개, `InstalledAssetsStore`(`electron/installed-assets-store.ts`)에 기록. 실패 시 Quarantine에 남고 사용자에게 실패 사유가 표시된다(E2E-03 시나리오, `06-quality-delivery.md`).
6. **연결 상태 재확인 (D09)**: "연결 상태" 화면에서 Ollama(`127.0.0.1:11434`)와 Local Agent Runtime(`127.0.0.1:8100`) Health를 재확인한다.

### 4.3 왜 이 순서인가

Offline Bundle의 `bundle-manifest.yaml`은 `runtime_requirements.python`(`electron/bundle-verify.ts`의 `ParsedManifest` 참고)을 선언하지만 Desktop Installer는 이를 검증만 할 뿐 설치하지 않는다 — Runtime이 먼저 준비되어 있지 않으면 Bundle은 "설치"는 되어도 "실행"은 되지 않는다. 이 간극이 §6의 미해결 결정이다.

## 5. 의존성 사전 캐싱 (재발 방지)

### 5.1 오늘 발생한 문제를 명확히 진술한다

이 워크스테이션(macOS, 폐쇄망 배포 프로젝트용 회사 지급 PC)에서 `apps/desktop-client`의 `pnpm install`을 실행했을 때, `electron` 패키지의 postinstall 스크립트가 GitHub Releases에서 macOS용 Electron 배포판을 공개 인터넷으로 직접 내려받았다. 이 바이너리는 Gatekeeper 서명 신뢰 체인 관점에서 이상 신호로 잡혀 macOS XProtect가 악성코드로 분류해 휴지통으로 이동시켰다. **결론: 사내 관리 macOS PC에서 공개 인터넷의 Electron 배포판을 직접 받는 것은 지원되는 경로가 아니다.** 이는 이번이 처음 발견된 사례이며, 향후 세션은 이 경로를 다시 시도하지 않는다(`progress-log.md` 세션 이력에도 기록).

### 5.2 지원되는 경로: 사내 미러

CLAUDE.md 원칙("새 의존성을 추가할 때 이유와 폐쇄망 설치 방법을 문서화한다")에 따라:

1. **npm 패키지**: 사내 npm 미러(Verdaccio 또는 Artifactory 등, `D-033`에서 이미 Tailwind 계열에 적용한 것과 동일한 패턴)에 `pnpm-lock.yaml`이 고정한 정확한 버전의 `electron`, `electron-builder`, 그리고 이번에 추가한 `electron-builder`의 전이 의존성을 사전에 캐싱한다.
2. **Electron/electron-builder의 바이너리 postinstall 산출물**: `electron`은 설치 시 Electron 실행 파일 자체(플랫폼별)를, `electron-builder`는 빌드 시 NSIS 실행 파일과 `winCodeSign` 등 서명 보조 도구를 추가로 내려받는다. 이들은 npm 패키지가 아니라 GitHub Releases 등에서 받는 **별도의 바이너리 아티팩트**이므로 일반 npm 미러 캐싱만으로는 해결되지 않는다 — electron-builder는 `electron-builder-binaries`라는 별도 캐시 채널을 사용하며, 사내 미러가 이 URL들도 프록시하거나, 해당 아티팩트를 사내 파일 서버에 미러링하고 `ELECTRON_MIRROR`/`ELECTRON_BUILDER_BINARIES_MIRROR`류 환경변수(정확한 변수명은 사용 중인 `electron`/`electron-builder` 버전의 문서로 재확인 필요 — 이 세션에서 실행해 검증하지 못했다)로 재지정해야 한다.
3. 설치는 항상 `pnpm install --offline`으로 실행해, 미러에 없는 버전을 요구할 경우 조용히 공개 인터넷으로 폴백하지 않고 즉시 실패하게 한다.

### 5.3 이번 세션에서 하지 않은 것

- `pnpm add`, `pnpm install`, `electron-builder` 실행, `npx` 호출을 포함해 **어떤 다운로드도 수행하지 않았다**. `apps/desktop-client/package.json`에 `electron-builder` 항목만 추가했고(§1.3), 실제 설치는 이 문서가 기술한 사내 미러가 가능한 환경에서 이후에 수행되어야 한다.

## 6. 런타임 동봉 문제 (M04-F12, 미해결 — 임의 확정하지 않음)

`09-functional-requirements-matrix.md`의 `M04-F12`는 "Python 런타임 포함 Windows 배포 — 폐쇄망 PC에서 설치 파일 실행"이라고 적고 있다. 이 문구는 D-030(Desktop UI 기술 = **Electron.js** 확정, PySide6 아님) 이전에 작성된 것으로 보이며, 두 사실이 동시에 참인 상태에서 이 요구사항을 그대로 둘 수 없다:

- Electron 자체는 Node.js/Chromium 런타임을 포함하므로 "런타임 동봉"은 이미 충족된다 — Electron 앱은 별도 Node.js 설치 없이 동작한다.
- 하지만 `docs/implementation-spec/02-desktop-and-agent-runtime.md` §1(D-006, "별도 Loopback Process 권장")이 규정하는 **Local Agent Runtime**(`services/agent-runtime`)은 여전히 **Python** 서비스다 — `Makefile`의 `dev-agent-runtime` 타겟이 `uv run uvicorn agent_runtime.main:app --port 8100`으로 기동하는 것에서 확인되듯, D-031(Python 패키지 관리 = uv)에 따라 `uv`와 Python 인터프리터, 그리고 `pyproject.toml`의 의존성이 필요하다. 여기에 **Ollama**(로컬 LLM 서버, `exaone3.5:7.8b` 채팅·`qwen3-embedding:0.6b` 임베딩 모델, `03-package-standards.md` 참고)도 별도 설치 대상이다.
- 즉 "Python 런타임 포함"은 **Electron 셸이 아니라 그 옆에서 함께 실행되는 Local Agent Runtime + Ollama**에 대해서만 여전히 유효한 요구사항이다. `apps/desktop-client/electron/connections.ts`가 `127.0.0.1:8100`(Runtime)과 `127.0.0.1:11434`(Ollama)를 각각 별도로 Health-check하는 것 자체가 이 둘이 Electron 프로세스와 무관하게 독립적으로 준비되어 있어야 함을 코드 수준에서 보여준다.

**이 문서는 아래 세 가지 선택지 중 하나를 임의로 확정하지 않는다** — CLAUDE.md 원칙("불명확한 결정은 추측하여 운영 기능으로 구현하지 말고 open-decisions.md에 기록한다")에 따라 `open-decisions.md`에 **D-047**로 남긴다.

| 선택지 | 설명 | 장점 | 단점 |
|---|---|---|---|
| A. Electron 설치 파일에 Python 런타임을 `extraResources`로 동봉 | electron-builder의 `extraResources`(현재 `electron-builder.yml`에는 설정하지 않음)로 임베디드 Python(예: python-build-standalone)과 `services/agent-runtime`의 의존성을 함께 패키징, Electron이 Main 프로세스에서 자식 프로세스로 기동 | 설치 파일 하나로 완결, 사용자가 별도 절차를 모른다 | 설치 파일이 커짐(Python 인터프리터+의존성+모델은 별도), Ollama 자체는 이 방식으로도 동봉하기 어려움(별도 서비스형 설치 프로그램), Python 버전/플랫폼별 재현성 관리 필요 |
| B. 별도 설치 프로그램(Runtime Installer)을 분리 배포 | Desktop Installer(Electron 셸)와 "Local Agent Runtime + Ollama" 설치 프로그램을 별개 산출물로 배포, §4.2 순서에 "3. Local Agent Runtime/Ollama 준비"를 명시적 설치 단계로 문서화 | 각 산출물이 독립적으로 버전 관리·서명·배포 가능, Ollama 공식 설치 방식을 그대로 활용 가능 | 설치 단계가 2~3개로 늘어남, 순서를 지키지 않으면 D09가 실패로 남는 사용자 혼란 가능 |
| C. 사전 구성된 이미지(Golden Image) 전제 | Ollama+모델+Python Runtime이 이미 설치된 표준 이미지를 IT가 배포하고, Desktop Installer는 Electron 셸만 얹는다 | 설치 파일이 가장 단순, 반복 배포 시 가장 안정적 | 골든 이미지 관리 체계가 선행되어야 함(이 프로젝트 범위 밖일 가능성), 이미지가 없는 PC에는 적용 불가 |

현재 §4.2의 반입 순서는 **B를 가정한 서술**로 작성했다(가장 적은 코드 변경으로 문서화 가능하고, 현재 구현 상태(Runtime을 Electron이 기동/동봉하지 않음)와 가장 가깝기 때문) — 하지만 이는 PoC 진행 편의를 위한 서술상의 가정일 뿐 **결정이 아니다**. 실제 결정은 D-047에 기록하고 운영 전환 전 재검토한다.

## 7. 검증: Windows Installer Smoke Test

`06-quality-delivery.md`는 Release Candidate 단계에 "Windows Desktop Installer Smoke Test"를 명시하지만 구체적 Assertion 목록은 정의하지 않는다. 이 문서에서 다음을 Smoke Test 최소 범위로 제안한다(구현은 범위 밖 — 실제 Windows 빌드 환경이 있어야 실행 가능):

1. **설치**: `AI Asset Hub 데스크톱-Setup-<version>-x64.exe /S`가 종료 코드 0으로 완료된다.
2. **경로/바로가기**: 설치 후 `%ProgramFiles%`(Per-machine이므로) 하위에 앱이 존재하고, 시작 메뉴/바탕화면 바로가기가 생성된다(옵션에 따름).
3. **실행**: 설치된 실행 파일이 정상 기동해 D02(홈) 화면이 표시된다 — 이 시점에 Local Agent Runtime/Ollama가 없어도 앱 자체는 죽지 않고 D09에서 실패 상태 + 복구 안내를 보여줘야 한다(CLAUDE.md: "Desktop은 Runtime 장애 시 종료되지 않고 복구 안내를 제공한다").
4. **Offline Bundle Import**: E2E-03(패키지 변조) 시나리오 — 정상 Bundle은 Import 성공, 1바이트 변조 Bundle은 Checksum 실패로 Quarantine에 남고 앱이 크래시하지 않는다.
5. **제거**: 언인스톨러가 앱 자체는 제거하되(§2 `deleteAppDataOnUninstall: false`), `assets/`·`state/` 하위 로컬 자산 데이터는 보존한다.
6. **재서명 확인**(회사 인증서 확보 후): `signtool verify /pa`로 설치 파일 서명이 유효한지 확인한다.

이 항목들은 실제 Windows 환경에서 실행해 얻은 결과가 아니라 이 문서 작성 시점에 **제안**한 체크리스트다 — CLAUDE.md 원칙("테스트 증거 없는 기능은 완료로 표시하지 않는다")에 따라 실행 전까지 "완료"로 표기하지 않는다.
