import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Desktop Client renderer (M04). `base: "./"` is required so the built
// index.html uses relative asset paths — production loads it via
// `win.loadFile()` (file:// protocol), where root-absolute paths ("/assets/..")
// would not resolve.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
