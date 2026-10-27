// Throws (M21): the tray in an opponent's sheet, items landing over the table, and the real thing
// between two phones.
import { expect, type Page } from "@playwright/test";
import type { Toss } from "../src/protocol";
import { atTurnStart, show } from "./harness";
import { botStep, seatedRoom, startGame, test } from "./helpers";

const throwAt = (page: Page, toss: Omit<Toss, "id">) =>
  page.evaluate((toss) => {
    const detail = { toss: { ...toss, id: Date.now() } };
    window.dispatchEvent(new CustomEvent("skyjo:table", { detail }));
  }, toss);

test("M21: items live only in an opponent's sheet, 6 big buttons; spectators get none", async ({
  page,
}) => {
  for (const players of [2, 8]) {
    const turn = atTurnStart(players);
    await show(page, turn);
    await expect(page.locator(".tray-item")).toHaveCount(0);
    await page.getByTestId("opponent").first().click();
    const items = page.getByTestId("tray").locator(".tray-item");
    await expect(items).toHaveCount(6);
    for (const box of await items.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect()),
    )) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
    await show(page, { ...turn, seat: null });
    await page.getByTestId("opponent").first().click();
    await expect(page.getByTestId("zoom")).toBeVisible();
    await expect(page.getByTestId("tray")).toHaveCount(0);
  }
});

test("M21: a throw lands on its target without taking a tap, one per target, and the switch turns them off for good", async ({
  page,
}) => {
  const turn = atTurnStart(4);
  const me = turn.seat ?? 0;
  await show(page, turn);
  await throwAt(page, { from: (me + 1) % 4, to: me, item: "beer" });
  const toss = page.getByTestId("toss");
  await expect(toss).toHaveCount(1);
  await expect(toss).toHaveAttribute("data-item", "beer");
  // On your name bar, and taps go through it.
  const [landed, bar] = await Promise.all([
    toss.boundingBox(),
    page.getByTestId("mine-head").boundingBox(),
  ]);
  if (!landed || !bar) throw new Error("no box");
  expect(landed.y + landed.height / 2).toBeGreaterThanOrEqual(bar.y - 1);
  expect(landed.y + landed.height / 2).toBeLessThanOrEqual(bar.y + bar.height + 1);
  expect(await toss.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  // Another at the same target while it's there is dropped.
  await throwAt(page, { from: (me + 2) % 4, to: me, item: "bomb" });
  await expect(toss).toHaveCount(1);
  await expect(toss).toHaveCount(0, { timeout: 2_000 });

  await page.getByTestId("opponent").first().click();
  await page.getByRole("checkbox", { name: "Throws" }).click();
  await expect(page.getByTestId("tray").locator(".tray-item")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("table")).toBeVisible();
  await throwAt(page, { from: (me + 1) % 4, to: me, item: "donkey" });
  await page.waitForTimeout(300);
  await expect(toss).toHaveCount(0);
});

test("M21: Ana throws a donkey at Ben, who feels it; her items rest 3 s, and her next move isn't held up", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "pixel", "the server path; one device is enough");
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  const [ana, ben] = pages;
  await ben.evaluate(() => {
    const w = window as unknown as { buzzes: number[][] };
    w.buzzes = [];
    Object.defineProperty(navigator, "userActivation", { value: { hasBeenActive: true } });
    navigator.vibrate = (p) => {
      w.buzzes.push([p].flat() as number[]);
      return true;
    };
  });
  await startGame(ana);
  await ana.getByTestId("opponent").click();
  await ana.getByRole("button", { name: "Donkey" }).click();
  await expect(ana.getByTestId("zoom")).toHaveCount(0);
  await expect(ben.locator('[data-testid="toss"][data-item="donkey"]')).toHaveCount(1);
  await expect(ana.locator('[data-testid="toss"][data-item="donkey"]')).toHaveCount(1);
  await expect
    .poll(() => ben.evaluate(() => (window as unknown as { buzzes: number[][] }).buzzes))
    .toContainEqual([30, 50, 30, 50, 90]);
  await ana.getByTestId("opponent").click();
  await expect(ana.getByRole("button", { name: "Bomb" })).toBeDisabled();
  await expect(ana.getByRole("button", { name: "Bomb" })).toBeEnabled({ timeout: 4_000 });
  await ana.getByRole("button", { name: "Close" }).click();
  // A throw has no seq, so a flip right after it goes through at once.
  await ana.getByTestId("opponent").click();
  await ana.getByRole("button", { name: "Kiss" }).click();
  expect(await botStep(ana)).toBe(true);
  await expect(ana.getByTestId("my-grid").locator('[data-face="up"]')).toHaveCount(1);
});
