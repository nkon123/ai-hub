import { describe, expect, it } from "vitest";
import { mergePendingIntoThread, shouldShowPendingItem } from "./chatThreadMerge";

describe("shouldShowPendingItem", () => {
  it("returns false when there is no pending item", () => {
    expect(shouldShowPendingItem(null, [])).toBe(false);
  });

  // 요구 A — 질문이 라우팅 전에 스레드에 들어간다: 아직 어떤 최종 항목도
  // 만들어지지 않았다면 placeholder가 유일한 표시 수단이므로 반드시 보여야
  // 한다.
  it("shows the placeholder while no final entry for this turn exists yet", () => {
    const pending = { id: "turn-1", ts: "2026-08-20T00:00:00.000Z" };
    expect(shouldShowPendingItem(pending, [])).toBe(true);
    expect(shouldShowPendingItem(pending, [{ id: "turn-2" }])).toBe(true);
  });

  // 요구 B — 질문이 두 번 그려지지 않는다: 로컬 라우팅이 끝나
  // LocalToolAutoRouteEntry가 같은 id로 만들어지면 placeholder는 내려가야
  // 한다.
  it("hides the placeholder once the local-tool auto-route entry for this turn exists", () => {
    const pending = { id: "turn-1", ts: "2026-08-20T00:00:00.000Z" };
    expect(shouldShowPendingItem(pending, [{ id: "turn-1" }])).toBe(false);
  });

  // 요구 B — MCP로 판정되거나 아무것도 고르지 않아 일반 ChatMessage로
  // 이어진 경우도 동일하게 hides.
  it("hides the placeholder once the normal ChatMessage for this turn exists (mcp/none outcome)", () => {
    const pending = { id: "turn-1", ts: "2026-08-20T00:00:00.000Z" };
    expect(shouldShowPendingItem(pending, [{ id: "turn-1" }])).toBe(false);
  });

  // 요구 E — 라우팅 실패·취소에도 질문은 남는다: 최종 항목이 실패/취소
  // 상태여도(이 함수는 상태를 전혀 보지 않는다 — id만 본다) placeholder는
  // 여전히 내려가고, 질문은 최종 항목 쪽 말풍선에 남는다.
  it("does not care about the resolved entry's status — presence of the id is enough", () => {
    const pending = { id: "turn-1", ts: "2026-08-20T00:00:00.000Z" };
    // 최종 항목이 danger/failed/cancelled 상태라도 이 함수 관점에서는 같은
    // "id가 이미 존재한다"는 사실만 본다.
    expect(shouldShowPendingItem(pending, [{ id: "turn-1" }])).toBe(false);
  });
});

describe("mergePendingIntoThread", () => {
  it("includes the pending item when no entries exist yet, sorted with real entries", () => {
    const pending = { id: "turn-1", ts: "2026-08-20T00:00:01.000Z" };
    const result = mergePendingIntoThread<{ id: string; ts: string }>([], pending);
    expect(result).toEqual([{ kind: "pending", ts: pending.ts, id: "turn-1" }]);
  });

  it("places the pending item chronologically among existing entries", () => {
    const earlier = { id: "turn-0", ts: "2026-08-20T00:00:00.000Z" };
    const pending = { id: "turn-1", ts: "2026-08-20T00:00:02.000Z" };
    const result = mergePendingIntoThread([earlier], pending);
    expect(result.map((r) => (r.kind === "pending" ? r.id : r.entry.id))).toEqual(["turn-0", "turn-1"]);
  });

  // 회귀 방지 핵심 — 같은 턴의 최종 항목이 이미 있으면 placeholder를
  // 완전히 빼서 같은 질문이 두 번(placeholder 말풍선 + 최종 항목 말풍선)
  // 그려지지 않게 한다.
  it("never emits both a pending item and its resolved entry for the same turn", () => {
    const resolved = { id: "turn-1", ts: "2026-08-20T00:00:00.000Z" };
    const pending = { id: "turn-1", ts: "2026-08-20T00:00:00.000Z" };
    const result = mergePendingIntoThread([resolved], pending);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "entry", ts: resolved.ts, entry: resolved });
  });

  it("keeps unrelated pending/resolved turns both visible", () => {
    const resolvedOtherTurn = { id: "turn-1", ts: "2026-08-20T00:00:00.000Z" };
    const pending = { id: "turn-2", ts: "2026-08-20T00:00:01.000Z" };
    const result = mergePendingIntoThread([resolvedOtherTurn], pending);
    expect(result).toHaveLength(2);
  });
});
