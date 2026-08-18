// Desktop Client PR2 — 대화 -> Agent 초안을 Portal에 DRAFT로 등록하는
// 오케스트레이션(`agent-draft-upload.ts`). 네트워크 없이 `createAsset`을
// 주입해 세 요구를 고정한다: Portal 미설정이면 아예 시도하지 않는다, Agent
// 성공+Prompt 실패 같은 부분 실패를 뭉개지 않는다, 두 호출이 서로 독립적
// (하나의 실패가 다른 하나의 시도를 막지 않는다).
import { describe, expect, it, vi } from "vitest";
import { uploadAgentDraft } from "../agent-draft-upload";
import type { AgentDraftUploadDeps } from "../agent-draft-upload";
import type { AgentDraftUploadInput } from "../types";

const INPUT: AgentDraftUploadInput = {
  agentManifest: { type: "agent", id: "a1", name: "테스트 Agent" },
  promptManifest: { type: "prompt", id: "p1", name: "테스트 Prompt" },
  templateContent: "# 시스템 프롬프트",
};

describe("uploadAgentDraft", () => {
  it("Portal이 설정되지 않았으면 createAsset을 한 번도 부르지 않고 attempted:false를 반환한다", async () => {
    const createAsset = vi.fn();
    const result = await uploadAgentDraft(
      { baseUrl: null, token: null },
      INPUT,
      "template.md",
      { createAsset } satisfies AgentDraftUploadDeps,
    );
    expect(result).toEqual({
      attempted: false,
      notConfiguredReason: "Portal 서버 주소와 식별 Token을 먼저 설정하세요.",
      agent: null,
      prompt: null,
    });
    expect(createAsset).not.toHaveBeenCalled();
  });

  it("baseUrl만 있고 token이 없어도 시도하지 않는다(둘 다 있어야 한다)", async () => {
    const createAsset = vi.fn();
    const result = await uploadAgentDraft(
      { baseUrl: "http://127.0.0.1:8003", token: null },
      INPUT,
      "template.md",
      { createAsset },
    );
    expect(result.attempted).toBe(false);
    expect(createAsset).not.toHaveBeenCalled();
  });

  it("Agent만 성공하고 Prompt가 실패하면 부분 성공을 그대로 보고한다(성공한 쪽 식별자 포함)", async () => {
    const createAsset = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { id: "v-agent", assetId: "a1", version: "0.1.0", status: "DRAFT" } })
      .mockResolvedValueOnce({
        ok: false,
        code: "ASSET_UPLOAD_FILE_TOO_LARGE",
        message: "'template.md' 파일 크기가 허용된 최대치를 초과했습니다.",
      });

    const result = await uploadAgentDraft(
      { baseUrl: "http://127.0.0.1:8003", token: "dev-user-token" },
      INPUT,
      "template.md",
      { createAsset },
    );

    expect(result.attempted).toBe(true);
    expect(result.agent).toEqual({
      ok: true,
      assetId: "a1",
      versionId: "v-agent",
      version: "0.1.0",
      errorCode: null,
      errorMessage: null,
      validationErrors: null,
    });
    expect(result.prompt).toEqual({
      ok: false,
      assetId: null,
      versionId: null,
      version: null,
      errorCode: "ASSET_UPLOAD_FILE_TOO_LARGE",
      errorMessage: "'template.md' 파일 크기가 허용된 최대치를 초과했습니다.",
      validationErrors: null,
    });
    // 두 번 호출됐다는 것 자체가 "하나의 실패가 다른 하나의 시도를 막지
    // 않는다"의 증거 — Prompt 호출은 Agent 결과와 무관하게 일어났다.
    expect(createAsset).toHaveBeenCalledTimes(2);
  });

  it("Agent가 실패해도 Prompt 시도를 막지 않는다(순서를 바꿔도 독립적)", async () => {
    const createAsset = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: "VALIDATION_ERROR", message: "Manifest가 스키마를 충족하지 않습니다.", details: { errors: ["'workflow' is a required property"] } })
      .mockResolvedValueOnce({ ok: true, data: { id: "v-prompt", assetId: "p1", version: "0.1.0", status: "DRAFT" } });

    const result = await uploadAgentDraft(
      { baseUrl: "http://127.0.0.1:8003", token: "dev-user-token" },
      INPUT,
      "template.md",
      { createAsset },
    );

    expect(result.agent?.ok).toBe(false);
    expect(result.agent?.errorCode).toBe("VALIDATION_ERROR");
    expect(result.agent?.validationErrors).toEqual(["'workflow' is a required property"]);
    expect(result.prompt).toEqual({
      ok: true,
      assetId: "p1",
      versionId: "v-prompt",
      version: "0.1.0",
      errorCode: null,
      errorMessage: null,
      validationErrors: null,
    });
  });

  it("Prompt 매니페스트에는 template.md 파일이 첨부되고 Agent 매니페스트에는 첨부 파일이 없다", async () => {
    const createAsset = vi.fn().mockResolvedValue({ ok: true, data: { id: "v1", assetId: "a1", version: "0.1.0", status: "DRAFT" } });

    await uploadAgentDraft({ baseUrl: "http://127.0.0.1:8003", token: "dev-user-token" }, INPUT, "template.md", {
      createAsset,
    });

    const [agentCall, promptCall] = createAsset.mock.calls;
    expect(agentCall[2]).toEqual(INPUT.agentManifest);
    expect(agentCall[3]).toEqual([]);
    expect(promptCall[2]).toEqual(INPUT.promptManifest);
    expect(promptCall[3]).toEqual([{ filename: "template.md", content: INPUT.templateContent }]);
  });

  it("전달된 externalSignal을 두 createAsset 호출 모두에 그대로 넘긴다(취소가 두 요청 모두에 적용되도록)", async () => {
    const createAsset = vi.fn().mockResolvedValue({ ok: true, data: { id: "v1", assetId: "a1", version: "0.1.0", status: "DRAFT" } });
    const controller = new AbortController();

    await uploadAgentDraft(
      { baseUrl: "http://127.0.0.1:8003", token: "dev-user-token" },
      INPUT,
      "template.md",
      { createAsset },
      controller.signal,
    );

    expect(createAsset.mock.calls[0][4]).toBe(controller.signal);
    expect(createAsset.mock.calls[1][4]).toBe(controller.signal);
  });

  it("두 자산 모두 성공하면 attempted:true와 두 ok:true 결과를 반환한다", async () => {
    const createAsset = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { id: "v-agent", assetId: "a1", version: "0.1.0", status: "DRAFT" } })
      .mockResolvedValueOnce({ ok: true, data: { id: "v-prompt", assetId: "p1", version: "0.1.0", status: "DRAFT" } });

    const result = await uploadAgentDraft(
      { baseUrl: "http://127.0.0.1:8003", token: "dev-user-token" },
      INPUT,
      "template.md",
      { createAsset },
    );

    expect(result.attempted).toBe(true);
    expect(result.agent?.ok).toBe(true);
    expect(result.prompt?.ok).toBe(true);
    // 두 자산 모두 DRAFT 상태로만 생성된다 — 다른 상태를 만들거나 승인
    // API를 호출하는 코드는 이 파일에 없다(`createAsset`이 유일한 호출).
    expect(createAsset).toHaveBeenCalledTimes(2);
  });
});
