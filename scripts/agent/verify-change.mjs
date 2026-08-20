#!/usr/bin/env node
// 변경 검증을 한 번에 돌리고 "기준선 대비 증감"만 작은 JSON 으로 돌려준다.
//
// 왜 있는가: 에이전트가 매 작업마다 pytest/vitest/typecheck/ruff 를 따로
// 돌리고 수천 줄 출력에서 숫자를 눈으로 골라 왔다. 파싱·집계·비교는
// 입력이 같으면 출력이 같아야 하는 결정적 작업이므로 코드로 내린다.
// 남는 판단(증가분이 신규 테스트 수와 맞는가, 실패를 어떻게 다룰 것인가)은
// 에이전트 몫이다.
//
// 의존성 0개 — 폐쇄망 전제(루트 CLAUDE.md "새 의존성을 추가할 때 이유와
// 폐쇄망 설치 방법을 문서화한다")라 tsx/zod 를 쓰지 않는다. 인자가 몇 개
// 안 되어 스키마 라이브러리의 이득보다 설치 비용이 크다.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 실패 발췌 상한 — 대량 실패 시 전체 덤프로 되돌아가지 않게 한다. */
const MAX_FAIL_LINES = 5;
const MAX_FAIL_LINE_CHARS = 120;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 스위트 정의. 새 스위트를 추가하려면 여기만 고친다.
 *  parse 는 stdout+stderr 를 받아 {passed,...} 또는 null(패턴 못 찾음)을 낸다.
 *  null 을 내면 조용히 0 으로 넘어가지 않고 parse_failed 오류가 된다. */
const SUITES = {
  python: {
    label: "pytest (루트)",
    cmd: ["uv", "run", "pytest", "tests/", "-q"],
    cwd: ".",
    parse: (out) => {
      const m = out.match(/(\d+) passed(?:, (\d+) skipped)?(?:, (\d+) deselected)?/);
      if (!m) return null;
      // 실패 시 요약은 "2 failed, 1 passed" 처럼 failed 가 앞에 온다.
      const f = out.match(/(\d+) failed/);
      const counts = { passed: +m[1], skipped: +(m[2] ?? 0), deselected: +(m[3] ?? 0) };
      if (f) counts.failed = +f[1];
      return counts;
    },
    // `FAILED tests/x.py::test_name` (short test summary info)
    excerpt: (out) => out.split("\n").filter((l) => l.startsWith("FAILED ")).map((l) => l.slice(7)),
  },
  desktop: {
    label: "vitest (desktop-client)",
    cmd: ["pnpm", "test"],
    cwd: "apps/desktop-client",
    parse: (out) => {
      // 실패가 있으면 "Tests  1 failed | 875 passed (876)" 로 나온다 —
      // `Tests\s+(\d+) passed` 로만 보면 매칭이 통째로 실패해 실패를
      // parseFailed(종료 3)로 잘못 보고했다. 실측으로 확인한 버그다.
      const line = out.match(/Tests\s+([^\n]+)/);
      if (!line) return null;
      const passed = line[1].match(/(\d+) passed/);
      if (!passed) return null;
      const failed = line[1].match(/(\d+) failed/);
      const filesLine = out.match(/Test Files\s+([^\n]+)/);
      const files = filesLine ? filesLine[1].match(/(\d+) passed/) : null;
      const counts = { passed: +passed[1], files: files ? +files[1] : null };
      if (failed) counts.failed = +failed[1];
      return counts;
    },
    // ` FAIL  src/x.test.ts > 테스트 이름`
    excerpt: (out) => out.split("\n").filter((l) => /^\s*FAIL\s/.test(l)).map((l) => l.trim().replace(/^FAIL\s+/, "")),
  },
  ruff: {
    label: "ruff check",
    cmd: ["uv", "run", "ruff", "check", "."],
    cwd: ".",
    parse: (out) => {
      if (/All checks passed/.test(out)) return { errors: 0 };
      const m = out.match(/Found (\d+) error/);
      return m ? { errors: +m[1] } : null;
    },
  },
  contract: {
    label: "contract tests",
    cmd: ["uv", "run", "pytest", "tests/contract/", "-q"],
    cwd: ".",
    parse: (out) => {
      const m = out.match(/(\d+) passed/);
      return m ? { passed: +m[1] } : null;
    },
  },
  "typecheck-desktop": {
    label: "typecheck (desktop-client)",
    cmd: ["pnpm", "typecheck"],
    cwd: "apps/desktop-client",
    parse: () => ({}), // 종료 코드만 의미가 있다
  },
  "typecheck-portal-web": {
    label: "typecheck (portal-web)",
    cmd: ["pnpm", "--filter", "portal-web", "exec", "tsc", "--noEmit"],
    cwd: ".",
    parse: () => ({}),
  },
};

const HELP = `verify-change — 변경 검증을 돌리고 기준선 대비 증감만 JSON 으로 낸다.

사용법:
  node scripts/agent/verify-change.mjs --suites <이름,...> [옵션]

옵션:
  --suites <a,b,c>     돌릴 스위트. 'all' 이면 전부.
                       가능: ${Object.keys(SUITES).join(", ")}
  --baseline <path>    이전 결과 JSON. 있으면 delta 를 함께 낸다.
  --save-baseline <p>  이번 결과를 그 경로에 쓴다(작업 시작 전에 찍어 둘 것).
  --verbose            라벨·종료코드·원본 출력 마지막 40줄까지 전부 낸다.
                       (기본 출력은 압축 JSON 한 줄이다)
  --help               이 도움말.

종료 코드:
  0  모든 스위트 통과
  1  하나 이상 실패(테스트 실패/타입 오류/lint 오류)
  2  사용법 오류(잘못된 인자)
  3  내부 오류(출력에서 숫자를 못 찾음 — 조용히 0 으로 넘어가지 않는다)

출력은 JSON 한 덩어리다. 사람이 아니라 에이전트가 읽는 것을 전제로,
전체 덤프 대신 숫자와 delta 만 낸다(--verbose 제외).`;

function fail(code, message, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: message, ...extra }, null, 2) + "\n");
  process.exit(code);
}

function parseArgs(argv) {
  const out = { suites: null, baseline: null, saveBaseline: null, verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--suites") out.suites = argv[++i];
    else if (a === "--baseline") out.baseline = argv[++i];
    else if (a === "--save-baseline") out.saveBaseline = argv[++i];
    else return { error: `알 수 없는 인자: ${a}` };
  }
  return out;
}

export function resolveSuites(spec) {
  if (!spec) return { error: "--suites 가 필요합니다. --help 를 보세요." };
  if (spec === "all") return { names: Object.keys(SUITES) };
  const names = spec.split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return { error: "--suites 값이 비어 있습니다." };
  const unknown = names.filter((n) => !(n in SUITES));
  if (unknown.length) return { error: `알 수 없는 스위트: ${unknown.join(", ")}` };
  return { names };
}

/** 두 결과 객체의 숫자 필드 차이. 기준선에 없던 키는 건너뛴다. */
export function diffCounts(before, after) {
  if (!before || !after) return null;
  const delta = {};
  for (const [k, v] of Object.entries(after)) {
    if (typeof v === "number" && typeof before[k] === "number") delta[k] = v - before[k];
  }
  return Object.keys(delta).length ? delta : null;
}

export function runSuite(name, { verbose = false, runner = spawnSync } = {}) {
  const suite = SUITES[name];
  const res = runner(suite.cmd[0], suite.cmd.slice(1), {
    cwd: path.join(REPO_ROOT, suite.cwd),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const exitCode = res.status ?? -1;
  const counts = suite.parse(out);
  const entry = { suite: name, label: suite.label, exitCode, ok: exitCode === 0 };
  if (counts === null) {
    entry.parseFailed = true;
    entry.hint = "출력에서 숫자를 찾지 못했습니다 — 명령이 아예 실행되지 않았거나 출력 형식이 바뀌었습니다.";
  } else {
    entry.counts = counts;
  }
  // 실패했을 때만 "왜" 를 담는다. 성공 출력은 그대로 98 bytes 를 유지한다.
  // 상한을 두는 이유: 대량 실패 때 전체를 쏟으면 소음 제거라는 목적이 사라진다.
  if (!entry.ok && suite.excerpt) {
    const lines = suite.excerpt(out).filter(Boolean);
    if (lines.length) {
      entry.fail = lines.slice(0, MAX_FAIL_LINES).map((l) => (l.length > MAX_FAIL_LINE_CHARS ? l.slice(0, MAX_FAIL_LINE_CHARS) + "…" : l));
      if (lines.length > MAX_FAIL_LINES) entry.failMore = lines.length - MAX_FAIL_LINES;
    }
  }
  if (verbose) entry.tail = out.trimEnd().split("\n").slice(-40);
  return entry;
}

/** 기본 출력. 에이전트가 읽는 것이므로 사람용 들여쓰기·라벨을 뺀다.
 *  실패/파싱실패는 절대 생략하지 않는다 — 조용해지면 안 되는 신호다. */
export function renderCompact(payload) {
  const out = { ok: payload.ok };
  for (const r of payload.suites) {
    const e = {};
    if (r.counts) {
      if (typeof r.counts.passed === "number") e.pass = r.counts.passed;
      if (typeof r.counts.errors === "number") e.err = r.counts.errors;
      if (typeof r.counts.files === "number") e.files = r.counts.files;
    }
    if (r.delta && typeof r.delta.passed === "number") e.d = r.delta.passed;
    if (typeof r.counts?.failed === "number") e.failCount = r.counts.failed;
    if (!r.ok) e.exit = r.exitCode;
    if (r.fail) e.fail = r.fail;
    if (r.failMore) e.failMore = r.failMore;
    if (r.parseFailed) e.parseFailed = true;
    out[r.suite] = e;
  }
  if (payload.failed.length) out.failed = payload.failed;
  const pf = payload.suites.filter((r) => r.parseFailed).map((r) => r.suite);
  if (pf.length) out.parseFailed = pf;
  if (payload.savedBaseline) out.savedBaseline = payload.savedBaseline;
  return JSON.stringify(out);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) fail(2, args.error);
  if (args.help || process.argv.length === 2) {
    process.stdout.write(HELP + "\n");
    process.exit(args.help ? 0 : 2);
  }
  const resolved = resolveSuites(args.suites);
  if (resolved.error) fail(2, resolved.error);

  let baseline = null;
  if (args.baseline) {
    if (!fs.existsSync(args.baseline)) fail(2, `기준선 파일이 없습니다: ${args.baseline}`);
    try {
      baseline = JSON.parse(fs.readFileSync(args.baseline, "utf-8"));
    } catch (e) {
      fail(2, `기준선 파일을 읽을 수 없습니다: ${e.message}`);
    }
  }

  const results = resolved.names.map((n) => runSuite(n, { verbose: args.verbose }));

  for (const r of results) {
    const before = baseline?.suites?.find((b) => b.suite === r.suite)?.counts;
    const d = diffCounts(before, r.counts);
    if (d) r.delta = d;
  }

  const parseFailures = results.filter((r) => r.parseFailed);
  const failures = results.filter((r) => !r.ok);
  const payload = {
    ok: failures.length === 0 && parseFailures.length === 0,
    baselineFrom: args.baseline ?? null,
    suites: results,
    failed: failures.map((r) => r.suite),
  };

  if (args.saveBaseline) {
    fs.mkdirSync(path.dirname(path.resolve(args.saveBaseline)), { recursive: true });
    fs.writeFileSync(args.saveBaseline, JSON.stringify({ suites: results.map(({ suite, counts }) => ({ suite, counts })) }, null, 2));
    payload.savedBaseline = args.saveBaseline;
  }

  // 기본은 압축. 상세(라벨/원본 tail)는 --verbose 일 때만 — 에이전트가
  // 읽는 출력에서 사람용 서식이 차지하는 비용이 실측으로 확인됐다.
  process.stdout.write((args.verbose ? JSON.stringify(payload, null, 2) : renderCompact(payload)) + "\n");
  if (parseFailures.length) process.exit(3);
  process.exit(failures.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
