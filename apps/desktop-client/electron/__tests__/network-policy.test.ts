// D01 필드 "Ollama Base URL; 기본은 loopback만 허용" — 이 규칙이 기본값이
// 아니라 실제 강제 규칙임을 검증한다.
import { describe, expect, it } from "vitest";
import {
  isLoopbackHostname,
  validateGenericUrl,
  validateNonEmpty,
  validateOllamaBaseUrl,
  validateSearchRuntimeBaseUrl,
} from "../network-policy";

describe("isLoopbackHostname", () => {
  it("recognizes loopback hostnames", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
  });

  it("rejects a remote hostname", () => {
    expect(isLoopbackHostname("10.0.0.5")).toBe(false);
    expect(isLoopbackHostname("ollama.internal.example.com")).toBe(false);
    expect(isLoopbackHostname("192.168.1.20")).toBe(false);
  });
});

describe("validateOllamaBaseUrl", () => {
  it("accepts a loopback URL without needing the override", () => {
    expect(validateOllamaBaseUrl("http://127.0.0.1:11434", false)).toEqual({ ok: true, error: null });
    expect(validateOllamaBaseUrl("http://localhost:11434", false)).toEqual({ ok: true, error: null });
  });

  it("rejects a non-loopback URL by default — this is the security rule, not a default", () => {
    const result = validateOllamaBaseUrl("http://10.0.0.5:11434", false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("loopback");
  });

  it("accepts a non-loopback URL only when the override is explicitly true", () => {
    expect(validateOllamaBaseUrl("http://10.0.0.5:11434", true)).toEqual({ ok: true, error: null });
  });

  it("rejects an empty value", () => {
    expect(validateOllamaBaseUrl("", false).ok).toBe(false);
    expect(validateOllamaBaseUrl("   ", false).ok).toBe(false);
  });

  it("rejects a malformed URL", () => {
    const result = validateOllamaBaseUrl("not-a-url", false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("URL");
  });

  it("rejects a non-http(s) protocol even on loopback", () => {
    const result = validateOllamaBaseUrl("ftp://127.0.0.1:11434", false);
    expect(result.ok).toBe(false);
  });
});

describe("validateGenericUrl", () => {
  it("accepts both loopback and remote http(s) URLs — no loopback rule for this field", () => {
    expect(validateGenericUrl("http://127.0.0.1:8500", "MCP Server URL")).toEqual({ ok: true, error: null });
    expect(validateGenericUrl("https://mcp.internal.example.com", "MCP Server URL")).toEqual({ ok: true, error: null });
  });

  it("rejects empty input with a field-specific message", () => {
    const result = validateGenericUrl("", "MCP Server URL");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("MCP Server URL");
  });
});

describe("validateSearchRuntimeBaseUrl", () => {
  it("accepts loopback URLs", () => {
    expect(validateSearchRuntimeBaseUrl("http://127.0.0.1:8300")).toEqual({ ok: true, error: null });
    expect(validateSearchRuntimeBaseUrl("http://localhost:8300")).toEqual({ ok: true, error: null });
  });

  it("rejects a remote address with no override — D-079: activation carries a local absolute path", () => {
    const result = validateSearchRuntimeBaseUrl("http://10.0.0.5:8300");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("loopback");
  });

  it("rejects a malformed URL", () => {
    expect(validateSearchRuntimeBaseUrl("not-a-url").ok).toBe(false);
  });

  it("rejects empty input", () => {
    expect(validateSearchRuntimeBaseUrl("").ok).toBe(false);
  });
});

describe("validateNonEmpty", () => {
  it("rejects blank/whitespace-only input", () => {
    expect(validateNonEmpty("", "Client 표시명").ok).toBe(false);
    expect(validateNonEmpty("   ", "Client 표시명").ok).toBe(false);
  });

  it("accepts non-empty input", () => {
    expect(validateNonEmpty("본사", "Client 표시명")).toEqual({ ok: true, error: null });
  });
});
