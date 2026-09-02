import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
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
