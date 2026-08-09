// Opts this route out of the portal chrome (the sticky nav + centered <main> padding
// from the root app/layout.tsx). Next.js nested layouts can only add to an ancestor
// layout, never remove its markup, so the root nav/<main> are still in the DOM — this
// layout instead covers the full viewport with its own stacking context (z-index above
// the nav's z-50) so the end-user chat screen reads as standalone, without touching or
// altering app/layout.tsx (which every other route still depends on unchanged).
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 z-[60] overflow-y-auto bg-background">{children}</div>;
}
