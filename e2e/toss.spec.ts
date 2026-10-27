// Throws (M21, M22): the tray in an opponent's sheet, items landing over the table and leaving their
// mark, and the real thing between two phones.
import { expect, type Page } from "@playwright/test";
import type { Toss } from "../src/protocol";
import { atTurnStart, show } from "./harness";
import { botStep, seatedRoom, startGame, test } from "./helpers";

const throwAt = (page: Page, toss: Omit<Toss, "id">) =>
  page.evaluate((toss) => {
    // Not Date.now(): tests with a frozen clock throw several in the same millisecond.
    const detail = { toss: { ...toss, id: Math.floor(Math.random() * 2 ** 31) } };
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

test("M21: a throw lands on its target without taking a tap, one buzz at a time, and the switch turns them off for good", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { buzzes: number[][] };
    w.buzzes = [];
    Object.defineProperty(navigator, "userActivation", { value: { hasBeenActive: true } });
    navigator.vibrate = (p) => {
      w.buzzes.push([p].flat() as number[]);
      return true;
    };
  });
  // Throws only: your turn starting buzzes too, a single 40.
  const buzzes = () =>
    page.evaluate(() =>
      (window as unknown as { buzzes: number[][] }).buzzes.filter((b) => b.length > 1),
    );
  await page.clock.install();
  const turn = atTurnStart(4);
  const me = turn.seat ?? 0;
  await show(page, turn);
  await throwAt(page, { from: (me + 1) % 4, to: me, item: "beer" });
  await page.clock.runFor(1);
  await expect(page.getByRole("status").filter({ hasText: "threw you: Beer" })).toHaveCount(1);
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
  await expect.poll(buzzes).toEqual([[40, 40, 40, 40]]);
  // Without motion (M22): nothing flies or shakes, and the mark is on your name bar at once.
  await expect(page.locator("section.mine > [data-testid=toss-decal]")).toHaveCount(1);
  expect(await page.locator(".toss-fly").evaluate((el) => el.getAnimations().length)).toBe(0);
  expect(await page.evaluate(() => document.getElementById("root")?.getAnimations().length)).toBe(
    0,
  );
  // Another at the same target lands too (M22), but a second buzz within 0.6 s is skipped.
  await throwAt(page, { from: (me + 2) % 4, to: me, item: "bomb" });
  await page.clock.runFor(1);
  await expect(toss).toHaveCount(2);
  expect(await buzzes()).toEqual([[40, 40, 40, 40]]);
  await page.clock.runFor(2300);
  await expect(toss).toHaveCount(0);
  await expect(page.getByTestId("toss-decal")).toHaveCount(0);

  await page.getByTestId("opponent").first().click();
  await page.getByRole("checkbox", { name: "Throws" }).click();
  await expect(page.getByTestId("tray").locator(".tray-item")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("table")).toBeVisible();
  await throwAt(page, { from: (me + 1) % 4, to: me, item: "donkey" });
  await page.waitForTimeout(300);
  await expect(toss).toHaveCount(0);
});

test.describe("with motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("M22: throws hit their target's panel and leave a mark there, up to 3 at once, yours always; a bomb at you shakes your table", async ({
    page,
  }) => {
    await page.clock.install();
    const turn = atTurnStart(8);
    const me = turn.seat ?? 0;
    await show(page, turn);
    const panel = page.getByTestId("opponent").first();
    const target =
      Number(((await panel.locator(".opp-name").textContent()) ?? "").replace(/\D/g, "")) - 1;
    const others = [0, 1, 2, 3, 4, 5, 6, 7].filter((s) => s !== me && s !== target);
    const tosses = page.getByTestId("toss");
    const marks = page.getByTestId("toss-decal");
    const of = (item: string) => page.locator(`[data-testid="toss"][data-item="${item}"]`);
    const quakes = () =>
      page.evaluate(
        () =>
          document
            .getElementById("root")
            ?.getAnimations()
            .filter((a) => a.id === "toss-quake").length,
      );

    // The mark goes inside the target's panel, clipped to it, and the panel takes the hit.
    await throwAt(page, { from: others[0], to: target, item: "tomato" });
    await expect(panel.getByTestId("toss-decal")).toHaveCount(1);
    expect(
      await panel.getByTestId("toss-decal").evaluate((el) => getComputedStyle(el).overflow),
    ).toBe("hidden");
    expect(
      await panel.evaluate((el) => el.getAnimations().some((a) => a.id === "toss-knock")),
    ).toBe(true);
    expect(await quakes()).toBe(0);
    // Three land on one player, a little apart; a fourth is dropped, unless it's yours.
    await throwAt(page, { from: others[1], to: target, item: "kiss" });
    await throwAt(page, { from: others[2], to: target, item: "slipper" });
    await expect(panel.getByTestId("toss-decal")).toHaveCount(3);
    const lefts = await tosses.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().left),
    );
    expect(new Set(lefts).size).toBe(3);
    await throwAt(page, { from: others[3], to: target, item: "beer" });
    await expect(of("beer")).toHaveCount(0);
    await throwAt(page, { from: me, to: target, item: "donkey" });
    await expect(of("donkey")).toHaveCount(1);
    await expect(of("tomato")).toHaveCount(0);
    await expect(tosses).toHaveCount(3);

    // A bomb at you shakes your whole table, its mark sits on your name bar, and taps still reach
    // your cards under the blast.
    await throwAt(page, { from: others[4], to: me, item: "bomb" });
    await expect.poll(quakes).toBe(1);
    await expect(page.locator("section.mine > [data-testid=toss-decal]")).toHaveCount(1);
    const card = await page.getByTestId("my-grid").locator(".card").first().boundingBox();
    if (!card) throw new Error("no card");
    expect(
      await page.evaluate(
        ([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-testid="my-grid"]'),
        [card.x + card.width / 2, card.y + 8],
      ),
    ).toBe(true);

    // The marks are still there at 1.2 s, and everything is gone by 2.5 s.
    await page.clock.runFor(1200);
    await expect(marks).toHaveCount(4);
    await page.clock.runFor(1300);
    await expect(marks).toHaveCount(0);
    await expect(tosses).toHaveCount(0);

    // Only a bomb at you shakes your table: one between two others doesn't. Its flight mounts
    // with any quake it would start, so once it shows, there would be one.
    await throwAt(page, { from: others[5], to: others[0], item: "bomb" });
    await expect(of("bomb")).toHaveCount(1);
    expect(await quakes()).toBe(0);
  });
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
    .toContainEqual([20, 60, 20, 60, 110]);
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
