// Builds the Local Agent Runtime bundle that the Windows installer ships
// under resources/runtime/ (D-047 A, docs/implementation-spec/
// 11-desktop-packaging-and-distribution.md §6.1).
//
//   node scripts/build-python-runtime.mjs [--python-zip <path>] [--out <dir>]
//
// Output (default build/runtime/, already git-ignored by `build/`):
//   python/   python.org embeddable 3.14.7 (PSF-signed) + Lib/site-packages
//   app/      workspace sources in the repo's own layout (see §6.1.2 for why
//             these are copied rather than installed as wheels)
//   runtime-manifest.json
//
// Needs, on the build machine: `uv` and a host Python 3.14 (`py -3.14`, or
// AIHUB_BUILD_PYTHON=<path to python.exe>). Network is used only to fetch the
// embeddable zip (skip with --python-zip) and the locked wheels; every file is
// checked against a pinned SHA256 (the zip) or uv.lock hashes (the wheels).

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const PYTHON_VERSION = "3.14.7";
const PYTHON_ZIP_NAME = `python-${PYTHON_VERSION}-embed-amd64.zip`;
const PYTHON_ZIP_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/${PYTHON_ZIP_NAME}`;
const PYTHON_ZIP_SHA256 = "d297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15";
const PTH_NAME = "python314._pth";

// Workspace packages agent-runtime imports (its pyproject `[tool.uv.sources]`),
// plus the service itself. Paths are repo-relative and kept as-is under app/.
const SOURCE_DIRS = [
  "packages/schemas",
  "packages/security-policy",
  "packages/observability",
  "services/agent-runtime/src",
  "services/agent-runtime/config",
];
const IMPORT_ROOTS = [
  "packages/schemas/src",
  "packages/security-policy/src",
  "packages/observability/src",
  "services/agent-runtime/src",
];
// Never ship tests, caches, agent notes, or a developer's local `.env`.
const EXCLUDED_NAMES = new Set(["tests", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".env", "CLAUDE.md", "AGENTS.md"]);

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appDir, "..", "..");

function fail(message) {
  console.error(`build-python-runtime: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8", ...options });
  if (result.error) fail(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with ${result.status}\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseArgs(argv) {
  const args = { pythonZip: null, out: join(appDir, "build", "runtime") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--python-zip") args.pythonZip = resolve(argv[++i]);
    else if (argv[i] === "--out") args.out = resolve(argv[++i]);
    else fail(`unknown argument: ${argv[i]}`);
  }
  return args;
}

async function loadPythonZip(localPath) {
  const cached = join(appDir, "build", "cache", PYTHON_ZIP_NAME);
  const source = localPath ?? cached;
  if (!existsSync(source)) {
    if (localPath) fail(`--python-zip not found: ${localPath}`);
    console.log(`downloading ${PYTHON_ZIP_URL}`);
    const res = await fetch(PYTHON_ZIP_URL);
    if (!res.ok) fail(`download failed: HTTP ${res.status} (pass --python-zip on an offline build machine)`);
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
  }
  const bytes = readFileSync(source);
  const actual = sha256(bytes);
  if (actual !== PYTHON_ZIP_SHA256) fail(`${source} SHA256 mismatch: expected ${PYTHON_ZIP_SHA256}, got ${actual}`);
  return bytes;
}

function hostPython() {
  const [command, ...prefix] = process.env.AIHUB_BUILD_PYTHON ? [process.env.AIHUB_BUILD_PYTHON] : ["py", "-3.14"];
  const version = run(command, [...prefix, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"]);
  // pip compiles .pyc for the host interpreter; they must match the bundled one.
  if (version !== PYTHON_VERSION.split(".").slice(0, 2).join(".")) {
    fail(`host Python is ${version}, need ${PYTHON_VERSION} minor line (set AIHUB_BUILD_PYTHON)`);
  }
  return { command, prefix };
}

function copySources(targetAppDir) {
  for (const rel of SOURCE_DIRS) {
    const from = join(repoRoot, rel);
    if (!existsSync(from)) fail(`missing source directory: ${rel}`);
    cpSync(from, join(targetAppDir, rel), {
      recursive: true,
      filter: (src) => {
        const parts = relative(from, src).split(sep);
        return !parts.some((part) => EXCLUDED_NAMES.has(part)) && !src.endsWith(".pyc");
      },
    });
  }
  // A fresh loopback default, never the repo's working copy: developers edit
  // config/ollama.json locally (it has held a LAN address), and the Desktop
  // supervisor points the runtime at its own settings file anyway (§6.1.3).
  mkdirSync(join(targetAppDir, "config"), { recursive: true });
  writeFileSync(join(targetAppDir, "config", "ollama.json"), `${JSON.stringify({ endpoint: "http://127.0.0.1:11434" }, null, 2)}\n`);
}

async function main() {
  if (process.platform !== "win32") fail("the runtime bundle is Windows x64 only (build on Windows)");
  const args = parseArgs(process.argv.slice(2));
  const pythonDir = join(args.out, "python");
  const targetAppDir = join(args.out, "app");

  const zipBytes = await loadPythonZip(args.pythonZip);
  const host = hostPython();
  run("uv", ["--version"]);

  rmSync(args.out, { recursive: true, force: true });
  mkdirSync(pythonDir, { recursive: true });
  new AdmZip(zipBytes).extractAllTo(pythonDir, true);
  if (!existsSync(join(pythonDir, PTH_NAME))) fail(`${PTH_NAME} not found in the embeddable zip`);

  // The ._pth file replaces sys.path entirely for the embeddable build.
  const pth = ["python314.zip", ".", "Lib\\site-packages", ...IMPORT_ROOTS.map((p) => `..\\app\\${p.replaceAll("/", "\\")}`), "import site"];
  writeFileSync(join(pythonDir, PTH_NAME), `${pth.join("\r\n")}\r\n`);

  const requirements = join(tmpdir(), `aihub-agent-runtime-${process.pid}.txt`);
  run("uv", ["export", "--package", "agent-runtime", "--no-dev", "--frozen", "--no-emit-workspace", "--no-header", "-o", requirements], { cwd: repoRoot });
  try {
    run(host.command, [
      ...host.prefix, "-m", "pip", "install", "--disable-pip-version-check", "--no-input",
      "--no-deps", "--require-hashes", "--only-binary=:all:",
      "--target", join(pythonDir, "Lib", "site-packages"), "-r", requirements,
    ]);
  } finally {
    rmSync(requirements, { force: true });
  }

  copySources(targetAppDir);

  // Import check from a neutral cwd with the same isolation flags the
  // supervisor uses, so a missing file fails the build, not the user's PC.
  run(join(pythonDir, "python.exe"), ["-E", "-s", "-B", "-c", "import agent_runtime.main, uvicorn; print('ok')"], { cwd: tmpdir() });

  const commit = run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const dirty = run("git", ["status", "--porcelain", "--", ...SOURCE_DIRS, "uv.lock"], { cwd: repoRoot }) !== "";
  const manifest = {
    python_version: PYTHON_VERSION,
    python_zip_sha256: PYTHON_ZIP_SHA256,
    uv_lock_sha256: sha256(readFileSync(join(repoRoot, "uv.lock"))),
    commit_sha: commit,
    sources_dirty: dirty,
    built_at: new Date().toISOString(),
  };
  writeFileSync(join(args.out, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (dirty) console.warn("build-python-runtime: WARNING — runtime sources or uv.lock have uncommitted changes (recorded as sources_dirty)");
  console.log(`runtime bundle ready: ${args.out}`);
}

await main();
