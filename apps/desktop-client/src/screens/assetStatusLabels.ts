// Shared Active/Inactive/Invalid/Revoked labels — extracted out of
// AssetsScreen.tsx (D08) so D02(HomeScreen)/D12(UpdateScreen) can show the
// exact same Korean labels and tone instead of a second hand-copied map
// silently drifting from it.
import type { AssetStatus } from "../../electron/types";

export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  INVALID: "Invalid",
  REVOKED: "Revoked",
};

export const ASSET_STATUS_TONE: Record<AssetStatus, string> = {
  ACTIVE: "bg-success/10 text-success",
  INACTIVE: "bg-slate-100 text-text-muted",
  INVALID: "bg-danger/10 text-danger",
  REVOKED: "bg-danger/10 text-danger",
};
