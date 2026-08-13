# Desktop Client (M04)

Electron Desktop 앱. Offline Bundle Import, 로컬 자산 관리, 로컬/Hosted 대화(Chat) 실행, 연결 상태, 로그/진단, 업데이트를 담당한다. Main process(Node/Electron)와 React 렌더러(Vite)로 구성된다. 렌더러 포트는 **5173 하나뿐이다**(`vite.config.ts`의 `port: 5173` + `strictPort: true`, `electron/main.ts`도 5173을 로드). `strictPort`가 켜져 있어 5173이 점유되면 vite는 다른 포트로 밀리지 않고 **실패한다** — 예전 문서가 경고하던 "5174로 밀려서 Electron이 엉뚱한 포트를 본다"는 설정으로 이미 닫혀 있다. 남은 함정은 반대쪽이다: 누군가 `--port 5174`로 따로 띄워 둔 렌더러는 Electron이 영영 보지 않으므로, 창은 비어 있는데 브라우저로는 멀쩡히 보이는 상태가 된다(2026-08-14 실제 발생). `scripts/macos/dev-stack.sh status`가 이 잔재를 경고한다.

## 반드시 지킬 규칙 (상위 저장소 규칙 중 이 모듈에 적용되는 것)

이 디렉터리만 열고 작업하는 경우를 위해 옮겨 적는다. 원본은 저장소 루트
`CLAUDE.md`이며, 충돌하면 원본이 우선한다.

- **제품 언어**: 사용자 화면과 신규 코드에서 `RAG`라는 용어를 쓰지 않는다.
  `Knowledge`, `지식 자산`, `지식 검색`을 쓴다. 신규 API·Schema Key·폴더명도 `knowledge`.
- **상태 5종**: Loading, Empty, Error, Permission, Cancellation을 정상 흐름과
  함께 구현한다. 오류를 조용히 삼키지 않는다(`if (!res.ok) return;` 금지 —
  실제로 이 저장소에서 화면 하나가 통째로 사라진 적이 있다).
- **UI**: 기술 명칭보다 업무 목적을 먼저 표시한다. 모든 Form Field에 Label과
  Validation Message를 준다. 호환되지 않는 선택지는 이유와 함께 비활성화한다.
  승인·반려·중단·폐기는 확인과 사유를 요구한다. 긴 Job은 진행률·단계·재시도
  가능 여부를 표시한다.
- **Desktop은 Runtime 장애 시 종료되지 않고 복구 안내를 제공한다.**
- **로그**에 Prompt 원문, 문서 전체, DB 결과, Secret을 기본 저장하지 않는다
  (`log-sanitizer.ts`를 거친다).
- 함수와 클래스는 한 가지 책임을 가진다. 사용자가 제공한 파일명으로 파일
  경로를 만들지 않는다. 승인된 Version을 수정하는 코드를 만들지 않는다.
- MCP Tool은 **읽기 전용만** 쓴다. 승인되지 않은 임의 실행·외부 URL·패키지
  설치 기능을 만들지 않는다.
- 테스트 증거 없는 기능은 완료로 표시하지 않는다.

## 먼저 읽을 것 (상위 저장소를 볼 수 있을 때만)

- `docs/implementation-spec/02-desktop-and-agent-runtime.md` §1(프로세스 구조), §2(로컬 디렉터리), §3(D00~D13 화면 목록), §4(화면별 기능)
- `docs/implementation-spec/11-desktop-packaging-and-distribution.md` — 빌드/서명/NSIS/폐쇄망 반입 전체
- `docs/implementation-spec/10-hosted-chatbot-publication.md` §3(Desktop Client와의 관계)
- `packages/schemas/manifests/*.schema.json` — Bundle/Service Definition 등 Desktop이 읽는 Manifest 계약

이 디렉터리만 열고 작업 중이라면 위 문서는 없는 셈 치고, 설계 문서
(`design-briefs/`)에 적힌 요구사항과 이 파일의 규칙만으로 작업한다.
명세 확인이 필요하면 추측하지 말고 설계 문서 작성자에게 되묻는다.

## 코드 배치

- `electron/`은 두 종류가 섞여 있다: fs/electron/node를 import하는 **Main process 전용** 모듈(`main.ts`, `bundle-install.ts`, `app-logger.ts`, `conversation-store.ts`, `desktop-settings.ts`, `installed-assets-store.ts`, `active-version-store.ts`, `portal-settings.ts`, `service-detail.ts`, `system-info.ts`, `preload.ts`)과, fs/electron import가 전혀 없는 **순수 함수/타입** 모듈(`network-policy.ts`, `bundle-verify.ts`, `connections.ts`, `log-filter.ts`, `log-sanitizer.ts`, `removal-guard.ts`, `service-dependencies.ts`, `store-install.ts`, `asset-status.ts`, `version-diff.ts`, `types.ts`, `portal-client.ts`). 후자는 렌더러(`src/`)가 상대경로로 직접 import해도 안전하다(예: `src/screens/ChatScreen.tsx`가 `../../electron/connections`의 `checkAllConnections`를 직접 씀). 새 Main 전용 로직을 순수 모듈 파일에 섞지 않는다 — Vite가 그 파일을 렌더러 번들에 그대로 넣는다.
- 렌더러 화면은 `src/screens/*.tsx`(D00~D13에 대응) + `src/App.tsx`가 라우팅한다. `src/bridge.ts`의 `getDesktopBridge()`를 거쳐서만 `window.desktop`(preload가 노출한 IPC)에 접근한다 — 화면에서 `window.desktop`을 직접 참조하지 않는다.
- 새 IPC 채널은 **네** 곳을 함께 바꾼다: `electron/types.ts`(`DesktopBridge`에 메서드 선언) → `electron/main.ts`(`ipcMain.handle`) → `electron/preload.ts`(`contextBridge`로 메서드 추가) → **`src/browserPreviewBridge.ts`**(브라우저 개발 모드용 구현 추가, 아래 참고). 넷 중 하나만 바꾸면 타입은 있는데 실제로는 호출 불가능한 상태가 된다.
- `src/browserPreviewBridge.ts`의 `BrowserSettingsBridge`는 `DesktopBridge`와 **동일한 타입**이다(`Pick<...>`으로 일부만 고르지 않는다). 브라우저 개발 모드가 실제로 수행할 수 없는 동작(파일 설치, Portal Store, Knowledge 활성화 등)은 조용히 성공한 척하지 않고 "Desktop 앱에서 실행하세요" 모양의 정직한 실패/빈 결과를 돌려주는 실제 구현을 채운다 — 메서드 자체를 빠뜨리지 않는다. 이렇게 두면 `DesktopBridge`에 메서드가 하나 추가될 때 이 파일이 갱신되지 않는 순간 `pnpm typecheck`가 즉시 실패한다(아래 "이 모듈에서 반복해서 틀렸던 것" 참고).
- `dist/`, `release/`는 빌드 산출물이다(`vite build`→`dist/renderer`, `tsc -p tsconfig.electron.json`→`dist/electron`, electron-builder→`release/`). 소스를 여기에 두지 않는다.

## 이 모듈의 경계

아래에 나오는 `apps/portal-web`, `apps/portal-api`, `packages/schemas`,
`services/...` 경로는 이 디렉터리만 열었을 때 **열 수 없는 것이 정상**이다.
대부분 "import하지 않는다"는 금지 규칙이므로 열 필요도 없다.

- 렌더러는 파일시스템/Node API에 직접 접근할 수 없다(`contextIsolation: true`, `nodeIntegration: false` — `main.ts`의 `BrowserWindow` 옵션). 모든 파일/DB/Bundle 작업은 `preload.ts`가 노출한 `DesktopBridge` 메서드를 통한 IPC 왕복이다.
- `network-policy.ts`가 실제로 강제하는 것: Ollama Base URL은 기본적으로 loopback(`127.0.0.1`/`localhost`/`::1`/`0.0.0.0`)만 허용하고, `allowNonLoopback`을 명시적으로 켜지 않는 한 원격 주소 저장을 거부한다(`main.ts`가 저장 직전 다시 검사). MCP Server URL 등 일반 endpoint는 http(s) 형식만 검사하고 loopback 강제는 없다.
- **보안 불변식(D-078)**: 로컬에서 조회한 내용을 허브로 보내지 않는다. 이 경계의 실제 강제 지점은 desktop-client가 아니라 `services/agent-runtime/src/agent_runtime/hub_query.py`다 — desktop-client는 그 결과를 보여주는 쪽이다: `ChatScreen.tsx`의 `allowHubLookup`(기본 `false`, `useState`로만 유지, 세션 간 영속하지 않음)이 매 요청의 `allow_hub_lookup`으로 agent-runtime에 전달되고(`src/agentRuntime.ts`), 전송 전에는 `chatTypes.ts`의 `buildHubQueryPreview`(서버 `build_hub_query`를 그대로 미러링한 순수 함수, 질문 원문과 History의 `.question`만 사용)로 미리보기를 보여주고, 전송 후에는 SSE `hub.query_sent` 이벤트로 실제 전송된 질의를 그대로 보여주며, Citation에는 `source: "local" | "hub"` 배지를 붙인다. 이 미러 함수가 서버 로직과 갈라지면(예: `.answer`나 재작성된 검색어를 읽도록 바뀌면) 사후 가시성이 실제 전송 내용과 달라진다.
  **이 디렉터리만 보고 작업하는 경우 지켜야 할 형태로 다시 적는다** — 서버 파일은 볼 수 없으므로 아래를 절대 규칙으로 취급한다:
  1. `buildHubQueryPreview`는 **사용자가 입력한 질문 텍스트만** 읽는다. 이전 턴의 `.answer`, Citation 발췌, 로컬 문서 내용, 재작성된 검색어를 **절대** 넣지 않는다.
  2. `allowHubLookup` 기본값 `false`를 바꾸지 않는다. 세션 간 영속시키지 않는다.
  3. 허브 동의 토글, "로컬 문서 내용은 허브로 전송되지 않습니다" 설명, `hub.query_sent` 표시, Citation의 로컬/허브 배지를 **없애지 않는다**. 이것들은 사용자가 유출 없음을 확인하는 유일한 수단이다. 설명은 2026-08-11 승인된 결정에 따라 상시 노출 대신 아이콘 토글의 `aria-describedby` 툴팁으로 제공해도 되지만, **접근성 트리에서 사라지면 안 된다**. 보유 Knowledge 검색이 켜지기 전 허브 토글이 `disabled`인 것과, `hubLookupApplicable`이 꺼질 때 `allowHubLookup`을 `false`로 되돌리는 `useEffect`도 유지한다.
  4. 이 함수나 허브 요청 경로를 **바꿔야 할 것 같으면 임의로 바꾸지 말고 설계 문서 작성자에게 되묻는다.** 서버에 같은 규칙을 강제하는 코드와 회귀 테스트가 있어, 여기만 바꾸면 표시와 실제 전송이 어긋난다.
- `apps/portal-web`, `apps/portal-api`의 소스를 import하지 않는다. `packages/schemas`의 Manifest 스키마도 코드로 직접 import하지 않고(별도 TS 스키마 패키지가 아직 없음) 필드 이름만 참고해 `electron/types.ts`에 로컬 타입을 둔다(`system-info.ts`, `service-detail.ts`의 주석이 이 갭을 명시).

## 실행

- `pnpm dev` — 내부적으로 `tsc -p tsconfig.electron.json`(Main 컴파일) 후 `concurrently`로 `vite`(렌더러)와 `electron .`을 함께 띄운다.
- 렌더러만 필요하면(Electron 바이너리가 사내 환경에서 격리되는 경우) `pnpm exec vite`로 브라우저에서 화면 대부분을 볼 수 있다 — `window.desktop`이 없으므로 `bridge.ts`가 `null`을 반환하고, 파일시스템 의존 화면은 "Desktop 런타임 필요" 상태를 보여준다.
- `.env.local`에 `VITE_AGENT_RUNTIME_BASE_URL`(기본 미설정 시 코드 내 기본값 사용)을 둘 수 있다 — 로컬 테스트 세션 파일이므로 임의로 덮어쓰지 않는다.

## 테스트

- `pnpm test`(vitest, `vitest.config.ts` — `environment: "node"`, `electron/**/*.test.ts` + `src/**/*.test.ts`만 포함, jsdom/React 렌더링 없음). Main 전용/순수 모듈 테스트는 `electron/__tests__/*.test.ts`(21개 파일, `fixtures/` 포함), 렌더러 순수 로직 테스트는 `src/**/*.test.ts`(예: `runStages.test.ts`, `screens/*Types.test.ts`)에 있다.
- React 컴포넌트(`ChatScreen.tsx` 등) 자체의 렌더링 테스트는 없다 — `environment: "node"`라 DOM이 없다.

## 개발 환경 — 실행 전에 알아야 할 것

- **Electron 실행 여부는 머신마다 다르다.** 이 개발 머신에서는 실측(2026-08-14) `node_modules`의 Electron **v43.3.0이 quarantine 속성 없이 정상 실행**되며 실제 창도 뜬다 — 그동안 "이 세션에서는 Electron을 띄울 수 없다"고 적혀 있던 제약은 최소한 이 머신에서는 더 이상 사실이 아니다. 다만 사내망에서는 GitHub Releases 다운로드가 막히고, macOS에서는 XProtect가 새로 받은 바이너리를 격리·삭제할 수 있다. **Gatekeeper/XProtect를 우회하지 마라**(`xattr -d com.apple.quarantine`, `spctl` 변경 금지). 우회 없이 확인하는 방법은 아래 "렌더러만 띄우기"다.
- **렌더러만 띄우기**: `pnpm exec vite` → 브라우저에서 `http://localhost:5173`. **반드시 `localhost`로 연다** — 이유가 둘이다: (1) `127.0.0.1`은 agent-runtime CORS에서 걸리고, (2) 실측(2026-08-14) Vite dev 서버는 **IPv6 `[::1]`에만 바인딩**해서 `127.0.0.1`로는 아예 응답하지 않는다(`localhost`는 `::1`로 풀린다). 이 두 번째 이유 때문에 dev-stack 스크립트의 준비 검사가 한동안 멀쩡한 서버를 "기동 실패"로 오판했다. 이 경로에서는 `window.desktop`이 없어 `bridge.ts`가 `null`을 반환하므로, 파일시스템에 의존하는 화면(스토어/가져오기/설치된 자산/업데이트·복구/로그·진단/설정)은 "Desktop 런타임 필요"로 표시되고 **대화 화면만 실제로 동작한다**. 대화 화면의 "개발자 옵션 > Knowledge ID 직접 입력"이 이때 쓰는 경로다.
- **스택 기동은 `scripts/macos/dev-stack.sh`를 쓴다**: `start|stop|restart|status [서비스...]`. `desktop-client`를 포함한 8개를 다루며, `status`는 각 서비스가 **실제로 응답하는 커밋**과 저장소 HEAD를 나란히 보여주고 Desktop은 `dist/electron` 빌드 신선도까지 표시한다(오래된 preload가 런타임 크래시를 만든 적이 있다). `stop`은 Electron 창까지 정리하되 **저장소 경로로 범위를 좁혀** 이 머신의 다른 Electron 앱(VS Code 등)은 건드리지 않는다.
- **연결 판정 오탐(미해결)**: `electron/connections.ts:17`의 `DEFAULT_RUNTIME_BASE_URL`이 `http://127.0.0.1:8100`으로 하드코딩되어 있어, 대화가 실제로 쓰는 `VITE_AGENT_RUNTIME_BASE_URL`을 무시한다. 그 결과 대화가 멀쩡히 되는데도 채팅 화면에 빨간 "연결 끊김" 배너가 뜬다.
- **`.env.local`은 개인 로컬 설정이다.** 커밋 대상이 아니고, 남의 세션 값을 임의로 덮어쓰지 않는다.
- 함께 떠 있어야 하는 것: agent-runtime(기본 8100), search-runtime(8300), Ollama(11434). MCP Tool을 쓸 때만 office-mcp-server(8500).

## 이 모듈에서 반복해서 틀렸던 것

- **`window.desktop`을 "항상 완전한 `DesktopBridge`"로 가정하면 안 된다(2026-08-13 실제 장애).**
  `src/global.d.ts`는 `window.desktop`을 무조건 `DesktopBridge` 전체 타입으로 선언하고, `src/bridge.ts`의
  `getDesktopBridge()`도 그 타입을 그대로 돌려준다 — 하지만 이 값을 실제로 채우는 것은 두 갈래로 갈라져
  있었다: (1) 실제 Electron의 `preload.ts`(빌드 산출물 `dist/electron/preload.js`가 소스보다 **stale**하면
  최신 메서드가 없는 채로 노출될 수 있다), (2) `src/browserPreviewBridge.ts`가 예전에는 `Pick<DesktopBridge, ...>`로
  메서드 **일부만** 고른 `BrowserSettingsBridge` 객체였다. 둘 다 TypeScript가 잡을 수 없는 방식으로 실제
  객체가 선언된 타입보다 "덜" 갖춰질 수 있는 구멍이었다 — `src/screens/ChatScreen.tsx`가
  `bridge.reconcileKnowledgeActivations()`를 가드 없이 호출해 `TypeError: ... is not a function`으로
  채팅 화면 전체가 무너졌다(D-079 활성화 3개 메서드가 두 곳 모두에서 빠져 있었다).
  지금은: (a) `browserPreviewBridge.ts`의 `BrowserSettingsBridge`를 `Pick`이 아니라 `DesktopBridge` 그
  자체로 만들어 메서드 하나라도 빠지면 `pnpm typecheck`가 실패하게 했고, (b) `ChatScreen.tsx`는
  `resolveReconcileNotice()`(`src/screens/chatTypes.ts`)로 이 특정 호출을 감싸 메서드가 없거나 예외를
  던져도 절대 throw하지 않고 "확인 불가" 안내로 degrade한다. **하지만 (a)는 stale `preload.js` 문제까지는
  막지 못한다** — 새 IPC 채널을 추가했다면 반드시 `pnpm dev`/`tsc -p tsconfig.electron.json`으로 다시
  빌드해 `dist/electron/preload.js`가 최신인지 확인한다. 그리고 이 화면 하나만 고쳐졌을 뿐, 다른 화면들도
  같은 가정(`window.desktop`이 항상 완전하다) 위에 있다 — 예를 들어 자산 허브 화면은 부분적으로만 채워진
  `window.desktop`을 주면 `bridge.onStoreInstallProgress is not a function`으로 최상위 ErrorBoundary까지
  올라간다(수동 재현으로 확인, 이번 수정 범위 밖).

- **활성화 상태를 "성공 아니면 실패"로만 모델링하면 정상 상태와 재시도해도 안 되는 실패를 구분하지
  못한다(D-079 후속, 2026-08-13).** 네 가지가 한 세트로 얽혀 있었다:
  1. `electron/connections.ts`의 `assessChatConnections`가 search-runtime 장애를 Knowledge 모드에서
     `blocked`(대화 자체를 막는 배너)로 승격하는 것은, search-runtime이 **렌더러에서** 직접
     health-check되기 때문에 CORS가 없으면 멀쩡한 서비스도 영구 `blocked`로 보인다는 전제가 맞을
     때만 안전하다 — 그 전제는 `services/search-runtime`에 CORS 미들웨어가 실제로 붙어 있는지에
     달려 있다(그쪽 CLAUDE.md에 기록됨). 이 파일에서 검사 대상이나 심각도를 바꿀 때는 상대편에
     CORS가 있는지부터 확인한다.
  2. `ChatScreen.tsx`의 `refreshConnections`는 `settingsBridge.getDesktopSettings()`로 읽은
     `settings.searchRuntimeBaseUrl`을 넘긴다 — `connections.ts`의
     `DEFAULT_SEARCH_RUNTIME_BASE_URL` 하드코딩 기본값으로만 검사하면, 사용자가 설정 화면에서 포트를
     바꾸는 순간 멀쩡한 서비스가 다시 "연결 끊김"으로 보인다. `DEFAULT_RUNTIME_BASE_URL`(agent-runtime
     쪽)은 아직 이 패턴을 따르지 않는다 — 위 "연결 판정 오탐(미해결)" 참고, 고칠 때 여기의 search
     쪽 코드를 참조한다.
  3. `electron/knowledge-activation.ts`의 `computeActivationReconcile`은 search-runtime이 돌려준
     계약의 `local_indexes_enabled`(`listLocalKnowledgeIndexes`의 `localIndexesEnabled`)가 `false`면
     `reason: "local_indexes_disabled"`로 분기해 "관리자에게 요청하세요"를 안내하고,
     `true`인데 등록이 없으면 `reason: "not_registered_on_server"`로 "다시 활성화하세요"를 안내한다 —
     두 원인을 하나로 뭉쳐 항상 "다시 활성화하세요"라고 하면, 전자의 경우 사용자는 반드시 다시
     거절당하는 행동으로 안내받는다. 새로운 거절 원인을 이 reconcile에 추가할 때는 재시도가 실제로
     성공할 수 있는 경우인지 먼저 판단하고 메시지를 분기한다.
  4. search-runtime이 등록을 `central_index_exists`로 거절하는 것은 "이미 중앙 색인이 있어 등록
     없이도 검색된다"는 뜻이지 실패가 아니다 — `knowledge-activation.ts`는 이를 `state: "FAILED"`가
     아니라 별도의 `"ALREADY_ACTIVE"`(`electron/types.ts`)로 저장하고 `ok: true`를 반환한다. 이
     구분이 없으면 정상 작동 중인 Knowledge가 빨간 "활성화 실패"로 보인다. 새로운 "거절이지만 사실은
     정상" 케이스를 다룰 때는 `FAILED`에 합치지 말고 별도 state를 검토한다.

## 검증 (변경 후 반드시 실행)

```
pnpm typecheck   # tsconfig.json + tsconfig.electron.json 둘 다
pnpm test        # vitest — 기준선 453개 통과(2026-08-13 기준, 계속 늘어난다 — 실행해서 실제 숫자를 확인한다)
```

- **테스트 수가 기준선보다 줄면 안 된다.** 화면을 옮기다 깨진 테스트를 지우지 말고 새 구조에 맞게 고친다.
- `pnpm lint`는 **현재 항상 실패한다** — 저장소에 eslint 설정 파일 자체가 없다(`.eslintrc*`/`eslint.config.*` 부재). 사전부터 있던 공백이며 네 변경 탓이 아니다.
- 렌더링(jsdom/React) 테스트는 이 프로젝트에 없다(`vitest.config.ts`가 `environment: "node"`). 따라서 **레이아웃/화면 변경은 자동 테스트로 증명되지 않는다** — 반드시 위 "렌더러만 띄우기"로 실제 화면을 열어 눈으로 확인한다.

## 완료 전 확인

- 새 IPC 채널을 추가했다면 `types.ts`/`main.ts`/`preload.ts`/`browserPreviewBridge.ts` 네 곳을 모두 갱신했는가(마지막 하나를 빠뜨려도 `pnpm typecheck`가 잡아준다 — `BrowserSettingsBridge`가 `DesktopBridge` 전체 타입이기 때문).
- IPC 채널을 추가/변경했다면 `dist/electron/preload.js`를 다시 빌드했는가(`tsc -p tsconfig.electron.json`, 또는 `pnpm dev`) — stale 빌드 산출물은 소스가 맞아도 실제 Electron 실행에서는 여전히 옛 메서드로 동작한다.
- 렌더러 코드에서 `fs`/`node:*`/`electron`을 직접 import하지 않았는가(순수 모듈에 Main 전용 코드를 섞지 않았는가).
- Hub 조회 관련 변경이면 `chatTypes.ts`의 `buildHubQueryPreview`가 여전히 사용자 질문 텍스트만 읽는가(위 D-078 규칙 4항 — 확신이 없으면 되묻는다).
- Ollama/외부 endpoint 검증을 추가했다면 `network-policy.ts`를 거치는가(직접 URL 문자열 저장 금지).
- 로그/진단에 넣는 문자열이 `log-sanitizer.ts`를 거치는가(Prompt 원문·문서 전체·Secret 미저장).
- `pnpm test`와 `typecheck`(`tsc --noEmit -p tsconfig.json` + `-p tsconfig.electron.json`)를 실행했는가.
