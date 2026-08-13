# 구현 보고 2026-08-11 — Ollama 기본 채팅 후속 요구사항

설계 문서: [`../001-connection-detection.md`](../001-connection-detection.md) 참조 + 직접 지시
구현자: Codex / 일자: 2026-08-11

## 받은 지시

아래는 설계 문서 외에 대화로 받은 지시 원문이다.

> 클로드가 현재 세션 리밋이라 직접 지시할게. 현재는 자산이 있어야지만 채팅이 가능한데 기본 올라마 모델과 채팅 할 수 있도록 해줘.

> 기본적으로 올라마채팅을 하고 채팅에서 필요하면 보유 하고 있는 날리지를 찾도록 하는게 어때

> 설정에서 올라마 모델 설정 가능하도록 하고.

> 5173포트로 열어봤는데 안보이네

> 일렉트론 실행 바이너리 외에서도 일단 테스트 하다 추후 바이너리로 확인 할 수 없어?

> 해줘

> 채팅 화면에서 모델을 선택 할 수 있었으면 하고, 현재 체크 버튼과 설명이 너무 장황하게 나와 있는데, 좀 단순화해서 아이콘화 하고 오버 하면 설명이 나온다던지 했으면 좋겠고. 현재 채팅 리스트가 없는데 채팅 리스트 기능도 있어야해 새 채팅, 채팅 리스트 ..등등

> 현재 모델 선택이 상단에 위치해 있는데, 하단 질문 입력 하는곳에 선택된 모델명 이 나오고 있어. 상단에 있는건 빼고 하단 질문입력하는곳 위에 선택된모델 나오는곳에 모델을 바꿀수 있게 하는게 좋을듯

> 클로드 진행하다 끈겼오,작업 지시서 참조 해서 더 진행해

## 무엇이 어떻게 됐나

소스 구현은 커밋 `037c4bd`에 이미 반영되어 있었고, 이번 이어받기에서는 현재 HEAD를
설계 문서 001과 위 직접 지시에 다시 대조해 미완료 코드가 없음을 확인했다. 누락돼 있던
직접 지시 추적만 이 보고서로 보완했다.

| 파일 | 무엇을 | 어느 지시에서 | 신규/수정/삭제 |
|---|---|---|---|
| `electron/ollama-chat.ts` | 설치 모델 확인 후 기본 Ollama 일반 대화 실행·취소 | 자산 없이 기본 Ollama 채팅 | 신규(기존 커밋) |
| `electron/types.ts`, `electron/main.ts`, `electron/preload.ts` | Ollama 채팅 IPC 계약과 Main/Preload 연결 | 기본 Ollama 채팅 | 수정(기존 커밋) |
| `electron/desktop-settings.ts` | 기본 채팅 모델 설정 저장 | 설정에서 모델 설정 | 수정(기존 커밋) |
| `src/screens/SettingsScreen.tsx`, `src/screens/settingsTypes.ts` | 설치된 Ollama 채팅 모델 조회·선택·저장 | 설정에서 모델 설정 | 수정/신규(기존 커밋) |
| `src/browserPreviewBridge.ts` | `?desktop-preview=1` 개발 모드에서 설정·대화 목록을 브라우저에 저장 | Electron 외 테스트 | 신규(기존 커밋) |
| `src/screens/ChatScreen.tsx` | Ollama 기본 대화, 필요 시 Knowledge 검색, 아이콘 툴팁, 새 대화·대화 목록·삭제, 입력창 위 모델 선택 | 채팅 기본 흐름과 후속 UI 지시 전체 | 수정(기존 커밋) |
| `src/runStages.ts`, `src/screens/chatTypes.ts` | Ollama 대화 단계와 메시지 타입 | 기본 Ollama 채팅 | 수정(기존 커밋) |
| `design-briefs/reports/2026-08-11-ollama-chat-followup.md` | 직접 지시 원문과 변경 연결, 재검증 결과 기록 | 중단 작업 이어받기 | 신규 |

## 실행 결과

2026-08-11 이어받기 세션에서 다시 실행했다.

```text
$ pnpm typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.electron.json
(오류 없음, exit code 0)

$ pnpm test
Test Files  30 passed (30)
     Tests  371 passed (371)
Duration  1.24s
```

설계 문서 001의 기준선 349개보다 22개 많고, 이전 검증 수치 371개에서 감소하지 않았다.

## 추가한 테스트

이번 이어받기에서는 소스 변경이 없어 테스트를 새로 추가하지 않았다. 기존 커밋에 다음
회귀 테스트가 존재하며 전부 통과했다.

- `electron/__tests__/ollama-chat.test.ts`: 모델 선택, Embedding 모델 제외, Ollama 대화 요청·오류·취소.
- `src/browserPreviewBridge.test.ts`: 브라우저 설정 검증과 대화 목록 저장.
- `src/screens/settingsTypes.test.ts`: 설치된 채팅 모델 선택 가능 여부.
- `electron/__tests__/connections.test.ts`: 실제 Runtime 주소와 대화 차단/기능 제한 구분.
- `src/runStages.test.ts`: Ollama 전용 실행 단계.

## 눈으로 확인한 결과

현재 실행 중인 렌더러는 5173이 아니라 5174였다. 다음 주소에서 확인했다.

`http://localhost:5174/?desktop-preview=1`

1. 첫 화면이 채팅이며 왼쪽에 `새 대화`와 채팅 목록 영역이 표시됐다.
2. 모델 선택은 상단에 없고 질문 입력창 바로 위에 표시됐다.
3. 설치 모델 목록에서 `qwen2.5-coder:3b`를 선택하고 `현재 선택한 모델 이름만 답해줘.`를 실행했다.
4. 응답이 `Qwen`으로 완료됐고 메시지에 `Ollama 일반 대화 · qwen2.5-coder:3b`가 표시됐다.
5. 완료된 대화가 왼쪽 목록에 제목, 모델, 턴 수와 함께 저장됐다.
6. Knowledge와 허브는 아이콘 토글이며 접근성 트리에 전체 설명 툴팁이 남아 있었다.
7. 허브 토글은 Knowledge가 꺼진 상태에서 비활성이고, 설명에 `로컬 문서 내용은 허브로 전송되지 않습니다`가 유지됐다.
8. Runtime과 Ollama는 정상, MCP만 오류인 상태에서 빨간 차단 대신 `일부 기능 제한`으로 표시됐다.

## 설계와 다른 부분

설계 문서 001은 연결 판정만 다루고, Ollama 기본 채팅·모델 선택·채팅 목록·브라우저
프리뷰는 이후 직접 지시로 추가됐다. D-078 경계는 유지했고, 허브 설명의 아이콘 툴팁
표현은 설계 문서와 `CLAUDE.md`에 기록된 2026-08-11 승인 결정과 일치한다.

## 범위 밖으로 남긴 것

- 5173/5174 포트 불일치는 설계 문서 001 §7에 따라 그대로 남겼다. 이번 실행에서는 5174가 실제 리스닝 포트였다.
- Electron 바이너리가 없는 환경에서의 최종 패키지 검증은 미실행이다. 브라우저 프리뷰로 렌더러·Ollama·대화 목록 경로를 확인했다.
