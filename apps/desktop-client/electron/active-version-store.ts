// D12 업데이트/복구 — Active Pointer 저장소 (`02-desktop-and-agent-runtime.md`
// §2, `state/active-versions.json`). D-068이 확인한 공백(설치 레이아웃에는
// 같은 자산의 여러 버전이 나란히 설치되지만 그중 "지금 쓰는 버전"이 무엇인지
// 가리키는 포인터가 없었다)을 실제로 메우는 저장소 — `InstalledAssetsStore`와
// 동일한 관례(단일 JSON 파일, PoC 규모)를 따르되 별개 파일로 분리한다: 설치
// 레코드(무엇이 설치돼 있는가)와 Active 여부(그중 무엇을 지금 쓰는가)는 서로
// 다른 수명주기를 가지기 때문이다 — 자산을 재설치해도 Active 지정은 유지돼야
// 하고, Active 지정을 바꿔도 설치 레코드 자체는 바뀌지 않는다.
//
// 포인터가 아예 없는 assetId는 "아직 한 번도 명시적으로 전환한 적 없음"을
// 뜻한다 — `computeAssetStatus`(asset-status.ts)가 이 경우를 절대 INACTIVE로
// 단정하지 않고 ACTIVE로 취급하는 것과 짝을 이룬다(근거 없이 상태를 지어내지
// 않는다는 D-068의 원칙을 포인터 도입 이후에도 유지).
import fs from "node:fs";
import path from "node:path";

export interface ActiveVersionRecord {
  assetType: string;
  assetId: string;
  activeVersion: string;
}

export class ActiveVersionStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, "active-versions.json");
  }

  list(): ActiveVersionRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ActiveVersionRecord[]) : [];
    } catch {
      // Corrupted state file: treat as "no pointers recorded yet" rather than
      // crashing the app (CLAUDE.md — Runtime/상태 장애 시 종료되지 않는다).
      // Every version then reads as ACTIVE (see module docstring) — a safe
      // fallback that never blocks usage, only loses the "which is active"
      // distinction until the user re-activates one explicitly.
      return [];
    }
  }

  /** `null` = no pointer recorded for this assetId yet (see module docstring
   * — callers must NOT treat this as "no active version exists"). */
  get(assetType: string, assetId: string): string | null {
    const found = this.list().find((r) => r.assetType === assetType && r.assetId === assetId);
    return found ? found.activeVersion : null;
  }

  /** D12 "Active Pointer 전환" / "이전 버전 Rollback" — both are exactly this
   * same call (Rollback is switching to a version that happens to be older;
   * there is no separate rollback code path to keep in sync). */
  set(assetType: string, assetId: string, version: string): void {
    const all = this.list().filter((r) => !(r.assetType === assetType && r.assetId === assetId));
    all.push({ assetType, assetId, activeVersion: version });
    this.save(all);
  }

  /** Called once the last remaining installed version of an asset is
   * removed — leaves no dangling pointer to a version that no longer exists
   * on disk. */
  clear(assetType: string, assetId: string): void {
    const all = this.list().filter((r) => !(r.assetType === assetType && r.assetId === assetId));
    this.save(all);
  }

  private save(records: ActiveVersionRecord[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(records, null, 2), "utf-8");
  }
}
