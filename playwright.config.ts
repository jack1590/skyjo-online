import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;
/** Run against an already-deployed site (post-deploy smoke test) instead of a local server. */
const BASE_URL = process.env.BASE_URL;
/** SERVER=node runs the suite against the Node self-host adapter instead of the local Worker. */
const NODE = process.env.SERVER === "node";
const build = CI ? "" : NODE ? "npm run build && npm run build:node && " : "npm run build && ";
const serve = NODE
  ? "PORT=4173 node dist/node/node.js"
  : "npm run preview -- --port 4173 --strictPort";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // A retry may rescue a run, but a flaky test still fails CI (delivery health: no flaky jobs).
  failOnFlakyTests: CI,
  reporter: CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL ?? "http://localhost:4173",
    trace: "retain-on-failure",
    locale: "en-US",
  },
  webServer: BASE_URL
    ? undefined
    : {
        // CI builds in an earlier step.
        command: build + serve,
        url: "http://localhost:4173",
        reuseExistingServer: !CI,
      },
  projects: [
    { name: "iphone", use: { ...devices["iPhone 13"] } },
    { name: "pixel", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
});
