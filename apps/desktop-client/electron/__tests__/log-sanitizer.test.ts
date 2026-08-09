import { describe, expect, it } from "vitest";
import { sanitizeText, looksSensitive } from "../log-sanitizer";

describe("sanitizeText", () => {
  it("redacts a Bearer token", () => {
    const out = sanitizeText("Authorization: Bearer sk-abcdefgh12345678ijklmnop");
    expect(out).not.toContain("sk-abcdefgh12345678ijklmnop");
    expect(out).toContain("***REDACTED***");
  });

  it("redacts an api_key= assignment", () => {
    const out = sanitizeText('config: api_key="AKIA1234567890ABCDEF"');
    expect(out).not.toContain("AKIA1234567890ABCDEF");
  });

  it("redacts a password= assignment", () => {
    const out = sanitizeText("db connection failed, password=SuperSecret123");
    expect(out).not.toContain("SuperSecret123");
  });

  it("redacts a PEM private key header", () => {
    const out = sanitizeText("-----BEGIN RSA PRIVATE KEY-----\nMIIExyz...");
    expect(out).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
  });

  it("redacts a credential embedded in a URL authority", () => {
    const out = sanitizeText("failed to reach https://admin:hunter2@internal.corp/api");
    expect(out).not.toContain("admin:hunter2");
  });

  it("redacts a macOS home directory absolute path", () => {
    const out = sanitizeText("stack trace at /Users/victory/projects/secret-app/main.py:42");
    expect(out).not.toContain("/Users/victory");
  });

  it("redacts a Linux home directory absolute path", () => {
    const out = sanitizeText("loaded config from /home/jdoe/.config/app.yaml");
    expect(out).not.toContain("/home/jdoe");
  });

  it("redacts a Windows user directory absolute path", () => {
    const out = sanitizeText("path: C:\\Users\\jdoe\\AppData\\Local\\app");
    expect(out).not.toContain("C:\\Users\\jdoe");
  });

  it("redacts a long quoted span (e.g. an interpolated prompt or document excerpt)", () => {
    const out = sanitizeText('Prompt 전송 실패: "다음 사용자 질문에 대해 회사 내부 정책만 근거로 답변하라: 연봉 인상 기준을 알려줘"');
    expect(out).not.toContain("연봉 인상 기준");
  });

  it("redacts a structured key=value record dump (e.g. a stringified DB row)", () => {
    const out = sanitizeText("DB 조회 결과: employee_id=10293, name=김민준, salary=68000000, ssn=901010-1234567");
    expect(out).not.toContain("901010-1234567");
    expect(out).not.toContain("68000000");
  });

  it("does not redact a short quoted value (below the length threshold)", () => {
    const out = sanitizeText('status: "ok"');
    expect(out).toBe('status: "ok"');
  });

  it("does not redact a single key=value pair (below the 3-pair threshold)", () => {
    const out = sanitizeText("stage=CHECKSUM");
    expect(out).toBe("stage=CHECKSUM");
  });

  it("leaves ordinary diagnostic text untouched", () => {
    const text = "Bundle import failed at stage CHECKSUM (retryable=true)";
    expect(sanitizeText(text)).toBe(text);
  });
});

describe("looksSensitive", () => {
  it("flags text containing a secret-shaped pattern", () => {
    expect(looksSensitive("token=abcd1234efgh5678")).toBe(true);
  });

  it("does not flag ordinary text", () => {
    expect(looksSensitive("run completed successfully")).toBe(false);
  });

  it("is stateless across repeated calls (no regex lastIndex leakage)", () => {
    // A global-flag regex's `.test()` is stateful unless guarded against —
    // this would fail intermittently if that guard were removed.
    expect(looksSensitive("password=abcd1234")).toBe(true);
    expect(looksSensitive("password=abcd1234")).toBe(true);
    expect(looksSensitive("password=abcd1234")).toBe(true);
  });
});
