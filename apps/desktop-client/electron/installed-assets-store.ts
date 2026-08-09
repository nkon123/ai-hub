// Installed-asset registry — M04, `02-desktop-and-agent-runtime.md` §2 로컬
// 디렉터리 (`state/installations.db`).
//
// PoC deviation: the spec names this file `installations.db` (implying
// SQLite), but a single JSON array is sufficient for the PoC's scale (a
// handful of Offline Bundle imports) and avoids pulling in a native/sqlite
// dependency just for this. `packages/schemas` does not yet define this
// record shape (D04 is new), so this stays a local M04 concern behind
// `InstalledAssetsStore` — nothing outside this module reads the file layout
// directly (RuntimeFacade-style boundary per `02-desktop-and-agent-runtime.md`
// §1).

import fs from "node:fs";
import path from "node:path";
import type { ChecksumVerification, InstalledAsset } from "./types";

export class InstalledAssetsStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, "installations.json");
  }

  list(): InstalledAsset[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as InstalledAsset[]) : [];
    } catch {
      // Corrupted state file: treat as empty rather than crashing the app
      // (CLAUDE.md — Desktop는 Runtime/상태 장애 시 종료되지 않는다).
      return [];
    }
  }

  find(assetType: string, assetId: string, version: string): InstalledAsset | undefined {
    return this.list().find((a) => a.assetType === assetType && a.assetId === assetId && a.version === version);
  }

  upsert(asset: InstalledAsset): void {
    const all = this.list().filter(
      (a) => !(a.assetType === asset.assetType && a.assetId === asset.assetId && a.version === asset.version),
    );
    all.push(asset);
    this.save(all);
  }

  remove(assetType: string, assetId: string, version: string): void {
    const all = this.list().filter(
      (a) => !(a.assetType === assetType && a.assetId === assetId && a.version === version),
    );
    this.save(all);
  }

  /** D08 "Checksum 재검사" 결과를 기존 레코드에 병합 저장한다. 대상 레코드가
   * 없으면 조용히 아무 것도 하지 않는다(재검사 IPC 핸들러가 그 전에 이미
   * `find`로 존재를 확인하므로 정상 흐름에서는 발생하지 않는다). */
  updateChecksumVerification(
    assetType: string,
    assetId: string,
    version: string,
    verification: ChecksumVerification,
  ): void {
    const all = this.list();
    const idx = all.findIndex((a) => a.assetType === assetType && a.assetId === assetId && a.version === version);
    if (idx === -1) return;
    all[idx] = { ...all[idx], checksumVerification: verification };
    this.save(all);
  }

  private save(records: InstalledAsset[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(records, null, 2), "utf-8");
  }
}
