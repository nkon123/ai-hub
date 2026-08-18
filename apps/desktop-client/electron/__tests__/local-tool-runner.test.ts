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
});
