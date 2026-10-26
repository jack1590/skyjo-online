import { describe, expect, it } from "vitest";
import { type Action, apply, createGame, type GameState } from "../engine/game";
import { toView } from "../engine/view";
import {
  bezier,
  FLIP_MS,
  flightMs,
  flightsBetween,
  flipDelays,
  flipFrames,
  LIFT_MS,
  path,
  revealStep,
  SUMMARY_MS,
  settled,
  slotKey,
} from "./motion";

/** 2 players past the flip phase, seat 0 to draw, with a known grid and next deck card. */
function table(grid: number[], up: number[], nextDraw: number): GameState {
  const s = createGame(["A", "B"], [1, 0, 0, 0]);
  s.phase = "draw";
  s.current = 0;
  s.players[0].grid = grid.map((card, i) => ({ card, up: up.includes(i) }));
  s.deck.push(nextDraw);
  return s;
}

/** Flights for the last action, as seen by someone who watched every earlier one. */
const flights = (s: GameState, ...actions: Action[]) => {
  const before = actions.slice(0, -1).reduce(apply, s);
  return flightsBetween(toView(before), toView(apply(before, actions.at(-1) as Action)));
};

const GRID = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

describe("flightsBetween", () => {
  it("a draw flies from the deck (or the discard) to the drawn spot", () => {
    const s = table(GRID, [0, 1], 7);
    expect(flights(s, { type: "draw", seat: 0, source: "deck" }).moves).toEqual(
      new Map([["drawn", "deck"]]),
    );
    expect(flights(s, { type: "draw", seat: 0, source: "discard" }).moves).toEqual(
      new Map([["drawn", "discard"]]),
    );
  });

  it("a swap flies the held card into the grid and the old card to the discard", () => {
    const s = apply(table(GRID, [0, 1], 0), { type: "draw", seat: 0, source: "deck" });
    const { moves, flips } = flights(s, { type: "swap", seat: 0, pos: 5 });
    expect(moves).toEqual(
      new Map([
        [slotKey(0, 5), "drawn"],
        ["discard", slotKey(0, 5)],
      ]),
    );
    expect(flips).toEqual([]);
  });

  it("discard-and-flip flies the held card to the discard and flips the chosen card", () => {
    const s = apply(table(GRID, [0, 1], 0), { type: "draw", seat: 0, source: "deck" });
    const { moves, flips } = flights(s, { type: "discardAndFlip", seat: 0, pos: 5 });
    expect(moves).toEqual(new Map([["discard", "drawn"]]));
    expect(flips).toEqual([slotKey(0, 5)]);
  });

  it("a completed column flies to the discard", () => {
    const s = apply(table([5, 1, 2, 3, 5, 2, 3, 4, 9, 3, 4, 1], [0, 4], 5), {
      type: "draw",
      seat: 0,
      source: "deck",
    });
    expect(flights(s, { type: "swap", seat: 0, pos: 8 }).moves.get("discard")).toMatch(/^slot-0-/);
  });

  it("the round's last swap flies into its own slot even though the final reveal changes others", () => {
    for (const source of ["deck", "discard"] as const) {
      const s = createGame(["A", "B"], [1, 0, 0, 0]);
      s.phase = "draw";
      s.current = 1;
      s.ender = 0;
      s.players[0].grid = GRID.map((card) => ({ card, up: true }));
      s.players[1].grid = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 0].map((card, i) => ({
        card,
        up: i < 2,
      }));
      (source === "deck" ? s.deck : s.discard).push(7);
      const { moves } = flights(
        s,
        { type: "draw", seat: 1, source },
        { type: "swap", seat: 1, pos: 5 },
      );
      expect(moves.get(slotKey(1, 5))).toBe("drawn");
      expect(moves.get("discard")).toBe(slotKey(1, 5));
    }
  });

  it("a new deal animates nothing", () => {
    const s = table(GRID, [0, 1], 0);
    const next = { ...toView(s), round: 2 };
    expect(flightsBetween(toView(s), next)).toEqual({
      moves: new Map(),
      turns: new Set(),
      flips: [],
      reveal: false,
    });
  });

  it("UX-23, UX-25: a card that leaves face down turns over on the way: a deck draw, and a swapped-out face-down card; not a face-up one, nor one from the discard", () => {
    const s = table(GRID, [0, 1], 0);
    expect(flights(s, { type: "draw", seat: 0, source: "deck" }).turns).toEqual(new Set(["drawn"]));
    expect(flights(s, { type: "draw", seat: 0, source: "discard" }).turns).toEqual(new Set());
    const held = apply(s, { type: "draw", seat: 0, source: "deck" });
    expect(flights(held, { type: "swap", seat: 0, pos: 5 }).turns).toEqual(new Set(["discard"]));
    expect(flights(held, { type: "swap", seat: 0, pos: 0 }).turns).toEqual(new Set());
    expect(flights(held, { type: "discardAndFlip", seat: 0, pos: 5 }).turns).toEqual(new Set());
  });

  it("UX-27: the final reveal turns cards in seat order from the ender's left, row by row", () => {
    // 3 players: B (seat 1) ended; C (seat 2) has played; A (seat 0) takes the last turn.
    const s = createGame(["A", "B", "C"], [1, 0, 0, 0]);
    s.phase = "draw";
    s.current = 0;
    s.ender = 1;
    const deal = (down: number[]) => GRID.map((card, i) => ({ card, up: !down.includes(i) }));
    s.players[0].grid = deal([3, 4, 9]);
    s.players[1].grid = deal([]);
    s.players[2].grid = deal([10, 1, 6]);
    s.deck.push(0);
    const { flips, reveal } = flights(
      s,
      { type: "draw", seat: 0, source: "deck" },
      { type: "discardAndFlip", seat: 0, pos: 4 },
    );
    expect(reveal).toBe(true);
    const order = [
      [2, 1],
      [2, 6],
      [2, 10],
      [0, 3],
      [0, 4],
      [0, 9],
    ];
    expect(flips).toEqual(order.map(([seat, pos]) => slotKey(seat, pos)));
  });

  it("UX-27: flips are 110 ms apart, closer when there are many (2.5 s at most); the summary waits until 600 ms after the last one ends", () => {
    expect(revealStep(5)).toBe(110);
    expect(revealStep(50)).toBe(50);
    expect(49 * revealStep(50)).toBeLessThanOrEqual(2500);
    expect(SUMMARY_MS).toBe(600);
    // The last of 5 small flips starts at 440 ms and ends at 700; the last move's flight sooner.
    const timing = new Map([
      ["discard", { start: 0, end: 345 }],
      ...flipDelays(["a", "b", "c", "d", "e"], revealStep(5)).map(
        ([key, start]) => [key, { start, end: start + FLIP_MS.sm }] as const,
      ),
    ]);
    expect(settled(timing)).toBe(440 + 260);
    expect(settled(new Map([["discard", { start: 0, end: 345 }]])), "nothing to turn").toBe(345);
    expect(settled(new Map()), "nothing moved").toBe(0);
  });

  it("UX-27: the card you tapped turns first, then the reveal in its order, a step apart", () => {
    const flips = ["slot-2-1", "slot-0-3", "slot-0-4"];
    expect(flipDelays(flips, 110, "slot-0-4")).toEqual([
      ["slot-0-4", 0],
      ["slot-2-1", 110],
      ["slot-0-3", 220],
    ]);
    expect(flipDelays(flips, 0, null).map(([, ms]) => ms)).toEqual([0, 0, 0]);
  });

  it("UX-27: an ordinary turn is not a reveal", () => {
    const s = apply(table(GRID, [0, 1], 0), { type: "draw", seat: 0, source: "deck" });
    expect(flights(s, { type: "discardAndFlip", seat: 0, pos: 5 }).reveal).toBe(false);
  });
});

/** A card-sized box centred on (x, y). */
const box = (x: number, y: number, width = 60) => ({
  x: x - width / 2,
  y: y - (width * 7) / 10,
  width,
  height: (width * 7) / 5,
});
/** The frame at `offset` of a flight's time (every acceptance time is one of its frames). */
const at = (frames: ReturnType<typeof path>["frames"], offset: number) => {
  const f = frames.find((f) => Math.abs(f.offset - offset) < 1e-9);
  if (!f) throw new Error(`no frame at ${offset}`);
  return f;
};

describe("UX-22: the flight curve", () => {
  it("UX-22: lasts clamp(260, 180 + 0.55·d, 460) ms", () => {
    expect([0, 100, 300, 500, 1000].map(flightMs)).toEqual([260, 260, 345, 455, 460]);
    expect(path(box(0, 0), box(300, 0)).duration).toBe(345);
  });

  it("UX-22: at 25% of the time 20–50% of the way is covered; at 50% it is lifted ≥ 1.04 and leans 3° the way it goes; it lands exactly, after settling to 0.97", () => {
    for (const [dx, dy] of [
      [300, 0],
      [-120, 40],
      [60, 300],
      [-30, -420],
    ]) {
      const { frames } = path(box(dx, dy), box(0, 0));
      const quarter = at(frames, 0.25);
      // Along the straight line from the start: the arc only moves it sideways from it.
      const covered = 1 - (quarter.x * dx + quarter.y * dy) / (dx * dx + dy * dy);
      expect(covered, `${dx},${dy}`).toBeGreaterThanOrEqual(0.2);
      expect(covered, `${dx},${dy}`).toBeLessThanOrEqual(0.5);
      const mid = at(frames, 0.5);
      expect(mid.scale).toBeGreaterThanOrEqual(1.04);
      expect(mid.rotate).toBe(3 * Math.sign(-dx));
      expect(at(frames, 0.94).scale).toBe(0.97);
      expect(frames.at(-1)).toEqual({ offset: 1, x: 0, y: 0, rotate: 0, scale: 1, turn: 0 });
    }
  });

  it("UX-22: arcs up by min(24, 0.12·d) px halfway when it travels more than 80 px up or down", () => {
    // 300 px down: 24 px above the straight line at half time.
    const down = at(path(box(0, -300), box(0, 0)).frames, 0.5);
    expect(down.x, "straight down: no sideways move").toBe(0);
    const straight = -300 * (1 - bezier(0.3, 0, 0.2, 1)(0.5));
    expect(down.y).toBeCloseTo(straight - 24, 3);
    expect(down.rotate).toBe(0);
    // 150 px up: 18 px.
    const up = at(path(box(0, 150), box(0, 0)).frames, 0.5);
    expect(up.y).toBeCloseTo(150 * (1 - bezier(0.3, 0, 0.2, 1)(0.5)) - 18, 3);
    // Sideways, or only 80 px up: no arc.
    const flat = at(path(box(0, 80), box(0, 0)).frames, 0.5);
    expect(flat.y).toBeCloseTo(80 * (1 - bezier(0.3, 0, 0.2, 1)(0.5)), 3);
  });

  it("UX-22: a card growing on the way (into your grid) still lifts 6% over its size halfway", () => {
    const { frames } = path(box(0, -200, 58), box(0, 0, 80));
    const mid = at(frames, 0.5);
    const size = 58 / 80 + (1 - 58 / 80) * bezier(0.3, 0, 0.2, 1)(0.5);
    expect(mid.scale / size).toBeCloseTo(1.06, 3);
  });
});

describe("UX-23: the swap", () => {
  it("UX-23: the card leaving is picked up for 80 ms where it is, its back up, then flies, face up by half way; ≤ 560 ms", () => {
    const { frames, duration } = path(box(0, 300, 80), box(90, 0, 58), {
      lift: LIFT_MS,
      turn: true,
    });
    expect(duration).toBe(80 + flightMs(Math.hypot(90, 300)));
    expect(duration).toBeLessThanOrEqual(560);
    const [start, lifted] = frames;
    expect(start).toMatchObject({ offset: 0, x: -90, y: 300, turn: 180 });
    expect(lifted).toMatchObject({ offset: 80 / duration, x: -90, y: 300, turn: 180 });
    expect(lifted.scale / start.scale).toBeCloseTo(1.06, 3);
    // Its back still shows at 20% of the swap; face up by the middle of its flight.
    const turnAt = (offset: number) => {
      const i = frames.findIndex((f) => f.offset >= offset);
      const [a, b] = [frames[i - 1], frames[i]];
      return a.turn + ((b.turn - a.turn) * (offset - a.offset)) / (b.offset - a.offset);
    };
    expect(turnAt(0.2)).toBeGreaterThan(90);
    const { edge } = path(box(0, 300, 80), box(90, 0, 58), { lift: LIFT_MS, turn: true });
    expect(at(frames, edge).turn, "edge-on when its back is hidden").toBe(90);
    const half = (80 + 0.5 * flightMs(Math.hypot(90, 300))) / duration;
    expect(turnAt(half)).toBe(0);
  });

  it("UX-23: a face-up card leaving doesn't turn", () => {
    const { frames } = path(box(0, 300, 80), box(90, 0, 58), { lift: LIFT_MS });
    expect(frames.every((f) => f.turn === 0)).toBe(true);
  });
});

describe("UX-24: the flip", () => {
  it("UX-24: from its back, edge-on and lifted 4 px, ×1.08 halfway (not when small), face up; 380, 340 and 260 ms", () => {
    expect(FLIP_MS).toEqual({ lg: 380, md: 340, sm: 260 });
    expect(flipFrames("lg", 80).map((k) => k.transform)).toEqual([
      "perspective(480px) translateY(0px) rotateY(180deg) scale(1)",
      "perspective(480px) translateY(-4px) rotateY(90deg) scale(1.08)",
      "perspective(480px) translateY(0px) rotateY(0deg) scale(1)",
    ]);
    expect(flipFrames("sm", 30)[1].transform).toBe(
      "perspective(180px) translateY(0px) rotateY(90deg) scale(1)",
    );
  });

  it("UX-24: each half eases, so at 50% ± 8% of its time the card is under 15% of its width", () => {
    const keyframes = flipFrames("lg", 80);
    expect(keyframes.every((k) => k.easing === "cubic-bezier(0.45, 0, 0.25, 1)")).toBe(true);
    const ease = bezier(0.45, 0, 0.25, 1);
    const turn = (t: number) => (t < 0.5 ? 180 - 90 * ease(2 * t) : 90 - 90 * ease(2 * t - 1));
    for (const t of [0.42, 0.46, 0.5, 0.54, 0.58]) {
      expect(Math.abs(Math.cos((turn(t) * Math.PI) / 180)), `at ${t}`).toBeLessThan(0.15);
    }
    expect(turn(0.25), "its back shows at 25%").toBeGreaterThan(90);
  });
});
