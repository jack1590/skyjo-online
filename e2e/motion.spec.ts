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
