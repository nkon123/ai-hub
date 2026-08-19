// D-084 "Desktop 로컬 Tool" — main-process-only invocation. Does real
// subprocess/fs work (`node:child_process`/`node:os`/`node:fs`/`node:crypto`)
// so it deliberately stays out of the pure module set (module split rule in
// this app's CLAUDE.md).
//
// This is genuinely unsandboxed local code execution of a file the user
// picked via a native file dialog and explicitly acknowledged is
// unsandboxed (`LocalToolStore.add`'s `acknowledgedRisk` gate) — every
// single call additionally requires a fresh explicit user action in the
// renderer (there is no automated/LLM-driven call path into this file, see
// `electron/__tests__/local-tool-isolation.test.ts`). The timeout and output
// cap below exist ONLY to stop a runaway/hung process from pinning a CPU
// core or filling memory forever — they are not a security boundary and
// must never be described as one (Task Brief 요구사항 3).
//
// Injection-safety property this file preserves: `module_path`/
// `function_name`/`args` are NEVER interpolated into the `-c` script text.
// They are written to the child's stdin as one JSON object; the fixed
// BOOTSTRAP_SCRIPT constant reads that JSON and does the rest. This means a
// module path or argument value containing arbitrary text (including
// something that looks like Python source) can never change what code the
// interpreter runs — only what data it operates on.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalToolInvocationResult } from "./types";

export const LOCAL_TOOL_TIMEOUT_MS = 30_000;
export const LOCAL_TOOL_MAX_OUTPUT_BYTES = 262_144; // 256 KiB

/** Fixed constant string — never built from user input. Reads exactly one
 * JSON object from stdin, loads the target module by absolute path (never
 * `import`s it by name, so it cannot collide with/shadow an installed
 * package), calls the requested function with the given kwargs, and prints
 * exactly one line of JSON to stdout describing the outcome. Every failure
 * mode (import error, missing function, bad args, non-serializable result)
 * is caught and turned into the `{"ok": false, ...}` shape instead of a raw
 * traceback on stderr.
 *
 * Callable unwrapping (실사용 버그 — 'StructuredTool' object is not
 * callable): a Tool/agent framework decorator (e.g. LangChain's `@tool`,
 * which our `@tool`/`@mcp.tool` recognition in `local-tool-signature.ts`
 * also accepts) commonly REPLACES the function object in the module
 * namespace with a wrapper object (a `StructuredTool`, etc.) that isn't
 * directly callable. `getattr(module, function_name)` then returns that
 * wrapper, not the function our static analyzer parsed the signature of.
 * `_resolve_callable` finds the thing to actually call, in order of
 * preference:
 *   1. `target` itself, if it's already callable — no change for the
 *      common case of an undecorated function.
 *   2. `target.func` — LangChain's `StructuredTool` stores the original
 *      plain function here. Preferred over anything else because it is
 *      EXACTLY the function `local-tool-signature.ts` parsed the
 *      `def`/parameter list of, so what we validated and what actually
 *      runs stay the same thing.
 *   3. `target.__wrapped__` (the `functools.wraps` chain) or `target.fn`
 *      (used by a couple of other lightweight tool-decorator libraries) —
 *      same reasoning as `.func`, just a different attribute name.
 *   4. `target.invoke` as an absolute last resort — called (not just
 *      looked up) only in the actual execution step below. This is NOT
 *      preferred because the framework's own `invoke()` does its own
 *      validation/coercion of `args`, which can behave differently from
 *      the exact signature our analyzer verified.
 * Every step here is attribute lookup (`getattr` with a default) and a
 * `callable()`/`hasattr()` check — no user code runs during resolution
 * itself, only when the resolved callable (or `.invoke`) is finally
 * invoked with `args`, exactly as before. If nothing usable is found, this
 * raises `TypeError` naming the actual wrapper type instead of leaving the
 * original opaque "'X' object is not callable" for the caller to puzzle
 * out. */
const BOOTSTRAP_SCRIPT = `
import importlib.util
import json
import sys


def _resolve_callable(target):
    if callable(target):
        return target, None
    for attr in ("func", "__wrapped__", "fn"):
        candidate = getattr(target, attr, None)
        if candidate is not None and callable(candidate):
            return candidate, None
    if hasattr(target, "invoke"):
        return None, "invoke"
    raise TypeError(
        "'" + type(target).__name__ + "' 객체를 호출할 수 없고 "
        ".func/.__wrapped__/.fn/.invoke 도 찾지 못했습니다"
    )


def _main() -> None:
    try:
        raw = sys.stdin.read()
        request = json.loads(raw)
        module_path = request["module_path"]
        function_name = request["function_name"]
        args = request.get("args") or {}

        spec = importlib.util.spec_from_file_location("_desktop_local_tool_target", module_path)
        if spec is None or spec.loader is None:
            raise ImportError(f"module could not be loaded from {module_path!r}")
        module = importlib.util.module_from_spec(spec)
        # 실행 전에 sys.modules 에 등록한다(importlib 공식 권고). 등록하지
        # 않으면 모듈은 정상적으로 실행되지만, 나중에 그 모듈의 객체에서
        # 타입 힌트를 해석하려는 코드가 전부 실패한다 — pydantic /
        # dataclasses / typing.get_type_hints 는 sys.modules[obj.__module__]
        # 를 찾아 그 globals 로 어노테이션을 평가하기 때문이다.
        # 실사용 버그(사내 Windows): LangGraph/LangChain 의 @tool 이 타입
        # 힌트로 pydantic 스키마를 만들면서, Dict 가 파일 안에 분명히
        # import 되어 있는데도 "'Dict' is not defined" 로 죽었다. 원인은
        # import 누락이 아니라 이 등록 누락이었다.
        # 프로세스는 호출 1회당 새로 뜨고 곧 끝나므로 정리하지 않는다.
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)

        target = getattr(module, function_name)
        callable_target, fallback = _resolve_callable(target)
        if fallback == "invoke":
            result = target.invoke(args)
        else:
            result = callable_target(**args)
        try:
            json.dumps(result)
            payload = result
        except TypeError:
            payload = str(result)
        print(json.dumps({"ok": True, "result": payload}))
    except Exception as exc:  # noqa: BLE001 - deliberately catch-all, see module docstring
        print(json.dumps({"ok": False, "error_type": type(exc).__name__, "error_message": str(exc)}))


_main()
`;

export interface LocalToolSpawnRequest {
  interpreterPath: string;
  modulePath: string;
  functionName: string;
  args: Record<string, unknown>;
  /** Overridable only by tests — production call sites always pass the
   * exported constants above. */
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Test-only escape hatch: substitutes a different fixed script for
   * BOOTSTRAP_SCRIPT so tests can exercise spawn/timeout/output-cap behavior
   * with a small throwaway script instead of requiring a real Python
   * install. Production call sites never pass this. */
  scriptOverride?: string;
}

/** The testable core: spawns `interpreterPath -c <script>`, writes the
 * request as JSON to stdin, and classifies the outcome. Parameterized by
 * timeout/output cap so tests can use small values instead of the real
 * 30s/256KiB constants. */
export function runLocalToolProcess(request: LocalToolSpawnRequest): Promise<LocalToolInvocationResult> {
  const timeoutMs = request.timeoutMs ?? LOCAL_TOOL_TIMEOUT_MS;
  const maxOutputBytes = request.maxOutputBytes ?? LOCAL_TOOL_MAX_OUTPUT_BYTES;
  const script = request.scriptOverride ?? BOOTSTRAP_SCRIPT;

  return new Promise((resolve) => {
    let cwd: string;
    try {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-local-tool-"));
    } catch (err) {
      resolve({ outcome: "spawn_error", message: err instanceof Error ? err.message : "임시 작업 디렉터리를 만들지 못했습니다." });
      return;
    }

    const cleanup = () => {
      fs.rmSync(cwd, { recursive: true, force: true });
    };

    let child: ChildProcess;
    try {
      child = spawn(request.interpreterPath, ["-c", script], {
        cwd,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      cleanup();
      resolve({ outcome: "spawn_error", message: err instanceof Error ? err.message : "인터프리터를 실행하지 못했습니다." });
      return;
    }

    let stdout = "";
    let stderr = "";
    let oversized = false;
    let settled = false;

    const finish = (result: LocalToolInvocationResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    child.on("error", (err) => {
      // ENOENT (interpreter path doesn't exist) surfaces here.
      finish({ outcome: "spawn_error", message: err.message });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (oversized) return;
      stdout += chunk.toString("utf-8");
      if (Buffer.byteLength(stdout, "utf-8") > maxOutputBytes) {
        oversized = true;
        child.kill("SIGKILL");
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("close", (code, signal) => {
      if (oversized) {
        finish({ outcome: "oversized_output", limitBytes: maxOutputBytes });
        return;
      }
      // Node's `spawn` `timeout` option sends `killSignal` ("SIGKILL" here)
      // once the timer fires — `child.killed` plus a SIGKILL signal with no
      // explicit exit code is that path's signature.
      if (child.killed && signal === "SIGKILL" && code === null) {
        finish({ outcome: "timeout", timeoutMs });
        return;
      }
      if (code !== 0) {
        finish({ outcome: "nonzero_exit", exitCode: code ?? -1, stderrSnippet: stderr.slice(0, 2000) });
        return;
      }
      const lastLine = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .pop();
      if (!lastLine) {
        finish({ outcome: "nonzero_exit", exitCode: code ?? 0, stderrSnippet: stderr.slice(0, 2000) || "출력이 없습니다." });
        return;
      }
      try {
        const parsed = JSON.parse(lastLine) as { ok: boolean; result?: unknown; error_type?: string; error_message?: string };
        if (parsed.ok) {
          finish({ outcome: "success", result: parsed.result });
        } else {
          finish({
            outcome: "function_error",
            errorType: parsed.error_type ?? "UnknownError",
            errorMessage: parsed.error_message ?? "알 수 없는 오류입니다.",
          });
        }
      } catch {
        finish({ outcome: "nonzero_exit", exitCode: code ?? 0, stderrSnippet: (stderr || stdout).slice(0, 2000) });
      }
    });

    child.stdin?.write(
      JSON.stringify({ module_path: request.modulePath, function_name: request.functionName, args: request.args }),
    );
    child.stdin?.end();
  });
}

export interface InvokeLocalToolTarget {
  interpreterPath: string | null;
  modulePath: string;
  functionName: string;
  args: Record<string, unknown>;
  /** 생략하면 `LOCAL_TOOL_TIMEOUT_MS`(대화형 기본 30초)가 적용된다 — 실사용
   * 제보(2026-08-19) D14 후속: 스케줄 실행 경로(`schedule-local-tool-runner.ts`)만
   * 스케줄에 설정된 값을 넘긴다. 대화형(채팅) 경로는 이 필드를 절대 넘기지
   * 않는다 — 대화형 기본값을 바꾸지 않는다는 판단(자세한 이유는
   * `electron/__tests__/local-tool-runner.test.ts`의 회귀 테스트 참고). */
  timeoutMs?: number;
}

/** Production entry point — checks `interpreterPath` before spawning
 * anything (Task Brief hard requirement 5: never fall back to a bare
 * `python`/`python3` on PATH, and never spawn when unconfigured). */
export async function invokeLocalTool(target: InvokeLocalToolTarget): Promise<LocalToolInvocationResult> {
  if (!target.interpreterPath || !target.interpreterPath.trim()) {
    return { outcome: "interpreter_not_configured" };
  }
  return runLocalToolProcess({
    interpreterPath: target.interpreterPath,
    modulePath: target.modulePath,
    functionName: target.functionName,
    args: target.args,
    timeoutMs: target.timeoutMs,
  });
}
