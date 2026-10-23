import { expect, type Page, test } from "@playwright/test";

/** Does whatever the table asks for (flip, draw from deck, discard and flip) until `done(phase)`. */
async function playUntil(page: Page, done: (phase: string) => boolean) {
  const table = page.getByTestId("table");
  const faceDown = page.getByTestId("my-grid").locator('button[data-face="down"]');
  for (let step = 0; step < 3000; step++) {
    const phase = (await table.getAttribute("data-phase")) ?? "";
    if (done(phase)) return;
    if (phase === "gameOver") throw new Error("game ended before the expected phase");
    if (phase === "roundOver") {
      await page.getByRole("button", { name: "Next round" }).click();
    } else if (phase === "flip") {
      await faceDown.first().click();
    } else if (phase === "draw") {
      await page.getByTestId("deck").click();
    } else if (phase === "place") {
      await page.getByTestId("discard").click();
      await expect(page.getByTestId("discard")).toHaveClass(/\bhl\b/);
      await faceDown.first().click();
    }
  }
  throw new Error("game did not finish");
}

async function start(page: Page, players: number, seed: number) {
  await page.goto(`/?seed=${seed}`);
  for (let n = 2; n < players; n++) {
    await page.getByRole("button", { name: "More players" }).click();
  }
  await page.getByRole("button", { name: "Start game" }).click();
}

async function expectMobileFriendly(page: Page) {
  const { scrollWidth, innerWidth, small } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    small: [...document.querySelectorAll("button:not(:disabled), input, summary")]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { label: el.getAttribute("aria-label") ?? el.textContent, w: r.width, h: r.height };
      })
      .filter((t) => t.w > 0 && (t.w < 44 || t.h < 44)),
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  expect(small).toEqual([]);
}

test("2-player hot-seat game runs to 100 points", async ({ page }) => {
  await start(page, 2, 7);
  await playUntil(page, (phase) => phase === "roundOver" || phase === "gameOver");
  await page.getByRole("button", { name: "View table" }).click();
  await expect(page.getByRole("table")).toBeHidden();
  await page.getByRole("button", { name: "Show scores" }).click();
  await playUntil(page, (phase) => phase === "gameOver");
  await expect(page.getByTestId("game-over")).toBeVisible();
  await expect(page.getByRole("heading", { name: /wins?!$/ })).toBeVisible();
});

test("8 players fit: no horizontal scroll, every tap target at least 44px", async ({ page }) => {
  await page.goto("/");
  await expectMobileFriendly(page);
  await start(page, 8, 3);
  await expect(page.getByTestId("opponent")).toHaveCount(7);
  await expectMobileFriendly(page);
  await playUntil(page, (phase) => phase === "draw");
  await expectMobileFriendly(page);
});

test("a hot-seat game survives a reload", async ({ page }) => {
  await start(page, 3, 5);
  await playUntil(page, (phase) => phase === "draw");
  const before = await page.getByTestId("my-grid").innerHTML();
  await page.reload();
  await expect(page.getByTestId("table")).toHaveAttribute("data-phase", "draw");
  expect(await page.getByTestId("my-grid").innerHTML()).toBe(before);
});

test("screenshots", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with npm run screenshots");
  const shot = (name: string) =>
    page.screenshot({ path: `docs/screenshots/m2/${name}.png`, animations: "disabled" });
  await page.goto("/?seed=11");
  await shot("01-home");
  await page.getByRole("button", { name: "Start game" }).click();
  await shot("02-flip");
  await playUntil(page, (phase) => phase === "draw");
  await shot("03-draw");
  await page.getByTestId("deck").click();
  await shot("04-drawn");
  await page.getByTestId("discard").click();
  await shot("05-discard-then-flip");
  await page.getByTestId("my-grid").locator('button[data-face="down"]').first().click();
  await playUntil(page, (phase) => phase === "roundOver");
  await shot("06-round-summary");
  await page.getByRole("button", { name: "View table" }).click();
  await shot("06b-view-table");
  await page.getByRole("button", { name: "Show scores" }).click();
  await playUntil(page, (phase) => phase === "gameOver");
  await shot("07-game-over");
  await page.evaluate(() => localStorage.clear());
  await start(page, 6, 11);
  await playUntil(page, (phase) => phase === "draw");
  await shot("08-six-players");
});
