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
import { describeTimeoutMs, invokeLocalToolForScheduledRun } from "../schedule-local-tool-runner";
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
  // 실사용 제보(2026-08-19) — "등록된 Tool이 없다"와 "모델이 불필요 판단했다"는
  // 둘 다 "Tool을 호출하지 않았다"로 귀결되지만 서로 다른 사실이다 —
  // toolRouteStatus로 구분되어야 한다(no_candidates는 라우팅 호출조차 하지
  // 않으므로 fetch가 필요 없다).
  it("reports toolRouteStatus:'no_candidates' when no local tools are registered — never calls Ollama", async () => {
    const fetchImpl = vi.fn();
    const original = global.fetch;
    global.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const result = await invokeLocalToolForScheduledRun("이번 달 매출 알려줘", [], {
        ollamaBaseUrl: "http://127.0.0.1:11434",
        chatModelAlias: "llama3",
        interpreterPath: null,
      });
      expect(result.ok).toBe(true);
      expect(result.invocation).toBeNull();
      expect(result.toolRouteStatus).toBe("no_candidates");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      global.fetch = original;
    }
  });

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
      // 실사용 제보(2026-08-19) — "모델이 불필요 판단"과 다른 미실행 사유를
      // 구분할 수 있어야 한다: 라우팅 결과 그대로 돌려준다, 뭉개지 않는다.
      expect(result.toolRouteStatus).toBe("declined_by_model");
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
      // Tool은 선택됐다(라우팅은 성공) — 실행 자체가 실패했을 뿐이므로
      // toolRouteStatus는 "ran"이다, "no_candidates" 등으로 뭉개지지 않는다.
      expect(result.toolRouteStatus).toBe("ran");
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

  // 회귀: options.signal 이 타입에만 선언돼 있고 invokeLocalTool 로
  // 전달되지 않아, 스케줄이 로컬 Tool 을 돌리는 중 "지금 실행 중단" 을
  // 눌러도 하위 Python 프로세스가 죽지 않았다. 프로미스 반환값이 아니라
  // 실제 프로세스가 종료됐는지를 본다.
  it("forwards the abort signal so cancelling actually kills the Python subprocess", async () => {
    if (!pythonPath) return; // python3 없는 환경 — 조용히 건너뛴다.

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ollamaResponse({ models: [{ name: "llama3" }] }))
      .mockResolvedValueOnce(
        ollamaResponse({ message: { content: '{"tool_name": "lookup_sales", "input": {"month": "2026-08"}}' } }),
      );
    const original = global.fetch;
    global.fetch = fetchImpl as unknown as typeof fetch;

    const pidPath = path.join(tmpDir, "pid.txt");
    const scriptPath = path.join(tmpDir, "spinner.py");
    fs.writeFileSync(
      scriptPath,
      [
        "import os, time",
        "def run(month):",
        `    open(${JSON.stringify(pidPath)}, 'w').write(str(os.getpid()))`,
        "    time.sleep(600)",
        "    return {}",
        "",
      ].join("\n"),
      "utf-8",
    );

    const controller = new AbortController();
    try {
      const pending = invokeLocalToolForScheduledRun(
        "이번 달 매출 알려줘",
        [makeTool({ filePath: scriptPath })],
        {
          ollamaBaseUrl: "http://127.0.0.1:11434",
          chatModelAlias: "llama3",
          interpreterPath: pythonPath,
          signal: controller.signal,
        },
      );

      // 자식이 실제로 뜰 때까지 기다린다(PID 파일이 생길 때까지).
      const deadline = Date.now() + 20_000;
      while (!fs.existsSync(pidPath) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(fs.existsSync(pidPath)).toBe(true);
      const pid = Number(fs.readFileSync(pidPath, "utf-8").trim());
      expect(() => process.kill(pid, 0)).not.toThrow(); // 살아 있다

      controller.abort();
      await pending;

      // OS 프로세스 테이블을 본다 — 반환값이 아니라.
      await new Promise((r) => setTimeout(r, 200));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      global.fetch = original;
    }
  }, 30_000);

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

  // 실사용 제보(2026-08-19) — 스케줄에 설정된 짧은 타임아웃이 실제로
  // 로컬 Tool 1회 호출에 적용되고, 실패 사유가 사람이 읽는 단위로 남는다.
  it("times out at the schedule-configured timeoutMs (not the interactive 30s default) and reports it in human units", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ollamaResponse({ models: [{ name: "llama3" }] }))
      .mockResolvedValueOnce(
        ollamaResponse({ message: { content: '{"tool_name": "lookup_sales", "input": {"month": "2026-08"}}' } }),
      );
    const original = global.fetch;
    global.fetch = fetchImpl as unknown as typeof fetch;

    // A "Python interpreter" that never returns — spawn's `timeout` option
    // kills it, exactly like local-tool-runner.test.ts's own hanging-process
    // test.
    const hangingInterpreter = path.join(tmpDir, "hang.js");
    fs.writeFileSync(hangingInterpreter, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", "utf-8");
    fs.chmodSync(hangingInterpreter, 0o755);

    try {
      const result = await invokeLocalToolForScheduledRun(
        "이번 달 매출 알려줘",
        [makeTool({ filePath: "/tmp/whatever.py" })],
        {
          ollamaBaseUrl: "http://127.0.0.1:11434",
          chatModelAlias: "llama3",
          interpreterPath: hangingInterpreter,
          timeoutMs: 200,
        },
      );
      expect(result.ok).toBe(false);
      expect(result.failureReason).toContain("Tool 실행 상한");
      expect(result.failureReason).not.toContain("30000ms"); // 원시 ms를 찍지 않는다
    } finally {
      global.fetch = original;
    }
  }, 10_000);
});

describe("describeTimeoutMs", () => {
  it("renders whole minutes without seconds", () => {
    expect(describeTimeoutMs(30 * 60_000)).toBe("30분");
  });
  it("renders sub-minute durations in seconds", () => {
    expect(describeTimeoutMs(200)).toBe("0초"); // rounds to nearest second
    expect(describeTimeoutMs(30_000)).toBe("30초");
  });
});
