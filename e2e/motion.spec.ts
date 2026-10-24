import { expect, type Page, test } from "@playwright/test";

/**
 * Flips the first card of a fresh hot-seat game and reports whether the app started an animation.
 * Counts Element.animate calls rather than sampling getAnimations(), which is timing-dependent
 * across engines (it came back empty on CI's Linux WebKit).
 */
async function flipAnimates(page: Page): Promise<boolean> {
  await page.addInitScript(() => {
    const original = Element.prototype.animate;
    (window as unknown as { animations: number }).animations = 0;
    Element.prototype.animate = function (...args) {
      (window as unknown as { animations: number }).animations++;
      return original.apply(this, args);
    };
  });
  await page.goto("/?seed=7");
  await page.getByRole("button", { name: "Start game" }).click();
  await page.getByTestId("my-grid").locator("button").first().click();
  await page.waitForTimeout(200);
  return page.evaluate(() => (window as unknown as { animations: number }).animations > 0);
}

test.describe("with motion allowed", () => {
  test.use({ reducedMotion: "no-preference" });

  test("a flipped card animates", async ({ page }) => {
    expect(await flipAnimates(page)).toBe(true);
  });
});

test("reduced motion: nothing animates", async ({ page }) => {
  expect(await flipAnimates(page)).toBe(false);
});

test("flights video for the PR", async ({ browser }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
  const context = await browser.newContext({
    ...info.project.use,
    reducedMotion: "no-preference",
    recordVideo: { dir: "test-results/flights-video", size: { width: 390, height: 664 } },
  });
  const page = await context.newPage();
  const pause = () => page.waitForTimeout(700);
  await page.goto("/?seed=11");
  await page.getByRole("button", { name: "Start game" }).click();
  const grid = page.getByTestId("my-grid");
  for (let i = 0; i < 2; i++) {
    await grid.locator('button[data-face="down"]').first().click(); // flip
    await pause();
  }
  await page.getByRole("button", { name: /^Pass to / }).click();
  for (let i = 0; i < 2; i++) {
    await grid.locator('button[data-face="down"]').first().click();
    await pause();
  }
  await page.getByRole("button", { name: /^Pass to / }).click();
  await page.getByTestId("deck").click(); // deck → drawn
  await pause();
  await grid.locator("button").nth(5).click(); // drawn → grid, old card → discard
  await pause();
  await page.getByRole("button", { name: /^Pass to / }).click();
  await page.getByTestId("deck").click();
  await pause();
  await page.getByTestId("discard").click(); // discard mode
  await grid.locator('button[data-face="down"]').first().click(); // drawn → discard, flip
  await page.waitForTimeout(1200);
  await context.close();
});
