// D-047 A — starts and watches the Local Agent Runtime that the Windows
// installer ships under <resources>/runtime/ (built by
// scripts/build-python-runtime.mjs). Rules: docs/implementation-spec/
// 11-desktop-packaging-and-distribution.md §6.1.3.
//
// No Electron import: `main.ts` passes `process.resourcesPath`, the install
// root's `stateDir`, and the saved settings in, so every decision here is
// unit-tested with a fake spawn/health/timer (`__tests__/runtime-supervisor.test.ts`).
//
// CLAUDE.md: "Desktop은 Runtime 장애 시 종료되지 않고 복구 안내를 제공한다."
// Nothing in this module throws past `start()`/`stop()`; the worst outcome is
// state "failed" with the log path, and D09 keeps showing the runtime as
// unreachable exactly as before this module existed.

import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_CHAT_MODEL_ALIAS, selectOllamaChatModel } from "./ollama-chat";
import { DESKTOP_APP_ORIGIN } from "./renderer-protocol";

/** The packaged renderer's origin (D-104, `renderer-protocol.ts`) is the only
 * one the bundled runtime allows: it is used only by this PC's Desktop — not
 * Portal Web — and never `null` (any web page can produce `Origin: null` via
 * a sandboxed iframe). */
export { DESKTOP_APP_ORIGIN };

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const HEALTH_TIMEOUT_MS = 2_000;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 500;
/** A runtime that stayed up this long gets a fresh restart budget, so one
 * crash a day never adds up to "failed" while a crash loop still does. */
const STABLE_RUN_MS = 60_000;

export interface BundledRuntime {
  runtimeDir: string;
  pythonExe: string;
  /** `runtime-manifest.json`'s `commit_sha`, or "unknown". */
  commitSha: string;
}

/** The runtime bundle, if this install carries one. `undefined`
 * resourcesPath (dev / Vitest) or a missing python.exe both mean "no
 * bundle" — dev keeps using the runtime started by scripts/windows. */
export function findBundledRuntime(resourcesPath: string | undefined): BundledRuntime | null {
  if (!resourcesPath) return null;
  const runtimeDir = path.join(resourcesPath, "runtime");
  const pythonExe = path.join(runtimeDir, "python", "python.exe");
  if (!fs.existsSync(pythonExe)) return null;
  let commitSha = "unknown";
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, "runtime-manifest.json"), "utf-8")) as { commit_sha?: unknown };
    if (typeof manifest.commit_sha === "string" && manifest.commit_sha) commitSha = manifest.commit_sha;
  } catch {
    // A bundle without a manifest still runs; /health just reports "unknown".
  }
  return { runtimeDir, pythonExe, commitSha };
}

export interface RuntimeLaunchInput {
  runtime: BundledRuntime;
  /** Saved `agentRuntimeBaseUrl` — the port to listen on comes from here. */
  agentRuntimeBaseUrl: string;
  /** Saved `ollamaBaseUrl` — handed to the runtime so Desktop and runtime
   * never look at two different Ollama servers. */
  ollamaBaseUrl: string;
  stateDir: string;
  /** `<assetsDir>/mcp-servers` — where Bundle/Store installs put MCP server
   * code (`ASSET_TYPE_FOLDER.mcp_server`). The only place the bundled runtime
   * may start stdio servers from. */
  mcpServerInstallRoot: string;
  /** Saved `chatModelAlias` — the model the chat screen shows. Without it the
   * runtime falls back to office-profile.json's `default-chat` model
   * (exaone3.5:7.8b), which a PC may not have: every runtime turn, including
   * MCP tool routing, then fails with "model not installed" while plain
   * Ollama chat (which uses this setting) works (2026-09-29 report). */
  chatModelId: string | null;
  appVersion: string;
}

/** The Ollama model the runtime should chat with: the same rule plain Ollama
 * chat uses (`selectOllamaChatModel` — the saved model if installed, else the
 * first installed chat model). The saved `chatModelAlias` defaults to the
 * alias name "default-chat", not a model, and the chat screen only *displays*
 * its fallback without saving it — passing the raw setting sent the runtime a
 * model that does not exist (0.1.5, 2026-09-29 report). `installed` is null
 * when Ollama could not be listed: then only a concrete saved model is passed,
 * and otherwise the runtime keeps its own office-profile default. */
export function resolveRuntimeChatModel(preferred: string, installed: readonly string[] | null): string | null {
  const saved = preferred.trim();
  if (installed === null) return saved && saved !== DEFAULT_CHAT_MODEL_ALIAS ? saved : null;
  return selectOllamaChatModel(installed, saved);
}

/** Settings that are baked into the runtime process at start. A change to
 * any of them needs a restart to take effect. */
export function runtimeSettingsChanged(
  before: { agentRuntimeBaseUrl: string; ollamaBaseUrl: string; chatModelAlias: string },
  after: { agentRuntimeBaseUrl: string; ollamaBaseUrl: string; chatModelAlias: string },
): boolean {
  return (
    before.agentRuntimeBaseUrl !== after.agentRuntimeBaseUrl ||
    before.ollamaBaseUrl !== after.ollamaBaseUrl ||
    before.chatModelAlias !== after.chatModelAlias
  );
}

export interface RuntimeLaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  healthUrl: string;
  logPath: string;
  ollamaConfigPath: string;
  ollamaConfig: { endpoint: string };
}

export type RuntimeLaunchPlanResult =
  | { ok: true; plan: RuntimeLaunchPlan }
  | { ok: false; reason: "invalid_url" | "not_loopback"; message: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function planRuntimeLaunch(input: RuntimeLaunchInput): RuntimeLaunchPlanResult {
  let url: URL;
  try {
    url = new URL(input.agentRuntimeBaseUrl);
  } catch {
    return { ok: false, reason: "invalid_url", message: `agent-runtime 주소가 올바르지 않습니다: ${input.agentRuntimeBaseUrl}` };
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      reason: "not_loopback",
      message: `agent-runtime 주소(${input.agentRuntimeBaseUrl})가 이 PC가 아니어서 동봉된 Runtime을 띄우지 않습니다.`,
    };
  }
  const port = url.port || "80";
  const runtimeStateDir = path.join(input.stateDir, "agent-runtime");
  const ollamaConfigPath = path.join(runtimeStateDir, "ollama.json");
  return {
    ok: true,
    plan: {
      command: input.runtime.pythonExe,
      // -E -s: ignore PYTHON* env and the user's site-packages; -B: never try
      // to write __pycache__ under Program Files (§6.1.3).
      args: ["-E", "-s", "-B", "-X", "utf8", "-m", "uvicorn", "agent_runtime.main:app", "--host", "127.0.0.1", "--port", port],
      env: {
        AGENT_RUNTIME_CORS_ORIGINS: JSON.stringify([DESKTOP_APP_ORIGIN]),
        AGENT_RUNTIME_MCP_TOOL_REGISTRY_PATH: path.join(runtimeStateDir, "mcp-tool-registry.json"),
        AGENT_RUNTIME_LOCAL_AGENT_REGISTRY_PATH: path.join(runtimeStateDir, "local-agent-registry.json"),
        AGENT_RUNTIME_BUILD_VERSION: input.appVersion,
        AGENT_RUNTIME_COMMIT_SHA: input.runtime.commitSha,
        AIHUB_OLLAMA_CONFIG: ollamaConfigPath,
        // D-094 stdio MCP servers, on by default in the installer (user
        // decision 2026-09-29, 11-desktop-packaging §6.1.7): Portal approval
        // is the control point, and an MCP server installed from the hub runs
        // on this PC without per-PC admin setup. Still bounded by D-094's
        // other layers — only code under the install root, only the bundled
        // interpreter (it already carries the MCP SDK), never PATH lookup.
        AGENT_RUNTIME_RUNTIME_MODE: "local",
        AGENT_RUNTIME_MCP_SERVER_REGISTRATION_ENABLED: "true",
        AGENT_RUNTIME_MCP_SERVER_INSTALL_ROOTS: JSON.stringify([input.mcpServerInstallRoot]),
        AGENT_RUNTIME_MCP_PYTHON_INTERPRETER_PATH: input.runtime.pythonExe,
        // `chat_model_id_override` field -> this exact name (env_prefix +
        // field name). The docs long said AGENT_RUNTIME_CHAT_MODEL_ID, which
        // older runtimes silently ignore; this name works in every version.
        ...(input.chatModelId?.trim() ? { AGENT_RUNTIME_CHAT_MODEL_ID_OVERRIDE: input.chatModelId.trim() } : {}),
        // The first Tool routing call after idle includes loading the model
        // into Ollama (exaone3.5:7.8b took longer than the runtime's 8s default
        // on a dev PC), so it failed closed as "no tool" every first time. On
        // a single-user PC waiting for the load beats silently skipping the tool.
        AGENT_RUNTIME_TOOL_ROUTE_TIMEOUT_SECONDS: "30",
      },
      healthUrl: `${url.origin}/health`,
      logPath: path.join(input.stateDir, "logs", "agent-runtime.log"),
      ollamaConfigPath,
      ollamaConfig: { endpoint: input.ollamaBaseUrl.trim().replace(/\/+$/, "") },
    },
  };
}

/** Delay before restart attempt `attempt` (0-based), or null once exhausted. */
export function restartDelayMs(attempt: number): number | null {
  return attempt < RESTART_DELAYS_MS.length ? RESTART_DELAYS_MS[attempt] : null;
}

export type RuntimeSupervisorState =
  | "disabled" // no bundle in this install (dev), or the address is not this PC
  | "external" // something already answers at the address; we did not start it
  | "starting"
  | "running"
  | "restarting"
  | "failed"
  | "stopped";

export interface RuntimeSupervisorStatus {
  state: RuntimeSupervisorState;
  message: string;
  logPath: string | null;
}

export interface SupervisorLogger {
  info(module: string, message: string): void;
  warn(module: string, message: string): void;
  error(module: string, message: string): void;
}

export interface RuntimeSupervisorDeps {
  spawn?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ["ignore", number, number]; windowsHide: boolean; cwd: string }) => ChildProcess;
  isHealthy?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  killTree?: (child: ChildProcess) => void;
  now?: () => number;
  platformEnv?: NodeJS.ProcessEnv;
}

const LOG_MODULE = "agent-runtime-supervisor";

async function defaultIsHealthy(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function defaultKillTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    // /T takes the stdio MCP servers the runtime started along with it.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill();
  }
}

function openLogFd(logPath: string): number {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  try {
    if (fs.statSync(logPath).size > MAX_LOG_BYTES) fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // no log yet
  }
  return fs.openSync(logPath, "a");
}

export class RuntimeSupervisor {
  private readonly spawnImpl: NonNullable<RuntimeSupervisorDeps["spawn"]>;
  private readonly isHealthy: (url: string) => Promise<boolean>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly killTree: (child: ChildProcess) => void;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private runningSince: number | null = null;
  private child: ChildProcess | null = null;
  private plan: RuntimeLaunchPlan | null = null;
  private stopping = false;
  private restartAttempt = 0;
  private status: RuntimeSupervisorStatus = { state: "stopped", message: "", logPath: null };

  constructor(
    private input: RuntimeLaunchInput | null,
    private readonly logger: SupervisorLogger,
    deps: RuntimeSupervisorDeps = {},
  ) {
    this.spawnImpl = deps.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
    this.isHealthy = deps.isHealthy ?? defaultIsHealthy;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.killTree = deps.killTree ?? defaultKillTree;
    this.baseEnv = deps.platformEnv ?? process.env;
    this.now = deps.now ?? Date.now;
  }

  getStatus(): RuntimeSupervisorStatus {
    return { ...this.status };
  }

  /** Resolves once the runtime answers /health, or with the reason it won't. */
  async start(): Promise<RuntimeSupervisorStatus> {
    try {
      return await this.startInner();
    } catch (err) {
      return this.setStatus("failed", `동봉된 Runtime을 시작하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  /** Apply new settings. Restarts only a runtime this supervisor started —
   * an adopted ("external") one is not ours to kill. Resolves like start(). */
  async restartWith(input: RuntimeLaunchInput | null): Promise<RuntimeSupervisorStatus> {
    const owned = this.child !== null || ["starting", "running", "restarting", "failed"].includes(this.status.state);
    this.input = input;
    if (!owned) return this.getStatus();
    const healthUrl = this.plan?.healthUrl;
    this.stop();
    // Wait for the old process to let go of the port, or start() would
    // "adopt" the dying one.
    if (healthUrl) {
      for (let i = 0; i < 20 && (await this.isHealthy(healthUrl)); i += 1) await this.sleep(250);
    }
    return this.start();
  }

  stop(): void {
    this.stopping = true;
    if (this.child) {
      try {
        this.killTree(this.child);
      } catch {
        // app is quitting; nothing useful to do
      }
      this.child = null;
    }
    if (this.status.state !== "disabled" && this.status.state !== "external") {
      this.status = { ...this.status, state: "stopped" };
    }
  }

  private async startInner(): Promise<RuntimeSupervisorStatus> {
    if (!this.input) return this.setStatus("disabled", "이 설치본에는 동봉된 Runtime이 없습니다.", "info");
    const planned = planRuntimeLaunch(this.input);
    if (!planned.ok) return this.setStatus("disabled", planned.message, "info");
    this.plan = planned.plan;

    if (await this.isHealthy(this.plan.healthUrl)) {
      return this.setStatus("external", `이미 실행 중인 agent-runtime을 사용합니다 (${this.plan.healthUrl}).`, "info");
    }
    fs.mkdirSync(path.dirname(this.plan.ollamaConfigPath), { recursive: true });
    fs.writeFileSync(this.plan.ollamaConfigPath, `${JSON.stringify(this.plan.ollamaConfig, null, 2)}\n`);
    this.stopping = false;
    this.restartAttempt = 0;
    this.launch("starting");
    return this.waitReady();
  }

  private launch(state: "starting" | "restarting"): void {
    const plan = this.plan!;
    const fd = openLogFd(plan.logPath);
    let child: ChildProcess;
    try {
      child = this.spawnImpl(plan.command, plan.args, {
        env: { ...this.baseEnv, ...plan.env },
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        cwd: path.dirname(plan.command),
      });
    } finally {
      fs.closeSync(fd); // the child holds its own handle
    }
    this.child = child;
    this.setStatus(state, "agent-runtime을 시작하는 중입니다.", "info");
    child.on("error", (err) => this.onExit(child, `시작 오류: ${err.message}`));
    child.on("exit", (code, signal) => this.onExit(child, `종료 코드 ${code ?? signal}`));
  }

  private async waitReady(): Promise<RuntimeSupervisorStatus> {
    const plan = this.plan!;
    const attempts = Math.ceil(READY_TIMEOUT_MS / READY_POLL_MS);
    for (let i = 0; i < attempts; i += 1) {
      if (this.stopping || this.status.state === "failed") return this.getStatus();
      if (await this.isHealthy(plan.healthUrl)) {
        this.runningSince = this.now();
        return this.setStatus("running", `agent-runtime이 실행 중입니다 (${plan.healthUrl}).`, "info");
      }
      await this.sleep(READY_POLL_MS);
    }
    return this.setStatus("starting", `agent-runtime이 ${READY_TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다. 로그: ${plan.logPath}`, "warn");
  }

  private onExit(child: ChildProcess, detail: string): void {
    if (child !== this.child) return; // already replaced or stopped ('error' and 'exit' can both fire)
    this.child = null;
    if (this.stopping) return;
    if (this.runningSince !== null && this.now() - this.runningSince >= STABLE_RUN_MS) this.restartAttempt = 0;
    this.runningSince = null;
    const delay = restartDelayMs(this.restartAttempt);
    if (delay === null) {
      this.setStatus("failed", `agent-runtime이 반복해서 종료되어 재시작을 멈췄습니다(${detail}). 로그: ${this.plan!.logPath}`, "error");
      return;
    }
    this.restartAttempt += 1;
    this.setStatus("restarting", `agent-runtime이 종료되어 ${delay / 1000}초 뒤 다시 시작합니다(${detail}, ${this.restartAttempt}/${RESTART_DELAYS_MS.length}).`, "warn");
    void this.sleep(delay).then(() => {
      if (this.stopping) return;
      try {
        this.launch("restarting");
        void this.waitReady();
      } catch (err) {
        this.setStatus("failed", `agent-runtime 재시작 실패: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    });
  }

  private setStatus(state: RuntimeSupervisorState, message: string, level: "info" | "warn" | "error"): RuntimeSupervisorStatus {
    this.status = { state, message, logPath: this.plan?.logPath ?? null };
    this.logger[level](LOG_MODULE, message);
    return this.getStatus();
  }
}
