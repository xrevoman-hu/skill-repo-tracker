import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/testSetup.ts"],
    css: false,
    exclude: [...configDefaults.exclude, "scripts/__tests__/**", "e2e/**"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/frontend",
      reporter: ["text", "json-summary", "lcov"],
      include: ["src/**/*.{ts,tsx,mts,cts}"],
      exclude: [
        "src/**/*.test.{ts,tsx,mts,cts}",
        "src/**/*.d.{ts,mts,cts}",
        "src/testSetup.ts",
      ],
    },
  },
});
