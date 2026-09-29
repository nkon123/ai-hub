import { describe, expect, it } from "vitest";
import { validateServerAlias } from "../../electron/local-mcp-servers";
import type { LocalMcpToolDraft } from "../../electron/types";
import {
  SERVER_ALIAS_PATTERN,
  confirmNote,
  enabledCount,
  suggestAlias,
  toggleChoice,
  validateAddForm,
} from "./localMcpServerTypes";

const drafts: LocalMcpToolDraft[] = [
  { toolName: "hello.now", description: null, riskLevel: "READ_ONLY", registrable: true, confirmLocked: false },
  { toolName: "files.delete", description: null, riskLevel: "WRITE", registrable: true, confirmLocked: true },
  { toolName: "bad name", description: null, riskLevel: "READ_ONLY", registrable: false, confirmLocked: false },
];

describe("localMcpServerTypes", () => {
  it("uses the same alias rule as the main process", () => {
    for (const alias of ["hello-local", "a1", "Hello", "1x", "x-", "한글", "a".repeat(64), "a".repeat(65)]) {
      expect(SERVER_ALIAS_PATTERN.test(alias), alias).toBe(validateServerAlias(alias) === null);
    }
  });

  it("validates the form per kind", () => {
    expect(validateAddForm({ kind: "STDIO", alias: "hello-local", entryFile: "C:\\x\\server.py", endpoint: "" })).toBeNull();
    expect(validateAddForm({ kind: "STDIO", alias: "hello-local", entryFile: "", endpoint: "" })).not.toBeNull();
    expect(validateAddForm({ kind: "STDIO", alias: "hello-local", entryFile: "C:\\x\\run.bat", endpoint: "" })).not.toBeNull();
    expect(validateAddForm({ kind: "HTTP", alias: "remote", entryFile: "", endpoint: "http://127.0.0.1:8000/mcp" })).toBeNull();
    expect(validateAddForm({ kind: "HTTP", alias: "remote", entryFile: "", endpoint: "ftp://x" })).not.toBeNull();
    expect(validateAddForm({ kind: "HTTP", alias: "Bad Name", entryFile: "", endpoint: "http://x/mcp" })).not.toBeNull();
  });

  it("suggests a valid alias from the file or address", () => {
    expect(suggestAlias("C:\\work\\hello-mcp\\server.py")).toBe("hello-mcp");
    expect(suggestAlias("C:\\work\\My Tools\\weather_api.py")).toBe("weather-api");
    expect(suggestAlias("http://127.0.0.1:8000/mcp")).toBe("mcp");
    expect(suggestAlias("C:\\123\\456.py")).toBe("my-mcp-server");
  });

  it("never lets the user turn off confirmation for a WRITE tool or enable an unregistrable one", () => {
    const choices = drafts.map((d) => ({ toolName: d.toolName, enabled: d.registrable, confirm: true }));
    expect(toggleChoice(choices, "files.delete", "confirm", drafts)).toEqual(choices);
    expect(toggleChoice(choices, "bad name", "enabled", drafts)).toEqual(choices);
    const off = toggleChoice(choices, "hello.now", "confirm", drafts);
    expect(off.find((c) => c.toolName === "hello.now")!.confirm).toBe(false);
    expect(enabledCount(choices)).toBe(2);
    expect(confirmNote(drafts[1])).toContain("항상");
    expect(confirmNote(drafts[2])).toContain("추가할 수 없습니다");
    expect(confirmNote(drafts[0])).toBeNull();
  });
});
