import { describe, expect, it } from "vitest";
import {
  SCOPE_AUTO,
  SCOPE_OFF,
  describeScope,
  describeScopeBadge,
  isServerSelectable,
  isToolSelected,
  scopeFromToolNames,
  scopeToRunParams,
  serverSelectionState,
  toggleServer,
  toggleTool,
  type McpServerOption,
} from "./mcpToolScopeTypes";

const hello: McpServerOption = {
  serverAlias: "hello-mcp",
  toolNames: ["hello.echo", "hello.now"],
  state: "ACTIVE",
};
const oracle: McpServerOption = {
  serverAlias: "oracle-connector",
  toolNames: ["db_metadata.get_tables"],
  state: "ACTIVE",
};
const broken: McpServerOption = {
  serverAlias: "broken-mcp",
  toolNames: ["broken.tool"],
  state: "UNREACHABLE",
  reason: "handshake_failed",
};

describe("isServerSelectable", () => {
  it("ACTIVE 이고 도구가 있을 때만 고를 수 있다", () => {
    expect(isServerSelectable(hello)).toBe(true);
    expect(isServerSelectable(broken)).toBe(false);
    expect(isServerSelectable({ ...hello, toolNames: [] })).toBe(false);
  });
});

describe("toggleServer", () => {
  it("서버를 누르면 그 서버의 도구 전체가 켜진다", () => {
    const scope = toggleServer(SCOPE_OFF, hello);
    expect(serverSelectionState(scope, hello)).toBe("all");
    expect(isToolSelected(scope, "hello.echo")).toBe(true);
  });

  it("전부 켜진 서버를 다시 누르면 그 서버만 꺼지고 다른 서버는 남는다", () => {
    const both = toggleServer(toggleServer(SCOPE_OFF, hello), oracle);
    const afterOff = toggleServer(both, hello);
    expect(serverSelectionState(afterOff, hello)).toBe("none");
    expect(serverSelectionState(afterOff, oracle)).toBe("all");
  });

  it("일부만 켜진 서버를 누르면 전부 켜진다(끄지 않는다)", () => {
    const partial = toggleTool(SCOPE_OFF, "hello.echo");
    expect(serverSelectionState(partial, hello)).toBe("partial");
    const afterServerClick = toggleServer(partial, hello);
    expect(serverSelectionState(afterServerClick, hello)).toBe("all");
  });

  it("고를 수 없는 서버는 아무 일도 하지 않는다", () => {
    expect(toggleServer(SCOPE_OFF, broken)).toBe(SCOPE_OFF);
  });
});

describe("toggleTool", () => {
  it("도구를 켜고 끈다", () => {
    const on = toggleTool(SCOPE_OFF, "hello.now");
    expect(isToolSelected(on, "hello.now")).toBe(true);
    expect(toggleTool(on, "hello.now").kind).toBe("off");
  });

  it("자동 상태에서 도구를 건드리면 그 도구만 고른 상태가 된다", () => {
    const scope = toggleTool(SCOPE_AUTO, "hello.echo");
    expect(scope).toEqual({ kind: "selected", toolNames: ["hello.echo"] });
  });

  it("같은 도구를 두 번 넣어도 중복되지 않는다", () => {
    expect(scopeFromToolNames(["a", "a", " ", "b"])).toEqual({
      kind: "selected",
      toolNames: ["a", "b"],
    });
  });
});

describe("scopeToRunParams", () => {
  it("아무것도 고르지 않으면 라우팅 자체를 켜지 않는다", () => {
    expect(scopeToRunParams(SCOPE_OFF)).toEqual({ toolRoute: false });
  });

  it("자동은 후보 목록을 보내지 않는다 — 생략이 '후보 전체'다", () => {
    const params = scopeToRunParams(SCOPE_AUTO);
    expect(params.toolRoute).toBe(true);
    expect(params.mcpToolNames).toBeUndefined();
  });

  it("고른 도구는 그대로 보낸다", () => {
    expect(scopeToRunParams(scopeFromToolNames(["hello.now"]))).toEqual({
      toolRoute: true,
      mcpToolNames: ["hello.now"],
    });
  });

  it("빈 배열을 만들지 않는다 — 서버에서 '후보 없음'이라는 다른 뜻이다", () => {
    const params = scopeToRunParams(scopeFromToolNames([]));
    expect(params).toEqual({ toolRoute: false });
    expect(params.mcpToolNames).toBeUndefined();
  });
});

describe("describeScopeBadge", () => {
  it("고른 것이 없으면 아무것도 붙이지 않는다", () => {
    expect(describeScopeBadge(SCOPE_OFF, [hello])).toBeNull();
  });

  it("자동은 '자동'", () => {
    expect(describeScopeBadge(SCOPE_AUTO, [hello])).toBe("자동");
  });

  it("서버 하나를 통째로 골랐으면 서버 이름을 보여준다", () => {
    expect(describeScopeBadge(toggleServer(SCOPE_OFF, hello), [hello, oracle])).toBe("hello-mcp");
  });

  it("여러 서버에 걸쳐 고르면 개수로 보여준다", () => {
    const scope = toggleServer(toggleServer(SCOPE_OFF, hello), oracle);
    expect(describeScopeBadge(scope, [hello, oracle])).toBe("도구 3개");
  });
});

describe("describeScope", () => {
  it("자동일 때 쓸 수 있는 서버가 없으면 그렇다고 말한다", () => {
    expect(describeScope(SCOPE_AUTO, [broken])).toContain("쓸 수 있는 MCP 서버가 없습니다");
  });

  it("자동일 때 후보 개수를 센다 — 고를 수 없는 서버는 빼고", () => {
    expect(describeScope(SCOPE_AUTO, [hello, oracle, broken])).toContain("서버 2개의 도구 3개");
  });

  it("고른 도구가 지금 연결된 서버에 없으면 빠진다고 말한다", () => {
    const scope = scopeFromToolNames(["hello.echo", "사라진.도구"]);
    const text = describeScope(scope, [hello]);
    expect(text).toContain("사라진.도구");
    expect(text).toContain("빠집니다");
  });

  it("전부 연결돼 있으면 빠진다는 말을 덧붙이지 않는다", () => {
    expect(describeScope(scopeFromToolNames(["hello.echo"]), [hello])).not.toContain("빠집니다");
  });
});
