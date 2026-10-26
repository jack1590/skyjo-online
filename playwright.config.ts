import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;
/** Run against an already-deployed site (post-deploy smoke test) instead of a local server. */
const BASE_URL = process.env.BASE_URL;
/** SERVER=node runs the suite against the Node self-host adapter instead of the local Worker. */
const NODE = process.env.SERVER === "node";
/** Local port for the server under test; change it when another checkout is already serving 4173. */
const PORT = Number(process.env.E2E_PORT ?? 4173);
/** The Node server binds loopback IPv4 only; vite preview answers on "localhost". */
const ORIGIN = `http://${NODE ? "127.0.0.1" : "localhost"}:${PORT}`;
const build = CI ? "" : NODE ? "npm run build && npm run build:node && " : "npm run build && ";
const serve = NODE
  ? `PORT=${PORT} node dist/node/node.js`
  : `npm run preview -- --port ${PORT} --strictPort`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // A retry may rescue a run, but a flaky test still fails CI (delivery health: no flaky jobs).
  failOnFlakyTests: CI,
  reporter: CI ? [["list"], ["./e2e/probe-reporter.ts"]] : "list",
  use: {
    baseURL: BASE_URL ?? ORIGIN,
    trace: "retain-on-failure",
    locale: "en-US",
    // Card-flight animations would make every click wait for movement to settle; motion.spec.ts
    // opts back in to test them.
    reducedMotion: "reduce",
  },
  webServer: BASE_URL
    ? undefined
    : {
        // CI builds in an earlier step.
        command: build + serve,
        url: ORIGIN,
        // Never test a server we didn't start: a stale build on the port would pass or fail for
        // the wrong reasons. A busy port fails loudly instead.
        reuseExistingServer: false,
      },
  projects: [
    // At 4 workers on CI (ci.yml) WebKit's 2-phone tests take 26–35 s, past the default 30 s (PR #17).
    { name: "iphone", use: { ...devices["iPhone 13"] }, timeout: CI ? 60_000 : 30_000 },
    { name: "pixel", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
});
