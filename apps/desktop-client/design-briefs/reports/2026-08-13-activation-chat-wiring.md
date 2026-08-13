# D-079 이어 붙이기 — 활성화 상태를 채팅까지 연결

## 받은 지시

D-079(전 세션)는 "설치됨"과 "활성화됨"을 서로 다른 사실로 분리해
`InstalledAsset.activation`에 저장하고, 설치된 자산 화면(D08)에 배지·버튼으로
보여주는 것까지 구현했다. 그런데 `src/screens/chatTypes.ts`의
`resolveInstalledKnowledgeIds`가 활성화 여부와 무관하게 `assetVersionId`가
있는 모든 설치된 Knowledge를 채팅 검색 대상으로 돌려주고 있었다 — 그 결과
채팅은 활성화되지 않은 Knowledge에도 여전히 `knowledge_id`를 보내고, 조용히
Citation 0건(정확히 D-079가 없애려던 "조용한 0건" 실패)을 받았다. 이번
작업은 그 연결 공백을 메운다:

1. 활성화 인지 Knowledge 선택 로직(`chatTypes.ts`)
2. ChatScreen에 활성/제외 상태와 인라인 활성화 노출
3. 로컬 ACTIVE 상태가 search-runtime과 여전히 일치하는지 재확인(reconcile)
4. 설정 화면에 `searchRuntimeBaseUrl` Form Field 추가
5. 자산 제거 시 search-runtime 등록도 함께 해제
6. D09 연결 상태에 search-runtime Health Check 추가

`apps/desktop-client/` 바깥은 건드리지 않는다.

## 이번 구현

### 1. 활성화 인지 Knowledge 선택 (`src/screens/chatTypes.ts`)

`resolveInstalledKnowledgeIds`를 제거하고 대체했다 — "활성화 여부와 무관하게
id만" 필요한 정당한 호출자가 없었고(유일한 실사용 호출부는 ChatScreen이었다),
남겨 두면 그 자체가 D-079 이전과 같은 함정이 된다.

- `partitionInstalledKnowledgeByActivation(assets)` — 설치된 Knowledge를
  `usable`(검색 가능)과 `excluded`(사유 포함)로 나누는 순수 함수. 판단 순서는
  `activateInstalledKnowledge`(main process)와 동일하게 맞췄다: D-060(legacy
  Bundle, `assetVersionId` 없음) 우선 → `activation.state === "ACTIVE"`만
  usable → `state === "FAILED"`는 서버 `message` 그대로 → 그 외(필드 없음
  또는 명시적 `null`)는 공통 사유 `KNOWLEDGE_NOT_ACTIVATED_REASON`(두 경우를
  구분하지 않는 이유: `installed-assets-store.ts`의 `updateActivation` 문서가
  이미 "두 경우 모두 화면에는 동일하게 '활성화 안 됨'"이라고 결정해 뒀다).
- `resolveActivatedKnowledgeIds(assets)` — `usable`에서 id만 뽑는다
  (`resolveInstalledKnowledgeIds`의 실질적 대체).
- 두 함수 모두 `T extends InstalledAsset`로 제네릭 — 호출자가
  `InstalledAssetWithStatus`(D08 `status` 필드 포함)를 넘기면 그 타입 그대로
  돌려받는다(ChatScreen이 캐스팅 없이 `asset.status`를 계속 읽을 수 있게).
- `resolveKnowledgeSelection`의 D-060 판단은 손대지 않고 그대로 재사용했다.

### 2. ChatScreen 노출 (`src/screens/ChatScreen.tsx`)

- `knowledgeIds`/`hasUsableKnowledge`/`knowledgeLabel`이 이제
  `partitionInstalledKnowledgeByActivation`의 `usable`만 본다 — 활성화되지
  않은 Knowledge는 `useKnowledge` 토글이 켜져 있어도 검색 대상에서 빠진다.
- 활성화된 게 하나도 없을 때(설치는 있지만 usable=0): 빨간 블로킹 배너로
  "왜 지금 지식 검색을 실행할 수 없는지"와 각 Knowledge별 제외 사유를
  보여주고, 각 행에 그 자리에서 바로 재시도할 수 있는 "활성화" 버튼을
  붙였다. 실제로 검색이 실행되지 않는 이유: `knowledgeLookupActive = useKnowledge
  && hasUsableKnowledge && ...`가 이미 `false`가 되어 대화가 자동으로 기본
  Ollama 대화로 넘어간다(질문이 결과 없는 검색으로 새는 경로 자체가 없다).
- 일부만 활성화된 경우(usable>0, excluded>0): 접이식 `<details>`로
  "N개 활성화됨 · M개 제외됨"을 보여주고 펼치면 동일한 사유+활성화 버튼
  목록이 나온다.
- 활성화 버튼(`handleActivateKnowledge`)은 `bridge.activateInstalledKnowledge`를
  호출하고 결과(성공/서버 메시지/네트워크 오류)를 그 행에 바로 표시한 뒤
  `loadInstalledKnowledge()`로 목록을 새로고침한다 — Loading(버튼 disabled +
  "활성화하는 중...")/성공/실패 상태를 모두 인라인으로 보여준다.
- "설치된 자산 화면 열기" 버튼 — 새 `onGoToInstalledAssets` prop(선택)으로
  App.tsx가 `자산 허브 > 설치된 자산` 탭 전환을 연결한다.
- `useKnowledge`가 켜진 채로 `hasUsableKnowledge`가 나중에 `false`가 되면
  (재확인으로 다운그레이드된 경우 등) 토글 자체도 꺼지도록 `useEffect`를
  추가했다 — `hubLookupApplicable`/`allowHubLookup` 재설정과 동일한 패턴.
- **D-078 경계는 건드리지 않았다.** `buildHubQueryPreview`, `allowHubLookup`
  기본값/비영속, 허브 토글 `disabled` 조건, `hub.query_sent` 표시,
  로컬/허브 Citation 배지 — 전부 원본 그대로다. 이번 변경은 Stage 1(로컬
  검색) 이전 단계에서 검색 대상 id 목록을 좁히는 것뿐이라 Stage 2 로직과는
  겹치지 않는다.

### 3. 활성화 상태 재확인(reconcile)

로컬 `activation.state === "ACTIVE"`는 시점 스냅샷일 뿐이다 —
search-runtime이 다른 `SEARCH_LOCAL_INDEX_ROOTS`로 재시작되었거나 등록
레지스트리가 초기화되면 로컬만 "거짓 ACTIVE"로 남는다.

- **순수 비교** — `electron/knowledge-activation.ts`의
  `computeActivationReconcile(installed, serverEntries)`. `serverEntries ===
  null`(도달 불가)이면 절대 아무것도 낮추지 않고 `checked:false`를 반환한다
  (네트워크 장애를 "등록 안 됨"으로 지어내지 않는다). 실제 서버 목록을 받은
  경우에만(`checked:true`) 로컬 ACTIVE 중 그 목록에 없는 것을 `state:
  "FAILED"`, `reason: "not_registered_on_server"`로 낮춘다. 세 번째 state는
  만들지 않았다(브리핑 지시대로 기존 `KnowledgeActivation`의 `FAILED`를
  재사용).
- **Main-process 오케스트레이션** — `reconcileInstalledKnowledgeActivations`가
  `listLocalKnowledgeIndexes`(기존 D-079 클라이언트)를 호출하고 위 순수
  비교 결과를 `store.updateActivation`으로 저장한다.
- 새 IPC `knowledge:reconcileActivations`(three-file rule: `types.ts` →
  `main.ts` → `preload.ts`) — `ChatScreen.loadInstalledKnowledge`가
  `listInstalledAssets()`보다 먼저 호출해, 화면에 보여줄 목록이 항상 방금
  재확인된 상태를 반영하게 했다. `checked:false`면 화면에 "활성화 상태 확인
  불가: <메시지>" 캡션만 보여주고 아무 배지도 바꾸지 않는다.

### 4. 설정 화면 Field (`src/screens/SettingsScreen.tsx`)

"지식 검색(search-runtime) 연결" Card를 MCP Card와 동일한 패턴(Label +
현재 값 + 저장 + 연결 테스트 + `CheckRow`)으로 추가했다. 설명 문단에
loopback 강제 이유(활성화 요청이 이 PC의 로컬 절대 경로를 담아 전달하므로
원격 주소는 애초에 동작할 수 없다)를 명시했다. 검증은 이미 존재하던
`validateSearchRuntimeBaseUrl`/`DesktopSettingsStore.update`를 그대로
쓴다 — 새 검증 로직을 만들지 않았다.

### 5. 제거 시 비활성화 (`electron/main.ts` `assets:remove`)

`assetType === "knowledge"`인 설치를 지우기 전에 `deactivateInstalledKnowledge`를
먼저 호출한다. search-runtime이 응답하지 않거나 등록 해제에 실패해도 제거
자체는 계속 진행한다(search-runtime은 디렉터리가 사라진 등록을 스스로
정리하므로 제거를 막을 이유가 아니다) — 대신 `RemoveAssetResult.warning`에
경고를 담아 반환한다. `AssetsScreen.tsx`가 그 경고를 `제거` 완료 후
배너로 보여주고("확인" 버튼으로 닫음) — 조용히 삼키지 않는다. 기존
제거-차단(참조 Service/Active Version) 로직과 확인 다이얼로그는 그대로다.

### 6. D09 연결 상태 (`electron/connections.ts`)

- `checkAllConnections`가 이제 4개(`runtime`/`ollama`/`mcp`/`search`)를
  병렬로 확인한다. `search`는 `GET {searchRuntimeBaseUrl}/health` —
  `ConnectionCheckSettings.searchRuntimeBaseUrl`이 없으면
  `DEFAULT_SEARCH_RUNTIME_BASE_URL`(8300)로 동작(다른 세 Endpoint와 동일한
  관례).
- `assessChatConnections`: search-runtime 장애는 **Knowledge 모드에서
  Local Agent Runtime과 동일하게 `blocked`**로 분류했다 — Stage 1 로컬
  검색과 활성화 모두 search-runtime에 의존하므로, 죽으면 Knowledge 대화가
  사실상 전부 실패한다(MCP처럼 "일부 기능만 제한"이 아니다). Ollama 전용
  모드에서는 아직 검색을 쓰지 않으므로 `runtime`과 동일하게
  `featureFailures`(limited)로만 표시했다 — 결정 근거를 함수 docstring에
  그대로 남겼다.
- `electron/main.ts`의 `connections:check` 핸들러가
  `desktopSettings.searchRuntimeBaseUrl`을 넘기도록 갱신했다.
- `ConnectionId` 타입에 `"search"` 추가(`electron/types.ts`).

## 지킨 경계

- `apps/`, `services/`, `packages/`, `docs/` 중 `apps/desktop-client/`
  바깥은 전혀 건드리지 않았다.
- D-060 규칙(`assetVersionId` 없으면 `assetId`로 대체하지 않음)은
  `resolveKnowledgeSelection`을 그대로 재사용해 지켰다 — 별도로
  재구현하지 않았다.
- D-078(허브 조회 로컬 유출 방지) 경계는 코드·문구 어느 쪽도 바꾸지 않았다.
- 새 IPC(`knowledge:reconcileActivations`)는 `types.ts`/`main.ts`/`preload.ts`
  세 곳을 모두 갱신했다.
- `fs`/`node:*`/`electron`을 `src/`나 순수 `electron/` 모듈에 새로 들여오지
  않았다 — `computeActivationReconcile`은 순수 함수이고,
  `reconcileInstalledKnowledgeActivations`(fs 사용)는 여전히 main-process
  전용 파일(`knowledge-activation.ts`, 기존에도 `fs`/`path` import) 안에만
  있다.
- 로그에는 사유 코드/개수 등 구조화된 정보만 남겼다(Prompt 원문·문서 전체
  없음).

## 검증

```
cd apps/desktop-client
pnpm typecheck   # tsc -p tsconfig.json && tsc -p tsconfig.electron.json — 오류 0건
pnpm test        # vitest run — 33 files, 440 passed (기준선 425에서 +15, 감소 없음)
pnpm lint        # 기존과 동일하게 즉시 실패 — 저장소에 eslint 설정 파일 자체가 없음(본 작업과 무관, 사전 존재하던 공백)
```

새로 추가/변경한 테스트 15개가 정확히 425 → 440의 차이와 일치한다:
- `src/screens/chatTypes.test.ts`: `resolveInstalledKnowledgeIds` 3개 테스트를
  `partitionInstalledKnowledgeByActivation`/`resolveActivatedKnowledgeIds` 6개로
  교체(+3) — 활성화 미시도/명시적 비활성화/실패/legacy Bundle/혼합 케이스를
  모두 커버.
- `electron/__tests__/connections.test.ts`: `checkAllConnections`에 2개
  (배열 길이 4, search 기본/커스텀 Endpoint), `assessChatConnections`에 2개
  (search 장애가 knowledge 모드에서 blocked, ollama 모드에서 limited) 추가(+4).
- `electron/__tests__/knowledge-activation.test.ts`: `computeActivationReconcile`
  순수 로직 5개(null=미확인/다운그레이드/일치/비-ACTIVE 무시/비-Knowledge
  무시) + `reconcileInstalledKnowledgeActivations` 오케스트레이션 3개
  (다운그레이드+영속화/도달 불가 시 상태 유지/완전 일치 시 0건) 추가(+8).

**손으로 확인한 것** (`pnpm exec vite` 포트 5174, Playwright로 `localhost`
접속):
- 채팅 화면: 브릿지 없는 상태(순수 브라우저)에서 크래시 없이 렌더링됨.
  콘솔에는 기존 MCP CORS 오류에 더해 **새로 추가한 search-runtime(8300)
  Health Check의 CORS 오류**가 나타났다 — 이는 `checkAllConnections`가
  실제로 search-runtime을 호출하기 시작했다는 신호이자, MCP와 동일한
  기존 방식의(사내 서비스가 안 떠 있을 때의) 예상된 오류다. 새로운 크래시나
  회귀는 없었다.
- 설정 화면(`?desktop-preview=1`로 Browser Preview 모드 활성화 후): 새
  "지식 검색(search-runtime) 연결" Card가 정상 렌더링되고, 원격 주소
  (`http://example.com:8300`)를 입력해 저장을 시도하면
  `validateSearchRuntimeBaseUrl`의 한국어 오류 메시지("search-runtime
  주소는 loopback(127.0.0.1/localhost)만 허용됩니다...")가 실제로 표시됨을
  확인했다.
- 설정 > 연결 상태 탭, 그리고 ChatScreen의 활성화 배너/버튼은 **Electron
  bridge(`window.desktop`)가 있어야만 데이터를 채우는 경로**라 이 Browser
  Preview 환경에서는 "Desktop 런타임 필요" 상태로만 보이거나(연결 상태
  화면 — 이 화면 자체가 `getDesktopBridge()`만 보고 fallback이 없다, 기존
  동작이며 이번 작업 범위 밖) 빈 목록으로 보였다(ChatScreen은
  `installedKnowledge`가 항상 `[]`). **활성화 배지·버튼·excluded 목록·재확인
  캡션의 실제 시각적 모습은 실 Electron 셸에서 검증하지 못했다** — 이전
  D-079 리포트와 동일한 한계다(Electron 바이너리를 이 환경에서 실행할 수
  없음, 회사 정책상 바이너리 다운로드 금지 + macOS XProtect 격리,
  Gatekeeper 우회 시도하지 않음).
- `electron/main.ts`의 `assets:remove` 핸들러 변경(work item 5)은 저장소에
  main.ts를 직접 실행하는 테스트가 이 프로젝트에 전혀 없어(다른 IPC
  핸들러들도 마찬가지) 단위 테스트로 커버하지 못한다 — 그 안에서 재사용한
  `deactivateInstalledKnowledge` 자체는 기존 `knowledge-activation.test.ts`가
  이미 충분히 검증한다(성공/도달 불가/비-Knowledge/레코드 없음).

## 남은 구조적 공백 / 이번 브리핑에서 어긋난 점

- ChatScreen의 활성화 배너·버튼, 설정 > 연결 상태의 search 행은 **UI
  렌더링 자체가 자동 테스트로 증명되지 않는다**(`vitest.config.ts`가
  `environment: "node"`). 위 "손으로 확인한 것"이 커버하지 못한 부분은
  다음에 실 Electron 셸이 확보되면 사람이 직접 확인해야 한다.
- reconcile은 `ChatScreen.loadInstalledKnowledge`가 화면 진입/새로고침 시마다
  호출한다(자동 폴링이나 별도 타이머는 없음) — 화면을 열어 두고 있는 동안
  search-runtime이 재시작되면, 다음 새로고침(또는 대화 목록 갱신 등으로
  `loadInstalledKnowledge`가 다시 불릴 때)까지는 낡은 ACTIVE 상태가 화면에
  남을 수 있다. 이 정도 지연은 이번 브리핑 범위에서 명시적으로 요구되지
  않았으므로 자동 폴링을 추가하지 않았다 — 필요하면 별도 작업으로 논의한다.
- `assets:remove`의 `deactivationWarning`은 search-runtime에 아예 도달하지
  못한 경우와, 도달은 했지만 거부당한 경우를 하나의 문자열로 합쳐 보여준다
  (`deactivateInstalledKnowledge`의 `error`/`remoteWarning`을 그대로
  이어붙임). 두 경우를 구조적으로 분리해 보여 달라는 지시는 없었으므로
  단순화했다 — 필요하면 `RemoveAssetResult.warning`을 구조화된 필드로
  바꾸는 후속 작업이 가능하다.
- 브리핑이 예상과 다르게 나온 부분은 없었다. 다만 `ExcludedKnowledge`/
  `UsableKnowledge`를 제네릭으로 만든 것은 브리핑에 없던 결정이다 —
  `InstalledAssetWithStatus`를 넘기는 ChatScreen과, `InstalledAsset`만
  다루는 다른 잠재 호출자(예: 향후 D08) 모두를 캐스팅 없이 만족시키려면
  필요했다.
