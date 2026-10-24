import { expect, type Page, test } from "@playwright/test";

/** Flips the first card of a fresh hot-seat game and reports whether any animation ran on it. */
async function flipAnimates(page: Page): Promise<boolean> {
  await page.goto("/?seed=7");
  await page.getByRole("button", { name: "Start game" }).click();
  return page.evaluate(async () => {
    const card = document.querySelector<HTMLElement>('[data-testid="my-grid"] button');
    if (!card) throw new Error("no card");
    card.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const target = document.querySelector('[data-testid="my-grid"]')?.children[0];
    return (target?.getAnimations().length ?? 0) > 0;
  });
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
