import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    // The engine simulations run tens of thousands of games' steps; CI runners are slower than laptops.
    testTimeout: 60_000,
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      include: ["src/engine/**"],
      exclude: ["**/*.test.ts"],
      thresholds: { lines: 95, branches: 95 },
    },
  },
});
