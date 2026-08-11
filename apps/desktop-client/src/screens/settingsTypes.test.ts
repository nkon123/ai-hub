import { describe, expect, it } from "vitest";
import { getChatModelSelectionIssue, getInstalledChatModels } from "./settingsTypes";

describe("getInstalledChatModels", () => {
  it("excludes embedding models from the chat model selector", () => {
    expect(
      getInstalledChatModels({
        ok: true,
        models: ["qwen3-embedding:0.6b", "wcamaralopes/bonsai-27b:latest"],
        error: null,
      }),
    ).toEqual(["wcamaralopes/bonsai-27b:latest"]);
  });
});

describe("getChatModelSelectionIssue", () => {
  it("blocks saving while models are loading or failed to load", () => {
    expect(getChatModelSelectionIssue(true, null, "default-chat")).toContain("확인하는 중");
    expect(getChatModelSelectionIssue(false, { ok: false, models: [], error: "연결 실패" }, "default-chat")).toContain(
      "불러온 뒤",
    );
  });

  it("blocks an alias that is not an installed Ollama model", () => {
    expect(
      getChatModelSelectionIssue(
        false,
        { ok: true, models: ["wcamaralopes/bonsai-27b:latest"], error: null },
        "default-chat",
      ),
    ).toBe("설치된 채팅 모델을 선택하세요.");
  });

  it("allows an installed chat model", () => {
    expect(
      getChatModelSelectionIssue(
        false,
        { ok: true, models: ["wcamaralopes/bonsai-27b:latest"], error: null },
        "wcamaralopes/bonsai-27b:latest",
      ),
    ).toBeNull();
  });
});
