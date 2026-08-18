# 구현 보고 001 — 채팅 화면 연결 판정 오탐 수정

설계 문서: [`../001-connection-detection.md`](../001-connection-detection.md)
구현자: Codex / 일자: 2026-08-11
## 실행 결과

2026-08-11에 아래 명령을 실행했다.

```text
$ pnpm typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.electron.json
(오류 없음, exit code 0)

$ pnpm test
Test Files  27 passed (27)
     Tests  353 passed (353)
Duration  4.95s
```

기준선 349개에서 테스트 4개가 추가됐으며 기존 테스트 파일 수 27개는 유지됐다.

## 추가한 테스트

`electron/__tests__/connections.test.ts`에 다음을 추가했다.

1. `runtimeBaseUrl`로 8102를 넘기면 `/health` 요청이 8102로 가고 기본값 8100으로는 가지 않는지 검증.
2. Local Agent Runtime 장애를 `blocked`로 판정하는지 검증.
3. MCP 단독 장애를 `limited`로 판정하고 대화 필수 장애 목록은 비어 있는지 검증.
4. 세 서비스가 정상이면 `healthy`로 판정하는지 검증.

## 눈으로 확인한 결과

브라우저 렌더러에서 §6.3을 확인했다.

1. `.env.local`의 실제 대화 주소 `http://127.0.0.1:8102`를 연결 검사에도 사용했다. Local Agent Runtime은 정상으로 표시됐고, Knowledge ID `d9e660b7-ca76-4f46-899e-2e1621bac139`로 `장비 지원은 무엇이 있나요?`를 질문해 답변과 `remote-work-policy · 장비 지원` 로컬 Citation이 출력되는 것을 확인했다.
2. 브라우저 CORS로 Office MCP Server 검사만 실패한 상태에서 빨간 대화 장애 대신 노란 `일부 기능 제한` 배지와 `Knowledge 대화는 정상 동작합니다` 안내가 표시됐고, 위 Knowledge 대화가 끝까지 완료됐다.
3. 사용자 설정 파일을 수정하지 않고 프로세스 환경으로 죽은 포트 `8199`를 주입한 임시 렌더러를 실행했다. 빨간 `대화 연결 문제` 배지와 대화 제한 배너, 실제 검사 주소 `http://127.0.0.1:8199`, 복구 안내, `설정 > 연결 상태` 안내가 모두 표시됐다.
4. `허브에도 물어보기` 토글이 새 세션에서 기본 꺼짐이고 로컬 문서 내용은 전송하지 않는다는 설명이 유지됨을 확인했다. 완료된 답변 Citation에 `로컬` 배지가 표시됐다.

## 설계와 다른 부분

없음. 필수 서비스와 선택 기능 판정은 `electron/connections.ts`의 `assessChatConnections` 한 곳에 모았고, ChatScreen은 판정 결과만 표시한다. 필수 서비스와 MCP가 동시에 실패하면 빨간 대화 장애와 노란 기능 제한을 각각 표시해 두 복구 범위를 구분한다.

## 범위 밖으로 남긴 것

§7에 명시된 5173/5174 불일치, eslint 설정 부재, 외부 서비스 CORS 설정은 변경하지 않았다.

