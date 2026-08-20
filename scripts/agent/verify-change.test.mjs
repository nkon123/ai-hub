// node --test scripts/agent/verify-change.test.mjs
// 의존성 0개 — Node 내장 test runner 를 쓴다(폐쇄망 전제).
import test from "node:test";
import assert from "node:assert/strict";
import { resolveSuites, diffCounts, runSuite } from "./verify-change.mjs";

// --- 정상 ---------------------------------------------------------------
test("resolveSuites: 이름 목록을 그대로 돌려준다", () => {
  assert.deepEqual(resolveSuites("python,ruff").names, ["python", "ruff"]);
});

test("resolveSuites: all 은 모든 스위트로 펼친다", () => {
  const { names } = resolveSuites("all");
  assert.ok(names.includes("python") && names.includes("desktop"));
});

test("diffCounts: 숫자 필드의 증감을 낸다", () => {
  assert.deepEqual(diffCounts({ passed: 100, skipped: 4 }, { passed: 107, skipped: 4 }), { passed: 7, skipped: 0 });
});

test("runSuite: 통과한 명령의 숫자를 파싱한다", () => {
  const fakeRunner = () => ({ status: 0, stdout: "Tests  875 passed (875)\nTest Files  63 passed (63)\n", stderr: "" });
  const r = runSuite("desktop", { runner: fakeRunner });
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, { passed: 875, files: 63 });
});

// --- 경계 ---------------------------------------------------------------
test("diffCounts: 기준선이 없으면 null (0 으로 지어내지 않는다)", () => {
  assert.equal(diffCounts(null, { passed: 10 }), null);
});

test("diffCounts: 기준선에 없던 키는 delta 를 만들지 않는다", () => {
  assert.deepEqual(diffCounts({ passed: 5 }, { passed: 6, files: 2 }), { passed: 1 });
});

test("runSuite: pytest 의 skipped/deselected 가 없어도 0 으로 채운다", () => {
  const fakeRunner = () => ({ status: 0, stdout: "12 passed in 0.4s\n", stderr: "" });
  const r = runSuite("python", { runner: fakeRunner });
  assert.deepEqual(r.counts, { passed: 12, skipped: 0, deselected: 0 });
});

test("runSuite: typecheck 는 출력이 없어도 종료 코드로 판정한다", () => {
  const fakeRunner = () => ({ status: 0, stdout: "", stderr: "" });
  const r = runSuite("typecheck-desktop", { runner: fakeRunner });
  assert.equal(r.ok, true);
  assert.equal(r.parseFailed, undefined);
});

// --- 실패 ---------------------------------------------------------------
test("resolveSuites: 모르는 이름은 거절한다", () => {
  assert.match(resolveSuites("python,nope").error, /알 수 없는 스위트: nope/);
});

test("resolveSuites: 인자가 없으면 거절한다", () => {
  assert.match(resolveSuites(undefined).error, /--suites/);
});

test("runSuite: 숫자를 못 찾으면 조용히 0 으로 넘어가지 않고 parseFailed 를 낸다", () => {
  const fakeRunner = () => ({ status: 0, stdout: "무슨 일이 일어났는지 알 수 없는 출력", stderr: "" });
  const r = runSuite("python", { runner: fakeRunner });
  assert.equal(r.parseFailed, true);
  assert.equal(r.counts, undefined);
  assert.match(r.hint, /숫자를 찾지 못했습니다/);
});

test("runSuite: 명령이 실패하면 ok=false 이고 종료 코드를 담는다", () => {
  const fakeRunner = () => ({ status: 1, stdout: "3 passed, 2 failed", stderr: "" });
  const r = runSuite("python", { runner: fakeRunner });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
});

// --- 압축 출력 (기본) ---------------------------------------------------
import { renderCompact } from "./verify-change.mjs";

test("renderCompact: 통과 시 숫자와 delta 만 남긴다", () => {
  const out = renderCompact({
    ok: true,
    failed: [],
    suites: [
      { suite: "python", ok: true, exitCode: 0, counts: { passed: 1285, skipped: 4 }, delta: { passed: 0 } },
      { suite: "ruff", ok: true, exitCode: 0, counts: { errors: 0 } },
    ],
  });
  assert.equal(out, '{"ok":true,"python":{"pass":1285,"d":0},"ruff":{"err":0}}');
});

test("renderCompact: 실패는 절대 생략하지 않는다", () => {
  const out = JSON.parse(renderCompact({
    ok: false,
    failed: ["python"],
    suites: [{ suite: "python", ok: false, exitCode: 1, counts: { passed: 3 } }],
  }));
  assert.deepEqual(out.failed, ["python"]);
  assert.equal(out.python.exit, 1);
});

test("renderCompact: 파싱 실패도 절대 생략하지 않는다", () => {
  const out = JSON.parse(renderCompact({
    ok: false,
    failed: [],
    suites: [{ suite: "python", ok: true, exitCode: 0, parseFailed: true }],
  }));
  assert.deepEqual(out.parseFailed, ["python"]);
});

test("renderCompact: 기준선이 없으면 d 를 지어내지 않는다", () => {
  const out = JSON.parse(renderCompact({
    ok: true, failed: [],
    suites: [{ suite: "python", ok: true, exitCode: 0, counts: { passed: 10 } }],
  }));
  assert.equal("d" in out.python, false);
});
