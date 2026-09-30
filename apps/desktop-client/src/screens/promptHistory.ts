// 입력창 위/아래 화살표로 이번 세션에 보낸 질문을 다시 불러오는 순수 로직.
// 터미널 셸의 히스토리와 같은 규칙이다 — 화면(ChatScreen)은 키 이벤트를 넘기고
// 결과만 반영하며, 판단은 전부 여기 있어 테스트로 고정된다.
//
// "이번 세션"은 앱을 켠 뒤로 이 PC에서 보낸 질문이다(저장하지 않는다). 저장된
// 대화 복원과 섞지 않는다 — 다른 대화의 문구가 화살표로 튀어나오면 안 된다.

/** 보관할 최대 개수. 오래된 것부터 버린다. */
export const PROMPT_HISTORY_LIMIT = 100;

export interface PromptHistoryCursor {
  /** `null` 이면 히스토리를 탐색 중이 아니다(사용자가 쓰던 글이 입력창에 있다). */
  index: number | null;
  /** 탐색을 시작하기 직전에 입력창에 있던 글 — 아래로 끝까지 내려오면 되돌린다. */
  draft: string;
}

export const IDLE_CURSOR: PromptHistoryCursor = { index: null, draft: "" };

/** 보낸 질문을 히스토리 끝에 붙인다. 빈 글과 바로 앞과 같은 글은 붙이지 않는다. */
export function pushPromptHistory(history: readonly string[], text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed || history[history.length - 1] === trimmed) return [...history];
  const next = [...history, trimmed];
  return next.length > PROMPT_HISTORY_LIMIT ? next.slice(next.length - PROMPT_HISTORY_LIMIT) : next;
}

export interface HistoryKeyContext {
  history: readonly string[];
  /** 입력창의 현재 글. */
  current: string;
  /** 커서가 첫 줄에 있는가(위 화살표가 히스토리로 가도 되는 조건). */
  caretOnFirstLine: boolean;
  /** 커서가 마지막 줄에 있는가(아래 화살표가 히스토리로 가도 되는 조건). */
  caretOnLastLine: boolean;
}

export interface HistoryStep {
  cursor: PromptHistoryCursor;
  /** 입력창에 넣을 글. */
  text: string;
}

/**
 * 위/아래 화살표 한 번의 결과. 히스토리가 처리하지 않을 키면 `null` 이다 — 그때는
 * 화살표가 원래 동작(여러 줄 글 안에서 커서 이동)을 해야 한다.
 */
export function stepPromptHistory(
  cursor: PromptHistoryCursor,
  key: "ArrowUp" | "ArrowDown",
  ctx: HistoryKeyContext,
): HistoryStep | null {
  const { history } = ctx;
  if (key === "ArrowUp") {
    if (history.length === 0 || !ctx.caretOnFirstLine) return null;
    if (cursor.index === null) {
      const index = history.length - 1;
      return { cursor: { index, draft: ctx.current }, text: history[index] };
    }
    const index = Math.max(0, cursor.index - 1);
    return { cursor: { index, draft: cursor.draft }, text: history[index] };
  }
  // ArrowDown
  if (cursor.index === null || !ctx.caretOnLastLine) return null;
  if (cursor.index >= history.length - 1) {
    return { cursor: IDLE_CURSOR, text: cursor.draft };
  }
  const index = cursor.index + 1;
  return { cursor: { index, draft: cursor.draft }, text: history[index] };
}

/** 커서(selectionStart)가 첫 줄/마지막 줄에 있는지. */
export function caretLinePosition(value: string, caret: number): { first: boolean; last: boolean } {
  return {
    first: !value.slice(0, caret).includes("\n"),
    last: !value.slice(caret).includes("\n"),
  };
}
