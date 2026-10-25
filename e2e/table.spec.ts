// Layout checks at exact game states, through the test-only table harness (src/client/App.tsx):
// the page renders a static table from an injected view instead of playing up to that state.
import { expect, type Page, test } from "@playwright/test";
import { apply } from "../src/engine/game";
import { toView } from "../src/engine/view";
import { atTurnStart, firstTurn, lastTurnGame, roundOver, type Shown, show } from "./harness";

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

/** Your turn with 9 s on your clock, the next player on Auto-play. */
const clockAt9 = (players: number): Shown => {
  const turn = atTurnStart(players);
  const me = turn.seat ?? 0;
  const auto = Array.from({ length: players }, (_, i) => i === (me + 1) % players);
  return { ...turn, auto, wait: [{ seat: me, inMs: 8_950, reason: "timer" }] };
};

/** Watching the player to move with 9 s left, from the next seat, which is on Auto-play. */
const autoBarAt9 = (players: number): Shown => {
  const state = lastTurnGame(players, 3);
  const me = (state.current + 1) % players;
  const auto = Array.from({ length: players }, (_, i) => i === me);
  return {
    view: toView(state),
    seat: me,
    auto,
    wait: [{ seat: state.current, inMs: 8_950, reason: "timer" }],
  };
};

const smallestOpponentNumber = (page: Page) =>
  page.evaluate(() =>
    Math.min(
      ...[...document.querySelectorAll('[data-testid="opponent"] .num')].map((n) =>
        Number.parseFloat(getComputedStyle(n).fontSize),
      ),
    ),
  );

for (const players of [2, 3, 4, 5, 6, 7, 8]) {
  test(`${players} players, with your clock running: fits, every tap target ≥ 44px, opponents' numbers readable`, async ({
    page,
  }) => {
    await show(page, clockAt9(players));
    await expect(page.getByTestId("clock")).toBeVisible();
    await expectMobileFriendly(page);
    await expect(page.getByTestId("opponent")).toHaveCount(players - 1);
    expect(await smallestOpponentNumber(page)).toBeGreaterThanOrEqual(12);
  });
}

test.describe("360×740 (common Android width)", () => {
  test.use({ viewport: { width: 360, height: 740 } });
  // 360 px is an Android width; the iPhone project keeps its own 390×664 checks, and CI's WebKit
  // is the critical path (PO, PR #17).
  test.skip(
    ({ browserName, isMobile }) => browserName !== "chromium" || !isMobile,
    "an Android width: Pixel only",
  );

  test("M8: 2–8 players with Auto-play on and an opponent's ring: fits, every tap target ≥ 44px, opponents' numbers stay ≥ 12px", async ({
    page,
  }) => {
    for (let players = 2; players <= 8; players++) {
      await show(page, autoBarAt9(players));
      await expectMobileFriendly(page);
      expect(await smallestOpponentNumber(page)).toBeGreaterThanOrEqual(12);
      await expect(page.locator(".opp.active .ring")).toBeVisible();
    }
  });

  test("M8, UX-12: your cards keep their width (±1 px) while you draw, place or discard, and while another seat is offline, in en, es and pt", async ({
    page,
  }) => {
    const state = firstTurn(4, 5);
    const me = state.current;
    const drawn = apply(state, { type: "draw", seat: me, source: "deck" });
    const next = apply(drawn, {
      type: "discardAndFlip",
      seat: me,
      pos: drawn.players[me].grid.findIndex((s) => s && !s.up),
    });
    const away = [0, 1, 2, 3].map((i) => i !== next.current);
    const states: Shown[] = [
      { view: toView(state), seat: me, wait: [{ seat: me, inMs: 25_000, reason: "timer" }] },
      { view: toView(drawn), seat: me, wait: [{ seat: me, inMs: 25_000, reason: "timer" }] },
      {
        view: toView(next),
        seat: me,
        connected: away,
        wait: [{ seat: next.current, inMs: 24_000, reason: "offline" }],
      },
    ];
    const widths: number[] = [];
    const width = async () =>
      (await page.getByTestId("my-grid").locator(".card").first().boundingBox())?.width ?? 0;
    for (const locale of ["en", "es", "pt"]) {
      await page.addInitScript((l) => localStorage.setItem("skyjo:locale", l), locale);
      for (const table of states) {
        await show(page, table);
        widths.push(await width());
        if (table.view.phase === "place") {
          await page.getByTestId("discard").click({ force: true }); // discard mode: the longest prompt
          await expect(page.getByTestId("drawn")).toHaveJSProperty("tagName", "BUTTON"); // tap to keep
          widths.push(await width());
        }
      }
      await expect(page.getByTestId("prompt")).toContainText(/ · /); // the offline note, last
    }
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });
});

/** The page's clock stands still from its first load: only page.clock.runFor moves it. */
async function frozenClock(page: Page) {
  const start = Date.UTC(2026, 9, 24, 12);
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 1_000);
}

test("M8: your clock: a bar with no number at 25 s, orange with the seconds at 9 s, red at 4 s, announced once", async ({
  page,
}) => {
  await frozenClock(page);
  const state = firstTurn(3, 5);
  const me = state.current;
  await show(page, {
    view: toView(state),
    seat: me,
    wait: [{ seat: me, inMs: 25_000, reason: "timer" }],
  });
  const clock = page.getByTestId("clock");
  const pill = page.getByTestId("pill");
  await expect(clock).toBeVisible();
  await expect(clock).not.toHaveClass(/warn|danger/);
  await expect(pill).toHaveText("Your turn");
  await page.clock.runFor(16_000);
  await expect(pill).toHaveText("Your turn · 9");
  await expect(clock).toHaveClass(/warn/);
  expect(await clock.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    "rgb(255, 166, 48)",
  );
  const said = (await page.getByRole("status").textContent()) ?? "";
  expect(said).toMatch(/^(10|9) seconds left$/);
  await page.clock.runFor(5_000);
  await expect(pill).toHaveText("Your turn · 4");
  await expect(clock).toHaveClass(/danger/);
  expect(await clock.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    "rgb(255, 82, 71)",
  );
  await expect(page.getByRole("status")).toHaveText(said);
});

test("M8: others see the active panel's ring with the seconds in its last 10 s; spectators too, with no switch", async ({
  page,
}) => {
  await frozenClock(page);
  const state = firstTurn(3, 5);
  const wait: Shown["wait"] = [{ seat: state.current, inMs: 9_000, reason: "timer" }];
  for (const seat of [(state.current + 1) % 3, null]) {
    await show(page, { view: toView(state), seat, wait });
    const active = page.locator('[data-testid="opponent"].active');
    await expect(active.locator(".ring")).toHaveClass(/warn/);
    await expect(active.locator(".opp-left")).toHaveText("9");
    await expect(page.getByRole("checkbox", { name: "Auto-play" })).toHaveCount(
      seat === null ? 0 : 1,
    );
  }
});

test("M8: a seat on Auto-play shows 🤖, the pill reads 'Name · auto', and the round summary marks it", async ({
  page,
}) => {
  const state = firstTurn(3, 5);
  const bot = state.current;
  const auto = [0, 1, 2].map((i) => i === bot);
  await show(page, {
    view: toView(state),
    seat: (bot + 1) % 3,
    auto,
    wait: [{ seat: bot, inMs: 1_000, reason: "auto" }],
  });
  await expect(page.getByTestId("pill")).toHaveText(`Player ${bot + 1} · auto`);
  await expect(
    page.locator('[data-testid="opponent"].active').getByRole("img", { name: "Auto-play" }),
  ).toBeVisible();
  await show(page, { view: toView(roundOver(2, 11)), seat: 0, lead: true, auto: [false, true] });
  await expect(
    page.getByTestId("round-summary").getByRole("img", { name: "Auto-play" }),
  ).toHaveCount(1);
});

test("M8: with Auto-play on, the row above your grid is a bar with a switch ≥ 44 px, and tapping a card shakes it instead of playing", async ({
  page,
}) => {
  const state = firstTurn(3, 5);
  const me = state.current;
  const auto = [0, 1, 2].map((i) => i === me);
  await show(page, {
    view: toView(state),
    seat: me,
    auto,
    wait: [{ seat: me, inMs: 1_500, reason: "auto" }],
  });
  const bar = page.getByTestId("mine-head");
  await expect(bar).toHaveText(/Auto-play was on while you were away/); // it was on when the table opened
  const box = await page.getByRole("checkbox", { name: "Auto-play" }).boundingBox();
  expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("checkbox", { name: "Auto-play" })).toBeChecked();
  await expect(page.getByTestId("deck")).not.toHaveClass(/hl/); // nothing offered to tap
  // A card, the deck or the discard: each tap starts the bar's shake (a flash with reduced motion),
  // even one that lands as the last shake ends.
  for (const target of [
    '[data-testid="my-grid"] button',
    '[data-testid="deck"]',
    '[data-testid="discard"]',
  ]) {
    const nudged = await page.evaluate(async (selector) => {
      const bar = document.querySelector('[data-testid="mine-head"]') as HTMLElement;
      const started = new Promise<boolean>((done) => {
        bar.addEventListener("animationstart", (e) => e.target === bar && done(true));
        setTimeout(() => done(false), 3_000);
      });
      document.querySelector<HTMLElement>(selector)?.click();
      return started;
    }, target);
    expect(nudged).toBe(true);
  }
  await expect(page.getByTestId("prompt")).toHaveText(
    "Auto-play is playing for you. Switch it off to play.",
  );
});

test("M8, UX-6: the table keeps the screen awake, and lets go on Home", async ({ page }) => {
  await page.addInitScript(() => {
    const lock = { requested: 0, released: 0 };
    Object.assign(window, { lock });
    Object.defineProperty(navigator, "wakeLock", {
      value: {
        request: async () => {
          lock.requested++;
          return { release: async () => void lock.released++ };
        },
      },
    });
  });
  await show(page, atTurnStart(3));
  const lock = () => page.evaluate(() => (window as unknown as { lock: object }).lock);
  await expect.poll(lock).toEqual({ requested: 1, released: 0 });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Quit to home" }).click();
  await expect.poll(lock).toEqual({ requested: 1, released: 1 });
});

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
  await first.click();
  await expect(zoom).toBeVisible();
  await page.keyboard.press("Escape");
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

test.describe("with motion allowed", () => {
  // The clock's bar and rings are CSS animations: these shots catch them mid-drain.
  test.use({ reducedMotion: "no-preference" });

  test("screenshots: M8 turn clock and Auto-play", async ({ page }, info) => {
    test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
    const shot = async (name: string) => {
      await page.waitForTimeout(400); // past the pill's pop
      await page.screenshot({
        path: `docs/screenshots/m8/${name}.jpg`,
        type: "jpeg",
        quality: 80,
        scale: "css",
      });
    };
    const state = firstTurn(4, 5);
    const view = toView(state);
    const me = state.current;
    const other = (me + 1) % 4;
    const mine = (inMs: number): Shown => ({
      view,
      seat: me,
      wait: [{ seat: me, inMs, reason: "timer" }],
    });
    await show(page, mine(25_000));
    await shot("01-clock-25s");
    await show(page, mine(10_000));
    await shot("02-clock-10s");
    await show(page, mine(5_000));
    await shot("03-clock-5s");
    await show(page, { view, seat: other, wait: [{ seat: me, inMs: 9_000, reason: "timer" }] });
    await shot("04-others-see-the-ring");
    const auto = [0, 1, 2, 3].map((i) => i === me);
    await show(page, { view, seat: me, auto, wait: [{ seat: me, inMs: 1_500, reason: "auto" }] });
    await shot("05-auto-play-was-on");
    await show(page, {
      view,
      seat: other,
      auto,
      wait: [{ seat: me, inMs: 1_500, reason: "auto" }],
    });
    await shot("06-others-see-the-bot");
    await show(page, {
      view,
      seat: null,
      auto: [0, 1, 2, 3].map((i) => i === other),
      wait: [{ seat: me, inMs: 7_000, reason: "timer" }],
    });
    await shot("07-spectator");
    const connected = [0, 1, 2, 3].map((i) => i !== me);
    await show(page, {
      view,
      seat: other,
      connected,
      wait: [{ seat: me, inMs: 24_000, reason: "offline" }],
    });
    await shot("08-offline");
    await show(page, {
      view: toView(roundOver(4, 11)),
      seat: 0,
      lead: true,
      auto: [false, true, false, false],
    });
    await shot("09-summary-bot");
  });
});
