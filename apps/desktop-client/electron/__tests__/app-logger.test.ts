import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppLogger } from "../app-logger";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-client-logger-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("AppLogger", () => {
  it("returns an empty list before anything is logged", () => {
    const logger = new AppLogger(tmpDir);
    expect(logger.readAll()).toEqual([]);
  });

  it("persists entries across instances (real file, not in-memory only)", () => {
    new AppLogger(tmpDir).info("bundle-install", "설치 성공");
    const second = new AppLogger(tmpDir);
    expect(second.readAll()).toHaveLength(1);
    expect(second.readAll()[0].message).toBe("설치 성공");
  });

  it("records level, module, and optional runId/traceId/errorCode", () => {
    const logger = new AppLogger(tmpDir);
    logger.error("asset-management", "Checksum 불일치", { runId: "r1", traceId: "t1", errorCode: "CHECKSUM_MISMATCH" });
    const [entry] = logger.readAll();
    expect(entry.level).toBe("ERROR");
    expect(entry.module).toBe("asset-management");
    expect(entry.runId).toBe("r1");
    expect(entry.traceId).toBe("t1");
    expect(entry.errorCode).toBe("CHECKSUM_MISMATCH");
    expect(typeof entry.timestamp).toBe("string");
  });

  it("preserves insertion order across multiple entries", () => {
    const logger = new AppLogger(tmpDir);
    logger.info("a", "1");
    logger.info("a", "2");
    logger.info("a", "3");
    expect(logger.readAll().map((e) => e.message)).toEqual(["1", "2", "3"]);
  });

  it("skips a corrupted line instead of failing the whole read", () => {
    const logger = new AppLogger(tmpDir);
    logger.info("a", "good-1");
    fs.appendFileSync(path.join(tmpDir, "logs", "app.log"), "{not valid json\n");
    logger.info("a", "good-2");
    expect(logger.readAll().map((e) => e.message)).toEqual(["good-1", "good-2"]);
  });
});
