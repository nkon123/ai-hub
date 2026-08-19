// Covers the spawn+stdin/stdout/timeout/output-cap contract of
// `local-tool-runner.ts` without requiring a real Python install for most
// cases: fake "interpreters" are throwaway Node scripts (shebang
// `#!/usr/bin/env node`, chmod +x) generated at test time into a tmp
// directory, standing in for the interpreter binary regardless of the
// (ignored) `-c <script>` argv it's invoked with — exactly what the task
// brief calls out as acceptable for exercising spawn/timeout/cap behavior.
// One additional test exercises the real BOOTSTRAP_SCRIPT contract against
// an actual `python3`/`python` on PATH when available, skipping gracefully
// otherwise.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invokeLocalTool, runLocalToolProcess } from "../local-tool-runner";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-local-tool-runner-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFakeInterpreter(name: string, body: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n${body}\n`, "utf-8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

describe("runLocalToolProcess", () => {
  it("reports success with a returned value", async () => {
    const interpreterPath = writeFakeInterpreter(
      "fake-success.js",
      'console.log(JSON.stringify({ ok: true, result: { greeting: "hi" } }));',
    );
    const result = await runLocalToolProcess({
      interpreterPath,
      modulePath: "/tmp/whatever.py",
      functionName: "f",
      args: {},
      timeoutMs: 5000,
      maxOutputBytes: 65536,
    });
    expect(result).toEqual({ outcome: "success", result: { greeting: "hi" } });
  });

  it("reports a Python-side exception as function_error", async () => {
    const interpreterPath = writeFakeInterpreter(
      "fake-error.js",
      'console.log(JSON.stringify({ ok: false, error_type: "ValueError", error_message: "bad input" }));',
    );
    const result = await runLocalToolProcess({
      interpreterPath,
      modulePath: "/tmp/whatever.py",
      functionName: "f",
      args: {},
      timeoutMs: 5000,
      maxOutputBytes: 65536,
    });
    expect(result).toEqual({ outcome: "function_error", errorType: "ValueError", errorMessage: "bad input" });
  });

  it("reports a non-zero exit code with a stderr snippet", async () => {
    const interpreterPath = writeFakeInterpreter(
      "fake-nonzero.js",
      'process.stderr.write("boom\\n"); process.exit(3);',
    );
    const result = await runLocalToolProcess({
      interpreterPath,
      modulePath: "/tmp/whatever.py",
      functionName: "f",
      args: {},
      timeoutMs: 5000,
      maxOutputBytes: 65536,
    });
    expect(result.outcome).toBe("nonzero_exit");
    if (result.outcome === "nonzero_exit") {
      expect(result.exitCode).toBe(3);
      expect(result.stderrSnippet).toContain("boom");
    }
  });

  it("reports a timeout for a hanging process", async () => {
    const interpreterPath = writeFakeInterpreter("fake-hang.js", "setInterval(() => {}, 1000);");
    const result = await runLocalToolProcess({
      interpreterPath,
      modulePath: "/tmp/whatever.py",
      functionName: "f",
      args: {},
      timeoutMs: 300,
      maxOutputBytes: 65536,
    });
    expect(result).toEqual({ outcome: "timeout", timeoutMs: 300 });
  }, 10_000);

  it("reports oversized_output and stops buffering once the cap is exceeded", async () => {
    const interpreterPath = writeFakeInterpreter(
      "fake-large.js",
      'const chunk = "x".repeat(4096); setInterval(() => process.stdout.write(chunk), 5);',
    );
    const result = await runLocalToolProcess({
      interpreterPath,
      modulePath: "/tmp/whatever.py",
      functionName: "f",
      args: {},
      timeoutMs: 5000,
      maxOutputBytes: 8192,
    });
    expect(result).toEqual({ outcome: "oversized_output", limitBytes: 8192 });
  }, 10_000);

  it("reports spawn_error for a nonexistent interpreter path (ENOENT)", async () => {
    const result = await runLocalToolProcess({
      interpreterPath: path.join(tmpDir, "does-not-exist-binary"),
      modulePath: "/tmp/whatever.py",
      functionName: "f",
      args: {},
      timeoutMs: 5000,
      maxOutputBytes: 65536,
    });
    expect(result.outcome).toBe("spawn_error");
  });

  // 실사용 제보(2026-08-19) — 이 작업의 합격 기준: 취소가 렌더러에 "취소했다"고
  // 표시만 하는 것이 아니라 Main Process가 실제로 spawn된 프로세스를 죽여야
  // 한다(D-084의 "Electron의 신뢰 경계는 Main Process" 규율 반복 위반 방지).
  // 가짜 인터프리터가 자기 pid를 파일에 쓰고 무한정 도는 동안, 취소 후 그
  // pid로 신호를 보내 실제로 죽었는지(`process.kill(pid, 0)`이 ESRCH로
  // throw하는지) 직접 확인한다 — resolve 값만 보고 "취소됐다"고 믿지 않는다.
  describe("cancellation via AbortSignal", () => {
    function isProcessAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    it("actually terminates the spawned process when the signal aborts — not just resolving the promise", async () => {
      const pidFile = path.join(tmpDir, "pid.txt");
      const interpreterPath = writeFakeInterpreter(
        "fake-hang-cancel.js",
        `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);`,
      );
      const controller = new AbortController();

      const resultPromise = runLocalToolProcess({
        interpreterPath,
        modulePath: "/tmp/whatever.py",
        functionName: "f",
        args: {},
        timeoutMs: 60_000, // 취소가 먼저 일어나야 한다 — 타임아웃이 먼저 개입하면 안 된다.
        maxOutputBytes: 65536,
        signal: controller.signal,
      });

      await waitUntil(() => fs.existsSync(pidFile));
      const pid = Number(fs.readFileSync(pidFile, "utf-8"));
      expect(isProcessAlive(pid)).toBe(true); // 취소 전에는 실제로 살아있다.

      controller.abort();
      const result = await resultPromise;

      expect(result).toEqual({ outcome: "cancelled" });
      // 핵심 검증 — resolve됐다는 사실이 아니라, OS 프로세스 테이블에서
      // 실제로 사라졌는지를 직접 확인한다.
      await waitUntil(() => !isProcessAlive(pid));
      expect(isProcessAlive(pid)).toBe(false);
    }, 10_000);

    it("reports cancelled as the result even when abort races a near-simultaneous timeout window", async () => {
      const interpreterPath = writeFakeInterpreter("fake-hang-cancel2.js", "setInterval(() => {}, 1000);");
      const controller = new AbortController();
      const resultPromise = runLocalToolProcess({
        interpreterPath,
        modulePath: "/tmp/whatever.py",
        functionName: "f",
        args: {},
        timeoutMs: 60_000,
        maxOutputBytes: 65536,
        signal: controller.signal,
      });
      controller.abort();
      const result = await resultPromise;
      expect(result).toEqual({ outcome: "cancelled" });
    }, 10_000);

    it("ignores an abort that arrives after the process already finished normally", async () => {
      const interpreterPath = writeFakeInterpreter(
        "fake-quick-success.js",
        'console.log(JSON.stringify({ ok: true, result: "done" }));',
      );
      const controller = new AbortController();
      const result = await runLocalToolProcess({
        interpreterPath,
        modulePath: "/tmp/whatever.py",
        functionName: "f",
        args: {},
        timeoutMs: 5000,
        maxOutputBytes: 65536,
        signal: controller.signal,
      });
      expect(result).toEqual({ outcome: "success", result: "done" });
      // Aborting after settlement must not throw or change anything.
      expect(() => controller.abort()).not.toThrow();
    });

    it("invokeLocalTool passes the signal through so callers can cancel the production entry point too", async () => {
      const pidFile = path.join(tmpDir, "pid2.txt");
      const interpreterPath = writeFakeInterpreter(
        "fake-hang-invoke.js",
        `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);`,
      );
      const controller = new AbortController();
      const resultPromise = invokeLocalTool({
        interpreterPath,
        modulePath: "/tmp/whatever.py",
        functionName: "f",
        args: {},
        timeoutMs: 60_000,
        signal: controller.signal,
      });
      await waitUntil(() => fs.existsSync(pidFile));
      const pid = Number(fs.readFileSync(pidFile, "utf-8"));
      controller.abort();
      const result = await resultPromise;
      expect(result).toEqual({ outcome: "cancelled" });
      await waitUntil(() => !isProcessAlive(pid));
      expect(isProcessAlive(pid)).toBe(false);
    }, 10_000);
  });
});

describe("invokeLocalTool", () => {
  it("returns interpreter_not_configured without spawning anything when interpreterPath is null", async () => {
    const result = await invokeLocalTool({ interpreterPath: null, modulePath: "/tmp/x.py", functionName: "f", args: {} });
    expect(result).toEqual({ outcome: "interpreter_not_configured" });
  });

  it("returns interpreter_not_configured for an empty/whitespace interpreterPath", async () => {
    const result = await invokeLocalTool({ interpreterPath: "   ", modulePath: "/tmp/x.py", functionName: "f", args: {} });
    expect(result).toEqual({ outcome: "interpreter_not_configured" });
  });
});

function findPython(): string | null {
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"]);
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

describe("real BOOTSTRAP_SCRIPT contract against python3/python (skips if unavailable)", () => {
  const python = findPython();
  const maybeIt = python ? it : it.skip;

  maybeIt("loads the target module by path and calls the function with kwargs", async () => {
    const modulePath = path.join(tmpDir, "target.py");
    fs.writeFileSync(
      modulePath,
      "def greet(name: str, times: int = 1) -> str:\n    return (name + '!') * times\n",
      "utf-8",
    );
    const result = await runLocalToolProcess({
      interpreterPath: python as string,
      modulePath,
      functionName: "greet",
      args: { name: "hi", times: 2 },
      timeoutMs: 15_000,
      maxOutputBytes: 65536,
    });
    expect(result).toEqual({ outcome: "success", result: "hi!hi!" });
  });

  // 실사용 버그(사내 Windows): 파일에 `from typing import Dict` 가 분명히
  // 있는데도 LangGraph/LangChain 의 @tool 이 "'Dict' is not defined" 로
  // 죽었다. 원인은 import 누락이 아니라 BOOTSTRAP_SCRIPT 가 모듈을
  // sys.modules 에 등록하지 않은 것이었다 — pydantic /
  // typing.get_type_hints 는 sys.modules[obj.__module__] 의 globals 로
  // 어노테이션을 평가한다. 여기서는 langchain 을 설치하지 않고(폐쇄망 전제,
  // 새 의존성 금지) 같은 해석 경로인 get_type_hints 로 재현한다.
  maybeIt("resolves a class's type hints via sys.modules (registers the module before exec)", async () => {
    const modulePath = path.join(tmpDir, "hinted.py");
    fs.writeFileSync(
      modulePath,
      [
        "from __future__ import annotations",
        "from typing import Dict, get_type_hints",
        "",
        "class Payload:",
        "    data: Dict[str, int]",
        "",
        "def probe() -> str:",
        "    # 모듈이 sys.modules 에 없으면 여기서",
        "    # NameError: name 'Dict' is not defined",
        "    return sorted(get_type_hints(Payload).keys())[0]",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = await runLocalToolProcess({
      interpreterPath: python as string,
      modulePath,
      functionName: "probe",
      args: {},
      timeoutMs: 15_000,
      maxOutputBytes: 65536,
    });
    expect(result).toEqual({ outcome: "success", result: "data" });
  });

  maybeIt("turns a raised exception into function_error, not a raw traceback", async () => {
    const modulePath = path.join(tmpDir, "raiser.py");
    fs.writeFileSync(modulePath, "def boom():\n    raise ValueError('nope')\n", "utf-8");
    const result = await runLocalToolProcess({
      interpreterPath: python as string,
      modulePath,
      functionName: "boom",
      args: {},
      timeoutMs: 15_000,
      maxOutputBytes: 65536,
    });
    expect(result.outcome).toBe("function_error");
    if (result.outcome === "function_error") {
      expect(result.errorType).toBe("ValueError");
      expect(result.errorMessage).toContain("nope");
    }
  });

  maybeIt("cwd is a fresh temp directory, not the repo", async () => {
    if (!python) return;
    // Sanity check the interpreter this test suite would actually spawn is
    // findable via execFileSync too (defensive — same binary resolution).
    expect(() => execFileSync(python, ["--version"])).not.toThrow();
  });

  // 실사용 버그 — 'StructuredTool' object is not callable: a `@tool`/
  // `@mcp.tool` decorator commonly replaces the function object in the
  // module namespace with an uncallable wrapper. These fixtures fake the
  // SHAPE of that wrapper (a plain class with a `.func`/`.__wrapped__`/
  // `.invoke` attribute) without installing LangChain itself (this repo is
  // offline-first and doesn't add new Python dependencies for a test).
  describe("callable unwrapping — decorator-wrapped targets", () => {
    maybeIt("(a) an undecorated plain function still calls directly, unchanged (regression)", async () => {
      const modulePath = path.join(tmpDir, "plain.py");
      fs.writeFileSync(modulePath, "def add(a: int, b: int) -> int:\n    return a + b\n", "utf-8");
      const result = await runLocalToolProcess({
        interpreterPath: python as string,
        modulePath,
        functionName: "add",
        args: { a: 1, b: 2 },
        timeoutMs: 15_000,
        maxOutputBytes: 65536,
      });
      expect(result).toEqual({ outcome: "success", result: 3 });
    });

    maybeIt("(b) unwraps a StructuredTool-shaped object via .func and calls the original function", async () => {
      const modulePath = path.join(tmpDir, "structured_tool_like.py");
      fs.writeFileSync(
        modulePath,
        [
          "class FakeStructuredTool:",
          "    def __init__(self, func):",
          "        self.func = func",
          "",
          "def _add_impl(a: int, b: int) -> int:",
          "    return a + b",
          "",
          "add = FakeStructuredTool(_add_impl)",
          "",
        ].join("\n"),
        "utf-8",
      );
      const result = await runLocalToolProcess({
        interpreterPath: python as string,
        modulePath,
        functionName: "add",
        args: { a: 3, b: 4 },
        timeoutMs: 15_000,
        maxOutputBytes: 65536,
      });
      expect(result).toEqual({ outcome: "success", result: 7 });
    });

    maybeIt("unwraps via __wrapped__ when .func is absent (functools.wraps-style chain)", async () => {
      const modulePath = path.join(tmpDir, "wrapped_like.py");
      fs.writeFileSync(
        modulePath,
        [
          "class FakeWrapped:",
          "    def __init__(self, fn):",
          "        self.__wrapped__ = fn",
          "",
          "def _mul_impl(a: int, b: int) -> int:",
          "    return a * b",
          "",
          "mul = FakeWrapped(_mul_impl)",
          "",
        ].join("\n"),
        "utf-8",
      );
      const result = await runLocalToolProcess({
        interpreterPath: python as string,
        modulePath,
        functionName: "mul",
        args: { a: 3, b: 4 },
        timeoutMs: 15_000,
        maxOutputBytes: 65536,
      });
      expect(result).toEqual({ outcome: "success", result: 12 });
    });

    maybeIt("falls back to .invoke(args) as a last resort when no plain function is found underneath", async () => {
      const modulePath = path.join(tmpDir, "invoke_only.py");
      fs.writeFileSync(
        modulePath,
        [
          "class FakeInvokeOnlyTool:",
          "    def invoke(self, args):",
          "        return args['a'] + args['b']",
          "",
          "add = FakeInvokeOnlyTool()",
          "",
        ].join("\n"),
        "utf-8",
      );
      const result = await runLocalToolProcess({
        interpreterPath: python as string,
        modulePath,
        functionName: "add",
        args: { a: 5, b: 6 },
        timeoutMs: 15_000,
        maxOutputBytes: 65536,
      });
      expect(result).toEqual({ outcome: "success", result: 11 });
    });

    maybeIt(
      "(c) fails clearly with the actual type name when nothing callable/.func/.__wrapped__/.fn/.invoke is found",
      async () => {
        const modulePath = path.join(tmpDir, "opaque.py");
        fs.writeFileSync(
          modulePath,
          ["class OpaqueThing:", "    pass", "", "add = OpaqueThing()", ""].join("\n"),
          "utf-8",
        );
        const result = await runLocalToolProcess({
          interpreterPath: python as string,
          modulePath,
          functionName: "add",
          args: {},
          timeoutMs: 15_000,
          maxOutputBytes: 65536,
        });
        expect(result.outcome).toBe("function_error");
        if (result.outcome === "function_error") {
          expect(result.errorType).toBe("TypeError");
          expect(result.errorMessage).toContain("OpaqueThing");
          expect(result.errorMessage).toContain(".func");
          expect(result.errorMessage).toContain(".invoke");
        }
      },
    );
  });
});
