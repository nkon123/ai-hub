# 구현 보고 2026-08-11 — Ollama 스타일 채팅 화면

설계 문서: 없음 — 직접 지시
구현자: Codex
**작성자: 검증 세션(Claude). 구현자가 보고를 남기지 않아, 커밋 `037c4bd`의 diff와
실제 동작 확인 결과로 사후 재구성했다.** 아래는 전부 검증으로 확인한 사실이며,
구현자의 의도를 추측해 적은 부분은 "추정"이라고 표시했다.
이후 작업부터는 구현자가 직접 보고를 남긴다(`README.md`의 "설계 문서 없이 직접
지시받은 작업" 규칙).

## 받은 지시

설계 문서 001과 별개로, 대화에서 직접 받은 지시다(원문):

> 메뉴 구성을 대분류로 좀 단순화 해봐 예를들어 날리지 , 에이전트, 서비스, 서포트 등등 이렇게

> 채팅이 일단 메인으로 하고, 좌측 메뉴에는 채팅, 자산 허브 , 설정 이렇게 하고.
> 채팅에는 올라마 데탑 클라이언트처럼 단순하게 채팅만 할 수 있도록 하되, 허브에서
> 다운 받아둔 지식,에이전트, 등을 에이전틱 하게 사용 하게 하고 싶어

허브 동의 설명 문구를 상시 노출에서 툴팁으로 바꾼 건에 대해, 저장소 소유자가
검토 후 "유지해 다 내가 시킨거야"로 승인했다.

## 무엇이 어떻게 됐나

| 파일 | 무엇을 | 어느 지시에서 | 신규/수정/삭제 |
|---|---|---|---|
| `electron/ollama-chat.ts` | Knowledge 자산이 없을 때 설정된 Ollama 모델과 직접 대화. `{base}/api/tags`로 모델 확인 후 `{base}/api/chat` 호출, `AbortSignal`로 취소 | "올라마처럼 단순하게 채팅만" | 신규 |
| `electron/__tests__/ollama-chat.test.ts` | 위 모듈 테스트 | 동일 | 신규 |
| `electron/types.ts` | `OllamaChatInput`/`OllamaChatResult`, `DesktopBridge.chatWithOllama` | 동일 | 수정 |
| `electron/preload.ts` | IPC 노출 `chat:ollama`, `chat:ollamaCancel` | 동일 | 수정 |
| `electron/main.ts` | 위 두 채널 핸들러. 주소는 `desktop-settings`의 `ollamaBaseUrl` 사용 | 동일 | 수정 |
| `electron/desktop-settings.ts` | 채팅 모델 Alias 설정 | 동일 | 수정 |
| `src/screens/chatTypes.ts` | `ChatMessage`에 선택 필드 `ollamaOnly`, `ollamaModel` 추가 | 동일 | 수정 |
| `src/runStages.ts`, `runStages.test.ts` | Ollama 전용 대화의 단계 표시 | 동일 | 수정 |
| `src/screens/ChatScreen.tsx` | Knowledge 검색·허브 조회를 입력줄 아이콘 토글로 이동, 설명은 `aria-describedby` 툴팁 | "단순하게 채팅만" | 수정 |
| `src/screens/settingsTypes.ts`, `settingsTypes.test.ts` | 설정 화면 순수 로직 분리 | 추정 — 위 설정 추가에 따른 정리 | 신규 |
| `src/screens/SettingsScreen.tsx` | 채팅 모델 설정 UI | 동일 | 수정 |
| `src/screens/SetupWizardScreen.tsx` | 위 변경 반영 | 동일 | 수정 |
| `src/browserPreviewBridge.ts`, `browserPreviewBridge.test.ts` | 브라우저(비Electron)에서 화면을 확인하기 위한 대체 브리지 | 추정 — 육안 검증 경로 확보용 | 신규 |
| `.impeccable.md` | 디자인 컨텍스트(사용자상, 톤, 원칙 4개) | 추정 — 디자인 방향 고정용 | 신규 |

## 실행 결과

검증 세션이 직접 실행했다(구현자 보고가 아니라 재실행 결과다).

```text
$ pnpm typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.electron.json
(오류 없음)

$ pnpm test
Test Files  30 passed (30)
     Tests  371 passed (371)
```

기준선 349개 → 371개. 22개 증가, 감소 없음.

## 추가한 테스트

구현자가 추가한 것으로, 파일 기준:
`electron/__tests__/ollama-chat.test.ts`, `src/browserPreviewBridge.test.ts`,
`src/screens/settingsTypes.test.ts`, 그리고 `connections.test.ts`·`runStages.test.ts` 보강.

## 눈으로 확인한 결과

검증 세션이 브라우저(`http://localhost:5174`)에서 확인했다.

1. 사이드바 3개(채팅/자산 허브/설정), 기본 진입 채팅.
2. Knowledge 자산이 없을 때 헤더가 "기본 Ollama 대화"로 표시되고, 안내가
   "질문을 입력하면 기본 Ollama 모델로 일반 대화를 시작합니다"로 나온다.
3. 입력줄 아이콘 토글 2개 확인 — `보유 Knowledge에서 찾기`,
   `허브에도 물어보기`. 둘 다 `aria-pressed="false"`.
4. Knowledge 검색을 켜고 `재택근무는 주 며칠까지 가능한가요?` 질문 →
   "주 최대 2일" 답변과 `remote-work-policy` 출처 3건, 전부 `로컬` 배지.
5. 연결 배너가 빨간 "대화 차단"이 아니라 노란 "Ollama 대화는 정상이며
   Knowledge·Tool 일부 기능만 제한됩니다"로 표시된다.

## D-078 확인

| 항목 | 결과 |
|---|---|
| `buildHubQueryPreview` | **변경 없음** — 여전히 `m.question`만 읽는다 |
| 허브 토글 기본값 | `aria-pressed="false"` |
| 허브 토글 사용 조건 | 보유 Knowledge 검색 전에는 `disabled` (초안보다 강화) |
| 적용 불가 시 자동 해제 | `ChatScreen.tsx`의 `useEffect`가 `allowHubLookup`을 `false`로 되돌림 |
| 설명 문구 | `aria-describedby="hub-toggle-tooltip"`에 "기본적으로 꺼져 있으며 로컬 문서 내용은 허브로 전송되지 않습니다" 유지 |
| Citation 로컬/허브 배지 | 유지 |
| Ollama 직결 경로의 전송 대상 | `desktop-settings`의 `ollamaBaseUrl`만 — `network-policy.ts`가 loopback을 강제한다. 허브로 나가지 않는다 |

## 설계와 다른 부분

허브 동의 설명 문구가 상시 노출에서 툴팁으로 **축소**됐다. 설계 문서 001 §5는
"제거·축소 금지"였으므로 초안 기준으로는 이탈이다. 저장소 소유자가 검토 후
유지하기로 승인했고, 001 §5와 `CLAUDE.md`의 D-078 항목을 그 결정에 맞게 갱신했다.

## 범위 밖으로 남긴 것

- 포트 5173/5174 불일치(`vite.config.ts`, `electron/main.ts`) — 미해결.
- eslint 설정 파일 부재 — 미해결.
