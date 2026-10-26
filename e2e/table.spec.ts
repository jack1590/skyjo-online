// Layout checks at exact game states, through the test-only table harness (src/client/App.tsx):
// the page renders a static table from an injected view instead of playing up to that state.
import { expect, type Page, test } from "@playwright/test";
import { apply } from "../src/engine/game";
import { toView } from "../src/engine/view";
import {
  atTurnStart,
  firstTurn,
  knockoutGame,
  lastTurnGame,
  roundOver,
  type Shown,
  show,
} from "./harness";

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
          await expect(page.locator(".undo")).toBeVisible(); // the card is thrown (UX-19)
          widths.push(await width());
        }
      }
      await expect(page.getByTestId("prompt")).toContainText(/ · /); // the offline note, last
    }
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });
});

/** You drew from the deck: place phase, with 2 cards face up. */
const placing = (): Shown => {
  const state = firstTurn(4, 5);
  const view = toView(apply(state, { type: "draw", seat: state.current, source: "deck" }));
  return { view, seat: state.current };
};

test.describe("M18: discard mode shows where to tap", () => {
  // The narrowest phone the prompt must fit (UX-20); on every device, as fonts differ.
  test.use({ viewport: { width: 360, height: 740 } });
  // The prompt no longer offers to keep the card: Undo does (UX-19).
  const words = {
    en: ["Now flip one of your face-down cards", "Undo"],
    es: ["Ahora voltea una de tus cartas boca abajo", "Deshacer"],
    pt: ["Agora vire uma das suas cartas viradas para baixo", "Desfazer"],
  };

  // One test per locale: looped in one test, it was CI's longest iPhone test (M10 PO).
  for (const [locale, [text, undo]] of Object.entries(words)) {
    test(`M18, UX-19 (${locale}): only your face-down cards are highlighted and the rest dims; the held card is lifted, never highlighted; thrown, it leaves an Undo chip ≥ 44 px; the prompt fits 2 lines, with no horizontal scroll; no pulse with reduced motion`, async ({
      page,
    }) => {
      const target = page.getByTestId("my-grid").locator('button[data-face="down"]').first();
      await page.addInitScript((l) => localStorage.setItem("skyjo:locale", l), locale);
      await show(page, placing());
      // Place phase (UX-4): every highlight is a button, and the held card sits 6 px up, unmarked.
      const hl = page.locator(".hl");
      expect(await hl.evaluateAll((els) => els.map((el) => el.tagName))).toEqual(["BUTTON"]);
      await expect(page.getByTestId("drawn")).not.toHaveClass(/\bhl\b/);
      const top = async (id: string) => (await page.getByTestId(id).boundingBox())?.y ?? 0;
      expect((await top("deck")) - (await top("drawn"))).toBeCloseTo(6, 0);

      // Discard mode (UX-18): the card lies on the pile, with Undo where it was (UX-19); the
      // highlights are exactly your face-down cards; face-up ones dim. Forced: a page's first
      // click waits for its first frames: 1.4–5.4 s on CI's WebKit (M20 probe). UX-29 hit-tests it.
      await page.getByTestId("discard").click({ force: true });
      await expect(page.getByRole("button", { name: undo, exact: true })).toBeVisible();
      await expect(page.getByTestId("drawn")).toHaveCount(0);
      await expectMobileFriendly(page);
      const marks = await page.evaluate(() => {
        const grid = '[data-testid="my-grid"]';
        const hl = [...document.querySelectorAll(".hl")];
        const down = [...document.querySelectorAll(`${grid} button[data-face="down"]`)];
        const up = [...document.querySelectorAll(`${grid} [data-face="up"]`)];
        return {
          exact: hl.length === down.length && down.every((el) => hl.includes(el)),
          down: down.length,
          up: up.length,
          opacity: Math.max(...up.map((el) => Number(getComputedStyle(el).opacity))),
        };
      });
      expect(marks).toMatchObject({ exact: true, down: 10, up: 2 });
      expect(marks.opacity).toBeLessThanOrEqual(0.5);
      await expect(target).toHaveCSS("outline-width", "3px");
      await expect(target).toHaveCSS("outline-color", "rgb(242, 193, 78)");

      // UX-20: says what to do, in at most 2 lines.
      const prompt = page.getByTestId("prompt");
      await expect(prompt).toContainText(text);
      await expect(prompt).not.toContainText(","); // no "or keep it" clause
      const lines = await prompt.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return new Set([...range.getClientRects()].map((r) => Math.round(r.bottom))).size;
      });
      expect(lines, `${locale}: "${await prompt.textContent()}"`).toBeLessThanOrEqual(2);
      // The outline holds still with reduced motion (the E2E default) and pulses without it.
      const pulse = () => target.evaluate((el) => getComputedStyle(el, "::after").animationName);
      expect(await pulse()).toBe("none");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      expect(await pulse()).not.toBe("none");
    });
  }
});

test("UX-29: in discard mode, your top row's outlines stay clear of your clock's bar", async ({
  page,
}) => {
  const table = placing();
  await show(page, { ...table, wait: [{ seat: table.seat ?? 0, inMs: 25_000, reason: "timer" }] });
  await page.getByTestId("discard").click();
  const gap = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="clock"]')?.getBoundingClientRect();
    const outlines = [...document.querySelectorAll('[data-testid="my-grid"] .card.hl')].map(
      (el) => {
        const style = getComputedStyle(el);
        const out = Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth);
        return el.getBoundingClientRect().top - out;
      },
    );
    return bar && outlines.length ? Math.min(...outlines) - bar.bottom : null;
  });
  expect(gap).not.toBeNull();
  expect(gap ?? -1).toBeGreaterThanOrEqual(0);
});

test("screenshots: M18 place and discard mode", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
  const shot = (name: string) =>
    page.screenshot({
      path: `docs/screenshots/m18/${name}.jpg`,
      type: "jpeg",
      quality: 80,
      scale: "css",
      animations: "disabled",
    });
  for (const locale of ["es", "en"]) {
    await page.addInitScript((l) => localStorage.setItem("skyjo:locale", l), locale);
    await show(page, placing());
    await shot(`after-${locale}-1-place`);
    await page.getByTestId("discard").click();
    await shot(`after-${locale}-2-discard-mode`);
  }
});

test("screenshots: M10 thrown away with Undo, and a tapped card waiting for the server", async ({
  page,
}, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
  const shot = (name: string) =>
    page.screenshot({
      path: `docs/screenshots/m10/${name}.jpg`,
      type: "jpeg",
      quality: 80,
      scale: "css",
      animations: "disabled",
    });
  for (const locale of ["es", "en"]) {
    await page.addInitScript((l) => localStorage.setItem("skyjo:locale", l), locale);
    await show(page, placing());
    await page.getByTestId("discard").click();
    await shot(`${locale}-1-thrown-undo`);
    // The harness has no server: the tapped card stays lifted, as if its answer were late.
    await page.getByTestId("my-grid").locator('button[data-face="down"]').nth(5).click();
    await shot(`${locale}-2-pending-tap`);
  }
});

test("UX-2: the deck and discard never move (±0.5 px): you or another player drawing, from either pile, with 2 and 8 players", async ({
  page,
}) => {
  // Each table after the first is the harness's next view: one page load per player count.
  const boxes = (table: Shown) =>
    page.evaluate((table) => {
      dispatchEvent(new CustomEvent("skyjo:table", { detail: table }));
      return ["deck", "discard"].map((id) => {
        const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
        return r ? [r.x, r.y, r.width, r.height] : [];
      });
    }, table);
  for (const players of [2, 8]) {
    const state = firstTurn(players, 5);
    const seat = state.current;
    const views = [
      state,
      apply(state, { type: "draw", seat, source: "deck" }),
      apply(state, { type: "draw", seat, source: "discard" }),
    ].map(toView);
    await show(page, { view: views[0], seat });
    const seen: number[][][] = [];
    for (const view of views) {
      for (const as of [seat, (seat + 1) % players]) seen.push(await boxes({ view, seat: as }));
    }
    for (const b of seen) {
      for (const [i, n] of b.flat().entries()) {
        expect(Math.abs(n - seen[0].flat()[i]), `${players} players: ${seen}`).toBeLessThanOrEqual(
          0.5,
        );
      }
    }
  }
});

// One test per locale (M10 PO), like M18's.
for (const [locale, caption, prompt] of [
  ["en", "From the discard", "From the discard: tap a grid card to swap it in"],
  ["es", "Del descarte", "Del descarte: toca una carta de tu cuadrícula para cambiarla"],
  ["pt", "Do descarte", "Do descarte: toque numa carta da sua grade para trocar"],
]) {
  test(`UX-21 (${locale}): a card taken from the discard is held up over the pile, which dims; the middle slot stays empty; caption and prompt`, async ({
    page,
  }) => {
    const state = firstTurn(4, 5);
    const view = toView(apply(state, { type: "draw", seat: state.current, source: "discard" }));
    await page.addInitScript((l) => localStorage.setItem("skyjo:locale", l), locale);
    await show(page, { view, seat: state.current });
    const held = await page.getByTestId("drawn").boundingBox();
    const pile = await page.getByTestId("discard").boundingBox();
    if (!held || !pile) throw new Error("no held card or pile");
    expect(Math.abs(held.x + held.width / 2 - (pile.x + pile.width / 2))).toBeLessThanOrEqual(1);
    // Lifted 16 px and 6% larger: its top is 16 px + 3% of the pile's height above the pile's.
    expect(pile.y - held.y).toBeCloseTo(16 + 0.03 * pile.height, 0);
    expect(held.width / pile.width).toBeCloseTo(1.06, 2);
    await expect(page.getByTestId("discard")).toHaveCSS("opacity", "0.45");
    await expect(page.locator(".piles > .pile").nth(1)).toBeHidden(); // the middle slot
    await expect(page.locator(".piles > .pile").nth(2).locator(".pile-label")).toHaveText(caption);
    await expect(page.getByTestId("prompt")).toHaveText(prompt);
    await expectMobileFriendly(page);
  });
}

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

/**
 * Seed 1 of a 4-player knockout game (R16): Dani goes out after round 1, Ana and Ben after round 2,
 * and Cris, the one left, wins.
 */
const knockout = () => {
  const states = knockoutGame(["Ana", "Ben", "Cris", "Dani"], 1);
  const pick = (test: (s: (typeof states)[number]) => boolean) => {
    const state = states.find(test);
    if (!state) throw new Error("seed 1 no longer plays out this way");
    return toView(state);
  };
  return {
    firstOut: pick((s) => s.phase === "roundOver"),
    round2: pick((s) => s.round === 2 && s.phase === "draw"),
    over: pick((s) => s.phase === "gameOver"),
  };
};
const DANI = 3;

test("M17: a knockout game to a winner: one goes out, the next round deals only to the others, and the one left wins", async ({
  page,
}) => {
  const { firstOut, round2, over } = knockout();
  expect(firstOut.players.map((p) => p.out)).toEqual([null, null, null, 1]);
  await show(page, { view: firstOut, seat: 0, lead: true });
  const summary = page.getByTestId("round-summary");
  await expect(summary.getByTestId("out-tag")).toHaveText(["Out in round 1"]);
  await expect(summary.getByRole("row", { name: /Dani/ })).toContainText("Out in round 1");
  // Dani still sees the grid she just played, but has no Auto-play switch left to tick.
  await show(page, { view: firstOut, seat: DANI });
  await expect(page.getByTestId("my-grid")).toBeAttached();
  await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
  // Round 2: Dani's panel has no cards, says why, and opens nothing.
  await show(page, { view: round2, seat: 0 });
  const dani = page.getByTestId("opponent").filter({ hasText: "Dani" });
  await expect(dani).toContainText("Out · watching");
  await expect(dani.locator(".card")).toHaveCount(0);
  await expect(dani).toBeDisabled();
  await expect(page.getByTestId("opponent").locator(".card")).toHaveCount(24);
  await expectMobileFriendly(page);
  expect(over.winners).toEqual([2]);
  await show(page, { view: over, seat: 2 });
  await expect(page.getByTestId("game-over")).toContainText("Cris wins!");
});

test("M17: a player who is out watches: 'Out · watching' on their seat, the spectator layout, nothing to tap", async ({
  page,
}) => {
  await show(page, { view: knockout().round2, seat: DANI, auto: [false, false, false, false] });
  await expect(page.getByTestId("my-grid")).toHaveCount(0);
  await expect(page.getByTestId("opponents")).toHaveClass(/watch/);
  await expect(page.getByTestId("opponent")).toHaveCount(4);
  await expect(page.getByTestId("opponent").nth(DANI)).toContainText("Out · watching");
  await expect(page.locator("button.card")).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByTestId("prompt")).toHaveText("You're watching this game");
  await expectMobileFriendly(page);
});

test("M17: when everyone still in reaches 100 in the same round, the winner went out too but isn't tagged out", async ({
  page,
}) => {
  // Seed 2: Dani goes out after round 1; Ana, Ben and Cris all reach 100 in round 2, and Cris,
  // on the lowest total, wins.
  const over = knockoutGame(["Ana", "Ben", "Cris", "Dani"], 2).at(-1);
  if (!over) throw new Error("no game");
  expect([over.players.map((p) => p.out), over.winners]).toEqual([[2, 2, 2, 1], [2]]);
  await show(page, { view: toView(over), seat: 0 });
  const rows = page.getByTestId("game-over").locator("tbody tr");
  await expect(rows.first()).toHaveText(/^Cris/);
  await expect(rows.first().getByTestId("out-tag")).toHaveCount(0);
  await expect(page.getByTestId("game-over").getByTestId("out-tag")).toHaveCount(3);
});

test("M17: the final ranking: the winner first, then by the round they went out, then the lower total, in en, es and pt", async ({
  page,
}) => {
  const { over } = knockout();
  for (const [locale, out] of [
    ["en", "Out in round"],
    ["es", "Fuera en la ronda"],
    ["pt", "Fora na rodada"],
  ]) {
    await page.addInitScript((l) => localStorage.setItem("skyjo:locale", l), locale);
    await show(page, { view: over, seat: DANI });
    // Ben (121) and Ana (123) went out in round 2, Dani in round 1.
    await expect(page.getByTestId("game-over").locator("tbody tr")).toHaveText([
      /^Cris/,
      new RegExp(`^Ben.*${out} 2`),
      new RegExp(`^Ana.*${out} 2`),
      new RegExp(`^Dani.*${out} 1–172$`),
    ]);
    await expect(page.getByTestId("game-over").getByTestId("out-tag")).toHaveCount(3);
    await expectMobileFriendly(page);
  }
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

test("screenshots: M17 knockout", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
  const shot = (name: string) =>
    page.screenshot({
      path: `docs/screenshots/m17/${name}.jpg`,
      type: "jpeg",
      quality: 80,
      scale: "css",
      animations: "disabled",
    });
  const { firstOut, round2, over } = knockout();
  await show(page, { view: firstOut, seat: 0, lead: true });
  await shot("03-out-in-round-1");
  await show(page, { view: round2, seat: 0 });
  await shot("04-others-see-who-is-out");
  await show(page, { view: round2, seat: DANI });
  await shot("05-out-watching");
  await show(page, { view: over, seat: 2 });
  await shot("06-winner-and-ranking");
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
