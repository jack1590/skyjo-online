// Regenerates the README's images of the current game (docs/readme/). Run `npm run shots:readme`
// whenever the UI changes (the PR checklist in AGENTS.md requires it). Needs ffmpeg for the GIF.
import { execFileSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { toView } from "../src/engine/view";
import { atTurnStart, roundOver, show } from "./harness";
import { botStep, seatedRoom, startGame } from "./helpers";

test.skip(!process.env.SHOTS, "run with npm run shots:readme");

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `docs/readme/${name}.jpg`,
    type: "jpeg",
    quality: 82,
    scale: "css",
    animations: "disabled",
  });

test("README stills", async ({ browser, page }, info) => {
  await page.goto("/");
  const gotIt = page.getByRole("button", { name: "Got it" });
  if (await gotIt.count()) await gotIt.click();
  await shot(page, "home");

  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben", "Cris", "Dani"]);
  // Show the live site's address, not the test server's.
  await pages[0].locator(".link").evaluate((el) => {
    el.textContent =
      el.textContent?.replace(location.origin, "https://skyjo-online.jcarl-30.workers.dev") ?? "";
  });
  await shot(pages[0], "lobby");

  await show(page, atTurnStart(4));
  await shot(page, "table-4");
  await show(page, atTurnStart(8));
  await shot(page, "table-8");
  await page.getByTestId("opponent").first().click();
  await expect(page.getByTestId("zoom")).toBeVisible();
  await shot(page, "zoom");
  await show(page, { view: toView(roundOver(2, 11)), seat: 0, lead: true });
  await shot(page, "summary");
});

/** Few colors and frame-to-frame diffs keep the GIF near 1 MB despite the detailed card art. */
const PALETTE =
  "[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle";

test("README card-flight GIF", async ({ browser }, info) => {
  const t0 = Date.now();
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"], {
    reducedMotion: "no-preference",
    recordVideo: { dir: "test-results/readme-video", size: { width: 390, height: 664 } },
  });
  const [ana, ben] = pages;
  await startGame(ana);
  const tableShown = (Date.now() - t0) / 1000; // the video starts with the page: skip the lobby
  const grid = ana.getByTestId("my-grid");
  const faceDown = grid.locator('button[data-face="down"]');
  const pause = () => ana.waitForTimeout(800);
  while (await botStep(ben)); // Ben flips his two
  for (let i = 0; i < 2; i++) {
    await faceDown.first().click();
    await pause();
  }
  for (const slot of [5, "discard", 10] as const) {
    while (await botStep(ben)) await pause(); // Ben's turn plays out in the strip
    await expect(ana.getByTestId("table")).toHaveAttribute("data-myturn", "true");
    await ana.getByTestId("deck").click();
    await pause();
    if (slot === "discard") {
      await ana.getByTestId("discard").click();
      await faceDown.first().click();
    } else {
      await grid.locator("button").nth(slot).click();
    }
    await pause();
  }
  const done = (Date.now() - t0) / 1000;
  const video = ana.video();
  await ana.context().close(); // finishes writing the video
  execFileSync("ffmpeg", [
    ...["-loglevel", "error", "-y", "-ss", String(tableShown), "-to", String(done)],
    ...["-i", String(await video?.path())],
    ...["-vf", `fps=10,scale=300:-1:flags=lanczos,split[a][b];${PALETTE}`],
    "docs/readme/card-flights.gif",
  ]);
});
