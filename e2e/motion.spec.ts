import { expect, type Page, test } from "@playwright/test";
import { seatedRoom, startGame } from "./helpers";

/** Counts Element.animate calls (deterministic across engines, unlike sampling getAnimations()). */
const countAnimations = (page: Page) =>
  page.addInitScript(() => {
    const original = Element.prototype.animate;
    (window as unknown as { animations: number }).animations = 0;
    Element.prototype.animate = function (...args) {
      (window as unknown as { animations: number }).animations++;
      return original.apply(this, args);
    };
  });

/** Ana flips her first card in a fresh 2-phone game; did Ben's phone animate it? */
async function opponentFlipAnimates(pages: Page[]): Promise<boolean> {
  await countAnimations(pages[1]);
  await pages[1].reload();
  await startGame(pages[0]);
  await pages[0].getByTestId("my-grid").locator("button").first().click();
  await pages[1].waitForTimeout(400);
  return pages[1].evaluate(() => (window as unknown as { animations: number }).animations > 0);
}

test.describe("with motion allowed", () => {
  test.use({ reducedMotion: "no-preference" });

  test("an opponent's flip animates on everyone's phone", async ({ browser }, info) => {
    const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"], {
      reducedMotion: "no-preference",
    });
    expect(await opponentFlipAnimates(pages)).toBe(true);
  });
});

test("reduced motion: nothing animates", async ({ browser }, info) => {
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  expect(await opponentFlipAnimates(pages)).toBe(false);
});

test("flights video for the PR", async ({ browser }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"], {
    reducedMotion: "no-preference",
    recordVideo: { dir: "test-results/flights-video", size: { width: 390, height: 664 } },
  });
  const [ana, ben] = pages;
  const pause = () => ana.waitForTimeout(700);
  await startGame(ana);
  for (const page of [ana, ben]) {
    for (let i = 0; i < 2; i++) {
      await page.getByTestId("my-grid").locator('button[data-face="down"]').first().click();
      await pause();
    }
  }
  for (let turn = 0; turn < 3; turn++) {
    const mover =
      (await ana.getByTestId("table").getAttribute("data-myturn")) === "true" ? ana : ben;
    await mover.getByTestId("deck").click();
    await pause();
    if (turn === 1) {
      await mover.getByTestId("discard").click();
      await mover.getByTestId("my-grid").locator('button[data-face="down"]').first().click();
    } else {
      await mover.getByTestId("my-grid").locator("button").nth(5).click();
    }
    await pause();
  }
  await ana.waitForTimeout(800);
  await ana.context().close(); // writes Ana's video
});
