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
import type { ChecksumVerification, InstalledAsset, KnowledgeActivation } from "./types";

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

  /** D-079 "활성화" 결과를 기존 레코드에 병합 저장한다 —
   * `updateChecksumVerification`과 동일한 패턴. 대상 레코드가 없으면 조용히
   * 아무 것도 하지 않는다(호출자가 이미 `find`로 존재를 확인). `null`을
   * 넘기면(명시적 비활성화) 필드 자체를 지운다 — "필드 없음(미시도)"과
   * 구분되는 세 번째 값이 아니라, 두 경우 모두 `activation`이 falsy이므로
   * 화면에는 동일하게 "활성화 안 됨"으로 보인다(그것이 정확한 사실이다). */
  updateActivation(
    assetType: string,
    assetId: string,
    version: string,
    activation: KnowledgeActivation | null,
  ): void {
    const all = this.list();
    const idx = all.findIndex((a) => a.assetType === assetType && a.assetId === assetId && a.version === version);
    if (idx === -1) return;
    all[idx] = { ...all[idx], activation };
    this.save(all);
  }

  /** Records an independently verified AssetVersion id for a legacy
   * installation. Existing non-null values are never overwritten. */
  backfillAssetVersionId(assetType: string, assetId: string, version: string, assetVersionId: string): boolean {
    const all = this.list();
    const idx = all.findIndex((a) => a.assetType === assetType && a.assetId === assetId && a.version === version);
    if (idx === -1 || all[idx].assetVersionId) return false;
    all[idx] = { ...all[idx], assetVersionId };
    this.save(all);
    return true;
  }

  private save(records: InstalledAsset[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(records, null, 2), "utf-8");
  }
}
