import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_APP_ORIGIN,
  RuntimeSupervisor,
  findBundledRuntime,
  planRuntimeLaunch,
  restartDelayMs,
  runtimeSettingsChanged,
  type BundledRuntime,
  type RuntimeLaunchInput,
} from "../runtime-supervisor";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "runtime-supervisor-"));
}

function fakeBundle(): { resources: string; runtime: BundledRuntime } {
  const resources = tempDir();
  const pythonDir = path.join(resources, "runtime", "python");
  fs.mkdirSync(pythonDir, { recursive: true });
  fs.writeFileSync(path.join(pythonDir, "python.exe"), "");
  fs.writeFileSync(path.join(resources, "runtime", "runtime-manifest.json"), JSON.stringify({ commit_sha: "abc123" }));
  return { resources, runtime: { runtimeDir: path.join(resources, "runtime"), pythonExe: path.join(pythonDir, "python.exe"), commitSha: "abc123" } };
}

function input(overrides: Partial<RuntimeLaunchInput> = {}): RuntimeLaunchInput {
  return {
    runtime: fakeBundle().runtime,
    agentRuntimeBaseUrl: "http://127.0.0.1:8100",
    ollamaBaseUrl: "http://127.0.0.1:11434/",
    stateDir: tempDir(),
    mcpServerInstallRoot: path.join(tempDir(), "assets", "mcp-servers"),
    chatModelId: "gemma4:latest",
    appVersion: "0.1.1",
    ...overrides,
  };
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

describe("findBundledRuntime", () => {
  it("finds python.exe and the manifest commit under <resources>/runtime", () => {
    const { resources, runtime } = fakeBundle();
    expect(findBundledRuntime(resources)).toEqual(runtime);
  });

  it("is null in dev (no resourcesPath) and when the bundle is absent", () => {
    expect(findBundledRuntime(undefined)).toBeNull();
    expect(findBundledRuntime(tempDir())).toBeNull();
  });
});

describe("planRuntimeLaunch", () => {
  it("listens on the saved address's port, isolated from the user's Python, with state outside Program Files", () => {
    const i = input({ agentRuntimeBaseUrl: "http://127.0.0.1:9100" });
    const result = planRuntimeLaunch(i);
    if (!result.ok) throw new Error(result.message);
    const { plan } = result;
    expect(plan.command).toBe(i.runtime.pythonExe);
    expect(plan.args.slice(0, 3)).toEqual(["-E", "-s", "-B"]);
    expect(plan.args).toEqual(expect.arrayContaining(["agent_runtime.main:app", "--host", "127.0.0.1", "--port", "9100"]));
    expect(plan.healthUrl).toBe("http://127.0.0.1:9100/health");
    for (const key of ["AGENT_RUNTIME_MCP_TOOL_REGISTRY_PATH", "AGENT_RUNTIME_LOCAL_AGENT_REGISTRY_PATH", "AIHUB_OLLAMA_CONFIG"]) {
      expect(plan.env[key].startsWith(i.stateDir)).toBe(true);
    }
    expect(plan.env.AGENT_RUNTIME_COMMIT_SHA).toBe("abc123");
    expect(plan.env.AGENT_RUNTIME_BUILD_VERSION).toBe("0.1.1");
  });

  it("allows only the packaged renderer's origin — never null (D-104)", () => {
    const result = planRuntimeLaunch(input());
    if (!result.ok) throw new Error(result.message);
    expect(JSON.parse(result.plan.env.AGENT_RUNTIME_CORS_ORIGINS)).toEqual([DESKTOP_APP_ORIGIN]);
  });

  it("turns on stdio MCP servers, bounded to the install root and the bundled interpreter (D-094, option B)", () => {
    const i = input();
    const result = planRuntimeLaunch(i);
    if (!result.ok) throw new Error(result.message);
    const env = result.plan.env;
    expect(env.AGENT_RUNTIME_RUNTIME_MODE).toBe("local");
    expect(env.AGENT_RUNTIME_MCP_SERVER_REGISTRATION_ENABLED).toBe("true");
    // JSON array: survives Windows backslashes and the Korean product folder name.
    expect(JSON.parse(env.AGENT_RUNTIME_MCP_SERVER_INSTALL_ROOTS)).toEqual([i.mcpServerInstallRoot]);
    expect(env.AGENT_RUNTIME_MCP_PYTHON_INTERPRETER_PATH).toBe(i.runtime.pythonExe);
    expect(env.AGENT_RUNTIME_MCP_NODE_INTERPRETER_PATH).toBeUndefined();
  });

  it("hands the runtime the chat model the Desktop uses, under the env name the runtime actually reads", () => {
    const withModel = planRuntimeLaunch(input());
    if (!withModel.ok) throw new Error(withModel.message);
    expect(withModel.plan.env.AGENT_RUNTIME_CHAT_MODEL_ID_OVERRIDE).toBe("gemma4:latest");
    for (const empty of [null, "", "  "]) {
      const without = planRuntimeLaunch(input({ chatModelId: empty }));
      if (!without.ok) throw new Error(without.message);
      expect(without.plan.env).not.toHaveProperty("AGENT_RUNTIME_CHAT_MODEL_ID_OVERRIDE");
    }
  });

  it("knows which settings need a runtime restart", () => {
    const base = { agentRuntimeBaseUrl: "http://127.0.0.1:8100", ollamaBaseUrl: "http://127.0.0.1:11434", chatModelAlias: "gemma4:latest" };
    expect(runtimeSettingsChanged(base, { ...base })).toBe(false);
    expect(runtimeSettingsChanged(base, { ...base, chatModelAlias: "qwen3:8b" })).toBe(true);
    expect(runtimeSettingsChanged(base, { ...base, ollamaBaseUrl: "http://127.0.0.1:11435" })).toBe(true);
    expect(runtimeSettingsChanged(base, { ...base, agentRuntimeBaseUrl: "http://127.0.0.1:9100" })).toBe(true);
  });

  it("hands the runtime the Desktop's own Ollama setting, in the form ollama_config.py accepts", () => {
    const result = planRuntimeLaunch(input({ ollamaBaseUrl: " http://127.0.0.1:11434// " }));
    if (!result.ok) throw new Error(result.message);
    expect(result.plan.ollamaConfig).toEqual({ endpoint: "http://127.0.0.1:11434" });
  });

  it("refuses to start for an address that is not this PC, or not a URL", () => {
    expect(planRuntimeLaunch(input({ agentRuntimeBaseUrl: "http://10.0.0.5:8100" }))).toMatchObject({ ok: false, reason: "not_loopback" });
    expect(planRuntimeLaunch(input({ agentRuntimeBaseUrl: "https://127.0.0.1:8100" }))).toMatchObject({ ok: false, reason: "not_loopback" });
    expect(planRuntimeLaunch(input({ agentRuntimeBaseUrl: "not a url" }))).toMatchObject({ ok: false, reason: "invalid_url" });
  });
});

describe("restartDelayMs", () => {
  it("backs off 1-2-4-8-16s, then gives up", () => {
    expect([0, 1, 2, 3, 4].map(restartDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(restartDelayMs(5)).toBeNull();
  });
});

describe("RuntimeSupervisor", () => {
  function harness(healthSequence: boolean[] | ((call: number) => boolean), i = input()) {
    const children: FakeChild[] = [];
    const killed: FakeChild[] = [];
    const spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    let healthCalls = 0;
    let clock = 0;
    const supervisor = new RuntimeSupervisor(i, silentLogger, {
      spawn: (command, args, options) => {
        const child = new FakeChild();
        children.push(child);
        spawned.push({ command, args, env: options.env });
        return child as unknown as ChildProcess;
      },
      isHealthy: async () => {
        const call = healthCalls++;
        return typeof healthSequence === "function" ? healthSequence(call) : (healthSequence[call] ?? false);
      },
      sleep: async (ms) => {
        clock += ms;
      },
      killTree: (child) => killed.push(child as unknown as FakeChild),
      now: () => clock,
      platformEnv: { PATH: "x" },
    });
    return { supervisor, children, killed, spawned, input: i, advance: (ms: number) => (clock += ms) };
  }

  it("is disabled without a bundle and never spawns", async () => {
    let spawned = false;
    const supervisor = new RuntimeSupervisor(null, silentLogger, {
      spawn: () => {
        spawned = true;
        throw new Error("unreachable");
      },
    });
    expect((await supervisor.start()).state).toBe("disabled");
    expect(spawned).toBe(false);
  });

  it("adopts a runtime that already answers instead of starting a second one", async () => {
    const h = harness([true]);
    expect((await h.supervisor.start()).state).toBe("external");
    expect(h.spawned).toHaveLength(0);
    h.supervisor.stop();
    expect(h.killed).toHaveLength(0); // not ours to kill
  });

  it("starts the bundle, writes the Ollama config, and reports running once /health answers", async () => {
    const h = harness([false, false, false, true]);
    const status = await h.supervisor.start();
    expect(status.state).toBe("running");
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].env.PATH).toBe("x");
    expect(h.spawned[0].env.AGENT_RUNTIME_CORS_ORIGINS).toBe(JSON.stringify([DESKTOP_APP_ORIGIN]));
    const ollamaConfig = JSON.parse(fs.readFileSync(h.spawned[0].env.AIHUB_OLLAMA_CONFIG!, "utf-8"));
    expect(ollamaConfig).toEqual({ endpoint: "http://127.0.0.1:11434" });
    expect(status.logPath).toBe(path.join(h.input.stateDir, "logs", "agent-runtime.log"));
    expect(fs.existsSync(status.logPath!)).toBe(true);
  });

  it("restarts after a crash, and stops trying after five quick crashes", async () => {
    const h = harness((call) => call === 1); // healthy only right after the first launch
    expect((await h.supervisor.start()).state).toBe("running");
    for (let crash = 0; crash < 6; crash += 1) {
      h.children[h.children.length - 1].exit(1);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(h.spawned).toHaveLength(6); // first launch + 5 restarts
    expect(h.supervisor.getStatus().state).toBe("failed");
  });

  it("gives a runtime that stayed up a fresh restart budget", async () => {
    const h = harness(() => true);
    // Adopt check says "not running" once, then everything is healthy.
    let first = true;
    const supervisor = new RuntimeSupervisor(h.input, silentLogger, {
      spawn: () => {
        const child = new FakeChild();
        h.children.push(child);
        return child as unknown as ChildProcess;
      },
      isHealthy: async () => {
        if (first) {
          first = false;
          return false;
        }
        return true;
      },
      sleep: async () => {},
      killTree: () => {},
      now: () => clockValue,
    });
    let clockValue = 0;
    await supervisor.start();
    for (let crash = 0; crash < 8; crash += 1) {
      clockValue += 120_000; // each run lasted two minutes
      h.children[h.children.length - 1].exit(1);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(supervisor.getStatus().state).not.toBe("failed");
  });

  it("restartWith relaunches the runtime it owns with the new settings", async () => {
    // Healthy exactly while a spawned process is alive (spawned but not killed).
    let h!: ReturnType<typeof harness>;
    h = harness(() => h.spawned.length > h.killed.length);
    expect((await h.supervisor.start()).state).toBe("running");
    expect((await h.supervisor.restartWith(input({ chatModelId: "qwen3:8b" }))).state).toBe("running");
    expect(h.killed).toEqual([h.children[0]]);
    expect(h.spawned).toHaveLength(2);
    expect(h.spawned[1].env.AGENT_RUNTIME_CHAT_MODEL_ID_OVERRIDE).toBe("qwen3:8b");
  });

  it("restartWith leaves an adopted runtime alone", async () => {
    const h = harness(() => true);
    expect((await h.supervisor.start()).state).toBe("external");
    expect((await h.supervisor.restartWith(input({ chatModelId: "qwen3:8b" }))).state).toBe("external");
    expect(h.spawned).toHaveLength(0);
    expect(h.killed).toHaveLength(0);
  });

  it("kills the process tree it started on stop, and does not restart it", async () => {
    const h = harness([false, true]);
    await h.supervisor.start();
    const child = h.children[0];
    h.supervisor.stop();
    expect(h.killed).toEqual([child]);
    child.exit(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.spawned).toHaveLength(1);
    expect(h.supervisor.getStatus().state).toBe("stopped");
  });

  it("never throws out of start(), even if spawning itself fails", async () => {
    const supervisor = new RuntimeSupervisor(input(), silentLogger, {
      spawn: () => {
        throw new Error("EPERM (blocked by application control)");
      },
      isHealthy: async () => false,
      sleep: async () => {},
    });
    const status = await supervisor.start();
    expect(status.state).toBe("failed");
    expect(status.message).toContain("EPERM");
  });
});
