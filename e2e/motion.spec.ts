import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { apply, type GameState } from "../src/engine/game";
import { type GameView, toView } from "../src/engine/view";
import { firstTurn, knockoutGame, show } from "./harness";
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

/**
 * A card's centre, width and height; which way it faces (its transform turns its face away:
 * "back") and whether its back face is drawn; its scale (from its transform, so a lean
 * doesn't widen it); its z-index; whether it is what a tap at its centre hits; and how many other
 * cards lie under its centre.
 */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  face: "front" | "back";
  backShown: boolean;
  scale: number;
  z: string;
  hit: boolean;
  over: number;
  opacity: number;
}
type Boxes = Record<string, Box | null>;

/**
 * Moves the harness table on to `view` (src/client/App.tsx) and returns each selector's box just
 * before the move, then at each fraction `at` of the flights it started (paused there, each at that
 * fraction of its own active time, after its delay). Then every flight lands, as if the players
 * took their time, unless `land` is false: then they stay paused at the last fraction. Also returns
 * the started animations' timing and the properties their keyframes animate.
 */
async function move(
  page: Page,
  view: GameView,
  read: Record<string, string>,
  at = [0],
  land = true,
) {
  return page.evaluate(
    ({ view, read, at, land }) => {
      const w = window as unknown as { flights: { el: Element; a: Animation }[] };
      const box = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const [x, y] = [r.x + r.width / 2, r.y + r.height / 2];
        const style = getComputedStyle(el);
        const m = new DOMMatrix(style.transform);
        const back = getComputedStyle(el, "::before");
        const under = [...document.querySelectorAll(".card")].filter((c) => {
          const b = c.getBoundingClientRect();
          return c !== el && x > b.left && x < b.right && y > b.top && y < b.bottom;
        });
        return {
          x,
          y,
          w: r.width,
          h: r.height,
          face: m.m11 < 0 ? "back" : "front",
          backShown: back.content !== "none" && Number(back.opacity) > 0.5,
          scale: Math.hypot(m.m21, m.m22, m.m23),
          z: style.zIndex,
          hit: el.contains(document.elementFromPoint(x, y)),
          over: under.length,
          opacity: Number(style.opacity),
        };
      };
      const boxes = () => Object.fromEntries(Object.entries(read).map(([k, s]) => [k, box(s)]));
      const before = boxes();
      const start = w.flights.length;
      dispatchEvent(new CustomEvent("skyjo:table", { detail: { view } }));
      const flights = w.flights.slice(start);
      const started = flights.map((f) => f.a);
      const timing = flights.map(({ el, a }) => {
        const t = a.effect?.getTiming();
        return {
          el: Object.keys(read).find((k) => document.querySelector(read[k]) === el) ?? null,
          delay: Number(t?.delay),
          duration: Number(t?.duration),
          props: [
            ...new Set(
              (a.effect as KeyframeEffect)
                .getKeyframes()
                .flatMap((k) => Object.keys(k))
                .filter((k) => !["offset", "computedOffset", "easing", "composite"].includes(k)),
            ),
          ],
        };
      });
      const during = at.map((f) => {
        for (const a of started) {
          const t = a.effect?.getTiming();
          a.pause();
          a.currentTime = Number(t?.delay) + f * Number(t?.duration);
        }
        return boxes();
      });
      if (land) for (const a of started) a.finish();
      return { before, during, timing, after: boxes() };
    },
    { view, read, at, land },
  ) as Promise<{
    before: Boxes;
    during: Boxes[];
    after: Boxes;
    timing: { el: string | null; delay: number; duration: number; props: string[] }[];
  }>;
}

/** A card value as the app writes it, with a real minus sign (Card.tsx). */
const formatCard = (n: number) => (n < 0 ? `−${-n}` : String(n));

const PILES = {
  deck: '[data-testid="deck"]',
  drawn: '[data-testid="drawn"]',
  discard: '[data-testid="discard"]',
};
/** A stand-in for a card on its way (motion.ts), not the one under a card flying onto the pile. */
const STAND_IN = '.card[data-copy=""]';

/** Within 2 px of `to`, centre and width: where the flight's first frame must be. */
function expectOver(box: Box | null | undefined, to: Box | null | undefined, what: string) {
  expect(box, what).toBeTruthy();
  expect(to, what).toBeTruthy();
  if (!box || !to) return;
  const off = Math.max(Math.abs(box.x - to.x), Math.abs(box.y - to.y), Math.abs(box.w - to.w));
  expect(off, `${what}: ${JSON.stringify({ box, to })}`).toBeLessThanOrEqual(2);
}

/** CI guard (M11): every animation keyframes only `transform` and/or `opacity`. */
function expectOnlyTransforms(timing: { props: string[] }[]) {
  for (const { props } of timing) {
    expect(props.length, "animates something").toBeGreaterThan(0);
    expect(
      props.every((p) => p === "transform" || p === "opacity"),
      props.join(),
    ).toBe(true);
  }
}

/**
 * A face-down slot (from position `from` on) to swap into that keeps the round going and removes
 * no column. Not one hiding the held card's value: that swap's view is the same as a
 * discard-and-flip, so no phone can tell.
 */
function swapTarget(state: GameState, from = 0): number {
  const seat = state.current;
  const grid = state.players[seat].grid;
  const pos = grid.findIndex((slot, i) => {
    if (i < from || !slot || slot.up || slot.card === state.drawn) return false;
    const next = apply(state, { type: "swap", seat, pos: i });
    return next.phase === "draw" && next.players[seat].grid.every((s) => s !== null);
  });
  if (pos === -1) throw new Error("no safe swap left: pick another seed");
  return pos;
}

/**
 * A round one player races to end, swapping into face-down slots, while the others swap into
 * face-up ones: a big final reveal. The table just before its last move, and after.
 */
function race(players: number, seed: number) {
  let after = firstTurn(players, seed);
  const racer = after.current;
  let before = after;
  while (after.phase === "draw" || after.phase === "place") {
    before = after;
    const seat = after.current;
    if (after.phase === "draw") {
      after = apply(after, { type: "draw", seat, source: "deck" });
    } else {
      const pos = after.players[seat].grid.findIndex((s) => s && s.up !== (seat === racer));
      after = apply(after, { type: "swap", seat, pos });
    }
  }
  return { before, after };
}

/** Your turn, holding a 7 from the deck; your column 0 shows 7, 7 and a face-down card (UX-26). */
function columnTurn() {
  const state = firstTurn(2, 5);
  const me = state.current;
  const grid = state.players[me].grid;
  grid[0] = { card: 7, up: true };
  grid[4] = { card: 7, up: true };
  grid[8] = { card: 3, up: false };
  state.deck.push(7);
  const held = apply(state, { type: "draw", seat: me, source: "deck" });
  return { held, me, after: apply(held, { type: "swap", seat: me, pos: 8 }) };
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
    // A card going into an opponent's grid flies as a stand-in, outside their strip (UX-8).
    const slot = (seat: number, pos: number) =>
      seat === me ? `[data-testid="my-grid"] > :nth-child(${pos + 1})` : STAND_IN;
    await show(page, { view: toView(state), seat: me });
    for (let swaps = 0; swaps < 16; swaps++) {
      const seat = state.current;
      state = apply(state, { type: "draw", seat, source: "deck" });
      const draw = await move(page, toView(state), PILES);
      const [frame0] = draw.during;
      expectOver(frame0.drawn, draw.before.deck, `draw ${swaps}: frame 0 over the deck`);
      expect(frame0.drawn?.face, "frame 0 shows the card's back").toBe("back");
      expect(frame0.drawn?.backShown, "drawn as a face of its own (UX-24)").toBe(true);
      expectOnlyTransforms(draw.timing);

      const pos = swapTarget(state);
      state = apply(state, { type: "swap", seat, pos });
      const swap = await move(page, toView(state), { ...PILES, slot: slot(seat, pos) });
      expectOver(swap.during[0].slot, swap.before.drawn, `swap ${swaps}: frame 0 at the held card`);
      expectOnlyTransforms(swap.timing);
    }
  });

  test("UX-1: a scroll while a card is in flight records where it lands, not the frame it's drawn at", async ({
    page,
  }, info) => {
    // Plain JS, so any engine shows it; on CI's iPhone job it took 8–14 s (0.5 s locally). WebKit's
    // flights stay covered by the draw, swap and discard tests (PO, PR #25).
    test.skip(info.project.name === "iphone", "engine-independent: Pixel and Desktop");
    await recordFlights(page);
    let state = firstTurn(2, 5);
    const me = state.current;
    await show(page, { view: toView(state), seat: me });
    state = apply(state, { type: "draw", seat: me, source: "deck" });
    // Held at rest (100%), then left in flight at frame 0, over the deck.
    const draw = await move(page, toView(state), PILES, [1, 0], false);
    await page.evaluate(async () => {
      dispatchEvent(new Event("scroll")); // positions are read again on the next frame
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    const pos = swapTarget(state);
    state = apply(state, { type: "swap", seat: me, pos });
    const swap = await move(page, toView(state), {
      slot: `[data-testid="my-grid"] > :nth-child(${pos + 1})`,
    });
    expectOver(swap.during[0].slot, draw.during[0].drawn, "the swap starts at the held card");
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

  test("M9 PO, UX-3: a tap on the discard pile while its new top card is still flying in is taken, and the card you take starts at the pile, not mid-flight", async ({
    page,
  }) => {
    await recordFlights(page);
    let state = firstTurn(2, 5);
    const me = (state.current + 1) % 2; // the opponent moves first
    await show(page, { view: toView(state), seat: me });
    const them = state.current;
    state = apply(state, { type: "draw", seat: them, source: "deck" });
    await move(page, toView(state), PILES);
    state = apply(state, { type: "swap", seat: them, pos: swapTarget(state) });
    // Their old card flies to the pile: held at 10% of its way, still over their grid.
    const swap = await move(page, toView(state), PILES, [0.1], false);
    const pile = swap.before.discard;
    const flying = swap.during[0].discard;
    if (!pile || !flying) throw new Error("no discard pile");
    expect(Math.hypot(flying.x - pile.x, flying.y - pile.y), "away from the pile").toBeGreaterThan(
      60,
    );
    await page.mouse.click(pile.x, pile.y);
    await expect(page.getByTestId("discard")).toHaveAttribute("data-pending", "true");
    // The in-flight guard: the tap re-measures the cards, but not one in flight.
    state = apply(state, { type: "draw", seat: me, source: "discard" });
    const take = await move(page, toView(state), PILES);
    expectOver(take.during[0].drawn, pile, "the card taken starts at the pile");
  });

  test("UX-19: thrown away, the drawn card lies on the discard pile within 300 ms, over ≥ 90% of it and tilted 4°; Undo brings it back to your hand", async ({
    page,
  }) => {
    const state = firstTurn(2, 5);
    const me = state.current;
    const view = toView(apply(state, { type: "draw", seat: me, source: "deck" }));
    await show(page, { view, seat: me });
    const thrown = await page.evaluate(async () => {
      const pile = document.querySelector(".stack")?.getBoundingClientRect();
      const discard = document.querySelector<HTMLElement>('[data-testid="discard"]');
      if (!pile || !discard) return null;
      discard.click();
      await new Promise((r) => setTimeout(r)); // React renders the tap in a microtask
      // Everything that moves the card (its flight, its tilt) ends by 300 ms: seen there, on the
      // animations' own clock. Headless WebKit on CI may not paint a frame in 300 ms of wall time.
      const moving = discard.getAnimations();
      const ends = moving.map((a) => {
        const { delay = 0, duration } = a.effect?.getTiming() ?? {};
        return Number(delay) + Number(duration);
      });
      for (const a of moving) a.currentTime = 300;
      // How much of the pile's box the card covers, tilted: what a tap there would hit.
      let over = 0;
      for (let i = 0; i < 20; i++) {
        for (let j = 0; j < 20; j++) {
          const x = pile.x + ((i + 0.5) * pile.width) / 20;
          const y = pile.y + ((j + 0.5) * pile.height) / 20;
          if (discard.contains(document.elementFromPoint(x, y))) over++;
        }
      }
      const label = discard.getAttribute("aria-label");
      const rotate = getComputedStyle(discard).rotate;
      return { covered: over / 400, label, rotate, ends, moving: moving.length };
    });
    expect(thrown?.moving, "a flight and the tilt").toBeGreaterThanOrEqual(2);
    for (const end of thrown?.ends ?? []) expect(end).toBeLessThanOrEqual(300);
    expect(thrown?.covered).toBeGreaterThanOrEqual(0.9);
    expect(thrown?.label).toBe(`Discard pile: ${formatCard(view.drawn ?? 0)}`);
    expect(thrown?.rotate).toBe("4deg");
    await expect(page.getByTestId("drawn")).toHaveCount(0);
    // Undo from the keyboard: focus stays on the pile, whose own card shows at once, straight.
    await page.getByRole("button", { name: "Undo", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("discard")).toBeFocused();
    const pile = page.getByTestId("discard");
    expect(
      await pile.evaluate((el) => [getComputedStyle(el).rotate, el.getAnimations().length]),
    ).toEqual(["none", 0]);
    const back = `Drawn card: ${formatCard(view.drawn ?? 0)}`;
    await expect(page.getByTestId("drawn")).toHaveAttribute("aria-label", back);
    const top = `Discard pile: ${formatCard(view.discardTop ?? 0)}`;
    await expect(pile).toHaveAttribute("aria-label", top);
    await expect(page.getByTestId("prompt")).toHaveText(
      "Tap a grid card to swap, or the discard pile to throw it away",
    );
    // Undo while the throw is still in flight: nothing carries the pile's own card in.
    const caught = await page.evaluate(async () => {
      const tick = () => new Promise((r) => setTimeout(r));
      const pile = () => document.querySelector('[data-testid="discard"]');
      document.querySelector<HTMLElement>('[data-testid="discard"]')?.click();
      await tick();
      const flying = pile()
        ?.getAnimations()
        .some((a) => a.id === "flight");
      document.querySelector<HTMLElement>(".undo")?.click();
      await tick();
      return { flying, after: pile()?.getAnimations().length };
    });
    expect(caught).toEqual({ flying: true, after: 0 });
  });

  test("UX-22: a flight covers 20–50% of its way at 25% of its time, is lifted ≥ 1.04 halfway, lands within 0.5 px, and lasts clamp(260, 180 + 0.55·d, 460) ms; only transforms move", async ({
    page,
  }) => {
    await recordFlights(page);
    let state = firstTurn(2, 5);
    const me = state.current;
    await show(page, { view: toView(state), seat: me });
    state = apply(state, { type: "draw", seat: me, source: "deck" });
    await move(page, toView(state), PILES);
    // Thrown away: the held card flies to the discard pile, the same size all the way.
    const pos = state.players[me].grid.findIndex((s) => s && !s.up);
    state = apply(state, { type: "discardAndFlip", seat: me, pos });
    const at = [0, 0.25, 0.5, 1 - 1 / 460];
    const fly = await move(page, toView(state), { discard: PILES.discard }, at);
    const [start, quarter, half, end] = fly.during.map((f) => f.discard);
    const rest = fly.after.discard;
    if (!start || !quarter || !half || !end || !rest) throw new Error("no discard pile");
    const covered = (quarter.x - start.x) / (rest.x - start.x);
    expect(covered).toBeGreaterThanOrEqual(0.2);
    expect(covered).toBeLessThanOrEqual(0.5);
    expect(half.scale).toBeGreaterThanOrEqual(1.04);
    expect(half.backShown, "a face-up card shows no back on its way").toBe(false);
    // From the held card, 6 px up (UX-4), to the pile: a short trip sideways doesn't arc.
    const along = (half.x - start.x) / (rest.x - start.x);
    expect(half.y).toBeCloseTo(start.y + along * (rest.y - start.y), 0);
    const off = Math.max(
      Math.abs(end.x - rest.x),
      Math.abs(end.y - rest.y),
      Math.abs(end.w - rest.w),
    );
    expect(off, "lands within 0.5 px").toBeLessThanOrEqual(0.5);
    const d = Math.abs(rest.x - start.x);
    const flight = fly.timing.find((t) => t.el === "discard");
    expect(flight?.duration).toBeCloseTo(Math.min(460, Math.max(260, 180 + 0.55 * d)), 0);
    expectOnlyTransforms(fly.timing);
  });

  test("UX-23, UX-7: a swap: the card leaving lifts for 80 ms, back up, and passes over your other cards; the one going in starts ≥ 80 ms later, above it; all done in 560 ms", async ({
    page,
  }) => {
    await recordFlights(page);
    let state = firstTurn(2, 5);
    const me = state.current;
    await show(page, { view: toView(state), seat: me });
    state = apply(state, { type: "draw", seat: me, source: "deck" });
    await move(page, toView(state), PILES);
    // A face-down card in the bottom row, so the card leaving crosses the rows above.
    const pos = swapTarget(state, 8);
    state = apply(state, { type: "swap", seat: me, pos });
    const read = { ...PILES, slot: `[data-testid="my-grid"] > :nth-child(${pos + 1})` };
    const swap = await move(page, toView(state), read, [0.1, 0.2, 0.4, 0.5], false);
    const out = swap.timing.find((t) => t.el === "discard");
    const into = swap.timing.find((t) => t.el === "slot");
    if (!out || !into) throw new Error(`no swap: ${JSON.stringify(swap.timing)}`);
    expect(into.delay - out.delay, "the card going in waits").toBeGreaterThanOrEqual(80);
    expect(Math.max(out.delay + out.duration, into.delay + into.duration)).toBeLessThanOrEqual(560);
    const [lifting, early, crossing, mid] = swap.during;
    // At 10% (inside its 80 ms lift) it is still over its slot, picked up, its back showing.
    const [slot, lifted] = [swap.before.slot, lifting.discard];
    expect(
      Math.hypot((lifted?.x ?? 0) - (slot?.x ?? 99), (lifted?.y ?? 0) - (slot?.y ?? 99)),
    ).toBeLessThanOrEqual(2);
    expect((lifted?.w ?? 0) / (slot?.w ?? 1)).toBeGreaterThan(1);
    expect(early.discard?.face, "its back shows at 20%").toBe("back");
    expect(early.discard?.backShown).toBe(true);
    expect(mid.discard?.backShown, "face up by mid-flight").toBe(false);
    expect(mid.slot?.backShown, "the card going in is face up all the way").toBe(false);
    // Mid-flight it is over your other cards, and on top of them (UX-7).
    expect(crossing.discard?.over, "over another card").toBeGreaterThan(0);
    for (const [i, frame] of [crossing, mid].entries()) {
      expect(frame.discard?.hit, `the card leaving is on top (${i})`).toBe(true);
      expect(frame.slot?.hit, `the card going in is on top (${i})`).toBe(true);
    }
    expect(Number(mid.slot?.z)).toBeGreaterThan(Number(mid.discard?.z));
    expect(Number(mid.discard?.z)).toBeGreaterThan(0);
    expectOnlyTransforms(swap.timing);
    // Where the two cross, the one going in is painted over the one leaving: step the swap's
    // clock until they overlap and hit-test the overlap.
    const crossed = await page.evaluate((slot) => {
      const w = window as unknown as { flights: { a: Animation }[] };
      const swap = w.flights.map((f) => f.a).filter((a) => a.playState === "paused");
      const [out, into] = ['[data-testid="discard"]', slot].map((sel) =>
        document.querySelector(sel),
      );
      let found: { t: number; top: string } | null = null;
      for (let t = 0; t <= 560 && !found && out && into; t += 10) {
        for (const a of swap) a.currentTime = t;
        const [o, i] = [out, into].map((el) => el.getBoundingClientRect());
        const [x0, x1] = [Math.max(o.left, i.left), Math.min(o.right, i.right)];
        const [y0, y1] = [Math.max(o.top, i.top), Math.min(o.bottom, i.bottom)];
        if (x1 - x0 < 10 || y1 - y0 < 10) continue;
        const hit = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
        found = { t, top: into.contains(hit) ? "in" : out.contains(hit) ? "out" : String(hit) };
      }
      for (const a of swap) a.finish();
      return found;
    }, read.slot);
    expect(crossed, "the two cards cross").not.toBeNull();
    expect(crossed?.top, `at ${crossed?.t} ms`).toBe("in");
  });

  test("UX-24: a flip turns from its back: under 15% of its width at 50% ± 8% of its time, its back up at 25%, a large card ×1.05 or more halfway; 380 ms in your grid, 260 ms in an opponent's", async ({
    page,
  }) => {
    await recordFlights(page);
    const state = firstTurn(2, 5);
    const at = [0.25, 0.42, 0.5, 0.58];
    for (const mine of [true, false]) {
      const them = state.current;
      const me = mine ? them : (them + 1) % 2;
      await show(page, { view: toView(state), seat: me });
      let next = apply(state, { type: "draw", seat: them, source: "deck" });
      await move(page, toView(next), PILES);
      const pos = next.players[them].grid.findIndex((s) => s && !s.up);
      next = apply(next, { type: "discardAndFlip", seat: them, pos });
      const card = mine
        ? `[data-testid="my-grid"] > :nth-child(${pos + 1})`
        : `[data-testid="opponent"] .mini > :nth-child(${pos + 1})`;
      const flip = await move(page, toView(next), { card }, at);
      const [quarter, ...edge] = flip.during.map((f) => f.card);
      const rest = flip.after.card;
      if (!quarter || !rest) throw new Error("no card");
      expect(quarter.face, "its back at 25%").toBe("back");
      expect(quarter.backShown).toBe(true);
      expect(edge[2]?.backShown, "its face once past edge-on").toBe(false);
      for (const [i, frame] of edge.entries()) {
        expect(frame?.w ?? 1, `edge-on at ${at[i + 1]}`).toBeLessThan(0.15 * rest.w);
      }
      if (mine) expect(edge[1]?.scale ?? 0, "lifted halfway").toBeGreaterThanOrEqual(1.05);
      expect(flip.timing.find((t) => t.el === "card")?.duration).toBe(mine ? 380 : 260);
      expectOnlyTransforms(flip.timing);
    }
  });

  test("UX-27: the final reveal turns cards in seat order from the ender's left, row by row, and the summary waits until 600 ms after the last", async ({
    page,
  }) => {
    await recordFlights(page);
    // The summary's wait is a timer: a paused clock runs it without waiting for real.
    await page.clock.install({ time: Date.UTC(2026, 9, 25, 12) });
    await page.clock.pauseAt(Date.UTC(2026, 9, 25, 12, 0, 1));
    const { before, after } = race(3, 5);
    const n = after.players.length;
    const me = 0;
    await show(page, { view: toView(before), seat: me, lead: true });
    const shown = await page.evaluate((view) => {
      const w = window as unknown as { flights: { el: Element; a: Animation }[] };
      const start = w.flights.length;
      dispatchEvent(new CustomEvent("skyjo:table", { detail: { view } }));
      const panels = [...document.querySelectorAll('[data-testid="opponent"]')];
      const flips = w.flights
        .slice(start)
        .filter(({ a }) => a.id === "flip")
        .map(({ el, a }) => ({
          panel: panels.findIndex((p) => p.contains(el)),
          pos: [...(el.parentElement?.children ?? [])].indexOf(el),
          delay: Number(a.effect?.getTiming().delay),
          end: Number(a.effect?.getComputedTiming().endTime),
        }));
      const animated = w.flights.slice(start).map(({ a }) => ({
        props: [
          ...new Set((a.effect as KeyframeEffect).getKeyframes().flatMap((k) => Object.keys(k))),
        ].filter((k) => !["offset", "computedOffset", "easing", "composite"].includes(k)),
      }));
      return { atOnce: !!document.querySelector(".overlay"), flips, animated };
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
    expect(new Set(flips.map((f) => Math.floor(f.order / 12))).size).toBe(2); // 2 players' cards
    for (let i = 1; i < flips.length; i++) {
      expect(flips[i].delay, `flip ${i} starts after flip ${i - 1}`).toBeGreaterThan(
        flips[i - 1].delay,
      );
    }
    expectOnlyTransforms(shown.animated);
    const lastFlip = Math.max(...flips.map((f) => f.end));
    expect(lastFlip).toBeLessThanOrEqual(2500 + 380);
    expect(shown.atOnce).toBe(false);
    await page.clock.runFor(lastFlip + 550);
    await page.waitForTimeout(100); // time for React to show it, if it were early
    await expect(page.locator(".overlay")).toHaveCount(0);
    await page.clock.runFor(100);
    await expect(page.locator(".overlay")).toBeVisible();
  });

  test("UX-27: while the final reveal plays, every total is still the one from before the round, then the new one; in knockout too", async ({
    page,
  }) => {
    await page.clock.install({ time: Date.UTC(2026, 9, 25, 12) });
    await page.clock.pauseAt(Date.UTC(2026, 9, 25, 12, 0, 1));
    // Knockout seed 1: Dani went out in round 1; Ana and Ben go out as round 2 ends.
    const knockout = knockoutGame(["Ana", "Ben", "Cris", "Dani"], 1);
    const end = knockout.findIndex((s) => s.round === 2 && s.phase === "gameOver");
    const games = [
      { ...race(3, 5), seat: 0 },
      { before: knockout[end - 1], after: knockout[end], seat: 2 },
    ];
    const totals = () =>
      page.evaluate(() => ({
        panels: [...document.querySelectorAll('[data-testid="opponent"] .opp-total')].map(
          (el) => el.textContent,
        ),
        mine: document.querySelector(".mine-head .pts")?.textContent,
      }));
    for (const { before, after, seat } of games) {
      const n = after.players.length;
      const others = Array.from({ length: n - 1 }, (_, i) => (seat + 1 + i) % n);
      await show(page, { view: toView(before), seat, lead: true });
      const was = await totals();
      expect(was.panels).toEqual(others.map((i) => String(before.players[i].total)));
      await page.evaluate((view) => {
        dispatchEvent(new CustomEvent("skyjo:table", { detail: { view } }));
      }, toView(after));
      expect(await totals(), "the reveal's first frame").toEqual(was);
      await page.clock.runFor(400); // every hold is ≥ 900 ms
      expect(await totals(), "mid-reveal").toEqual(was);
      await page.clock.runFor(3500);
      await expect(page.locator(".overlay")).toBeVisible();
      expect(await totals()).toEqual({
        panels: others.map((i) => String(after.players[i].total)),
        mine: `${after.players[seat].total} pts`,
      });
    }
  });

  test("UX-27: the card you tap to end the round turns at once, then the reveal", async ({
    page,
  }) => {
    await recordFlights(page);
    const { before, after } = race(3, 5);
    const me = before.current; // the last to play, holding a card from the deck
    await show(page, { view: toView(before), seat: me });
    // Forced: hit-testing isn't under test, and WebKit's stability wait is slow with motion on.
    await page.getByTestId("discard").click({ force: true });
    const mine = page.getByTestId("my-grid").locator('button[data-face="down"]').last();
    const pos = await mine.evaluate((el) => [...(el.parentElement?.children ?? [])].indexOf(el));
    await mine.click({ force: true });
    const delays = await page.evaluate((view) => {
      const w = window as unknown as { flights: { el: Element; a: Animation }[] };
      const start = w.flights.length;
      dispatchEvent(new CustomEvent("skyjo:table", { detail: { view } }));
      const grid = document.querySelector('[data-testid="my-grid"]');
      return w.flights
        .slice(start)
        .filter(({ el, a }) => el.parentElement === grid && a.id === "flip")
        .map(({ el, a }) => [
          [...(grid?.children ?? [])].indexOf(el),
          Number(a.effect?.getTiming().delay),
        ]);
    }, toView(after));
    const tapped = delays.filter(([p]) => p === pos);
    expect(tapped.length).toBeGreaterThan(0);
    for (const [, delay] of tapped) expect(delay).toBe(0);
    for (const [p, delay] of delays) if (p !== pos) expect(delay).toBeGreaterThan(0);
  });

  test("UX-8: a card going into an opponent's grid flies as a stand-in that no ancestor clips; their card stays hidden until it lands there, within 0.5 px", async ({
    page,
  }) => {
    await recordFlights(page);
    let state = firstTurn(2, 5);
    const me = (state.current + 1) % 2; // the opponent moves first
    const them = state.current;
    await show(page, { view: toView(state), seat: me });
    state = apply(state, { type: "draw", seat: them, source: "deck" });
    await move(page, toView(state), PILES);
    const pos = swapTarget(state);
    state = apply(state, { type: "swap", seat: them, pos });
    const read = {
      real: `[data-testid="opponent"] .mini > :nth-child(${pos + 1})`,
      copy: STAND_IN,
    };
    const swap = await move(page, toView(state), read, [0.5], false);
    // Every card on screen in motion, through the first half of its flight (the strip hid it for
    // ~140 ms, UX-8): none sticks out of a box that clips it.
    const clipped = await page.evaluate(() => {
      const w = window as unknown as { flights: { el: Element; a: Animation }[] };
      const paused = w.flights.filter(({ a }) => a.playState === "paused");
      return [0, 0.1, 0.25, 0.5].flatMap((f) => {
        for (const { a } of paused) {
          const t = a.effect?.getTiming();
          a.currentTime = Number(t?.delay) + f * Number(t?.duration);
        }
        const moving = paused.flatMap(({ el, a }) =>
          !(a.effect as KeyframeEffect).pseudoElement && Number(getComputedStyle(el).opacity) > 0
            ? [el]
            : [],
        );
        return [...new Set(moving)].flatMap((el) => {
          const r = el.getBoundingClientRect();
          const out: string[] = [];
          for (let box = el.parentElement; box; box = box.parentElement) {
            const s = getComputedStyle(box);
            if (s.overflowX === "visible" && s.overflowY === "visible") continue;
            const b = box.getBoundingClientRect();
            const inside =
              r.left >= b.left - 0.5 &&
              r.right <= b.right + 0.5 &&
              r.top >= b.top - 0.5 &&
              r.bottom <= b.bottom + 0.5;
            if (!inside) out.push(`at ${f}: ${el.className} in ${box.className}`);
          }
          return out;
        });
      });
    });
    expect(clipped).toEqual([]);
    const [mid] = swap.during;
    expect(mid.real?.opacity, "their card waits, hidden").toBe(0);
    expect(mid.copy?.opacity).toBe(1);
    // It lands on their card, which then shows instead.
    const landing = await page.evaluate((copy) => {
      const w = window as unknown as { flights: { el: Element; a: Animation }[] };
      const paused = w.flights.filter(({ a }) => a.playState === "paused");
      const flight = paused.find(({ el }) => el.matches(copy))?.a;
      const end = Number(flight?.effect?.getComputedTiming().endTime);
      for (const { a } of paused) a.currentTime = end - 1;
      const at = document.querySelector(copy)?.getBoundingClientRect();
      for (const { a } of paused) a.finish();
      return at && { x: at.x, y: at.y, w: at.width };
    }, STAND_IN);
    const card = await page.locator(read.real).boundingBox();
    expect(Math.abs((landing?.x ?? 0) - (card?.x ?? 99))).toBeLessThanOrEqual(0.5);
    expect(Math.abs((landing?.y ?? 0) - (card?.y ?? 99))).toBeLessThanOrEqual(0.5);
    expect(Math.abs((landing?.w ?? 0) - (card?.width ?? 99))).toBeLessThanOrEqual(0.5);
    await expect(page.locator(STAND_IN)).toHaveCount(0);
    await expect(page.locator(read.real)).toHaveCSS("opacity", "1");
    expectOnlyTransforms(swap.timing);
  });

  test("UX-30: at 25% of a flight onto the discard pile, the pile still shows the card it will cover: their swap, yours, and their discard-and-flip", async ({
    page,
  }) => {
    await recordFlights(page);
    let state = firstTurn(2, 5);
    const me = (state.current + 1) % 2; // the opponent moves first
    await show(page, { view: toView(state), seat: me });
    for (const [i, how] of (["swap", "swap", "discardAndFlip"] as const).entries()) {
      const seat = state.current;
      state = apply(state, { type: "draw", seat, source: "deck" });
      await move(page, toView(state), PILES);
      const covered = formatCard(state.discard.at(-1) ?? 99);
      const pos =
        how === "swap" ? swapTarget(state) : state.players[seat].grid.findIndex((s) => !s?.up);
      state = apply(state, { type: how, seat, pos });
      await move(page, toView(state), PILES, [0.25], false);
      // Every card seen over the pile's centre (at full opacity), and how far its flight is.
      const shown = await page.evaluate(() => {
        const w = window as unknown as { flights: { a: Animation }[] };
        const pile = document.querySelector(".stack")?.getBoundingClientRect();
        if (!pile) return null;
        const [x, y] = [pile.x + pile.width / 2, pile.y + pile.height / 2];
        const over = [...document.querySelectorAll(".card")].filter((el) => {
          const r = el.getBoundingClientRect();
          const seen = Number(getComputedStyle(el).opacity) > 0.99;
          return seen && x > r.left && x < r.right && y > r.top && y < r.bottom;
        });
        for (const { a } of w.flights) if (a.playState === "paused") a.finish();
        return over.map((el) => el.textContent);
      });
      expect(shown, `${i} (${how}): the pile at 25%`).toEqual([covered]);
    }
  });

  test("UX-26: a swap that completes a column: once it has landed, a beat; the column's 3 cards pulse ×1.1, then fly to the pile 60–90 ms apart, 380 ms each, and the pile shows their card", async ({
    page,
  }) => {
    await recordFlights(page);
    const { held, me, after } = columnTurn();
    await show(page, { view: toView(held), seat: me });
    const column = [0, 4, 8].map((pos) => `[data-testid="my-grid"] > :nth-child(${pos + 1})`);
    const seen = await page.evaluate(
      ({ view, column }) => {
        const w = window as unknown as { flights: { el: Element; a: Animation }[] };
        const start = w.flights.length;
        dispatchEvent(new CustomEvent("skyjo:table", { detail: { view } }));
        const started = w.flights.slice(start);
        for (const { a } of started) a.pause();
        const seek = (t: number) => {
          for (const { a } of started) a.currentTime = t;
        };
        const box = (el: Element | null) => {
          const r = el?.getBoundingClientRect();
          return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width } : null;
        };
        const leave = started
          .filter(({ a }) => a.id === "column")
          .map(({ el, a }) => ({ el, ...a.effect?.getTiming() }))
          .map(({ el, delay, duration }) => ({
            el,
            delay: Number(delay),
            duration: Number(duration),
          }))
          .sort((a, b) => a.delay - b.delay);
        const copies = [...document.querySelectorAll('.card[data-copy=""]')];
        const at = (t: number) => {
          seek(t);
          return copies.map(box);
        };
        const pulse = leave[0].delay - 220;
        const beat = [at(pulse - 120), at(pulse)];
        const slots = column.map((sel) => box(document.querySelector(sel)));
        seek(pulse);
        const rest = leave.map(({ el }) => box(el));
        seek(pulse + 110);
        const peak = leave.map(({ el }) => box(el));
        const landed = leave.map(({ el, delay, duration }) => {
          seek(delay + duration);
          return box(el);
        });
        const pile = box(document.querySelector('[data-testid="discard"]'));
        const props = started.map(({ a }) => ({
          props: [
            ...new Set((a.effect as KeyframeEffect).getKeyframes().flatMap((k) => Object.keys(k))),
          ].filter((k) => !["offset", "computedOffset", "easing", "composite"].includes(k)),
        }));
        for (const { a } of started) a.finish();
        return { leave, beat, slots, rest, peak, landed, pile, props };
      },
      { view: toView(after), column },
    );
    const { leave, beat, slots, rest, peak, landed, pile } = seen;
    expect(leave.map((l) => l.duration)).toEqual([380, 380, 380]);
    for (let i = 1; i < 3; i++) {
      const gap = leave[i].delay - leave[i - 1].delay;
      expect(gap, `flight ${i} after flight ${i - 1}`).toBeGreaterThanOrEqual(60);
      expect(gap).toBeLessThanOrEqual(90);
    }
    // Through the beat nothing moves, and the column's cards are on its slots.
    for (const [i, b] of beat[0].entries()) {
      expect(
        Math.hypot((b?.x ?? 0) - (beat[1][i]?.x ?? 99), (b?.y ?? 0) - (beat[1][i]?.y ?? 99)),
      ).toBeLessThan(0.5);
    }
    for (const [i, r] of rest.entries()) {
      const near = slots.some(
        (s) => Math.hypot((r?.x ?? 0) - (s?.x ?? 99), (r?.y ?? 0) - (s?.y ?? 99)) < 1,
      );
      expect(near, `column card ${i} rests on a slot`).toBe(true);
      expect((peak[i]?.w ?? 0) / (r?.w ?? 1), `pulse ${i}`).toBeCloseTo(1.1, 1);
      expect(Math.abs((landed[i]?.x ?? 0) - (pile?.x ?? 99)), `lands ${i}`).toBeLessThanOrEqual(
        0.5,
      );
      expect(Math.abs((landed[i]?.y ?? 0) - (pile?.y ?? 99))).toBeLessThanOrEqual(0.5);
    }
    expectOnlyTransforms(seen.props);
    await expect(page.locator(".card[data-copy]")).toHaveCount(0);
    await expect(page.getByTestId("discard")).toHaveText("7");
    await expect(page.getByTestId("discard")).toHaveCSS("opacity", "1");
    for (const sel of column) await expect(page.locator(sel)).toHaveAttribute("data-face", "gone");
  });

  /**
   * Moves on to `view` and saves the frames at each time (ms after the move) side by side, from the
   * top of the page down to `height`, as docs/screenshots/<dir>/strip-<name>.jpg (STRIP=before-
   * names them before-strip-…, for a run against `main`). Returns each frame's file.
   */
  async function strip(
    page: Page,
    name: string,
    view: GameView,
    ms: number[],
    height = 664,
    dir = "m11",
  ) {
    await page.evaluate((view) => {
      const w = window as unknown as { flights: { a: Animation }[]; mark: number };
      w.mark = w.flights.length;
      dispatchEvent(new CustomEvent("skyjo:table", { detail: { view } }));
      for (const { a } of w.flights.slice(w.mark)) a.pause();
    }, view);
    const frames: string[] = [];
    for (const [i, t] of ms.entries()) {
      await page.evaluate((t) => {
        const w = window as unknown as { flights: { a: Animation }[]; mark: number };
        for (const { a } of w.flights.slice(w.mark)) a.currentTime = t;
      }, t);
      frames.push(`test-results/${dir}/${name}-${i}.png`);
      await page.screenshot({
        path: frames[i],
        clip: { x: 0, y: 0, width: 390, height },
        scale: "css",
      });
    }
    await page.evaluate(() => {
      const w = window as unknown as { flights: { a: Animation }[]; mark: number };
      for (const { a } of w.flights.slice(w.mark)) a.finish();
    });
    execFileSync("ffmpeg", [
      ...["-loglevel", "error", "-y"],
      ...frames.flatMap((f) => ["-i", f]),
      ...["-filter_complex", `hstack=inputs=${frames.length}`, "-q:v", "4"],
      `docs/screenshots/${dir}/${process.env.STRIP ?? ""}strip-${name}.jpg`,
    ]);
    return frames;
  }

  test("screenshots: M11 frame strips", async ({ page }, info) => {
    test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
    mkdirSync("test-results/m11", { recursive: true });
    // Every 70 ms through a swap (560 ms at most), every 65 ms through a short trip.
    const swap = [0, 70, 140, 210, 280, 350, 420, 490];
    const short = [0, 65, 130, 195, 260, 325];
    const TOP = 420; // the opponents and the piles
    await recordFlights(page);
    let state = firstTurn(2, 5);
    const me = (state.current + 1) % 2; // the opponent moves first
    const them = state.current;
    await show(page, { view: toView(state), seat: me });
    state = apply(state, { type: "draw", seat: them, source: "deck" });
    await move(page, toView(state), PILES);
    state = apply(state, { type: "swap", seat: them, pos: swapTarget(state) });
    await strip(page, "opponent-swap", toView(state), swap, TOP);
    // Take the discard, then swap it into a face-down card in your bottom row.
    state = apply(state, { type: "draw", seat: me, source: "discard" });
    await strip(page, "take-discard", toView(state), short, TOP);
    state = apply(state, { type: "swap", seat: me, pos: swapTarget(state, 8) });
    await strip(page, "swap-from-discard", toView(state), swap);
    state = apply(state, { type: "draw", seat: them, source: "deck" });
    await move(page, toView(state), PILES);
    state = apply(state, { type: "swap", seat: them, pos: swapTarget(state) });
    await move(page, toView(state), PILES);
    // A deck draw, then a swap into your bottom row.
    state = apply(state, { type: "draw", seat: me, source: "deck" });
    await strip(page, "draw-deck", toView(state), short, TOP);
    state = apply(state, { type: "swap", seat: me, pos: swapTarget(state, 8) });
    await strip(page, "swap", toView(state), swap);
    // Their turn, then yours: a deck draw thrown away, and a card turned over in your grid.
    state = apply(state, { type: "draw", seat: them, source: "deck" });
    await move(page, toView(state), PILES);
    state = apply(state, { type: "swap", seat: them, pos: swapTarget(state) });
    await move(page, toView(state), PILES);
    state = apply(state, { type: "draw", seat: me, source: "deck" });
    await move(page, toView(state), PILES);
    const down = state.players[me].grid.findIndex((s) => s && !s.up);
    state = apply(state, { type: "discardAndFlip", seat: me, pos: down });
    await strip(page, "flip", toView(state), [0, 60, 125, 190, 255, 320, 380]);

    // The final reveal, every 500 ms.
    const { before, after } = race(3, 5);
    await show(page, { view: toView(before), seat: 0 });
    await strip(page, "final-reveal", toView(after), [0, 500, 1000, 1500, 2000, 2500]);
  });

  test("screenshots: M19 frame strips", async ({ page }, info) => {
    test.skip(!process.env.SHOTS || info.project.name !== "iphone", "run with SHOTS=1");
    mkdirSync("test-results/m19", { recursive: true });
    const swap = [0, 70, 140, 210, 280, 350, 420, 490];
    await recordFlights(page);
    // An opponent's swap (UX-8): the card going into their grid, over their strip.
    let state = firstTurn(2, 5);
    const me = (state.current + 1) % 2; // the opponent moves first
    const them = state.current;
    await show(page, { view: toView(state), seat: me });
    state = apply(state, { type: "draw", seat: them, source: "deck" });
    await move(page, toView(state), PILES);
    state = apply(state, { type: "swap", seat: them, pos: swapTarget(state) });
    const frames = await strip(page, "opponent-swap", toView(state), swap, 420, "m19");
    execFileSync("ffmpeg", [
      ...["-loglevel", "error", "-y", "-i", frames[2], "-q:v", "3"],
      `docs/screenshots/m19/${process.env.STRIP ?? ""}opponent-swap-140ms.jpg`,
    ]);
    // Your swap onto the discard pile (UX-30): the pile keeps its card until the new one lands.
    state = apply(state, { type: "draw", seat: me, source: "deck" });
    await move(page, toView(state), PILES);
    state = apply(state, { type: "swap", seat: me, pos: swapTarget(state, 8) });
    await strip(page, "swap", toView(state), swap, 664, "m19");
    // A swap that completes your column (UX-26), every 120 ms.
    const { held, after } = columnTurn();
    await show(page, { view: toView(held), seat: held.current });
    const every = Array.from({ length: 13 }, (_, i) => i * 120);
    await strip(page, "column", toView(after), every, 664, "m19");
  });
});

test("reduced motion: nothing animates", async ({ browser }, info) => {
  const { pages } = await seatedRoom(browser, info, ["Ana", "Ben"]);
  expect(await opponentFlipAnimates(pages)).toBe(false);
});

test("UX-26: with reduced motion a completed column just goes: no stand-in, no animation", async ({
  page,
}) => {
  await recordFlights(page);
  const { held, me, after } = columnTurn();
  await show(page, { view: toView(held), seat: me });
  const seen = await page.evaluate((view) => {
    const w = window as unknown as { flights: unknown[] };
    dispatchEvent(new CustomEvent("skyjo:table", { detail: { view } }));
    return {
      animations: w.flights.length,
      copies: document.querySelectorAll("[data-copy]").length,
    };
  }, toView(after));
  expect(seen).toEqual({ animations: 0, copies: 0 });
  await expect(page.getByTestId("my-grid").locator('[data-face="gone"]')).toHaveCount(3);
});

test("UX-27: with reduced motion the round summary shows at once", async ({ page }) => {
  const { before, after } = race(3, 5);
  await show(page, { view: toView(before), seat: 0, lead: true });
  const atOnce = await page.evaluate((view) => {
    dispatchEvent(new CustomEvent("skyjo:table", { detail: { view } }));
    return !!document.querySelector(".overlay");
  }, toView(after));
  expect(atOnce).toBe(true);
});
