// 실사용 제보(2026-08-20) — "채팅에서 엔터를 누르면 대화창에 안 올라가고,
// 조금 있다가 올라가면서 결과가 나온다". 원인: `ChatScreen.tsx`의
// `handleSend`가 로컬 Tool/MCP Tool 통합 자동 라우팅(`handleLocalToolAutoRoute`
// — 로컬 Ollama 호출, 상한 20초)이 끝난 뒤에야 질문을 스레드에 올렸다. 이
// 파일은 그 수정의 핵심 불변식 — "질문은 전송 즉시 스레드에 올라가고, 절대
// 두 번 그려지지 않는다" — 을 순수 함수로 뽑아 단위 테스트한다
// (`vitest.config.ts`가 `environment: "node"`라 `ChatScreen.tsx`의 실제
// 렌더링은 테스트할 수 없다 — CLAUDE.md 검증 섹션 참고).
//
// 설계(질문 말풍선 소유자를 하나로 만들기): 전송 시점에는 이번 턴이
// 로컬/MCP/일반 대화 중 어디로 끝날지 아직 모른다(라우팅이 비동기). 그래서
// `handleSend`는 라우팅을 시작하기 전에 먼저 `PendingThreadItem`(질문
// 말풍선 + "확인 중" 표시만 있는 placeholder)을 만들어 스레드에 넣는다.
// 라우팅이 끝나면 정확히 하나의 최종 항목 —
//   - "local": `LocalToolAutoRouteEntry`(localToolRouteEntries)
//   - "mcp"/"none": `ChatMessage`(messages)
// — 이 **같은 id**로 만들어지고, placeholder는 그 순간 사라진다. 두 최종
// 항목 타입 중 어느 쪽도 다른 쪽을 모르게 하기 위해(D-084 구조적 격리 —
// `chatTypes.ts`는 local-tool 식별자를 전혀 참조할 수 없다,
// `local-tool-isolation.test.ts` 참고) 이 파일은 최종 항목의 실제 타입을
// 전혀 모른다 — `{ id, ts }` 모양만 있으면 된다(제네릭).
export interface PendingThreadItem {
  id: string;
  ts: string;
}

export interface ThreadEntryRef {
  id: string;
}

/** placeholder가 여전히 그려져야 하는지 결정한다. 이번 턴의 최종 항목이
 * (같은 id로) 이미 만들어졌다면 그 최종 항목이 스스로 질문 말풍선을 그리므로
 * placeholder는 더 이상 필요 없다 — 계속 그리면 질문이 두 번 보인다. 최종
 * 항목의 상태(성공/실패/취소)는 이 판단과 무관하다: 라우팅이 실패하거나
 * 사용자가 취소해도 최종 항목 자체는 여전히 만들어져 있으므로(질문이
 * 스레드에서 사라지지 않는다는 요구, Task Brief E) placeholder만 내려간다. */
export function shouldShowPendingItem(
  pending: PendingThreadItem | null,
  resolvedEntries: readonly ThreadEntryRef[],
): pending is PendingThreadItem {
  if (!pending) return false;
  return !resolvedEntries.some((entry) => entry.id === pending.id);
}

export type MergedThreadItem<T> = { kind: "pending"; ts: string; id: string } | { kind: "entry"; ts: string; entry: T };

/** 실제 스레드 항목들(이미 `{id, ts}`를 가진 임의 타입)과 placeholder를
 * 시간순으로 합친다. placeholder는 `shouldShowPendingItem`이 참일 때만
 * 포함된다 — 그래서 이 함수 하나만 통과하면 "라우팅 전에 올라간다"와 "두 번
 * 그려지지 않는다"를 함께 보장한다. */
export function mergePendingIntoThread<T extends ThreadEntryRef & { ts: string }>(
  entries: readonly T[],
  pending: PendingThreadItem | null,
): Array<MergedThreadItem<T>> {
  const items: Array<MergedThreadItem<T>> = entries.map((entry) => ({
    kind: "entry" as const,
    ts: entry.ts,
    entry,
  }));
  if (shouldShowPendingItem(pending, entries)) {
    items.push({ kind: "pending", ts: pending.ts, id: pending.id });
  }
  return items.sort((a, b) => a.ts.localeCompare(b.ts));
}
