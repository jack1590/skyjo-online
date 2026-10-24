// Layout checks at exact game states, through the test-only table harness (src/client/App.tsx):
// the page renders a static table from an injected view instead of playing up to that state.
import { expect, type Page, test } from "@playwright/test";
import { apply, createGame, type GameState, legalActions } from "../src/engine/game";
import { type GameView, toView } from "../src/engine/view";

/** A game one move into its last turns: someone revealed everything; the next player is to draw. */
function lastTurnGame(players: number, seed: number): GameState {
  const names = Array.from({ length: players }, (_, i) => `Player ${i + 1}`);
  let state = createGame(names, [seed, 0, 0, 0]);
  while (state.ender === null || state.phase !== "draw") {
    const legal = legalActions(state);
    // Discard-and-flip (listed last) always reveals a card, so the round heads for its end.
    state = apply(state, legal[state.phase === "place" ? legal.length - 1 : 0]);
  }
  return state;
}

/** The finished round: everyone takes their last turn the same way. */
function roundOver(players: number, seed: number): GameState {
  let state = lastTurnGame(players, seed);
  while (state.phase === "draw" || state.phase === "place") {
    const legal = legalActions(state);
    state = apply(state, legal[state.phase === "place" ? legal.length - 1 : 0]);
  }
  return state;
}

interface Shown {
  view: GameView;
  seat: number | null;
  lead?: boolean;
}

async function show(page: Page, table: Shown) {
  await page.addInitScript((t) => {
    (window as unknown as { __SKYJO_TABLE__: unknown }).__SKYJO_TABLE__ = t;
  }, table);
  await page.goto("/");
  await expect(page.getByTestId("table")).toBeVisible();
}

/** The table as seen by the player about to move (seat = current). */
const atTurnStart = (players: number, seed = 3): Shown => {
  const state = lastTurnGame(players, seed);
  return { view: toView(state), seat: state.current };
};

async function expectMobileFriendly(page: Page) {
  const { scrollWidth, innerWidth, small } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    small: [...document.querySelectorAll("button:not(:disabled), input, select, summary")]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { label: el.getAttribute("aria-label") ?? el.textContent, w: r.width, h: r.height };
      })
      .filter((t) => t.w > 0 && (t.w < 44 || t.h < 44)),
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  expect(small).toEqual([]);
}

for (const players of [2, 3, 4, 5, 6, 7, 8]) {
  test(`${players} players: fits, every tap target ≥ 44px, opponents' numbers readable`, async ({
    page,
  }) => {
    await show(page, atTurnStart(players));
    await expectMobileFriendly(page);
    await expect(page.getByTestId("opponent")).toHaveCount(players - 1);
    const smallest = await page.evaluate(() =>
      Math.min(
        ...[...document.querySelectorAll('[data-testid="opponent"] .num')].map((n) =>
          Number.parseFloat(getComputedStyle(n).fontSize),
        ),
      ),
    );
    expect(smallest).toBeGreaterThanOrEqual(12);
  });
}

test("8 players: the strip scrolls sideways and keeps whoever is playing in view", async ({
  page,
}) => {
  const state = lastTurnGame(8, 3);
  const me = (state.current + 2) % 8; // the player to move sits far down the strip
  await show(page, { view: toView(state), seat: me });
  const strip = page.getByTestId("opponents");
  expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const active = page.locator('[data-testid="opponent"].active');
  await expect(active).toBeInViewport();
});

test("tapping an opponent shows their whole grid at full size", async ({ page }) => {
  await show(page, atTurnStart(6));
  const first = page.getByTestId("opponent").first();
  await first.click();
  const zoom = page.getByTestId("zoom");
  await expect(zoom).toBeVisible();
  await expect(zoom.getByRole("img")).toHaveCount(12);
  await zoom.getByRole("button", { name: "Close" }).click();
  await expect(zoom).toBeHidden();
});

test("a spectator sees everyone in two columns", async ({ page }) => {
  const state = lastTurnGame(8, 3);
  await show(page, { view: toView(state), seat: null });
  await expectMobileFriendly(page);
  const boxes = await page
    .getByTestId("opponent")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
  expect(new Set(boxes.map(Math.round)).size).toBe(2);
});

test("round summary: rows, who ended, doubling shown as base ×2 = total; View table hides it", async ({
  page,
}) => {
  // Seed 11: round 1 ends below 100 and the ender is doubled.
  const state = roundOver(2, 11);
  await show(page, { view: toView(state), seat: 0, lead: true });
  const summary = page.getByTestId("round-summary");
  await expect(summary.getByRole("row")).toHaveCount(3);
  await expect(summary.getByText("ended")).toBeVisible();
  if (state.doubled) await expect(summary.getByText(/×2 = \d+/)).toBeVisible();
  await page.getByRole("button", { name: "View table" }).click();
  await expect(page.getByRole("table")).toBeHidden();
  await page.getByRole("button", { name: "Show scores" }).click();
  await expect(page.getByRole("button", { name: "Next round" })).toBeVisible();
});

test.describe("small phone (375×548)", () => {
  test.use({ viewport: { width: 375, height: 548 } });

  const gridInView = async (page: Page) =>
    expect(async () => {
      const box = await page.getByTestId("my-grid").boundingBox();
      expect(box?.y).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(548 + 1); // subpixels
    }).toPass();

  for (const players of [2, 8]) {
    test(`${players} players: your whole grid is on screen when your turn starts`, async ({
      page,
    }) => {
      await show(page, atTurnStart(players));
      await gridInView(page);
      await expectMobileFriendly(page);
    });
  }

  test.describe("with motion allowed (smooth scroll)", () => {
    test.use({ reducedMotion: "no-preference" });

    for (const players of [2, 8]) {
      test(`${players} players: the grid scrolls fully into view`, async ({ page }, info) => {
        // Headless WebKit never animates smooth scrolling in an overflow container (a Playwright
        // limit, not an app bug), so the smooth path is checked in Chromium only.
        test.skip(info.project.name !== "pixel", "smooth scroll is checked in Chromium");
        await show(page, atTurnStart(players));
        await gridInView(page);
      });
    }
  });
});

test("screenshots: 2–8 players", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
  const shot = (name: string) =>
    page.screenshot({
      path: `docs/screenshots/m6/${name}.jpg`,
      type: "jpeg",
      quality: 80,
      scale: "css",
      animations: "disabled",
    });
  for (const players of [2, 4, 5, 6, 7, 8]) {
    await show(page, atTurnStart(players));
    await shot(`players-${players}`);
  }
  await page.getByTestId("opponent").first().click();
  await shot("zoom");
  await show(page, { view: toView(lastTurnGame(8, 3)), seat: null });
  await shot("spectator-8");
});
