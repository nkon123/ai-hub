# 001 — 채팅 화면 연결 판정 오탐 수정

대상 모듈: `apps/desktop-client` (M04)
작성자/일자: 설계·검증 세션 / 2026-08-11
선행 조건: 없음 (커밋 `c51da51` IA 재편 이후 상태 기준)

작업 전에 [`apps/desktop-client/CLAUDE.md`](../../../apps/desktop-client/CLAUDE.md)와
루트 [`/CLAUDE.md`](../../../CLAUDE.md)를 읽는다. 이 문서는 그 규칙을 반복하지 않는다.

## 1. 문제

채팅이 정상 동작하는데도 채팅 화면 상단에 빨간 배너가 뜬다:

> **Local Agent Runtime, Office MCP Server (oracle-connector) 연결이 끊어져 있어 대화가 제한될 수 있습니다.**
> Local Agent Runtime: Failed to fetch — … (설정된 주소: http://127.0.0.1:8100)
> Office MCP Server (oracle-connector): Failed to fetch — … (설정된 주소: http://127.0.0.1:8500)

**재현** (2026-08-11 실측):

1. agent-runtime을 8100이 아닌 포트로 띄운다. 예: 8102.
2. `apps/desktop-client/.env.local`에 `VITE_AGENT_RUNTIME_BASE_URL=http://127.0.0.1:8102`.
3. `pnpm --filter desktop-client exec vite` → 브라우저에서 `http://localhost:5174`.
4. 개발자 옵션에서 Knowledge ID를 넣고 질문한다 → **답변과 Citation이 정상 출력된다.**
5. 그런데 상단 배너는 계속 "연결이 끊어져 있어 대화가 제한될 수 있습니다"를 표시한다.

**증상의 무게**: 앱을 열자마자 사용자가 보는 첫 화면이 가짜 오류다. 진짜 장애가
났을 때 이 배너를 아무도 믿지 않게 만든다는 점이 더 큰 문제다.

**지금 X / 앞으로 Y**
- 지금: 연결 판정이 **하드코딩된 8100/8500**을 검사한다. 실제 대화가 쓰는 주소와 무관하다.
- 앞으로: 연결 판정은 **대화가 실제로 사용하는 주소**를 검사해야 하고, 대화에 필요 없는 서비스의 장애를 대화 차단으로 표현하면 안 된다.

## 2. 원인

두 개의 독립된 결함이다.

**(A) 호출부가 설정을 전달하지 않는다 — 오탐의 직접 원인**

- `src/agentRuntime.ts:18-19` — 대화가 실제로 쓰는 주소:
  `AGENT_RUNTIME_BASE_URL = import.meta.env.VITE_AGENT_RUNTIME_BASE_URL ?? "http://127.0.0.1:8100"`
- `src/screens/ChatScreen.tsx:160` — `await checkAllConnections()` … **인자 없이** 호출한다.
- `electron/connections.ts:162-167` — 인자가 없으면 `DEFAULT_RUNTIME_BASE_URL`(=`http://127.0.0.1:8100`, 17행)로 폴백한다.

즉 `checkAllConnections`는 `ConnectionCheckSettings.runtimeBaseUrl`을 **이미 받을 수 있는데** 호출부가 안 넘긴다. `electron/main.ts:379`와 `electron/diagnostic-bundle.ts:108`은 제대로 설정을 넘기고 있다 — ChatScreen만 빠져 있다.

**(B) MCP 장애를 대화 차단으로 표현한다 — 배너 문구의 원인**

Office MCP Server(8500)는 MCP Tool을 실제로 호출할 때만 필요하다. Knowledge 대화는 agent-runtime + search-runtime + Ollama만 있으면 된다. 그런데 배너는 세 서비스를 동등하게 묶어 "대화가 제한될 수 있습니다"라고 말한다.

브라우저 검증 경로에서는 이게 **항상** 발생한다: office-mcp-server는 살아 있어도(`curl http://127.0.0.1:8500/health/live` → 200 실측) origin `http://localhost:5174`에 CORS 헤더를 주지 않아 브라우저 `fetch`가 실패한다. agent-runtime 8100도 같은 이유로 실패한다(8102는 CORS 허용됨 — 실측으로 8100은 `access-control-allow-origin` 없음, 8102는 있음).

## 3. 변경 범위

| 파일 | 무엇을 | 신규/수정/삭제 |
|---|---|---|
| `src/screens/ChatScreen.tsx` | `checkAllConnections`에 실제 사용 주소를 전달. 배너를 "대화 차단" / "기능 제한" 두 단계로 구분 | 수정 |
| `electron/connections.ts` | (선택) `ConnectionStatus`에 대화 필수 여부를 나타낼 수단이 필요하면 추가. §4 참고 | 수정 |
| `electron/__tests__/connections.test.ts` | 기존 테스트 유지 + §6.2 케이스 추가 | 수정 |

계약 변경 없음: `packages/schemas`, OpenAPI, IPC 채널(`electron/types.ts`/`main.ts`/`preload.ts`) 모두 그대로다.

## 4. 설계

### 4.1 (A) 실제 주소를 전달한다

`ChatScreen.tsx`에서 `agentRuntime.ts`가 이미 export하는 `AGENT_RUNTIME_BASE_URL`을 import해 넘긴다:

```ts
await checkAllConnections({ runtimeBaseUrl: AGENT_RUNTIME_BASE_URL });
```

**`connections.ts` 안에서 `import.meta.env`를 읽지 마라.** 이 파일은 `electron/main.ts:9`와 `electron/diagnostic-bundle.ts:13`이 import하는 **순수 모듈**이다(모듈 CLAUDE.md "코드 배치" 참고). `import.meta.env`는 Vite 전용이라 Electron 메인 프로세스(tsc 컴파일)에서 깨진다. 주소 해석은 호출부의 책임으로 남긴다 — `main.ts`/`diagnostic-bundle.ts`가 이미 그렇게 하고 있다.

Ollama/MCP 주소도 Electron에서는 저장된 설정을 쓴다. 브라우저 경로에는 그 설정이 없으므로 기본값 폴백이 맞다 — 그대로 둔다.

### 4.2 (B) 대화 필수 / 선택 기능을 구분한다

배너를 두 단계로 나눈다.

- **대화 차단 (빨강)**: Local Agent Runtime 또는 Ollama가 죽었을 때. 지금 문구 유지.
- **기능 제한 (노랑/정보)**: Office MCP Server만 죽었을 때. "MCP Tool을 사용하는 질문은 실패할 수 있습니다. Knowledge 대화는 정상 동작합니다." 수준으로 낮춘다.
- 셋 다 정상이면 배너 없음.

구현 방식은 구현자가 정한다. 다만 **어떤 서비스가 대화에 필수인지를 판단하는 지식은 한 곳에만 둔다** — ChatScreen에 조건문을 흩뿌리지 말고 상수/헬퍼로 모은다. 루트 CLAUDE.md "함수와 클래스는 한 가지 책임을 가진다".

### 4.3 유지할 것

- 진짜 장애 시 **복구 안내**는 반드시 남는다(루트 CLAUDE.md: "Desktop은 Runtime 장애 시 종료되지 않고 복구 안내를 제공한다"). 지금 배너가 보여주는 "설정된 주소"와 "설정 > 연결 상태에서 자세히" 안내는 유지한다.
- 배너에 표시하는 주소는 **실제로 검사한 주소**여야 한다. 지금은 검사도 표시도 8100이라 우연히 일치하지만, §4.1 이후에는 전달받은 주소를 표시해야 한다.

## 5. 깨면 안 되는 것 (불변식)

| 불변식 | 왜 | 확인 방법 |
|---|---|---|
| **D-078** — 로컬 조회 데이터를 허브로 보내지 않는다 | 이 저장소의 최우선 보안 경계 | 이 작업은 `hub_query`/`chatTypes.ts`/허브 토글을 건드릴 이유가 없다. `git diff`에 `buildHubQueryPreview`, `allowHubLookup`, `hub.query_sent`, Citation 배지가 나타나면 설계 이탈이다 |
| 허브 동의 토글 기본값 `false` | 사용자가 명시적으로 켜야 허브로 나간다 | 화면에서 육안 확인(§6.3-4) |
| `connections.ts`가 순수 모듈로 남는다 | Electron 메인·렌더러 양쪽이 import한다 | `grep -n "import.meta" electron/connections.ts` → 0건. `pnpm --filter desktop-client typecheck`가 `tsconfig.electron.json`까지 돌아 깨짐을 잡는다 |
| `checkAllConnections`의 기존 3개 호출부가 계속 동작 | `main.ts:379`, `diagnostic-bundle.ts:108`, SetupWizard | 기존 `connections.test.ts` 통과 유지 |
| 진짜 장애 시 복구 안내가 사라지지 않는다 | 루트 CLAUDE.md 요구사항 | §6.3-3에서 강제 재현 |

## 6. 완료 판정

### 6.1 실행할 명령과 기대 결과

```
$ pnpm --filter desktop-client typecheck
(오류 없음 — tsconfig.json과 tsconfig.electron.json 둘 다)

$ pnpm --filter desktop-client test
Test Files  27 passed (27)
     Tests  349 passed (349)      ← 기준선. §6.2 추가분만큼 늘어야 하고 줄면 안 된다.
```

`pnpm --filter desktop-client lint`는 실행하지 않아도 된다 — 저장소에 eslint 설정 파일이 없어 항상 실패한다(기존 공백, 이 작업과 무관).

### 6.2 반드시 존재해야 할 테스트

`electron/__tests__/connections.test.ts`에 추가한다:

1. **`runtimeBaseUrl`을 넘기면 그 주소를 검사한다** — `checkAllConnections({ runtimeBaseUrl: "http://127.0.0.1:8102" })` 호출 시 fetch가 `http://127.0.0.1:8102/health`로 가는지 확인. **기본값 8100으로 가지 않는 것까지** assert한다(그러지 않으면 이 버그를 다시 통과시킨다).
2. **MCP만 죽은 경우와 runtime이 죽은 경우가 구분된다** — §4.2의 판정 헬퍼를 순수 함수로 두고 직접 테스트한다. runtime down → 대화 차단, MCP만 down → 기능 제한, 전부 정상 → 배너 없음.

ChatScreen 자체의 렌더링 테스트는 만들지 않는다 — 이 프로젝트는 `environment: "node"`라 React 렌더 테스트가 없다(모듈 CLAUDE.md 참고). 그래서 §6.3이 필수다.

### 6.3 눈으로 확인할 것

**이 모듈은 렌더링 테스트가 없어 UI 변경은 여기서만 검증된다.** 반드시 수행한다.

준비: agent-runtime을 8100이 아닌 포트(예: 8102)로 띄우고, `.env.local`에 `VITE_AGENT_RUNTIME_BASE_URL`을 그 포트로 설정. 브라우저에서 `http://localhost:5174`(반드시 `localhost`).

1. **오탐 해소** — 채팅 화면 진입 시 빨간 "대화 제한" 배너가 **뜨지 않는다**. 개발자 옵션에서 Knowledge ID `d9e660b7-ca76-4f46-899e-2e1621bac139`를 넣고 `장비 지원은 무엇이 있나요?`를 물어 답변과 Citation이 나오는지 확인.
2. **MCP 단독 장애** — office-mcp-server가 응답하지 않는 상태(브라우저 경로에서는 CORS로 항상 그렇다)에서 배너가 **빨간 "대화 차단"이 아니라 낮은 강도의 "기능 제한"**으로 표시되고, 대화는 정상 동작하는지.
3. **진짜 장애** — `VITE_AGENT_RUNTIME_BASE_URL`을 죽은 포트(예: 8199)로 바꾸고 새로고침 → **빨간 배너가 뜨고**, 표시되는 주소가 `8199`(실제 검사한 주소)인지. 복구 안내 문구와 "설정 > 연결 상태" 안내가 남아 있는지.
4. **D-078 육안 확인** — 하단 "허브에도 물어보기" 토글이 **기본 꺼짐**이고 설명 문구가 그대로인지. Citation의 로컬/허브 배지가 보이는지.

## 7. 범위 밖

발견해도 이 작업에서 고치지 않는다. 별도 설계 문서로 다룬다.

- **포트 5173/5174 불일치** — `vite.config.ts:16`과 `electron/main.ts:145`가 5173 하드코딩인데 문서·운영은 5174. 별개 결함이다.
- **eslint 설정 파일 부재** — 인프라 공백.
- **`services/search-runtime/src/search_runtime/hybrid.py:24`의 `INDEX_BASE` 개인 절대경로 하드코딩** — 다른 모듈이고 Codex 담당 범위 밖이다.
- office-mcp-server / agent-runtime(8100)의 CORS 설정 — `services/` 쪽 변경이다. 이 작업은 Desktop만 건드린다.

## 8. 열린 질문

없음. §4.2의 배너 2단계 표현 방식(색/문구/컴포넌트)은 구현자 재량이되, 판정 로직은 한 곳에 모은다는 제약만 지킨다.
