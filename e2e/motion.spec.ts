import { expect, type Page, test } from "@playwright/test";
import { apply, type GameState } from "../src/engine/game";
import { type GameView, toView } from "../src/engine/view";
import { finalMove, firstTurn, show } from "./harness";
import { seatedRoom, startGame } from "./helpers";

/** Counts Element.animate calls (deterministic across engines, unlike sampling getAnimations()). */
const countAnimations = (page: Page) =>
  page.addInitScript(() => {
    const original = Element.prototype.animate;
    (window as unknown as { animations: number }).animations = 0;
    Element.prototype.animate = function (...args) {
      (window as unknown as { animations: number }).animations++;
      return original.apply(this, args);
    };
  });

/** Ana flips her first card in a fresh 2-phone game; did Ben's phone animate it? */
async function opponentFlipAnimates(pages: Page[]): Promise<boolean> {
  await countAnimations(pages[1]);
  await pages[1].reload();
  await startGame(pages[0]);
  // Ben's reloaded page must show the deal before Ana flips, or his first view already holds the
  // flip and there is nothing to animate (10 of 40 runs at 12 workers, PR #21).
  await expect(pages[1].getByTestId("table")).toHaveAttribute("data-phase", "flip");
  await pages[0].getByTestId("my-grid").locator("button").first().click();
  await expect(pages[1].getByTestId("opponent").locator('[data-face="up"]')).toHaveCount(1);
  return pages[1].evaluate(() => (window as unknown as { animations: number }).animations > 0);
}

/** Every Element.animate call, with its element, for the harness tests below. */
const recordFlights = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { flights: { el: Element; a: Animation }[] };
    w.flights = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const a = original.apply(this, args);
      w.flights.push({ el: this, a });
      return a;
    };
  });

/** A card's centre and width, its picture, and how visible its number is. */
interface Box {
  x: number;
  y: number;
  w: number;
  bg: string;
  num: string | null;
}
type Boxes = Record<string, Box | null>;

/**
 * Moves the harness table on to `view` (src/client/App.tsx) and returns each selector's box just
 * before the move, then at each fraction `at` of the flights it started (paused there). Then every
 * flight lands, as if the players took their time.
 */
async function move(page: Page, view: GameView, read: Record<string, string>, at = [0]) {
  return page.evaluate(
    ({ view, read, at }) => {
      const w = window as unknown as { flights: { el: Element; a: Animation }[] };
      const box = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const num = el.querySelector(".num");
        return {
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          w: r.width,
          bg: getComputedStyle(el).backgroundImage,
          num: num && getComputedStyle(num).opacity,
        };
      };
      const boxes = () => Object.fromEntries(Object.entries(read).map(([k, s]) => [k, box(s)]));
      const before = boxes();
      const start = w.flights.length;
      dispatchEvent(new CustomEvent("skyjo:table", { detail: { view } }));
      const started = w.flights.slice(start).map((f) => f.a);
      const during = at.map((f) => {
        for (const a of started) {
          a.pause();
          a.currentTime = f * Number(a.effect?.getTiming().duration);
        }
        return boxes();
      });
      for (const a of started) a.finish();
      return { before, during };
    },
    { view, read, at },
  ) as Promise<{ before: Boxes; during: Boxes[] }>;
}

const PILES = {
  deck: '[data-testid="deck"]',
  drawn: '[data-testid="drawn"]',
  discard: '[data-testid="discard"]',
};

/** Within 2 px of `to`, centre and width: where the flight's first frame must be. */
function expectOver(box: Box | null | undefined, to: Box | null | undefined, what: string) {
  expect(box, what).toBeTruthy();
  expect(to, what).toBeTruthy();
  if (!box || !to) return;
  const off = Math.max(Math.abs(box.x - to.x), Math.abs(box.y - to.y), Math.abs(box.w - to.w));
  expect(off, `${what}: ${JSON.stringify({ box, to })}`).toBeLessThanOrEqual(2);
}

/** A face-down slot to swap into that keeps the round going and removes no column. */
function swapTarget(state: GameState): number {
  const seat = state.current;
  const grid = state.players[seat].grid;
  const pos = grid.findIndex((slot, i) => {
    if (!slot || slot.up) return false;
    const next = apply(state, { type: "swap", seat, pos: i });
    return next.phase === "draw" && next.players[seat].grid.every((s) => s !== null);
  });
  if (pos === -1) throw new Error("no safe swap left: pick another seed");
  return pos;
}

test.describe("with motion allowed", () => {
  test.use({ reducedMotion: "no-preference" });

  test("an opponent's flip animates on everyone's phone", async ({ browser }, info) => {
    const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"], {
      reducedMotion: "no-preference",
    });
    expect(await opponentFlipAnimates(pages)).toBe(true);
  });

  test("UX-1, UX-25: a deck draw leaves the deck face down, and every swap starts at the held card (8 of 8, yours and the opponent's)", async ({
    page,
  }) => {
    await recordFlights(page);
    let state = firstTurn(2, 5);
    const me = state.current;
    const slot = (seat: number, pos: number) =>
      seat === me
        ? `[data-testid="my-grid"] > :nth-child(${pos + 1})`
        : `[data-testid="opponent"] .mini > :nth-child(${pos + 1})`;
    await show(page, { view: toView(state), seat: me });
    for (let swaps = 0; swaps < 16; swaps++) {
      const seat = state.current;
      state = apply(state, { type: "draw", seat, source: "deck" });
      const draw = await move(page, toView(state), PILES);
      const [frame0] = draw.during;
      expectOver(frame0.drawn, draw.before.deck, `draw ${swaps}: frame 0 over the deck`);
      expect(frame0.drawn?.bg, "frame 0 shows the card back").toBe(draw.before.deck?.bg);
      expect(frame0.drawn?.num, "and no number").toBe("0");

      const pos = swapTarget(state);
      state = apply(state, { type: "swap", seat, pos });
      const swap = await move(page, toView(state), { ...PILES, slot: slot(seat, pos) });
      expectOver(swap.during[0].slot, swap.before.drawn, `swap ${swaps}: frame 0 at the held card`);
    }
  });

  test("UX-1, UX-21: a card taken from the discard right after an opponent's swap starts at the pile and stays over it (0, 25, 50, 100%)", async ({
    page,
  }) => {
    await recordFlights(page);
    let state = firstTurn(2, 5);
    const me = (state.current + 1) % 2; // the opponent moves first
    await show(page, { view: toView(state), seat: me });
    for (let turn = 0; turn < 4; turn++) {
      const them = state.current;
      state = apply(state, { type: "draw", seat: them, source: "deck" });
      await move(page, toView(state), PILES);
      state = apply(state, { type: "swap", seat: them, pos: swapTarget(state) });
      await move(page, toView(state), PILES);

      state = apply(state, { type: "draw", seat: me, source: "discard" });
      const take = await move(page, toView(state), PILES, [0, 0.25, 0.5, 1]);
      expectOver(take.during[0].drawn, take.before.discard, `take ${turn}: frame 0 at the pile`);
      for (const [i, frame] of take.during.entries()) {
        const dx = Math.abs((frame.drawn?.x ?? 0) - (frame.discard?.x ?? 99));
        expect(dx, `take ${turn}, frame ${i}: centred on the pile`).toBeLessThanOrEqual(2);
      }

      const pos = swapTarget(state);
      state = apply(state, { type: "swap", seat: me, pos });
      const swap = await move(page, toView(state), {
        ...PILES,
        slot: `[data-testid="my-grid"] > :nth-child(${pos + 1})`,
      });
      expectOver(swap.during[0].slot, swap.before.drawn, `swap ${turn}: frame 0 at the held card`);
    }
  });

  test("UX-27: the final reveal turns cards in seat order from the ender's left, row by row, and the summary waits until 600 ms after the last", async ({
    page,
  }) => {
    await recordFlights(page);
    const { before, after } = finalMove(3, 3);
    const n = after.players.length;
    const me = 0;
    await show(page, { view: toView(before), seat: me, lead: true });
    const shown = await page.evaluate(async (view) => {
      const w = window as unknown as { flights: { el: Element; a: Animation }[] };
      const start = w.flights.length;
      const t0 = performance.now();
      const sheet = new Promise<number>((done) => {
        const watch = new MutationObserver(() => {
          if (!document.querySelector(".overlay")) return;
          watch.disconnect();
          done(performance.now() - t0);
        });
        watch.observe(document.body, { childList: true, subtree: true });
      });
      dispatchEvent(new CustomEvent("skyjo:table", { detail: { view } }));
      const panels = [...document.querySelectorAll('[data-testid="opponent"]')];
      const flips = w.flights
        .slice(start)
        .filter(({ el, a }) => {
          const keyframes = (a.effect as KeyframeEffect).getKeyframes();
          return el.matches(".card") && keyframes.some((k) => k.backgroundImage);
        })
        .map(({ el, a }) => ({
          panel: panels.findIndex((p) => p.contains(el)),
          pos: [...(el.parentElement?.children ?? [])].indexOf(el),
          delay: Number(a.effect?.getTiming().delay),
          end: Number(a.effect?.getComputedTiming().endTime),
        }));
      return { atOnce: !!document.querySelector(".overlay"), flips, sheet: await sheet };
    }, toView(after));

    // Seats after the ender's, then row by row (grid positions are row-major).
    const seatOf = (panel: number) => (panel === -1 ? me : (me + 1 + panel) % n);
    const order = (seat: number, pos: number) =>
      ((seat - (after.ender ?? 0) - 1 + n) % n) * 12 + pos;
    const expected = before.players.flatMap((p, seat) =>
      p.grid.flatMap((slot, pos) =>
        slot && !slot.up && after.players[seat].grid[pos] ? [order(seat, pos)] : [],
      ),
    );
    const flips = shown.flips
      .map((f) => ({ ...f, order: order(seatOf(f.panel), f.pos) }))
      .sort((a, b) => a.order - b.order);
    expect(flips.map((f) => f.order)).toEqual(expected.sort((a, b) => a - b));
    expect(flips.length).toBeGreaterThan(2);
    for (let i = 1; i < flips.length; i++) {
      expect(flips[i].delay, `flip ${i} starts after flip ${i - 1}`).toBeGreaterThan(
        flips[i - 1].delay,
      );
    }
    const lastFlip = Math.max(...flips.map((f) => f.end));
    expect(shown.atOnce).toBe(false);
    expect(shown.sheet - lastFlip).toBeGreaterThanOrEqual(500);
    expect(shown.sheet - lastFlip).toBeLessThan(1500);
  });
});

test("reduced motion: nothing animates", async ({ browser }, info) => {
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  expect(await opponentFlipAnimates(pages)).toBe(false);
});

test("UX-27: with reduced motion the round summary shows at once", async ({ page }) => {
  const { before, after } = finalMove(3, 3);
  await show(page, { view: toView(before), seat: 0, lead: true });
  const atOnce = await page.evaluate((view) => {
    dispatchEvent(new CustomEvent("skyjo:table", { detail: { view } }));
    return !!document.querySelector(".overlay");
  }, toView(after));
  expect(atOnce).toBe(true);
});
