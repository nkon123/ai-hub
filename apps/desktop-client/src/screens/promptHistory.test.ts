import { describe, expect, it } from "vitest";
import {
  IDLE_CURSOR,
  PROMPT_HISTORY_LIMIT,
  caretLinePosition,
  pushPromptHistory,
  stepPromptHistory,
} from "./promptHistory";

const ctx = (history: string[], current = "", first = true, last = true) => ({
  history,
  current,
  caretOnFirstLine: first,
  caretOnLastLine: last,
});

describe("pushPromptHistory", () => {
  it("appends trimmed text and ignores blank input", () => {
    expect(pushPromptHistory([], "  안녕  ")).toEqual(["안녕"]);
    expect(pushPromptHistory(["a"], "   ")).toEqual(["a"]);
  });

  it("does not repeat the same question twice in a row, but allows it later", () => {
    expect(pushPromptHistory(["a"], "a")).toEqual(["a"]);
    expect(pushPromptHistory(["a", "b"], "a")).toEqual(["a", "b", "a"]);
  });

  it("keeps only the newest entries past the limit", () => {
    const full = Array.from({ length: PROMPT_HISTORY_LIMIT }, (_, i) => `q${i}`);
    const next = pushPromptHistory(full, "new");
    expect(next).toHaveLength(PROMPT_HISTORY_LIMIT);
    expect(next[0]).toBe("q1");
    expect(next[next.length - 1]).toBe("new");
  });
});

describe("stepPromptHistory", () => {
  const history = ["첫째", "둘째", "셋째"];

  it("ArrowUp starts at the newest and remembers what was being typed", () => {
    const step = stepPromptHistory(IDLE_CURSOR, "ArrowUp", ctx(history, "쓰던 글"));
    expect(step?.text).toBe("셋째");
    expect(step?.cursor).toEqual({ index: 2, draft: "쓰던 글" });
  });

  it("ArrowUp keeps walking back and stops at the oldest", () => {
    let cursor = IDLE_CURSOR;
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const step = stepPromptHistory(cursor, "ArrowUp", ctx(history));
      if (!step) break;
      cursor = step.cursor;
      seen.push(step.text);
    }
    expect(seen).toEqual(["셋째", "둘째", "첫째", "첫째", "첫째"]);
  });

  it("ArrowDown walks forward and finally restores the draft", () => {
    let step = stepPromptHistory(IDLE_CURSOR, "ArrowUp", ctx(history, "초안"))!;
    step = stepPromptHistory(step.cursor, "ArrowUp", ctx(history))!; // 둘째
    const down1 = stepPromptHistory(step.cursor, "ArrowDown", ctx(history))!;
    expect(down1.text).toBe("셋째");
    const down2 = stepPromptHistory(down1.cursor, "ArrowDown", ctx(history))!;
    expect(down2.text).toBe("초안");
    expect(down2.cursor).toEqual(IDLE_CURSOR);
  });

  it("does nothing when there is no history or when not browsing on ArrowDown", () => {
    expect(stepPromptHistory(IDLE_CURSOR, "ArrowUp", ctx([]))).toBeNull();
    expect(stepPromptHistory(IDLE_CURSOR, "ArrowDown", ctx(history))).toBeNull();
  });

  it("leaves arrows alone while the caret is inside a multi-line draft", () => {
    expect(stepPromptHistory(IDLE_CURSOR, "ArrowUp", ctx(history, "a\nb", false, true))).toBeNull();
    const browsing = { index: 1, draft: "" };
    expect(stepPromptHistory(browsing, "ArrowDown", ctx(history, "a\nb", true, false))).toBeNull();
  });
});

describe("caretLinePosition", () => {
  it("reports first/last line from the caret", () => {
    expect(caretLinePosition("abc", 1)).toEqual({ first: true, last: true });
    expect(caretLinePosition("a\nb\nc", 0)).toEqual({ first: true, last: false });
    expect(caretLinePosition("a\nb\nc", 3)).toEqual({ first: false, last: false });
    expect(caretLinePosition("a\nb\nc", 5)).toEqual({ first: false, last: true });
  });
});
