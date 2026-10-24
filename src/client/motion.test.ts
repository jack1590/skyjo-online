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
    expect(flightsBetween(toView(s), next)).toEqual({ moves: new Map(), flips: [] });
  });
});
