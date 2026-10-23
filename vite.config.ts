import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    coverage: {
      include: ["src/engine/**"],
      exclude: ["**/*.test.ts"],
      thresholds: { lines: 95, branches: 95 },
    },
  },
});
