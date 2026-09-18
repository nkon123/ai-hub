import { describe, expect, it } from "vitest";
import {
  buildActiveChips,
  itemAvailability,
  type ComposerMenuState,
} from "./composerMenuTypes";

function state(overrides: Partial<ComposerMenuState> = {}): ComposerMenuState {
  return {
    running: false,
    knowledge: { on: false, usable: true, loading: false, count: 3 },
    hub: { on: false, applicable: true },
    toolAuto: { on: false, hasCandidates: true, applicable: true, blockedReason: null },
    mcp: { badge: null, selectable: true, blockedReason: null },
    prompt: { available: true },
    localTool: { available: true },
    ...overrides,
  };
}

describe("itemAvailability", () => {
  it("실행 중에는 전부 비활성이고 이유를 말한다", () => {
    const running = state({ running: true });
    for (const key of ["knowledge", "hub", "toolAuto", "mcp", "prompt", "localTool"] as const) {
      const availability = itemAvailability(key, running);
      expect(availability.disabled).toBe(true);
      expect(availability.reason).toBeTruthy();
    }
  });

  it("Knowledge 확인 중과 하나도 없음을 구분한다 — 확인 중에 '없다'고 하면 안 된다", () => {
    const loading = itemAvailability(
      "knowledge",
      state({ knowledge: { on: false, usable: false, loading: true, count: 0 } }),
    );
    const empty = itemAvailability(
      "knowledge",
      state({ knowledge: { on: false, usable: false, loading: false, count: 0 } }),
    );
    expect(loading.reason).toContain("확인하는 중");
    expect(empty.reason).toContain("없습니다");
    expect(loading.reason).not.toBe(empty.reason);
  });

  it("허브는 지식 검색이 꺼져 있으면 비활성 + 무엇을 먼저 켜야 하는지 말한다", () => {
    const availability = itemAvailability("hub", state({ hub: { on: false, applicable: false } }));
    expect(availability.disabled).toBe(true);
    expect(availability.reason).toContain("보유 Knowledge에서 찾기를 먼저");
  });

  it("Tool 자동은 후보가 없으면 항목 자체를 그리지 않는다", () => {
    const availability = itemAvailability(
      "toolAuto",
      state({ toolAuto: { on: false, hasCandidates: false, applicable: false, blockedReason: null } }),
    );
    expect(availability.hidden).toBe(true);
  });

  it("MCP 범위는 막힌 이유를 그대로 전달한다(자체 문구를 지어내지 않는다)", () => {
    const availability = itemAvailability(
      "mcp",
      state({ mcp: { badge: null, selectable: false, blockedReason: "Local Agent 선택 중입니다." } }),
    );
    expect(availability.reason).toBe("Local Agent 선택 중입니다.");
  });

  it("브라우저 개발 모드에서는 프롬프트/로컬 Tool 이 비활성이고 이유가 붙는다", () => {
    const browser = state({ prompt: { available: false }, localTool: { available: false } });
    expect(itemAvailability("prompt", browser).reason).toContain("Desktop 앱");
    expect(itemAvailability("localTool", browser).reason).toContain("Desktop 앱");
  });

  it("정상 상태에는 사유를 만들지 않는다", () => {
    expect(itemAvailability("knowledge", state()).reason).toBeNull();
    expect(itemAvailability("mcp", state()).reason).toBeNull();
  });
});

describe("buildActiveChips", () => {
  it("아무것도 안 켜져 있으면 칩이 없다", () => {
    expect(buildActiveChips(state())).toEqual([]);
  });

  it("켜진 것만 칩으로 남는다 — 메뉴를 열지 않아도 보인다", () => {
    const chips = buildActiveChips(
      state({
        knowledge: { on: true, usable: true, loading: false, count: 3 },
        hub: { on: true, applicable: true },
        mcp: { badge: "hello-mcp", selectable: true, blockedReason: null },
      }),
    );
    expect(chips.map((c) => c.key)).toEqual(["knowledge", "hub", "mcp"]);
    expect(chips[0].label).toBe("지식 3개");
    expect(chips[2].label).toBe("MCP · hello-mcp");
  });

  it("Tool 자동은 후보가 있을 때만 칩이 된다 — 켤 수 없는 상태를 켜진 것처럼 보여주지 않는다", () => {
    const chips = buildActiveChips(
      state({ toolAuto: { on: true, hasCandidates: false, applicable: false, blockedReason: null } }),
    );
    expect(chips).toEqual([]);
  });

  it("개수를 모르면 숫자를 지어내지 않는다", () => {
    const chips = buildActiveChips(
      state({ knowledge: { on: true, usable: true, loading: false, count: 0 } }),
    );
    expect(chips[0].label).toBe("지식");
  });
});
