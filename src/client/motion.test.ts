import { describe, expect, it } from "vitest";
import { type Action, apply, createGame, type GameState } from "../engine/game";
import { toView } from "../engine/view";
import { flightsBetween, slotKey } from "./motion";

/** 2 players past the flip phase, seat 0 to draw, with a known grid and next deck card. */
function table(grid: number[], up: number[], nextDraw: number): GameState {
  const s = createGame(["A", "B"], [1, 0, 0, 0]);
  s.phase = "draw";
  s.current = 0;
  s.players[0].grid = grid.map((card, i) => ({ card, up: up.includes(i) }));
  s.deck.push(nextDraw);
  return s;
}

const flights = (s: GameState, ...actions: Action[]) => {
  const before = toView(s);
  const after = toView(actions.reduce(apply, s));
  return flightsBetween(before, after);
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

  it("a new deal animates nothing", () => {
    const s = table(GRID, [0, 1], 0);
    const next = { ...toView(s), round: 2 };
    expect(flightsBetween(toView(s), next)).toEqual({ moves: new Map(), flips: [] });
  });
});
