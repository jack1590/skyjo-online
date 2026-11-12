// Layout checks at exact game states, through the test-only table harness (src/client/App.tsx):
// the page renders a static table from an injected view instead of playing up to that state.
import { expect, type Page, test } from "@playwright/test";
import { apply, createGame, type GameState, places } from "../src/engine/game";
import { type GameView, type PlayerView, toView } from "../src/engine/view";
import {
  atTurnStart,
  firstTurn,
  knockoutGame,
  lastTurnGame,
  playedRound,
  roundOver,
  type Shown,
  show,
} from "./harness";
import { expectMobileFriendly } from "./helpers";

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

/** The smallest number on the opponents' panels: their cards and round scores (UX-15). */
const smallestOpponentNumber = (page: Page) =>
  page.evaluate(() =>
    Math.min(
      ...[...document.querySelectorAll('[data-testid="opponent"] :is(.num, .sum)')].map((n) =>
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
  // The clock's own line; the throws have one too (M21).
  const status = page.getByTestId("mine-head").getByRole("status");
  const said = (await status.textContent()) ?? "";
  expect(said).toMatch(/^(10|9) seconds left$/);
  await page.clock.runFor(5_000);
  await expect(pill).toHaveText("Your turn · 4");
  await expect(clock).toHaveClass(/danger/);
  expect(await clock.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    "rgb(255, 82, 71)",
  );
  await expect(status).toHaveText(said);
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
  await show(page, { view: toView(roundOver(2, 344)), seat: 0, lead: true, auto: [false, true] });
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
  // Forced: a page's first click waits for its first frames on CI's WebKit (M18's, M20 probe). The
  // second click on the same panel, below, still hit-tests it.
  await first.click({ force: true });
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

/**
 * Moves the harness table on to `view`, then tells whether each element is wholly on screen and
 * inside every scrolling box around it: its test id, or why not.
 */
const onScreen = (page: Page, view: GameView, testIds: string[]) =>
  page.evaluate(
    ({ view, ids }) => {
      dispatchEvent(new CustomEvent("skyjo:table", { detail: { view } }));
      return ids.map((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) return `${id}: missing`;
        const r = el.getBoundingClientRect();
        const boxes = [{ top: 0, bottom: innerHeight, left: 0, right: innerWidth }];
        for (let up = el.parentElement; up; up = up.parentElement) {
          if (getComputedStyle(up).overflowY !== "visible") boxes.push(up.getBoundingClientRect());
        }
        const inside = boxes.every(
          (b) =>
            r.top >= b.top - 1 &&
            r.bottom <= b.bottom + 1 &&
            r.left >= b.left - 1 &&
            r.right <= b.right + 1,
        );
        return inside ? id : `${id}: off screen at ${Math.round(r.top)}–${Math.round(r.bottom)}`;
      });
    },
    { view, ids: testIds },
  );

test.describe("M12: spectators keep the piles", () => {
  test.use({ viewport: { width: 390, height: 664 } });

  test("at 8 seats, a spectator sees the deck, the discard and the drawn card on every turn of a played round, and whoever is playing", async ({
    page,
  }) => {
    const states = playedRound(8, 3);
    await show(page, { view: toView(states[0]), seat: null });
    let turns = 0;
    for (const state of states.slice(0, -1)) {
      const view = toView(state);
      const ids = ["deck", "discard", ...(view.drawn === null ? [] : ["drawn"])];
      expect(await onScreen(page, view, ids), `turn ${turns}, ${state.phase}`).toEqual(ids);
      // The table follows whoever is playing: a full turn of the table is enough.
      if (state.phase === "draw" && turns++ < 8) {
        await expect(page.locator('[data-testid="opponent"].active')).toBeInViewport({
          ratio: 0.99,
        }); // subpixels
      }
    }
    // Both ways of holding a card were seen: drawn from the deck, and taken from the discard.
    expect(new Set(states.map((s) => s.drawnFrom))).toEqual(new Set([null, "deck", "discard"]));
    expect(turns).toBeGreaterThan(40);
  });

  test("2–8 seats, at the device's own size and at 360 and 390 px wide: two columns, the piles and the held card in view, nothing to tap but the panels; targets ≥ 44 px, no sideways scroll, numbers ≥ 12 px", async ({
    page,
  }, info) => {
    const drew = (players: number) => {
      const state = firstTurn(players, 5);
      return toView(apply(state, { type: "draw", seat: state.current, source: "deck" }));
    };
    await show(page, { view: drew(2), seat: null });
    const own = info.project.use.viewport ?? { width: 390, height: 664 };
    for (const [width, height] of [
      [own.width, own.height],
      [360, 740],
      [390, 664],
    ]) {
      await page.setViewportSize({ width, height });
      for (let players = 2; players <= 8; players++) {
        const where = `${players} seats at ${width} px`;
        const ids = ["deck", "discard", "drawn"];
        expect(await onScreen(page, drew(players), ids), where).toEqual(ids);
        await expect(page.getByTestId("opponent"), where).toHaveCount(players);
        // Two panels a row, each half the width.
        const rows = await page.getByTestId("opponent").evaluateAll((els) => {
          const tops = els.map((el) => Math.round(el.getBoundingClientRect().top));
          return [...new Set(tops)].map((top) => tops.filter((t) => t === top).length);
        });
        expect(rows, where).toEqual(
          Array.from({ length: Math.ceil(players / 2) }, (_, i) =>
            i < Math.floor(players / 2) ? 2 : 1,
          ),
        );
        await expect(page.locator("button.card, input"), where).toHaveCount(0);
        await expectMobileFriendly(page);
        expect(await smallestOpponentNumber(page), where).toBeGreaterThanOrEqual(12);
      }
    }
  });
});

test("round summary: rows, who ended, doubling shown as base ×2 = total; View table hides it", async ({
  page,
}) => {
  // Seed 344: round 1 ends below 100 and the ender is doubled.
  const state = roundOver(2, 344);
  await show(page, { view: toView(state), seat: 0, lead: true });
  const summary = page.getByTestId("round-summary");
  await expect(summary.getByRole("row")).toHaveCount(3);
  await expect(summary.getByText("ended", { exact: true })).toBeVisible();
  if (state.doubled) await expect(summary.getByText(/×2 = \d+/)).toBeVisible();
  await page.getByRole("button", { name: "View table" }).click();
  await expect(page.getByRole("table")).toBeHidden();
  await page.getByRole("button", { name: "Show scores" }).click();
  await expect(page.getByRole("button", { name: "Next round" })).toBeVisible();
});

/**
 * Seed 61 of a 4-player knockout game (R16): Dani goes out after round 1, Ana and Ben after round 2,
 * and Cris, the one left, wins.
 */
const knockout = () => {
  const states = knockoutGame(["Ana", "Ben", "Cris", "Dani"], 61);
  const pick = (test: (s: (typeof states)[number]) => boolean) => {
    const state = states.find(test);
    if (!state) throw new Error("seed 61 no longer plays out this way");
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
  await expect(page.getByTestId("game-over")).toContainText("You win!");
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
  await expect(page.getByTestId("prompt")).toHaveText("You're out · watching");
  await expectMobileFriendly(page);
  // M12 (M17 PO): out, Dani is one slim line under the players still in, not a grid's space.
  const boxes = await page
    .getByTestId("opponent")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect));
  const dani = boxes[DANI];
  const strip = await page.getByTestId("opponents").evaluate((el) => el.clientWidth);
  expect(dani.height).toBeLessThanOrEqual(44);
  expect(dani.width).toBeGreaterThanOrEqual(strip - 4 - 1); // the strip's 2 px padding each side
  for (const other of boxes.filter((_, i) => i !== DANI)) {
    expect(dani.top).toBeGreaterThanOrEqual(other.bottom);
  }
});

test("M17: when everyone still in reaches 100 in the same round, the winner went out too but isn't tagged out", async ({
  page,
}) => {
  // Seed 53: Dani goes out after round 1; Ana, Ben and Cris all reach 100 in round 2, and Cris,
  // on the lowest total, wins.
  const over = knockoutGame(["Ana", "Ben", "Cris", "Dani"], 53).at(-1);
  if (!over) throw new Error("no game");
  expect([over.players.map((p) => p.out), over.winners]).toEqual([[2, 2, 2, 1], [2]]);
  await show(page, { view: toView(over), seat: 0 });
  const rows = page.getByTestId("game-over").getByRole("row");
  await expect(rows.nth(1)).toHaveText(/^Cris/);
  await expect(rows.nth(1).getByTestId("out-tag")).toHaveCount(0);
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
    // Ben (111) and Ana (210) went out in round 2, Dani in round 1.
    await expect(page.getByTestId("game-over").locator("tbody tr:first-child")).toHaveText([
      /^Cris/,
      new RegExp(`^Ben.*${out} 2`),
      new RegExp(`^Ana.*${out} 2`),
      new RegExp(`^Dani.*${out} 1–152$`),
    ]);
    await expect(page.getByTestId("game-over").getByTestId("out-tag")).toHaveCount(3);
    await expectMobileFriendly(page);
  }
});

/** Moves the harness table on (a seat, a view) without reloading the page. */
const retable = (page: Page, detail: Partial<Shown>) =>
  page.evaluate((d) => window.dispatchEvent(new CustomEvent("skyjo:table", { detail: d })), detail);

test("UX-11: the summary is a modal: the first Tab lands inside it and 10 Tabs never leave it; Escape is View table", async ({
  page,
}) => {
  await show(page, { view: toView(roundOver(3, 344)), seat: 0, lead: true });
  const summary = page.getByTestId("round-summary");
  await expect(summary).toBeVisible();
  // Which button has focus, or "outside".
  const focus = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return el?.closest("dialog") ? el.textContent : "outside";
    });
  const seen = [];
  for (let tab = 1; tab <= 10; tab++) {
    await page.keyboard.press("Tab");
    seen.push(await focus());
  }
  expect(seen).toEqual(Array.from({ length: 5 }, () => ["View table", "Next round"]).flat());
  await page.keyboard.press("Shift+Tab");
  expect(await focus()).toBe("View table");
  await page.keyboard.press("Escape");
  await expect(summary).toHaveCount(0);
  const showScores = page.getByRole("button", { name: "Show scores" });
  // What has the focus, and whether a dialog is still open, so a failure says why. 20 s: WebKit's
  // frames are slow at 4 workers on CI, where 5 s wasn't enough twice (main, run 43117120506).
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const el = document.activeElement;
          return {
            focus: el === document.body ? "body" : (el?.textContent ?? null),
            open: document.querySelectorAll("dialog[open]").length,
          };
        }),
      { timeout: 20_000 },
    )
    .toEqual({ focus: "Show scores", open: 0 });
  await showScores.click();
  await expect(summary).toBeVisible();
});

test("UX-14: every summary ranks the players as the engine does, lowest total first, and tags your row 'you'", async ({
  page,
}) => {
  // Seed 344, 4 players: round 1's totals aren't in seat order.
  const view = toView(roundOver(4, 344));
  const rank = places(view);
  const expected = view.players
    .map((p, seat) => ({ ...p, seat }))
    .sort((a, b) => rank[a.seat] - rank[b.seat]);
  expect(expected.map((p) => p.seat)).not.toEqual([0, 1, 2, 3]);
  const totals = expected.map((p) => p.total);
  expect(totals).toEqual([...totals].sort((a, b) => a - b));
  await show(page, { view, seat: 2, lead: true });
  const rows = page.getByTestId("round-summary").locator("tbody tr:first-child");
  await expect(rows).toHaveText(expected.map((p) => new RegExp(`^${p.name}.*${p.total}$`)));
  await expect(rows.locator(".tag.you")).toHaveCount(1);
  await expect(rows.filter({ hasText: "Player 3" }).locator(".tag.you")).toHaveText("you");
  // Knockout (R16): those still in by total, then whoever went out, as places() ranks them.
  const { firstOut } = knockout();
  await retable(page, { view: firstOut, seat: DANI });
  await expect(rows).toHaveText([/^Cris/, /^Ben/, /^Ana/, /^Dani.*Out in round 1/]);
  await expect(rows.last().locator(".tag.you")).toHaveText("you");
});

for (const [locale, win, third, cris, host] of [
  ["en", "You win!", "You placed 3rd", "Cris wins!", "The host can start a new game"],
  [
    "es",
    "¡Ganaste!",
    "Quedaste en 3.er lugar",
    "¡Gana Cris!",
    "El anfitrión puede empezar otra partida",
  ],
  [
    "pt",
    "Você venceu!",
    "Você ficou em 3º lugar",
    "Cris venceu!",
    "O anfitrião pode começar outra partida",
  ],
]) {
  test(`UX-17 (${locale}): game over is yours: the winner reads '${win}', 3rd place '${third}' and who won; nobody is told to wait`, async ({
    page,
  }) => {
    await page.addInitScript((l) => localStorage.setItem("skyjo:locale", l), locale);
    // Cris wins; Ben, then Ana (out in round 2), then Dani.
    await show(page, { view: knockout().over, seat: 2 });
    const over = page.getByTestId("game-over");
    await expect(over.getByRole("heading")).toHaveText(win);
    await expect(over.getByTestId("summary-sub")).toHaveCount(0);
    // Reduced motion: no confetti.
    await expect(over.getByTestId("confetti")).toHaveCount(0);
    await expect(over.locator(".prompt")).toHaveText(host);
    await retable(page, { seat: 0 });
    await expect(over.getByRole("heading")).toHaveText(third);
    await expect(over.getByTestId("summary-sub")).toHaveText(cris);
    await retable(page, { seat: null });
    await expect(over.getByRole("heading")).toHaveText(cris);
    await expectMobileFriendly(page);
  });
}

test("M13 (M17 PO): going out has its own moment: 'You're out · watching' at that summary instead of waiting for the host, and after it", async ({
  page,
}) => {
  const { firstOut, round2 } = knockout();
  await show(page, { view: firstOut, seat: DANI });
  const summary = page.getByTestId("round-summary");
  await expect(summary.getByTestId("summary-sub")).toHaveText("You're out · watching");
  await expect(summary.getByText("Waiting for the host…")).toHaveCount(0);
  // The others wait for the next round.
  await retable(page, { seat: 0 });
  await expect(summary.getByTestId("summary-sub")).toHaveCount(0);
  await expect(summary.getByText("Waiting for the host…")).toBeVisible();
  await retable(page, { view: round2, seat: DANI });
  await expect(page.getByTestId("prompt")).toHaveText("You're out · watching");
});

test.describe("UX-17 with motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("the winner gets a confetti burst that moves only by transform and opacity; the others get none", async ({
    page,
  }) => {
    await show(page, { view: knockout().over, seat: 2 });
    const confetti = page.getByTestId("confetti");
    await expect(confetti).toBeAttached();
    const animated = await confetti.evaluate((el) =>
      el
        .getAnimations({ subtree: true })
        .flatMap((a) => (a.effect as KeyframeEffect).getKeyframes())
        .flatMap((k) => Object.keys(k))
        .filter((key) => !["offset", "computedOffset", "easing", "composite"].includes(key)),
    );
    expect(animated.length).toBeGreaterThan(0);
    expect([...new Set(animated)].sort()).toEqual(["opacity", "transform"]);
    await retable(page, { seat: 0 });
    await expect(confetti).toHaveCount(0);
  });
});

test.describe("small phone (375×548)", () => {
  test.use({ viewport: { width: 375, height: 548 } });

  const gridInView = async (page: Page) =>
    expect(async () => {
      const box = await page.getByTestId("my-grid").boundingBox();
      expect(box?.y).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(548 + 1); // subpixels
    }).toPass();

  test("M13: an 8-player summary leaves the top 56 px to the toasts (M10's Reconnecting…)", async ({
    page,
  }) => {
    await show(page, { view: toView(roundOver(8, 344)), seat: 0, lead: true });
    const sheet = await page.locator("dialog .sheet").boundingBox();
    expect(sheet?.y).toBeGreaterThanOrEqual(56);
  });

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

/** A player's round score so far as the table writes it (UX-15, M27): "14", "−3", "0". */
const roundScore = (p: PlayerView) => {
  const n = p.grid.reduce<number>((sum, slot) => sum + (typeof slot === "number" ? slot : 0), 0);
  return n < 0 ? `−${-n}` : String(n);
};

test("UX-15: at 2, 5 and 8 seats, everyone's round score so far is by their total: the sum of their face-up cards; none from the final reveal on, and your cards keep their size", async ({
  page,
}) => {
  const cardWidth = async () =>
    (await page.getByTestId("my-grid").locator(".card").first().boundingBox())?.width ?? 0;
  for (const players of [2, 5, 8]) {
    const state = lastTurnGame(players, 3);
    const view = toView(state);
    const seat = state.current;
    // Nothing face up yet, so no scores: their line stays, so your cards don't shrink as they come.
    const deal = createGame(
      state.players.map((p) => p.name),
      [3, 0, 0, 0],
    );
    await show(page, { view: toView(deal), seat });
    await expect(page.getByTestId("sum")).toHaveCount(0);
    const before = await cardWidth();
    await retable(page, { view });
    const others = Array.from({ length: players - 1 }, (_, i) => (seat + 1 + i) % players);
    await expect(page.getByTestId("opponent").getByTestId("sum")).toHaveText(
      others.map((i) => roundScore(view.players[i])),
    );
    await expect(page.getByTestId("mine-head").getByTestId("sum")).toHaveText(
      roundScore(view.players[seat]),
    );
    // Each number sits under its caption (M27).
    await expect(page.getByTestId("opponent").first().locator(".stat small")).toHaveText([
      "Game",
      "Round",
    ]);
    await expect(page.getByTestId("mine-head").locator(".stat small")).toHaveText([
      "Game",
      "this round",
    ]);
    expect(Math.abs((await cardWidth()) - before)).toBeLessThanOrEqual(1);
  }
  // The summary has the round's scores; behind it, the totals hold while the cards are revealed
  // (M9), so no running score either.
  await show(page, { view: toView(roundOver(4, 344)), seat: 0 });
  await page.getByRole("button", { name: "View table" }).click();
  await expect(page.getByTestId("table")).toBeVisible();
  await expect(page.getByTestId("sum")).toHaveCount(0);
});

test("UX-15: with a 16-character name in Portuguese, your row stays one line: your round score sits beside your points, inside the row", async ({
  page,
}) => {
  const state = lastTurnGame(4, 3);
  state.players[state.current].name = "Valentina Rodrig";
  await page.addInitScript(() => localStorage.setItem("skyjo:locale", "pt"));
  const box = (selector: string) =>
    page
      .locator(`[data-testid="mine-head"] ${selector}`)
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, middle: (r.top + r.bottom) / 2 };
      });
  for (const width of [0, 360]) {
    if (width) await page.setViewportSize({ width, height: 740 });
    await show(page, { view: toView(state), seat: state.current });
    const [row, pts, sum] = [await box(""), await box(".pts"), await box('[data-testid="sum"]')];
    expect(Math.abs(sum.middle - pts.middle)).toBeLessThan(3);
    expect(sum.top).toBeGreaterThanOrEqual(row.top);
    expect(sum.bottom).toBeLessThanOrEqual(row.bottom);
  }
});

/**
 * Everyone has a 16-character name, a 3-digit total and Auto-play on, and the next player's clock
 * shows its last seconds: the most an opponent's panel head ever holds (BUG-3).
 */
const longNames = (players: number): Shown => {
  const state = lastTurnGame(players, 3);
  state.players.forEach((p, i) => {
    p.name = "Valentina Rodrig";
    p.total = 104 + i;
  });
  return {
    view: toView(state),
    seat: state.current,
    auto: state.players.map(() => true),
    wait: [{ seat: (state.current + 1) % players, inMs: 8_950, reason: "timer" }],
  };
};

test("BUG-3: a 16-character name never covers an opponent's total: at 2, 4 and 8 seats it gives way to the total and the clock's seconds, on Auto-play too", async ({
  page,
}) => {
  const device = page.viewportSize() ?? { width: 390, height: 664 };
  for (const players of [2, 4, 8]) {
    const table = longNames(players);
    const seat = table.seat ?? 0;
    for (const size of [device, { width: 360, height: 740 }]) {
      await page.setViewportSize(size);
      await show(page, table);
      await expect(page.locator(".opp-left")).toBeVisible();
      const heads = await page.getByTestId("opponent").evaluateAll((panels) =>
        panels.map((panel) => {
          const box = (selector: string) => panel.querySelector(selector)?.getBoundingClientRect();
          const [name, total, left] = [box(".opp-name"), box(".opp-total"), box(".opp-left")];
          return {
            total: panel.querySelector(".opp-total")?.textContent,
            // How far the name reaches into the clock's seconds beside it, or out of the panel
            // (px). Since M27 the total sits under the name, not beside it.
            over: (name?.right ?? 0) - (left?.left ?? panel.getBoundingClientRect().right),
            inside: (total?.right ?? 0) <= panel.getBoundingClientRect().right,
          };
        }),
      );
      expect(heads).toEqual(
        Array.from({ length: players - 1 }, (_, i) => ({
          total: String(104 + ((seat + 1 + i) % players)),
          over: expect.any(Number),
          inside: true,
        })),
      );
      expect(Math.max(...heads.map((h) => h.over))).toBeLessThanOrEqual(0.5);
    }
  }
});

test("screenshots: BUG-3 long names", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
  for (const players of [4, 8]) {
    await show(page, longNames(players));
    await expect(page.locator(".opp-left")).toBeVisible();
    await page.screenshot({
      path: `docs/screenshots/bug3/after-${players}.jpg`,
      type: "jpeg",
      quality: 80,
      scale: "css",
      animations: "disabled",
    });
  }
});

test("UX-16: at the first draw everyone reads who starts and why; with one face-down card left, your turn says revealing it ends the round", async ({
  page,
}) => {
  const state = firstTurn(4, 5);
  const view = toView(state);
  const starter = view.players[state.current];
  const pair = roundScore(starter).replace("+", "");
  const prompt = page.getByTestId("prompt");
  await show(page, { view, seat: state.current });
  await expect(prompt).toHaveText(
    new RegExp(`^You start: highest pair \\(${pair}(, tied)?\\)\\. Draw from the deck`),
  );
  await retable(page, { seat: (state.current + 1) % 4 });
  await expect(prompt).toHaveText(new RegExp(`^${starter.name} starts: highest pair \\(${pair}`));
  const late = structuredClone(state);
  late.turn = 9;
  for (const [pos, slot] of late.players[late.current].grid.entries()) {
    if (slot) slot.up = pos !== 6;
  }
  await retable(page, { view: toView(late), seat: late.current });
  await expect(prompt).toHaveText("Revealing your last card ends the round");
});

test("PO, PR #33: in the opening flip only a player with cards to flip is asked to; watchers, out players and anyone done read a neutral 'Everyone flips 2'", async ({
  page,
}) => {
  const deal = createGame(["Ana", "Ben", "Cris", "Dani"], [1, 0, 0, 0]);
  const pill = page.getByTestId("pill");
  const gold = () =>
    pill.evaluate((el) => getComputedStyle(el).backgroundImage.includes("rgb(242, 193, 78)"));
  await show(page, { view: toView(deal), seat: null });
  await expect(pill).toHaveText("Everyone flips 2");
  expect(await gold()).toBe(false);
  await retable(page, { seat: 0 });
  await expect(pill).toHaveText("Flip 2 cards");
  expect(await gold()).toBe(true);
  const done = [0, 1].reduce((s, pos) => apply(s, { type: "flip", seat: 0, pos }), deal);
  await retable(page, { view: toView(done) });
  await expect(pill).toHaveText("Everyone flips 2");
  const round2 = knockoutGame(["Ana", "Ben", "Cris", "Dani"], 61).find(
    (s) => s.round === 2 && s.phase === "flip",
  );
  if (!round2) throw new Error("seed 61 no longer plays out this way");
  await retable(page, { view: toView(round2), seat: DANI });
  await expect(pill).toHaveText("Everyone flips 2");
  expect(await gold()).toBe(false);
});

test("M14: when someone reveals their whole grid, the last turns start with one vibration for everyone, and the pill says so", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const buzzes: unknown[] = [];
    Object.assign(window, { buzzes });
    navigator.vibrate = (pattern) => buzzes.push(pattern) > 0;
    Object.defineProperty(navigator, "userActivation", { value: { hasBeenActive: true } });
  });
  const buzzes = () => page.evaluate(() => (window as unknown as { buzzes: unknown[] }).buzzes);
  const states = playedRound(4, 3);
  const i = states.findIndex((s, j) => s.ender === null && states[j + 1]?.ender !== null);
  await show(page, { view: toView(states[i]), seat: null });
  await retable(page, { view: toView(states[i + 1]) });
  await expect(page.getByTestId("pill")).toHaveClass(/final/);
  await expect.poll(buzzes).toEqual([[80, 80, 80]]);
  // The next player's last turn: the round is already ending, so no second cue.
  await retable(page, { view: toView(states[i + 3]) });
  await expect(page.getByTestId("table")).toHaveAttribute(
    "data-current",
    String(states[i + 3].current),
  );
  await page.waitForTimeout(500); // past the cue's 250 ms
  expect(await buzzes()).toEqual([[80, 80, 80]]);
});

test("screenshots: M14 round awareness", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
  const shot = async (name: string) => {
    await page.waitForLoadState("networkidle"); // the cards' art
    await page.screenshot({ path: `docs/screenshots/m14/${name}.jpg`, type: "jpeg", quality: 80 });
  };
  const round = playedRound(4, 3);
  const mid = round[12];
  await show(page, { view: toView(mid), seat: mid.current });
  await shot("01-round-scores-4");
  const eight = playedRound(8, 3)[30];
  await show(page, { view: toView(eight), seat: (eight.current + 2) % 8 });
  await shot("02-round-scores-8");
  const first = firstTurn(4, 5);
  for (const locale of ["en", "es", "pt"]) {
    await page.addInitScript((l) => localStorage.setItem("skyjo:locale", l), locale);
    await show(page, { view: toView(first), seat: first.current });
    await shot(`03-${locale}-you-start`);
    await retable(page, { seat: (first.current + 1) % 4 });
    await shot(`04-${locale}-who-starts`);
    const late = structuredClone(first);
    late.turn = 9;
    for (const [pos, slot] of late.players[late.current].grid.entries()) {
      if (slot) slot.up = pos !== 6;
    }
    await retable(page, { view: toView(late), seat: late.current });
    await shot(`05-${locale}-last-card`);
  }
  await page.addInitScript(() => localStorage.setItem("skyjo:locale", "en"));
  const i = round.findIndex((s, j) => s.ender === null && round[j + 1]?.ender !== null);
  await show(page, { view: toView(round[i + 1]), seat: round[i + 1].current });
  await shot("06-last-turns");
  await show(page, {
    view: toView(createGame(["Ana", "Ben", "Cris", "Dani"], [1, 0, 0, 0])),
    seat: null,
  });
  await shot("07-spectator-everyone-flips");
  const out = knockoutGame(["Ana", "Ben", "Cris", "Dani"], 61).find(
    (s) => s.round === 2 && s.phase === "flip",
  );
  if (!out) throw new Error("seed 61 no longer plays out this way");
  await show(page, { view: toView(out), seat: DANI });
  await shot("08-out-player-everyone-flips");
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

test("screenshots: M12 spectators keep the piles", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
  const shot = (name: string) =>
    page.screenshot({
      path: `docs/screenshots/m12/${name}.jpg`,
      type: "jpeg",
      quality: 80,
      scale: "css",
      animations: "disabled",
    });
  const watch = async (players: number, at: (s: GameState) => boolean) => {
    const state = playedRound(players, 3).find(at);
    if (!state) throw new Error("no such turn");
    await show(page, { view: toView(state), seat: null });
  };
  await watch(4, (s) => s.drawnFrom === "deck");
  await shot("01-spectator-4-drawn-from-deck");
  // Late in the round, so the table has scrolled down to whoever is playing.
  await watch(8, (s) => s.drawnFrom === "deck" && s.current >= 5);
  await shot("02-spectator-8-drawn-from-deck");
  await watch(8, (s) => s.drawnFrom === "discard" && s.current >= 5);
  await shot("03-spectator-8-taken-from-discard");
  await page.setViewportSize({ width: 360, height: 740 });
  await shot("04-spectator-8-at-360");
  await page.setViewportSize({ width: 390, height: 664 });
  await show(page, { view: knockout().round2, seat: DANI });
  await shot("05-out-player-panel");
});

test.describe("M13 with motion allowed", () => {
  // The winner's shots catch the confetti mid-burst.
  test.use({ reducedMotion: "no-preference" });

  test("screenshots: M13 summary and game over", async ({ page }, info) => {
    test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
    const shot = async (name: string) => {
      await page.waitForTimeout(850); // the totals have counted up; the confetti is falling
      await page.screenshot({
        path: `docs/screenshots/m13/${name}.jpg`,
        type: "jpeg",
        quality: 80,
      });
    };
    const { firstOut, round2, over } = knockout();
    await show(page, { view: toView(roundOver(4, 344)), seat: 2, lead: true });
    await shot("01-summary-ranked-with-you");
    await show(page, { view: firstOut, seat: DANI });
    await shot("02-you-are-out");
    await show(page, { view: round2, seat: DANI });
    await shot("03-out-watching");
    for (const locale of ["en", "es", "pt"]) {
      await page.addInitScript((l) => localStorage.setItem("skyjo:locale", l), locale);
      await show(page, { view: over, seat: 2 });
      await shot(`04-${locale}-you-win`);
      await retable(page, { seat: 0 });
      await shot(`05-${locale}-you-placed-3rd`);
    }
  });
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
      view: toView(roundOver(4, 344)),
      seat: 0,
      lead: true,
      auto: [false, true, false, false],
    });
    await shot("09-summary-bot");
  });
});

// M27: scores you can read. The states are the design mockup's (docs/screenshots/m27/target-*.jpg).
const X = "down" as const;
const m27Players = (): PlayerView[] =>
  (
    [
      ["Sofi", 41, [4, X, 0, 9, 4, 12, -2, X, X, 5, X, 1]],
      ["Leo", 28, [1, X, 6, X, 0, 3, X, X, X, 7, 2, X]],
      ["Mamá", 39, [null, 5, X, -1, null, X, 2, X, null, 0, X, 6]],
      ["Abuelo", 48, [10, X, 4, X, X, 8, X, 3, 6, X, X, 0]],
    ] as const
  ).map(([name, total, grid]) => ({
    name,
    total,
    grid: [...grid],
    scores: [20, total - 20],
    out: null,
  }));
const m27View = (): GameView => ({
  round: 3,
  phase: "place",
  current: 0,
  ender: null,
  doubled: false,
  winners: [],
  players: m27Players(),
  deckCount: 71,
  discardTop: 8,
  drawn: 2,
  drawnFrom: "deck",
  turn: 5,
  knockout: false,
});
/** Sofi holds a 2 from the deck, with 22 s on her clock. */
const m27Table = (): Shown => ({
  view: m27View(),
  seat: 0,
  wait: [{ seat: 0, inMs: 22_000, reason: "timer" }],
});
/** Round 3 is over: Mamá ended it on 18, Leo scored 14, so her 18 counted double. */
const m27Summary = (): Shown => {
  const view = m27View();
  const results = [
    [21, 62],
    [14, 42],
    [36, 75],
    [44, 92],
  ];
  return {
    view: {
      ...view,
      phase: "roundOver",
      ender: 2,
      doubled: true,
      drawn: null,
      drawnFrom: null,
      players: view.players.map((p, i) => ({
        ...p,
        grid: p.grid.map((slot) => (slot === X ? 5 : slot)),
        total: results[i][1],
        scores: [...p.scores, results[i][0]],
      })),
    },
    seat: 0,
    lead: true,
  };
};

test("M27: every face-up card of yours and on the piles carries its weight under its number: a diamond below zero, then 0–3 filled dots by band; opponents' small cards carry none", async ({
  page,
}) => {
  await show(page, m27Table());
  const marks = (selector: string) =>
    page.locator(selector).evaluateAll((cards) =>
      cards.map((card) => {
        const mark = getComputedStyle(card, "::after");
        const dots = ["--m1", "--m2", "--m3"].filter((v) => mark.getPropertyValue(v)).length;
        const value = Number(card.textContent?.replace("−", "-"));
        return [value, mark.content === "none" ? "none" : mark.rotate === "45deg" ? "◆" : dots];
      }),
    );
  expect(await marks('[data-testid="my-grid"] .card.up, .piles .card.up')).toEqual([
    [2, 1],
    [8, 2],
    [4, 1],
    [0, 0],
    [9, 3],
    [4, 1],
    [12, 3],
    [-2, "◆"],
    [5, 2],
    [1, 1],
  ]);
  const small = await marks('[data-testid="opponent"] .card.up');
  expect(small).toHaveLength(17);
  expect(new Set(small.map(([, mark]) => mark))).toEqual(new Set(["none"]));
  // Under the number, inside the card, and at least 4 px tall.
  const box = await page
    .getByTestId("my-grid")
    .locator(".card.up")
    .first()
    .evaluate((card) => {
      const mark = getComputedStyle(card, "::after");
      const num = card.querySelector(".num")?.getBoundingClientRect();
      const r = card.getBoundingClientRect();
      const bottom = r.bottom - Number.parseFloat(mark.marginBottom);
      const top = bottom - Number.parseFloat(mark.height);
      return { below: top - (num?.bottom ?? 0), height: bottom - top, inside: bottom < r.bottom };
    });
  expect(box.below).toBeGreaterThanOrEqual(0);
  expect(box.height).toBeGreaterThanOrEqual(4);
  expect(box.inside).toBe(true);
});

test("M27: on your turn your row, clock and cards are framed, 'Low score wins' beside the clock; on another's turn the frame is off and your cards keep their size", async ({
  page,
}) => {
  await show(page, m27Table());
  const frame = () =>
    page.locator(".mine").evaluate((mine) => {
      const style = getComputedStyle(mine, "::before");
      const box = (el: Element | null) => el?.getBoundingClientRect().toJSON() as DOMRect;
      const m = box(mine);
      const out = (side: string) => Number.parseFloat(style.getPropertyValue(side));
      return {
        lit: style.borderTopColor !== "rgba(0, 0, 0, 0)",
        // The frame, from `.mine`'s box and the pseudo-element's insets.
        top: m.top + out("top"),
        bottom: m.bottom - out("bottom"),
        left: m.left + out("left"),
        right: m.right - out("right"),
        clock: box(document.querySelector('[data-testid="clock"]')),
        grid: box(document.querySelector('[data-testid="my-grid"]')),
        card: box(document.querySelector('[data-testid="my-grid"] .card')).width,
        prompt: box(document.querySelector('[data-testid="prompt"]')).bottom,
        page: document.documentElement.clientWidth,
      };
    });
  const mine = await frame();
  expect(mine.lit).toBe(true);
  expect(mine.clock.top).toBeGreaterThan(mine.top);
  expect(mine.clock.bottom).toBeLessThan(mine.grid.top);
  expect(mine.grid.bottom).toBeLessThanOrEqual(mine.bottom);
  // Around your cards, and inside the page: under the prompt, between the screen's edges.
  expect(mine.top).toBeGreaterThanOrEqual(mine.prompt);
  expect(mine.left).toBeGreaterThanOrEqual(0);
  expect(mine.right).toBeLessThanOrEqual(mine.page);
  await expect(page.locator(".clock-row")).toContainText("Low score wins");
  await expectMobileFriendly(page);
  const view = m27View();
  await retable(page, {
    view: { ...view, phase: "draw", current: 1, drawn: null, drawnFrom: null },
    wait: [],
  });
  await expect(page.getByTestId("table")).toHaveAttribute("data-myturn", "false");
  const theirs = await frame();
  expect(theirs.lit).toBe(false);
  expect(Math.abs(theirs.card - mine.card)).toBeLessThanOrEqual(1);
  await expect(page.locator(".clock-row")).toHaveText("Low score wins");
});

for (const [locale, drew, here, drawn, discard] of [
  ["en", "You drew", "Discard here", "Drawn", "Discard"],
  ["es", "Robaste", "Descarta aquí", "Robada", "Descarte"],
  ["pt", "Você comprou", "Descarte aqui", "Comprada", "Descarte"],
]) {
  test(`M27 (${locale}): the card you drew reads '${drew}' and the discard pile is a dashed drop target, '${here}'; another player's draw reads '${drawn}' beside a plain '${discard}'`, async ({
    page,
  }) => {
    await page.addInitScript((l) => localStorage.setItem("skyjo:locale", l), locale);
    await show(page, m27Table());
    const labels = page.locator(".piles .pile-label");
    await expect(labels.nth(1)).toHaveText(drew);
    await expect(labels.nth(2)).toHaveText(here);
    await expect(page.getByTestId("discard")).toHaveCSS("outline-style", "dashed");
    // One line each: a wrapped caption would move your cards (UX-12).
    for (const label of await labels.all()) {
      expect((await label.boundingBox())?.height).toBeLessThan(20);
    }
    await expectMobileFriendly(page);
    // Thrown away (UX-19), the pile is no drop target any more.
    await page.getByTestId("discard").click();
    await expect(labels.nth(2)).toHaveText(discard);
    // Watching Sofi from Leo's seat: nothing of hers to tap.
    await show(page, { ...m27Table(), seat: 1 });
    await expect(labels.nth(1)).toHaveText(drawn);
    await expect(labels.nth(2)).toHaveText(discard);
    await expect(page.getByTestId("discard")).toHaveCSS("outline-style", "none");
  });
}

test("M27: the summary has 'This round' and 'Game' columns, a bar toward 100 a player, the doubling in a sentence, and what ends the game; knockout says its own", async ({
  page,
}) => {
  await show(page, m27Summary());
  const summary = page.getByTestId("round-summary");
  await expect(summary.getByRole("columnheader")).toHaveText(["Player", "this round", "Game"]);
  await expect(summary.getByTestId("summary-why")).toHaveText(
    "Mamá ended the round, but Leo scored lower, so Mamá's 18 counts double.",
  );
  await expect(summary.locator("tbody tr:first-child")).toHaveText([
    /^Leo1442$/,
    /^Sofiyou2162$/,
    /^Mamáended18×2 = 3675$/,
    /^Abuelo4492$/,
  ]);
  // Their place is drawn before the name; the leader's row stands out.
  expect(
    await summary
      .locator(".who")
      .evaluateAll((els) => els.map((el) => getComputedStyle(el, "::before").content)),
  ).toEqual(['"1"', '"2"', '"3"', '"4"']);
  await expect(summary.locator("tbody.win")).toHaveText(/^Leo/);
  const bars = await summary.locator(".meter").evaluateAll((meters) =>
    meters.map((meter) => {
      const fill = meter.firstElementChild?.getBoundingClientRect().width ?? 0;
      return Math.round((100 * fill) / meter.getBoundingClientRect().width);
    }),
  );
  expect(bars).toEqual([42, 62, 75, 92]);
  await expect(summary.locator(".goal")).toHaveText("Lowest total winsGame ends at 100");
  await expect(summary.getByRole("row")).toHaveCount(5); // the bars' rows aren't read out
  await expectMobileFriendly(page);
  // Knockout (R16): 100 puts you out, and the last one in wins. A total past 100 fills the bar.
  const { firstOut, over } = knockout();
  await retable(page, { view: firstOut });
  await expect(summary.locator(".goal")).toHaveText("Last one under 100 winsOut at 100");
  await expect(summary.locator("tbody").last().locator(".meter")).toHaveAttribute(
    "style",
    "--p: 100;",
  );
  // Game over: nothing left to aim for.
  await show(page, { view: over, seat: 0 });
  await expect(page.getByTestId("game-over").locator(".goal")).toHaveCount(0);
});

test("M27: at 8 seats the summary still fits a small phone: Next round is on screen without scrolling", async ({
  page,
}) => {
  // 8 rows, seen from seat 1. Seat 0 ended this round and was doubled: on its own phone that row
  // also carries "you", wraps to two lines, and the sheet scrolls 8 px at 360 × 640 (PLAN, M27).
  const view: GameView = { ...toView(roundOver(8, 344)), phase: "roundOver", winners: [] };
  for (const size of [
    { width: 360, height: 640 },
    { width: 390, height: 664 },
  ]) {
    await page.setViewportSize(size);
    await show(page, { view, seat: 1, lead: true });
    await expect(page.getByRole("button", { name: "Next round" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("round-summary").getByRole("row")).toHaveCount(9);
    const sheet = page.getByTestId("round-summary").locator(".sheet");
    expect(await sheet.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(0);
    await expectMobileFriendly(page);
  }
});

test("screenshots: M27 scores you can read", async ({ page }, info) => {
  test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
  // The mockup's size (docs/screenshots/m27/target-*.jpg), to compare side by side.
  await page.setViewportSize({ width: 390, height: 844 });
  const shot = async (name: string) => {
    await page.waitForLoadState("networkidle"); // the cards' art
    await page.screenshot({
      path: `docs/screenshots/m27/${name}.jpg`,
      type: "jpeg",
      quality: 85,
      scale: "css",
    });
  };
  await show(page, m27Table());
  await shot("01-your-turn");
  const view = m27View();
  await show(page, {
    view: { ...view, phase: "draw", current: 1, drawn: null, drawnFrom: null },
    seat: 0,
    wait: [{ seat: 1, inMs: 22_000, reason: "timer" }],
  });
  await shot("02-their-turn");
  await show(page, m27Summary());
  await shot("03-summary");
  for (const locale of ["es", "pt"]) {
    await page.addInitScript((l) => localStorage.setItem("skyjo:locale", l), locale);
    await show(page, m27Table());
    await shot(`04-${locale}-your-turn`);
    await show(page, m27Summary());
    await shot(`05-${locale}-summary`);
  }
  await page.addInitScript(() => localStorage.setItem("skyjo:locale", "en"));
  const eight = playedRound(8, 344)[30];
  await page.setViewportSize({ width: 390, height: 664 });
  await show(page, { view: toView(eight), seat: eight.current });
  await shot("06-eight-players");
  await show(page, {
    view: { ...toView(roundOver(8, 344)), phase: "roundOver", winners: [] },
    seat: 0,
    lead: true,
  });
  await shot("07-eight-summary");
});

test("UX-19: a tap on the pile as your turn appears, before the page has settled, still throws the card away", async ({
  page,
}) => {
  const state = firstTurn(2, 5);
  const me = state.current;
  // The tap lands right as the pile is added to the page: before React runs the table's effects.
  await page.addInitScript(() => {
    const watch = new MutationObserver(() => {
      const pile = document.querySelector<HTMLElement>('[data-testid="discard"]');
      if (!pile) return;
      watch.disconnect();
      pile.click();
    });
    watch.observe(document, { childList: true, subtree: true });
  });
  const view = toView(apply(state, { type: "draw", seat: me, source: "deck" }));
  await show(page, { view, seat: me });
  await expect(page.locator(".undo")).toBeVisible();
  await expect(page.getByTestId("discard")).toHaveAttribute("data-tilt", "4");
});
