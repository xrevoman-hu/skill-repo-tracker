import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { SAFARI_15_OBJECT_HAS_OWN_BANNER } from "./scripts/browser-compatibility-contract.mjs";

export default defineConfig({
  build: {
    target: "safari15",
    cssTarget: "safari15",
    sourcemap: false,
    rolldownOptions: {
      output: { postBanner: SAFARI_15_OBJECT_HAS_OWN_BANNER },
    },
  },
  clearScreen: false,
  publicDir: false,
  css: {
    postcss: { plugins: [] },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
  },
  plugins: [react()],
});
