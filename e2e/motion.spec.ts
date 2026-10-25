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
  // Ben's reloaded page must show the deal before Ana flips, or his first view already holds the
  // flip and there is nothing to animate (10 of 40 runs at 12 workers, PR #21).
  await expect(pages[1].getByTestId("table")).toHaveAttribute("data-phase", "flip");
  await pages[0].getByTestId("my-grid").locator("button").first().click();
  await expect(pages[1].getByTestId("opponent").locator('[data-face="up"]')).toHaveCount(1);
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
