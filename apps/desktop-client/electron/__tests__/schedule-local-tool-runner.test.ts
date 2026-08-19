// D14 F — proves the scheduled local-tool path never touches
// `dialog.showMessageBox` or `LocalToolStore.approval`: `main.ts` is never
// imported by this test, and `invokeLocalToolForScheduledRun` is exercised
// directly against a fake Ollama endpoint + a real (throwaway) Python
// interpreter script, exactly like `local-tool-runner.test.ts` already does
// for the interactive path, without any approval/dialog machinery at all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeLocalToolForScheduledRun } from "../schedule-local-tool-runner";
import type { LocalTool } from "../types";

function makeTool(overrides: Partial<LocalTool> = {}): LocalTool {
  return {
    id: "tool-1",
    filePath: "/tmp/does-not-matter.py",
    functionName: "run",
    toolName: "lookup_sales",
    inputSchema: { type: "object", properties: { month: { type: "string" } }, required: ["month"], additionalProperties: false },
    parameters: [],
    discarded: { bodyStatementCount: 1, decoratorCount: 0, docstringPresent: false, sourceExecuted: false, sourcePersisted: false },
    warnings: [],
    addedAt: new Date().toISOString(),
    riskAcknowledgedAt: new Date().toISOString(),
    approval: null,
    ...overrides,
  };
}

function ollamaResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

describe("invokeLocalToolForScheduledRun", () => {
  it("reports 'no tool called' (ok:true, invocation:null) when the model declines — never a failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ollamaResponse({ models: [{ name: "llama3" }] }))
      .mockResolvedValueOnce(ollamaResponse({ message: { content: '{"tool_name": null, "input": null}' } }));
    // routeLocalToolCall uses global fetch by default — inject via
    // ollamaBaseUrl + monkeypatch global fetch for this test only.
    const original = global.fetch;
    global.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const result = await invokeLocalToolForScheduledRun("이번 달 매출 알려줘", [makeTool()], {
        ollamaBaseUrl: "http://127.0.0.1:11434",
        chatModelAlias: "llama3",
        interpreterPath: null,
      });
      expect(result.ok).toBe(true);
      expect(result.invocation).toBeNull();
    } finally {
      global.fetch = original;
    }
  });

  it("returns a failure with no invocation when the interpreter isn't configured, even though a tool was selected", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ollamaResponse({ models: [{ name: "llama3" }] }))
      .mockResolvedValueOnce(
        ollamaResponse({ message: { content: '{"tool_name": "lookup_sales", "input": {"month": "2026-08"}}' } }),
      );
    const original = global.fetch;
    global.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const result = await invokeLocalToolForScheduledRun("이번 달 매출 알려줘", [makeTool()], {
        ollamaBaseUrl: "http://127.0.0.1:11434",
        chatModelAlias: "llama3",
        interpreterPath: null, // not configured
      });
      expect(result.ok).toBe(false);
      expect(result.invocation).toEqual({ toolName: "lookup_sales", args: { month: "2026-08" } });
      expect(result.failureReason).toContain("인터프리터");
    } finally {
      global.fetch = original;
    }
  });
});

describe("invokeLocalToolForScheduledRun — actually runs the tool end-to-end with a real interpreter", () => {
  let tmpDir: string;
  let pythonPath: string | null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-local-tool-"));
    // Reuse whatever python3 the host has, same as local-tool-runner.test.ts's
    // convention of skipping cleanly when unavailable rather than failing.
    pythonPath = process.env.PYTHON_BIN ?? "/usr/bin/python3";
    if (!fs.existsSync(pythonPath)) pythonPath = null;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs the selected tool without any approval dialog and reports success", async () => {
    if (!pythonPath) return; // environment has no python3 — skip, do not fail the suite.

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ollamaResponse({ models: [{ name: "llama3" }] }))
      .mockResolvedValueOnce(
        ollamaResponse({ message: { content: '{"tool_name": "lookup_sales", "input": {"month": "2026-08"}}' } }),
      );
    const original = global.fetch;
    global.fetch = fetchImpl as unknown as typeof fetch;

    const scriptPath = path.join(tmpDir, "tool.py");
    fs.writeFileSync(scriptPath, "def run(month):\n    return {'month': month, 'total': 123}\n", "utf-8");

    try {
      const result = await invokeLocalToolForScheduledRun(
        "이번 달 매출 알려줘",
        [makeTool({ filePath: scriptPath })],
        { ollamaBaseUrl: "http://127.0.0.1:11434", chatModelAlias: "llama3", interpreterPath: pythonPath },
      );
      expect(result.ok).toBe(true);
      expect(result.invocation).toEqual({ toolName: "lookup_sales", args: { month: "2026-08" } });
      expect(result.resultSummary).toContain("123");
    } finally {
      global.fetch = original;
    }
  }, 15_000);
});
