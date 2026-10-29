import { describe, expect, it } from "vitest";
import { apply, createGame, type GameState, legalActions } from "../engine/game";
import { toView } from "../engine/view";
import { lastMover } from "../protocol";
import { END_REACT, LAND } from "./Reactions";
import { flight } from "./Toss";

/** Plays the first legal move (the last one when placing) until `done`. */
const playUntil = (state: GameState, done: (s: GameState) => boolean) => {
  let s = state;
  while (!done(s)) {
    const legal = legalActions(s);
    s = apply(s, legal[s.phase === "place" ? legal.length - 1 : 0]);
  }
  return s;
};

describe("lastMover", () => {
  it("M23: none in the opening flip or at a round's first turn; then the seat before the one to move, unless it's you", () => {
    const fresh = createGame(["A", "B", "C"], [3, 0, 0, 0]);
    expect(lastMover(toView(fresh), 0)).toBeNull();
    const first = playUntil(fresh, (s) => s.phase === "draw");
    expect(lastMover(toView(first), 0)).toBeNull();
    const second = playUntil(first, (s) => s.turn === 1);
    const before = (second.current + 2) % 3;
    expect(lastMover(toView(second), second.current)).toBe(before);
    expect(lastMover(toView(second), null)).toBe(before);
    expect(lastMover(toView(second), before)).toBeNull();
    // Still the same seat while the next player holds the card they drew.
    const placing = apply(second, legalActions(second)[0]);
    expect(placing.phase).toBe("place");
    expect(lastMover(toView(placing), null)).toBe(before);
  });

  it("M23: skips players who are out (R16)", () => {
    const s = playUntil(createGame(["A", "B", "C"], [3, 0, 0, 0]), (s) => s.turn === 1);
    const before = (s.current + 2) % 3;
    const view = toView(s);
    view.players[before].out = 1;
    expect(lastMover(view, null)).toBe((s.current + 1) % 3);
  });
});

describe("the migajero's pigeon", () => {
  it("M23: winds up, flies 700 ms with a flutter, and lands at LAND, well before everything goes", () => {
    const { frames, land } = flight("pigeon", 200, -300);
    expect(land).toBe(LAND);
    expect(String(frames.at(-1)?.transform)).toBe("translate(0px, 0px) scale(1)");
    expect(LAND + 1500).toBeLessThan(END_REACT);
  });
});
