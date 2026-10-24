import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/** Files from public/ the app needs offline (the build's own files are added automatically). */
const PUBLIC_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

/**
 * Emits /sw.js from src/client/sw.js with this build's full file list to precache and a cache
 * name derived from it, so every deploy installs a fresh cache and drops the old one.
 */
function precacheServiceWorker(): Plugin {
  return {
    name: "precache-service-worker",
    apply: "build",
    generateBundle(_, bundle) {
      if (this.environment.name !== "client") return; // not the Worker or Node server builds
      const built = Object.keys(bundle)
        .filter((file) => !file.endsWith(".map") && file !== "index.html")
        .map((file) => `/${file}`);
      const precache = [...PUBLIC_SHELL, ...built];
      const version = createHash("sha256").update(precache.join()).digest("hex").slice(0, 12);
      const source = readFileSync("src/client/sw.js", "utf8")
        .replace("self.__PRECACHE__", JSON.stringify(precache))
        .replace("__VERSION__", version);
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig(({ mode }) => ({
  // The Cloudflare plugin runs the Worker and Durable Object inside dev/preview. Unit tests and the
  // Node self-host build (`--mode node`) don't want it.
  plugins: [
    react(),
    precacheServiceWorker(),
    ...(process.env.VITEST || mode === "node" ? [] : [cloudflare()]),
  ],
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
