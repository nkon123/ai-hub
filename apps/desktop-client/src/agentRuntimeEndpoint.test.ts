// D-080 후속 — 렌더러 쪽 agent-runtime 주소 해석 규칙.
//
// 이 모듈이 노출하는 주소는 대화 실행(POST /runs, SSE)과 연결 배너가 **같은
// 값**을 봐야 한다는 요구에서 나왔다. 그래서 여기서 고정하는 것은 세터가
// 동작한다는 사실보다도, 세터가 무엇을 거부하지 않는지와 빈 값이 어디로
// 떨어지는지다 — 빈 문자열이 그대로 통과하면 요청이 `/local/v1/runs`처럼
// host 없는 상대 경로로 나가 조용히 렌더러 자신에게 간다.
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_RUNTIME_BASE_URL,
  getAgentRuntimeBaseUrl,
  setAgentRuntimeBaseUrl,
} from "./agentRuntime";

beforeEach(() => {
  setAgentRuntimeBaseUrl(null);
});

describe("agent-runtime base URL resolution", () => {
  it("starts at the documented default", () => {
    expect(getAgentRuntimeBaseUrl()).toBe(DEFAULT_AGENT_RUNTIME_BASE_URL);
    expect(DEFAULT_AGENT_RUNTIME_BASE_URL).toContain("8100");
  });

  it("applies a saved setting to every later read", () => {
    setAgentRuntimeBaseUrl("http://127.0.0.1:9100");

    expect(getAgentRuntimeBaseUrl()).toBe("http://127.0.0.1:9100");
  });

  it("returns the value it applied, so a caller cannot check a different address", () => {
    // ChatScreen이 연결 검사 대상으로 쓰는 값이 바로 이 반환값이다 — 적용과
    // 검사가 갈라지면 "대화는 되는데 연결 끊김" 오탐이 그대로 돌아온다.
    expect(setAgentRuntimeBaseUrl("http://localhost:9200")).toBe("http://localhost:9200");
    expect(getAgentRuntimeBaseUrl()).toBe("http://localhost:9200");
  });

  it("falls back to the default for blank/absent values instead of building relative URLs", () => {
    setAgentRuntimeBaseUrl("http://127.0.0.1:9100");

    expect(setAgentRuntimeBaseUrl("   ")).toBe(DEFAULT_AGENT_RUNTIME_BASE_URL);
    expect(setAgentRuntimeBaseUrl(undefined)).toBe(DEFAULT_AGENT_RUNTIME_BASE_URL);
    expect(setAgentRuntimeBaseUrl(null)).toBe(DEFAULT_AGENT_RUNTIME_BASE_URL);
  });

  it("trims surrounding whitespace", () => {
    expect(setAgentRuntimeBaseUrl("  http://127.0.0.1:9100  ")).toBe("http://127.0.0.1:9100");
  });
});
