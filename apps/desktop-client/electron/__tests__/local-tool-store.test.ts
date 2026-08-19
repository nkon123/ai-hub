import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findToolNameConflict, hashLocalToolSource, LocalToolStore, type AddLocalToolInput } from "../local-tool-store";

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

  it("new tools start with approval: null (never pre-approved)", () => {
    const store = new LocalToolStore(tmpDir);
    const added = store.add(sampleInput(), true);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.tool.approval).toBeNull();
  });

  // D-084 후속 3 ("최초 한번만 승인")
  describe("approve/revoke — standing execution approval bound to file content", () => {
    it("approve records approvedAt and the given file hash", () => {
      const store = new LocalToolStore(tmpDir);
      const added = store.add(sampleInput(), true);
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      const hash = hashLocalToolSource("def lookup(): pass\n");
      const approved = store.approve(added.tool.id, hash);
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.tool.approval).not.toBeNull();
      expect(approved.tool.approval?.approvedFileHash).toBe(hash);
      expect(approved.tool.approval?.approvedAt).toBeTruthy();

      // Persisted, not just returned in-memory.
      expect(store.find(added.tool.id)?.approval?.approvedFileHash).toBe(hash);
    });

    it("approve reports a clear error for an unknown id and writes nothing", () => {
      const store = new LocalToolStore(tmpDir);
      const result = store.approve("does-not-exist", "deadbeef");
      expect(result.ok).toBe(false);
      expect(store.list()).toEqual([]);
    });

    it("revoke clears approval back to null", () => {
      const store = new LocalToolStore(tmpDir);
      const added = store.add(sampleInput(), true);
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      store.approve(added.tool.id, hashLocalToolSource("x"));
      expect(store.find(added.tool.id)?.approval).not.toBeNull();

      const revoked = store.revoke(added.tool.id);
      expect(revoked.ok).toBe(true);
      if (!revoked.ok) return;
      expect(revoked.tool.approval).toBeNull();
      expect(store.find(added.tool.id)?.approval).toBeNull();
    });

    it("revoke reports a clear error for an unknown id", () => {
      const store = new LocalToolStore(tmpDir);
      const result = store.revoke("does-not-exist");
      expect(result.ok).toBe(false);
    });

    it("legacy records written before `approval` existed are normalized to null, not treated as approved", () => {
      fs.mkdirSync(tmpDir, { recursive: true });
      const legacyTool = {
        id: "legacy-1",
        filePath: "/legacy.py",
        functionName: "legacy",
        toolName: "legacy",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        parameters: [],
        discarded: { bodyStatementCount: 1, decoratorCount: 0, docstringPresent: false, sourceExecuted: false, sourcePersisted: false },
        warnings: [],
        addedAt: "2026-08-01T00:00:00.000Z",
        riskAcknowledgedAt: "2026-08-01T00:00:00.000Z",
        // no `approval` field at all — pre-dates this feature.
      };
      fs.writeFileSync(path.join(tmpDir, "local-tools.json"), JSON.stringify({ tools: [legacyTool] }), "utf-8");
      const store = new LocalToolStore(tmpDir);
      expect(store.find("legacy-1")?.approval).toBeNull();
      expect(store.list()[0].approval).toBeNull();
    });
  });
});

describe("findToolNameConflict", () => {
  it("returns null when no existing tool has the given toolName", () => {
    const store = new LocalToolStore(tmpDir);
    const added = store.add(sampleInput({ toolName: "lookup" }), true);
    expect(added.ok).toBe(true);
    expect(findToolNameConflict(store.list(), "other")).toBeNull();
  });

  it("returns the conflicting tool when an existing tool already has the same toolName (cross-file conflict)", () => {
    const store = new LocalToolStore(tmpDir);
    const added = store.add(
      sampleInput({ filePath: "/a.py", functionName: "lookup", toolName: "lookup" }),
      true,
    );
    expect(added.ok).toBe(true);
    const conflict = findToolNameConflict(store.list(), "lookup");
    expect(conflict).not.toBeNull();
    expect(conflict?.filePath).toBe("/a.py");
  });

  it("also catches a same-file conflict once the first function from a batch has been added", () => {
    // Mirrors how `electron/main.ts`'s `localTool:add` handler registers
    // several @tool-decorated functions from one file sequentially: after
    // the first succeeds, a second candidate with the same functionName
    // must be reported as a conflict against the store's current list()
    // (which now includes the first), not silently accepted.
    const store = new LocalToolStore(tmpDir);
    const first = store.add(sampleInput({ filePath: "/dup.py", functionName: "dup", toolName: "dup" }), true);
    expect(first.ok).toBe(true);
    const conflict = findToolNameConflict(store.list(), "dup");
    expect(conflict).not.toBeNull();
    expect(conflict?.filePath).toBe("/dup.py");
  });
});

describe("hashLocalToolSource", () => {
  it("produces different digests for different content", () => {
    expect(hashLocalToolSource("a")).not.toBe(hashLocalToolSource("b"));
  });

  it("is deterministic for the same content", () => {
    const source = "def f(x: int) -> int:\n    return x + 1\n";
    expect(hashLocalToolSource(source)).toBe(hashLocalToolSource(source));
  });

  it("is sensitive to any change in the content, including whitespace", () => {
    expect(hashLocalToolSource("def f(): pass\n")).not.toBe(hashLocalToolSource("def f(): pass\n\n"));
  });
});
