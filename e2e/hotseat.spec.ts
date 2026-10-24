import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { apply, createGame, type GameState, legalActions } from "../src/engine/game";

type Done = (phase: string) => boolean | Promise<boolean>;

/**
 * Does whatever the table asks for until `done(phase)`. Turns rotate through the three ways to
 * move: take the discard and swap, draw and swap, draw then discard and flip. Every turn reveals a
 * card, so rounds always end.
 */
async function playUntil(page: Page, done: Done) {
  const table = page.getByTestId("table");
  const faceDown = page.getByTestId("my-grid").locator('button[data-face="down"]');
  const pass = page.getByRole("button", { name: /^Pass to / });
  let turn = 0;
  for (let step = 0; step < 3000; step++) {
    if (await pass.count()) {
      await pass.click();
      continue;
    }
    const phase = (await table.getAttribute("data-phase")) ?? "";
    if (await done(phase)) return;
    if (phase === "gameOver") throw new Error("game ended before the expected phase");
    if (phase === "roundOver") {
      await page.getByRole("button", { name: "Next round" }).click();
    } else if (phase === "flip") {
      await faceDown.first().click();
    } else if (phase === "draw") {
      turn++;
      await page.getByTestId(turn % 3 === 0 ? "discard" : "deck").click();
    } else if (phase === "place") {
      if (turn % 3 === 2) {
        await page.getByTestId("discard").click();
        await expect(page.getByText("Tap a face-down card to flip it")).toBeVisible();
      }
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

/**
 * A game one move into its last turns: someone has revealed every card and the next player is
 * about to draw. Built with the engine so layout checks don't click through a whole round.
 */
function lastTurnGame(players: number, seed: number) {
  const names = Array.from({ length: players }, (_, i) => `Player ${i + 1}`);
  let state: GameState = createGame(names, [seed, 0, 0, 0]);
  while (state.ender === null || state.phase !== "draw") {
    const legal = legalActions(state);
    // Discard-and-flip (listed last) always reveals a card, so the round heads for its end.
    state = apply(state, legal[state.phase === "place" ? legal.length - 1 : 0]);
  }
  return { names, state, seat: state.current };
}

async function loadGame(page: Page, game: ReturnType<typeof lastTurnGame>) {
  await page.goto("/");
  await page.evaluate(
    (saved) => localStorage.setItem("skyjo:hotseat:v2", JSON.stringify(saved)),
    game,
  );
  await page.reload();
  await expect(page.getByText(/^Last turn · /)).toBeVisible();
}

/** Full play-throughs are slow and engine-independent, so CI runs them on one device. */
function longPlayThrough(info: TestInfo) {
  test.skip(info.project.name !== "pixel", "long play-throughs run on Pixel only");
  test.setTimeout(120_000);
}

const lastTurn = (page: Page) => async (phase: string) =>
  phase === "draw" && (await page.getByText(/^Last turn · /).count()) > 0;

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

test("2-player hot-seat game runs to 100 points", async ({ page }, info) => {
  longPlayThrough(info);
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

for (const players of [2, 8]) {
  test(`${players} players: cards stay at least 44px during the last turns`, async ({ page }) => {
    await loadGame(page, lastTurnGame(players, 4));
    await expectMobileFriendly(page);
    await page.getByTestId("deck").click();
    await expectMobileFriendly(page);
  });
}

test("a round runs to its summary and the next round starts", async ({ page }) => {
  await loadGame(page, lastTurnGame(2, 11)); // seed 11: round 1 ends at 39–52, no game over
  await playUntil(page, (phase) => phase === "roundOver");
  await expect(page.getByTestId("round-summary")).toBeVisible();
  const rows = page.getByRole("row");
  await expect(rows).toHaveCount(3); // header + 2 players
  await expect(page.getByTestId("round-summary").getByText("ended")).toBeVisible();
  await expect(rows.nth(1)).toHaveText(/^Player 1/);
  await page.getByRole("button", { name: "View table" }).click();
  await expect(page.getByRole("table")).toBeHidden();
  await page.getByRole("button", { name: "Show scores" }).click();
  await page.getByRole("button", { name: "Next round" }).click();
  await expect(page.getByTestId("table")).toHaveAttribute("data-phase", "flip");
  await expect(page.getByText("Round 2")).toBeVisible();
});

test("8-player hot-seat play-through reaches the last turns", async ({ page }, info) => {
  longPlayThrough(info);
  await start(page, 8, 3);
  await playUntil(page, lastTurn(page));
  await expectMobileFriendly(page);
});

test.describe("small phone (375×548)", () => {
  test.use({ viewport: { width: 375, height: 548 } });

  for (const players of [2, 8]) {
    test(`${players} players: your whole grid is on screen when your turn starts`, async ({
      page,
    }) => {
      await loadGame(page, lastTurnGame(players, 3));
      await expect(async () => {
        const box = await page.getByTestId("my-grid").boundingBox();
        expect(box?.y).toBeGreaterThanOrEqual(0);
        expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(548 + 1); // subpixel rounding
      }).toPass();
    });
  }

  test("the table scrolls instead of shrinking cards", async ({ page }) => {
    await loadGame(page, lastTurnGame(8, 3));
    await expectMobileFriendly(page);
  });
});

test("discard mode can be cancelled and the drawn card swapped in", async ({ page }) => {
  await start(page, 2, 9);
  await playUntil(page, (phase) => phase === "draw");
  await page.getByTestId("deck").click();
  const drawn = (await page.getByTestId("drawn").getAttribute("aria-label"))?.split(": ")[1];
  await page.getByTestId("discard").click();
  await expect(page.getByText("Tap a face-down card to flip it")).toBeVisible();
  await page.getByTestId("drawn").click();
  await expect(page.getByText("Tap a grid card to swap")).toBeVisible();
  const target = page.getByTestId("my-grid").locator('button[data-face="up"]').first();
  const position = (await target.getAttribute("aria-label"))?.split(":")[0];
  await target.click();
  await expect(page.getByLabel(`${position}: ${drawn}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Pass to / })).toBeVisible();
});

test("names are remembered after quitting", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Player 1 name" }).fill("Ana");
  await page.getByRole("textbox", { name: "Player 2 name" }).fill("Ben");
  await page.getByRole("button", { name: "Start game" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Quit to home" }).click();
  await expect(page.getByRole("textbox", { name: "Player 1 name" })).toHaveValue("Ana");
  await expect(page.getByRole("textbox", { name: "Player 2 name" })).toHaveValue("Ben");
});

test("a hot-seat game survives a reload", async ({ page }) => {
  await start(page, 3, 5);
  await playUntil(page, (phase) => phase === "draw");
  const before = await page.getByTestId("my-grid").innerHTML();
  await page.reload();
  await expect(page.getByTestId("table")).toHaveAttribute("data-phase", "draw");
  expect(await page.getByTestId("my-grid").innerHTML()).toBe(before);
});

test("a corrupt saved game falls back to the home screen", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem("skyjo:hotseat:v2", JSON.stringify({ state: { players: [] }, seat: 0 })),
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Start game" })).toBeVisible();
});

test.describe("m5 small-phone screenshots", () => {
  test.use({ viewport: { width: 375, height: 548 } });

  test("small phone", async ({ page }, info) => {
    test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
    for (const players of [2, 8]) {
      await loadGame(page, lastTurnGame(players, 3));
      await page.screenshot({
        path: `docs/screenshots/m5/0${players === 2 ? 3 : 4}-small-phone-${players}p.jpg`,
        type: "jpeg",
        quality: 80,
        scale: "css",
        animations: "disabled",
      });
    }
  });
});

test("screenshots", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with npm run screenshots");
  const shot = (name: string) =>
    page.screenshot({
      path: `docs/screenshots/m2/${name}.jpg`,
      type: "jpeg",
      quality: 80,
      scale: "css",
      animations: "disabled",
    });
  await page.goto("/?seed=11");
  await shot("01-home");
  await page.getByRole("button", { name: "Start game" }).click();
  await shot("02-flip");
  await page.getByTestId("my-grid").locator('button[data-face="down"]').first().click();
  await page.getByTestId("my-grid").locator('button[data-face="down"]').first().click();
  await shot("03-pass");
  await playUntil(page, (phase) => phase === "draw");
  await shot("04-draw");
  await page.getByTestId("deck").click();
  await shot("05-drawn");
  await page.getByTestId("discard").click();
  await shot("06-discard-then-flip");
  await page.getByTestId("my-grid").locator('button[data-face="down"]').first().click();
  await playUntil(page, lastTurn(page));
  await shot("07-last-turn");
  await playUntil(page, (phase) => phase === "roundOver");
  await shot("08-round-summary");
  await page.getByRole("button", { name: "View table" }).click();
  await shot("09-view-table");
  await page.getByRole("button", { name: "Show scores" }).click();
  await playUntil(page, (phase) => phase === "gameOver");
  await shot("10-game-over");
  await page.evaluate(() => localStorage.clear());
  await start(page, 6, 11);
  await playUntil(page, (phase) => phase === "draw");
  await shot("11-six-players");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Quit to home" }).click();
  for (const [code, name] of [
    ["es", "12-home-es"],
    ["pt", "13-home-pt"],
  ]) {
    await page.getByRole("combobox").selectOption(code);
    await shot(name);
  }
});
