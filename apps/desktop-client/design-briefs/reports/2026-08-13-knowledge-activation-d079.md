# D-079 Knowledge 활성화 — Desktop 절반 구현

## 받은 지시

D-079의 Desktop Client(M04) 절반을 구현한다. 지금까지 "설치됨"은 파일과 설치
메타데이터가 안전하게 기록되었다는 뜻일 뿐, search-runtime의 검색 경로에
등록되었다는 뜻은 아니었다 — 그 결과 Offline Bundle로 설치한 Knowledge는
채팅에서 조용히 Citation 0건만 반환했다(2026-08-13-knowledge-mcp-install-ux.md
"남은 구조적 공백" 참고). `packages/schemas/api/knowledge-local-index.schema.json`에
이미 정의되고 `services/search-runtime`에 이미 구현된 공개 Loopback 계약
(`POST/GET/DELETE /search/v1/local-indexes`)을 소비해, "설치됨"과 "활성화됨"을
서로 다른 두 사실로 화면에 분리해 보여주고, 설치 성공 뒤 자동 활성화를
시도하고, 실패해도 설치 자체는 성공으로 유지하도록 지시받았다. `apps/`,
`services/`, `packages/` 중 `apps/desktop-client/` 바깥은 건드리지 않는다.

## 이번 구현

**신규 파일**

- `electron/search-runtime-client.ts` — 순수 HTTP 클라이언트(`fs`/`electron`
  import 없음). `registerLocalKnowledgeIndex`/`unregisterLocalKnowledgeIndex`/
  `listLocalKnowledgeIndexes`. 절대 throw하지 않고 판별 유니언
  (`{ok:true,...} | {ok:false,reason,message}`)을 반환한다. 서버 Error
  Envelope의 `details.reason`을 알려진 14개 사유 집합과 대조해 모르는 값/비어
  있음/비-JSON 본문은 모두 `"unknown"`으로, 네트워크 단절·타임아웃은
  `"unreachable"`로 별도 구분한다. Timeout은 `connections.ts`의 Health Check용
  2500ms와 분리된 `ACTIVATION_TIMEOUT_MS = 8000`(named constant) — 활성화는
  index-meta/bm25/chroma를 실제로 여는 작업이라 더 오래 걸릴 수 있다.
- `electron/knowledge-activation.ts` — Main Process 오케스트레이션.
  `activateInstalledKnowledge`/`deactivateInstalledKnowledge`. `assetType !==
  "knowledge"`와 레코드 없음만 아무것도 저장하지 않고 즉시 거부하고, 그 외
  모든 경로(assetVersionId 없음=D-060, index 폴더 없음, search-runtime 거부,
  search-runtime 도달 불가, 성공)는 반드시 `InstalledAssetsStore.updateActivation`으로
  저장한 뒤 반환한다 — 지금 화면에 안 보이는 실패도 나중에 보여야 한다는
  요구사항의 핵심.
- `src/screens/knowledgeActivation.ts` — 렌더러 순수 헬퍼.
  `IncludedAssetSummary[]`(설치 결과의 installPlan)에서 활성화를 시도할 만한
  Knowledge 항목만 골라낸다(`asset_id`/`version`이 둘 다 non-null인 것만 —
  D-060 클래스의 누락을 추측하지 않는다).
- 테스트 3종:
  - `electron/__tests__/search-runtime-client.test.ts` (26개) — 성공, 14개
    거부 사유 전부(it.each), reason 미상, 비-JSON 응답, 도달 불가,
    Timeout(AbortError), entry 누락 200 응답.
  - `electron/__tests__/knowledge-activation.test.ts` (11개) — 실제 임시
    설치 Layout(`asset-management.test.ts`와 동일 관례) + 주입한 가짜
    `fetchImpl`. 성공 시 저장, assetVersionId null 시 fetch 자체를 호출하지
    않고 거부, index 폴더 없을 때 로컬에서 빠르게 실패, 서버 거부 사유
    저장, 도달 불가 시 `unreachable`로 저장, 비-Knowledge 유형 거부(저장
    없음), 레코드 없음 거부(저장 없음), 비활성화 성공, 비활성화 중
    search-runtime 도달 불가해도 로컬 상태는 정리(+`remoteWarning`).
  - `src/screens/knowledgeActivation.test.ts` (6개) — install plan 필터링.

**기존 파일 변경**

- `electron/connections.ts` — `DEFAULT_SEARCH_RUNTIME_BASE_URL =
  "http://127.0.0.1:8300"` 추가(이 파일이 Endpoint 기본값의 단일 출처라는
  기존 관례를 그대로 따름).
- `electron/network-policy.ts` — `validateSearchRuntimeBaseUrl` 추가.
  `isLoopbackHostname`을 재사용하되, Ollama의 `allowNonLoopback` 같은 예외를
  두지 않고 항상 loopback만 허용한다(활성화 요청이 이 기기의 절대 경로를
  담기 때문 — 원격으로 보내면 경로가 유출되고, 애초에 원격 search-runtime은
  이 디스크를 읽을 수 없어 동작할 수 없다).
- `electron/desktop-settings.ts` — `searchRuntimeBaseUrl` 필드 추가. 기존
  부분 업데이트 + All-or-nothing 검증 패턴을 그대로 따른다.
- `electron/installed-assets-store.ts` — `updateActivation` 추가
  (`updateChecksumVerification`과 동일한 패턴: 레코드 없으면 조용히 no-op,
  `null`을 넘기면 명시적으로 지운다).
- `electron/types.ts` — `KnowledgeActivation`(+`InstalledAsset.activation?`),
  `ActivateKnowledgeResult`, `DeactivateKnowledgeResult`,
  `DesktopSettingsPublic.searchRuntimeBaseUrl`,
  `DesktopSettingsInput.searchRuntimeBaseUrl`, `DesktopBridge`에
  `activateInstalledKnowledge`/`deactivateInstalledKnowledge` 추가.
  `activation` 필드 문서에 "필드 없음 = 시도한 적 없음, 이걸 ACTIVE로
  그리면 안 된다"를 `checksumVerification`과 동일한 어조로 명시했다.
- `electron/main.ts`/`electron/preload.ts` — IPC 채널
  `knowledge:activate`/`knowledge:deactivate` 추가(three-file rule: types →
  main → preload 모두 갱신). 로그는 성공/실패 모두 `app-logger`에 구조화
  기록.
- `src/browserPreviewBridge.ts` — `DesktopSettingsPublic`이 새 필수 필드를
  얻었으므로 브라우저 미리보기 기본값/patch 처리/localStorage 파싱에
  `searchRuntimeBaseUrl`을 추가(안 하면 typecheck가 즉시 깨진다 — 실제로
  이번 작업에서 그렇게 깨져서 잡았다).
- `src/screens/AssetsScreen.tsx` — Knowledge 행에 활성화 배지 3종(활성화됨/
  활성화 안 됨(미시도)/활성화 실패 + 서버 메시지)과 활성화·비활성화 버튼.
  MCP Tool 행에는 "설치되었지만 아직 실행 레지스트리에 연결되지 않음(D-079
  나머지 절반)" 설명을 상시 노출. Agent/Prompt/Service 행에는 애초에 이
  개념이 없으므로 버튼도 문구도 추가하지 않았다(모든 비-Knowledge 행에
  동일 문구를 반복 노출하면 오히려 신호 대 잡음비가 나빠진다고 판단 —
  지시문의 "MCP Tool: 아직 지원되지 않음" 예시를 MCP Tool에만 적용).
- `src/screens/StoreScreen.tsx`/`src/screens/ImportScreen.tsx` — 설치 성공
  직후 `knowledgeActivationTargets`로 뽑은 Knowledge 항목마다
  `activateInstalledKnowledge`를 순차 호출하고 결과를 인라인으로 보여준다.
  성공/실패 배너는 설치 결과 그대로 유지하고, 활성화 결과는 그 아래 별도
  구획에 "설치는 완료되었지만 검색에 활성화되지 않았습니다: <사유> — 설치된
  자산 화면에서 다시 시도할 수 있습니다"로 명확히 분리했다.

## 지킨 경계

- search-runtime의 `INDEX_BASE` 트리에 파일을 쓰거나 M08 내부 코드를
  import하지 않는다 — 오직 문서화된 HTTP 계약만 소비한다.
- `packages/schemas/api/knowledge-local-index.schema.json`과
  `services/search-runtime`은 읽기만 했고 수정하지 않았다.
- D-060 규칙을 재확인했다: `assetVersionId`가 없으면 어떤 경로에서도
  `assetId`로 대체하지 않는다(`activateInstalledKnowledge`의 첫 번째
  분기이자 전용 단위 테스트).
- MCP Tool 활성화(agent-runtime/Office Profile 실행 레지스트리 연결)는
  손대지 않았다 — D-079의 나머지 절반이며 이번 작업 범위 밖임을 UI 문구로도
  명시했다.
- `apps/portal-*`, `services/*`, `packages/*`는 전혀 수정하지 않았다.

## 검증

```
pnpm typecheck   # tsc -p tsconfig.json && tsc -p tsconfig.electron.json — 오류 0건
pnpm test        # vitest run — 33 files, 425 passed (기준선 376에서 +49, 감소 없음)
pnpm lint        # 기존과 동일하게 즉시 실패 — 저장소에 eslint 설정 파일 자체가 없음(본 작업과 무관, 사전 존재하던 공백)
```

새로 추가한 테스트 43개(search-runtime-client 26 + knowledge-activation
11 + knowledgeActivation(screen) 6) + 기존 파일에 추가한 6개
(network-policy 4, desktop-settings 2) = 49개가 정확히 376 → 425의 차이와
일치한다.

**손으로 확인한 것**: 기존에 이미 떠 있던 `pnpm exec vite`(포트 5174,
`localhost`)에 Playwright로 접속해 채팅/자산 허브/설치된 자산 탭을
열었다 — 콘솔에는 기존부터 있던 MCP CORS 오류만 있었고 이번 변경으로 인한
새 오류나 화면 크래시는 없었다. 다만 이 경로는 `window.desktop`이 없어
`bridge.ts`가 `null`을 반환하므로 모든 자산 허브 화면이 "Desktop 런타임
필요" 상태로만 보인다 — **활성화 배지·버튼·설치 후 인라인 활성화 결과는
실제 Electron 셸(`window.desktop` 존재)에서만 보이는 화면이라 이번에는 눈으로
확인하지 못했다.** Electron 바이너리는 이 환경에서 실행할 수 없었다(회사
정책상 바이너리 다운로드 금지 및 macOS XProtect 격리 — Gatekeeper 우회는
시도하지 않았다).

## 남은 구조적 공백

- **UI 렌더링은 자동 테스트로 증명되지 않는다.** `vitest.config.ts`가
  `environment: "node"`라 AssetsScreen/StoreScreen/ImportScreen의 JSX
  변경 자체는 타입만 검증됐고, 실제 배지 색상·레이아웃·버튼 활성/비활성
  전환은 Electron 셸에서 사람이 직접 확인해야 한다.
- **search-runtime이 실제로 떠 있는 상태에서의 End-to-End 확인은 하지
  않았다** — 이 작업은 Desktop 절반만의 범위였고, 실제 등록/검색 가능
  여부는 `services/search-runtime`의 자체 테스트와 향후 통합 테스트의
  몫이다.
- MCP Tool 활성화(D-079 나머지 절반)는 여전히 미구현이며, UI는 "설치되었지만
  아직 연결되지 않음"이라고만 알린다.
- `searchRuntimeBaseUrl` 설정을 D01 설정 마법사/D10 설정 화면의 입력
  Form에 노출하는 UI는 이번 범위에 포함하지 않았다(지시문이 "설정: 기본값 +
  검증 로직"까지만 요구했고, 별도 Form 필드 추가는 언급하지 않았다) —
  현재는 기본값(`http://127.0.0.1:8300`)으로만 동작하며, 값을 바꾸려면
  `updateDesktopSettings({ searchRuntimeBaseUrl })` IPC를 호출할 UI 진입점이
  아직 없다. 필요하면 별도 작업으로 설정 화면에 입력 필드를 추가해야 한다.
