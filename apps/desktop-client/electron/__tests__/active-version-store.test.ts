import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActiveVersionStore } from "../active-version-store";

let tmpRoot: string;
let stateDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-active-version-"));
  stateDir = path.join(tmpRoot, "state");
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ActiveVersionStore", () => {
  it("returns null when no pointer has ever been recorded (D-068: never fabricate one)", () => {
    const store = new ActiveVersionStore(stateDir);
    expect(store.get("knowledge", "know-1")).toBeNull();
  });

  it("persists a pointer across a fresh instance reading the same state dir", () => {
    new ActiveVersionStore(stateDir).set("knowledge", "know-1", "1.0.0");
    const reopened = new ActiveVersionStore(stateDir);
    expect(reopened.get("knowledge", "know-1")).toBe("1.0.0");
  });

  it("D12 Active Pointer 전환: re-setting overwrites the previous pointer for the same assetId", () => {
    const store = new ActiveVersionStore(stateDir);
    store.set("knowledge", "know-1", "1.0.0");
    store.set("knowledge", "know-1", "2.0.0");
    expect(store.get("knowledge", "know-1")).toBe("2.0.0");
    expect(store.list().filter((r) => r.assetId === "know-1")).toHaveLength(1);
  });

  it("D12 Rollback is the same call, just targeting the older version again", () => {
    const store = new ActiveVersionStore(stateDir);
    store.set("knowledge", "know-1", "1.0.0");
    store.set("knowledge", "know-1", "2.0.0");
    // Rollback:
    store.set("knowledge", "know-1", "1.0.0");
    expect(store.get("knowledge", "know-1")).toBe("1.0.0");
  });

  it("keeps distinct assetIds (even of the same assetType) independent", () => {
    const store = new ActiveVersionStore(stateDir);
    store.set("knowledge", "know-1", "1.0.0");
    store.set("knowledge", "know-2", "3.0.0");
    expect(store.get("knowledge", "know-1")).toBe("1.0.0");
    expect(store.get("knowledge", "know-2")).toBe("3.0.0");
  });

  it("clear() removes the pointer (called when the last installed version is removed)", () => {
    const store = new ActiveVersionStore(stateDir);
    store.set("knowledge", "know-1", "1.0.0");
    store.clear("knowledge", "know-1");
    expect(store.get("knowledge", "know-1")).toBeNull();
  });

  it("clear() on an assetId with no pointer is a safe no-op", () => {
    const store = new ActiveVersionStore(stateDir);
    expect(() => store.clear("knowledge", "no-such-asset")).not.toThrow();
  });

  it("treats a corrupted state file as 'no pointers recorded' rather than crashing", () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "active-versions.json"), "{ not valid json");
    const store = new ActiveVersionStore(stateDir);
    expect(store.list()).toEqual([]);
    expect(store.get("knowledge", "know-1")).toBeNull();
  });
});
