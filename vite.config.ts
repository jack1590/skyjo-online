import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  // The Cloudflare plugin runs the Worker and Durable Object inside dev/preview. Unit tests and the
  // Node self-host build (`--mode node`) don't want it.
  plugins: [react(), ...(process.env.VITEST || mode === "node" ? [] : [cloudflare()])],
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
}));
