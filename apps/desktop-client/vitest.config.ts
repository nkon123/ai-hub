import { defineConfig } from "vitest/config";

// Dedicated Vitest config for the Electron-side verification/install logic
// (electron/**/*.test.ts) and pure renderer-side logic (src/**/*.test.ts —
// e.g. runStages.ts, the D06 SSE-driven stage machine). Kept separate from
// vite.config.ts (renderer build) so the test run never pulls in the React
// plugin or jsdom — everything under test here is pure Node/TS logic, no
// DOM or React rendering involved.
export default defineConfig({
  test: {
    environment: "node",
    include: ["electron/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 20000,
  },
});
