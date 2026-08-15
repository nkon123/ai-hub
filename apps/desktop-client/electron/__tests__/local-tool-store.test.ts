import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalToolStore, type AddLocalToolInput } from "../local-tool-store";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-local-tool-store-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sampleInput(overrides: Partial<AddLocalToolInput> = {}): AddLocalToolInput {
  return {
    filePath: "/Users/tester/scripts/lookup.py",
    functionName: "lookup",
    toolName: "lookup",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    parameters: [],
    discarded: { bodyStatementCount: 1, decoratorCount: 0, docstringPresent: false, sourceExecuted: false, sourcePersisted: false },
    warnings: [],
    ...overrides,
  };
}

describe("LocalToolStore", () => {
  it("starts empty", () => {
    const store = new LocalToolStore(tmpDir);
    expect(store.list()).toEqual([]);
  });

  it("refuses to add without acknowledgedRisk:true and persists nothing", () => {
    const store = new LocalToolStore(tmpDir);
    const result = store.add(sampleInput(), false);
    expect(result.ok).toBe(false);
    expect(store.list()).toEqual([]);
    // Re-open a fresh store pointed at the same dir to prove nothing hit disk.
    const reopened = new LocalToolStore(tmpDir);
    expect(reopened.list()).toEqual([]);
  });

  it("adds, lists, finds, and removes a tool when risk is acknowledged", () => {
    const store = new LocalToolStore(tmpDir);
    const added = store.add(sampleInput(), true);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    expect(added.tool.riskAcknowledgedAt).toBeTruthy();
    expect(added.tool.addedAt).toBeTruthy();
    expect(typeof added.tool.id).toBe("string");
    expect(added.tool.id.length).toBeGreaterThan(0);
    // Identity must never be derived from the file name or tool name.
    expect(added.tool.id).not.toContain("lookup");
    expect(added.tool.id).not.toContain("scripts");

    expect(store.list()).toHaveLength(1);
    expect(store.find(added.tool.id)?.filePath).toBe("/Users/tester/scripts/lookup.py");
    expect(store.find("does-not-exist")).toBeNull();

    const removed = store.remove(added.tool.id);
    expect(removed.ok).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("remove reports a clear error for an unknown id", () => {
    const store = new LocalToolStore(tmpDir);
    const result = store.remove("nope");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("generates a distinct random id per tool, never reusing file-derived text", () => {
    const store = new LocalToolStore(tmpDir);
    const a = store.add(sampleInput({ filePath: "/a.py", functionName: "a", toolName: "a" }), true);
    const b = store.add(sampleInput({ filePath: "/a.py", functionName: "a", toolName: "a" }), true);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.tool.id).not.toBe(b.tool.id);
    }
    expect(store.list()).toHaveLength(2);
  });

  it("survives a corrupted state file by treating it as empty", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "local-tools.json"), "{not valid json", "utf-8");
    const store = new LocalToolStore(tmpDir);
    expect(store.list()).toEqual([]);
  });
});
