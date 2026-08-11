# Desktop Client (M04)

Electron Desktop 앱. Offline Bundle Import, 로컬 자산 관리, 로컬/Hosted 대화(Chat) 실행, 연결 상태, 로그/진단, 업데이트를 담당한다. Main process(Node/Electron)와 React 렌더러(Vite)로 구성된다. 렌더러는 `dev` 스크립트 기준 5173(`vite.config.ts`/`electron/main.ts:145` 하드코딩)이 기본값이지만, 이 저장소 문서(open-decisions.md D-059, 13-windows-local-setup.md)와 실제 운영 세션은 5174를 참조한다 — 실행 전 `lsof -i :5173`/`:5174`로 실제 뜬 포트를 확인한다(아래 "코드 배치" 참고).

## 먼저 읽을 것

- `docs/implementation-spec/02-desktop-and-agent-runtime.md` §1(프로세스 구조), §2(로컬 디렉터리), §3(D00~D13 화면 목록), §4(화면별 기능)
- `docs/implementation-spec/11-desktop-packaging-and-distribution.md` — 빌드/서명/NSIS/폐쇄망 반입 전체
- `docs/implementation-spec/10-hosted-chatbot-publication.md` §3(Desktop Client와의 관계)
- `packages/schemas/manifests/*.schema.json` — Bundle/Service Definition 등 Desktop이 읽는 Manifest 계약

## 코드 배치

- `electron/`은 두 종류가 섞여 있다: fs/electron/node를 import하는 **Main process 전용** 모듈(`main.ts`, `bundle-install.ts`, `app-logger.ts`, `conversation-store.ts`, `desktop-settings.ts`, `installed-assets-store.ts`, `active-version-store.ts`, `portal-settings.ts`, `service-detail.ts`, `system-info.ts`, `preload.ts`)과, fs/electron import가 전혀 없는 **순수 함수/타입** 모듈(`network-policy.ts`, `bundle-verify.ts`, `connections.ts`, `log-filter.ts`, `log-sanitizer.ts`, `removal-guard.ts`, `service-dependencies.ts`, `store-install.ts`, `asset-status.ts`, `version-diff.ts`, `types.ts`, `portal-client.ts`). 후자는 렌더러(`src/`)가 상대경로로 직접 import해도 안전하다(예: `src/screens/ChatScreen.tsx`가 `../../electron/connections`의 `checkAllConnections`를 직접 씀). 새 Main 전용 로직을 순수 모듈 파일에 섞지 않는다 — Vite가 그 파일을 렌더러 번들에 그대로 넣는다.
- 렌더러 화면은 `src/screens/*.tsx`(D00~D13에 대응) + `src/App.tsx`가 라우팅한다. `src/bridge.ts`의 `getDesktopBridge()`를 거쳐서만 `window.desktop`(preload가 노출한 IPC)에 접근한다 — 화면에서 `window.desktop`을 직접 참조하지 않는다.
- 새 IPC 채널은 세 곳을 함께 바꾼다: `electron/types.ts`(공용 타입) → `electron/main.ts`(`ipcMain.handle`) → `electron/preload.ts`(`contextBridge`로 `DesktopBridge`에 메서드 추가). 셋 중 하나만 바꾸면 타입은 있는데 실제로는 호출 불가능한 상태가 된다.
- `dist/`, `release/`는 빌드 산출물이다(`vite build`→`dist/renderer`, `tsc -p tsconfig.electron.json`→`dist/electron`, electron-builder→`release/`). 소스를 여기에 두지 않는다.

## 이 모듈의 경계

- 렌더러는 파일시스템/Node API에 직접 접근할 수 없다(`contextIsolation: true`, `nodeIntegration: false` — `main.ts`의 `BrowserWindow` 옵션). 모든 파일/DB/Bundle 작업은 `preload.ts`가 노출한 `DesktopBridge` 메서드를 통한 IPC 왕복이다.
- `network-policy.ts`가 실제로 강제하는 것: Ollama Base URL은 기본적으로 loopback(`127.0.0.1`/`localhost`/`::1`/`0.0.0.0`)만 허용하고, `allowNonLoopback`을 명시적으로 켜지 않는 한 원격 주소 저장을 거부한다(`main.ts`가 저장 직전 다시 검사). MCP Server URL 등 일반 endpoint는 http(s) 형식만 검사하고 loopback 강제는 없다.
- **보안 불변식(D-078)**: 로컬에서 조회한 내용을 허브로 보내지 않는다. 이 경계의 실제 강제 지점은 desktop-client가 아니라 `services/agent-runtime/src/agent_runtime/hub_query.py`다 — desktop-client는 그 결과를 보여주는 쪽이다: `ChatScreen.tsx`의 `allowHubLookup`(기본 `false`, `useState`로만 유지, 세션 간 영속하지 않음)이 매 요청의 `allow_hub_lookup`으로 agent-runtime에 전달되고(`src/agentRuntime.ts`), 전송 전에는 `chatTypes.ts`의 `buildHubQueryPreview`(서버 `build_hub_query`를 그대로 미러링한 순수 함수, 질문 원문과 History의 `.question`만 사용)로 미리보기를 보여주고, 전송 후에는 SSE `hub.query_sent` 이벤트로 실제 전송된 질의를 그대로 보여주며, Citation에는 `source: "local" | "hub"` 배지를 붙인다. 이 미러 함수가 서버 로직과 갈라지면(예: `.answer`나 재작성된 검색어를 읽도록 바뀌면) 사후 가시성이 실제 전송 내용과 달라진다 — 수정 시 반드시 `hub_query.py`와 나란히 검토한다.
- `apps/portal-web`, `apps/portal-api`의 소스를 import하지 않는다. `packages/schemas`의 Manifest 스키마도 코드로 직접 import하지 않고(별도 TS 스키마 패키지가 아직 없음) 필드 이름만 참고해 `electron/types.ts`에 로컬 타입을 둔다(`system-info.ts`, `service-detail.ts`의 주석이 이 갭을 명시).

## 실행

- `pnpm --filter desktop-client dev` — 내부적으로 `tsc -p tsconfig.electron.json`(Main 컴파일) 후 `concurrently`로 `vite`(렌더러)와 `electron .`을 함께 띄운다.
- 렌더러만 필요하면(Electron 바이너리가 사내 환경에서 격리되는 경우) `pnpm --filter desktop-client exec vite`로 브라우저에서 화면 대부분을 볼 수 있다 — `window.desktop`이 없으므로 `bridge.ts`가 `null`을 반환하고, 파일시스템 의존 화면은 "Desktop 런타임 필요" 상태를 보여준다.
- `.env.local`에 `VITE_AGENT_RUNTIME_BASE_URL`(기본 미설정 시 코드 내 기본값 사용)을 둘 수 있다 — 로컬 테스트 세션 파일이므로 임의로 덮어쓰지 않는다.

## 테스트

- `pnpm --filter desktop-client test`(vitest, `vitest.config.ts` — `environment: "node"`, `electron/**/*.test.ts` + `src/**/*.test.ts`만 포함, jsdom/React 렌더링 없음). Main 전용/순수 모듈 테스트는 `electron/__tests__/*.test.ts`(21개 파일, `fixtures/` 포함), 렌더러 순수 로직 테스트는 `src/**/*.test.ts`(예: `runStages.test.ts`, `screens/*Types.test.ts`)에 있다.
- React 컴포넌트(`ChatScreen.tsx` 등) 자체의 렌더링 테스트는 없다 — `environment: "node"`라 DOM이 없다.

## 개발 환경 — 실행 전에 알아야 할 것

- **Electron 바이너리가 없을 수 있다.** 사내망에서는 GitHub Releases 다운로드가 막히고, macOS에서는 XProtect가 받은 바이너리를 격리·삭제한다. **Gatekeeper/XProtect를 우회하지 마라**(`xattr -d com.apple.quarantine`, `spctl` 변경 금지). 우회 없이 확인하는 방법은 아래 "렌더러만 띄우기"다.
- **렌더러만 띄우기**: `pnpm --filter desktop-client exec vite` → 브라우저에서 `http://localhost:5174`. 반드시 `localhost`로 연다 — `127.0.0.1`은 agent-runtime CORS에서 걸린다. 이 경로에서는 `window.desktop`이 없어 `bridge.ts`가 `null`을 반환하므로, 파일시스템에 의존하는 화면(스토어/가져오기/설치된 자산/업데이트·복구/로그·진단/설정)은 "Desktop 런타임 필요"로 표시되고 **대화 화면만 실제로 동작한다**. 대화 화면의 "개발자 옵션 > Knowledge ID 직접 입력"이 이때 쓰는 경로다.
- **포트 불일치(미해결)**: `vite.config.ts`와 `electron/main.ts:145`는 `5173`으로 하드코딩되어 있는데 문서·실운영 세션은 `5174`를 쓴다. 5173이 점유된 상태에서 vite가 5174로 밀리면 Electron은 엉뚱한 5173을 로드한다. 실행 전 실제 포트를 확인한다.
- **연결 판정 오탐(미해결)**: `electron/connections.ts:17`의 `DEFAULT_RUNTIME_BASE_URL`이 `http://127.0.0.1:8100`으로 하드코딩되어 있어, 대화가 실제로 쓰는 `VITE_AGENT_RUNTIME_BASE_URL`을 무시한다. 그 결과 대화가 멀쩡히 되는데도 채팅 화면에 빨간 "연결 끊김" 배너가 뜬다.
- **`.env.local`은 개인 로컬 설정이다.** 커밋 대상이 아니고, 남의 세션 값을 임의로 덮어쓰지 않는다.
- 함께 떠 있어야 하는 것: agent-runtime(기본 8100), search-runtime(8300), Ollama(11434). MCP Tool을 쓸 때만 office-mcp-server(8500).

## 검증 (변경 후 반드시 실행)

```
pnpm --filter desktop-client typecheck   # tsconfig.json + tsconfig.electron.json 둘 다
pnpm --filter desktop-client test        # vitest — 기준선 349개 통과
```

- **테스트 수가 기준선보다 줄면 안 된다.** 화면을 옮기다 깨진 테스트를 지우지 말고 새 구조에 맞게 고친다.
- `pnpm --filter desktop-client lint`는 **현재 항상 실패한다** — 저장소에 eslint 설정 파일 자체가 없다(`.eslintrc*`/`eslint.config.*` 부재). 사전부터 있던 공백이며 네 변경 탓이 아니다.
- 렌더링(jsdom/React) 테스트는 이 프로젝트에 없다(`vitest.config.ts`가 `environment: "node"`). 따라서 **레이아웃/화면 변경은 자동 테스트로 증명되지 않는다** — 반드시 위 "렌더러만 띄우기"로 실제 화면을 열어 눈으로 확인한다.

## 완료 전 확인

- 새 IPC 채널을 추가했다면 `types.ts`/`main.ts`/`preload.ts` 세 곳을 모두 갱신했는가.
- 렌더러 코드에서 `fs`/`node:*`/`electron`을 직접 import하지 않았는가(순수 모듈에 Main 전용 코드를 섞지 않았는가).
- Hub 조회 관련 변경이면 `agent-runtime`의 `hub_query.py`와 `chatTypes.ts`의 `buildHubQueryPreview`가 여전히 같은 필드만 읽는가.
- Ollama/외부 endpoint 검증을 추가했다면 `network-policy.ts`를 거치는가(직접 URL 문자열 저장 금지).
- 로그/진단에 넣는 문자열이 `log-sanitizer.ts`를 거치는가(Prompt 원문·문서 전체·Secret 미저장).
- `pnpm --filter desktop-client test`와 `typecheck`(`tsc --noEmit -p tsconfig.json` + `-p tsconfig.electron.json`)를 실행했는가.
