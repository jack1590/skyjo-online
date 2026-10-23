import { describe, expect, it } from "vitest";
import { type Card, createGame, newDeck } from "./game";

const names = (n: number) => Array.from({ length: n }, (_, i) => `P${i}`);

describe("setup", () => {
  it("R1: deck has 150 cards: -2×5, -1×10, 0×15, 1..12×10", () => {
    const deck = newDeck();
    expect(deck).toHaveLength(150);
    const count = (v: Card) => deck.filter((c) => c === v).length;
    expect(count(-2)).toBe(5);
    expect(count(-1)).toBe(10);
    expect(count(0)).toBe(15);
    for (let v = 1; v <= 12; v++) expect(count(v)).toBe(10);
  });

  it("R2: deals 12 face-down cards per player and starts the discard with one card", () => {
    const s = createGame(names(3), 7);
    for (const p of s.players) {
      expect(p.grid).toHaveLength(12);
      expect(p.grid.every((slot) => slot && !slot.up)).toBe(true);
    }
    expect(s.discard).toHaveLength(1);
    expect(s.deck).toHaveLength(150 - 3 * 12 - 1);
    expect(s.phase).toBe("flip");
    expect(s.round).toBe(1);
  });

  it("createGame is deterministic for a seed and differs across seeds", () => {
    expect(createGame(names(4), 42)).toEqual(createGame(names(4), 42));
    expect(createGame(names(4), 42).deck).not.toEqual(createGame(names(4), 43).deck);
  });
});
