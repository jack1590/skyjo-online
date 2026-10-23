import { describe, expect, it } from "vitest";
import {
  type Action,
  apply,
  type Card,
  createGame,
  type GameState,
  type Grid,
  legalActions,
  newDeck,
  RuleError,
} from "./game";
import type { Rng } from "./rng";

const names = (n: number) => Array.from({ length: n }, (_, i) => `P${i}`);
const seed = (n: number): Rng => [n, 0, 0, 0];
const ZEROS = Array<Card>(12).fill(0);

/** 12 cards in reading order; positions in `up` start face up ("all" = every card); null = removed. */
function grid(cards: (Card | null)[], up: number[] | "all" = []): Grid {
  return cards.map((card, i) =>
    card === null ? null : { card, up: up === "all" || up.includes(i) },
  );
}

/** A game past the flip phase with `current` about to draw. Push onto `deck` to set the next draw. */
function inPlay(players: number, current = 0): GameState {
  const s = createGame(names(players), seed(1));
  s.phase = "draw";
  s.current = current;
  return s;
}

const sum = (cards: (Card | null)[]) => cards.reduce<number>((a, b) => a + (b ?? 0), 0);
const upExcept = (pos: number) => [...Array(12).keys()].filter((i) => i !== pos);

function run(s: GameState, ...actions: Action[]): GameState {
  return actions.reduce(apply, s);
}

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
    const s = createGame(names(3), seed(7));
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
    expect(createGame(names(4), seed(42))).toEqual(createGame(names(4), seed(42)));
    expect(createGame(names(4), seed(42)).deck).not.toEqual(createGame(names(4), seed(43)).deck);
  });
});

describe("flip phase", () => {
  it("R3: each player flips exactly two cards; a third flip is rejected", () => {
    let s = createGame(names(2), seed(1));
    s = run(s, { type: "flip", seat: 0, pos: 0 }, { type: "flip", seat: 0, pos: 5 });
    expect(() => apply(s, { type: "flip", seat: 0, pos: 3 })).toThrow(RuleError);
    expect(s.phase).toBe("flip");
    s = run(s, { type: "flip", seat: 1, pos: 2 }, { type: "flip", seat: 1, pos: 3 });
    expect(s.phase).toBe("draw");
    expect(s.players[0].grid.filter((slot) => slot?.up)).toHaveLength(2);
  });

  const flipFirstTwo = (pairs: [Card, Card][]) => {
    const s = createGame(names(pairs.length), seed(1));
    pairs.forEach(([a, b], seat) => {
      s.players[seat].grid = grid([a, b, ...ZEROS.slice(2)]);
    });
    return run(
      s,
      ...pairs.flatMap((_, seat): Action[] => [
        { type: "flip", seat, pos: 0 },
        { type: "flip", seat, pos: 1 },
      ]),
    );
  };

  it("R4: highest flipped sum starts", () => {
    expect(
      flipFirstTwo([
        [1, 2],
        [12, -2],
        [3, 4],
      ]).current,
    ).toBe(1);
  });

  it("R4: ties go to the lowest seat", () => {
    expect(
      flipFirstTwo([
        [1, 2],
        [6, 6],
        [5, 7],
      ]).current,
    ).toBe(1);
  });
});

describe("turns", () => {
  it("R5: turn passes to the next seat and wraps", () => {
    const s = run(
      inPlay(3, 2),
      { type: "draw", seat: 2, source: "deck" },
      { type: "discardAndFlip", seat: 2, pos: 0 },
    );
    expect(s.current).toBe(0);
    expect(s.phase).toBe("draw");
  });

  it("R6: drawing from the deck sets drawn/drawnFrom and phase 'place'", () => {
    const s0 = inPlay(2);
    s0.deck.push(7);
    const s = apply(s0, { type: "draw", seat: 0, source: "deck" });
    expect(s.drawn).toBe(7);
    expect(s.drawnFrom).toBe("deck");
    expect(s.phase).toBe("place");
    expect(s.deck).toHaveLength(s0.deck.length - 1);
  });

  it("R6: discardAndFlip discards the drawn card and flips the chosen face-down card", () => {
    const s0 = inPlay(2);
    s0.deck.push(7);
    const s = run(
      s0,
      { type: "draw", seat: 0, source: "deck" },
      { type: "discardAndFlip", seat: 0, pos: 4 },
    );
    expect(s.discard.at(-1)).toBe(7);
    expect(s.players[0].grid[4]?.up).toBe(true);
    expect(s.drawn).toBeNull();
    expect(s.current).toBe(1);
  });

  it("R7: a card taken from the discard cannot be discarded", () => {
    const s0 = inPlay(2);
    s0.discard.push(3);
    const s = apply(s0, { type: "draw", seat: 0, source: "discard" });
    expect(s.drawn).toBe(3);
    expect(s.drawnFrom).toBe("discard");
    expect(s.discard).toHaveLength(s0.discard.length - 1);
    expect(() => apply(s, { type: "discardAndFlip", seat: 0, pos: 0 })).toThrow(RuleError);
  });

  it("R8: swap puts the drawn card face up and the old card face up on the discard", () => {
    for (const pos of [0, 1]) {
      const s0 = inPlay(2);
      s0.players[0].grid = grid([5, 9, ...ZEROS.slice(2)], [1]);
      s0.deck.push(2);
      const s = run(s0, { type: "draw", seat: 0, source: "deck" }, { type: "swap", seat: 0, pos });
      expect(s.players[0].grid[pos]).toEqual({ card: 2, up: true });
      expect(s.discard.at(-1)).toBe(pos === 0 ? 5 : 9);
    }
  });

  it("R9: removes a column of three equal face-up cards; discard order is swapped card then column", () => {
    const s0 = inPlay(2);
    s0.players[0].grid = grid([5, 1, 2, 3, 5, 2, 3, 4, 9, 3, 4, 1], [0, 4]);
    s0.deck.push(5);
    const s = run(s0, { type: "draw", seat: 0, source: "deck" }, { type: "swap", seat: 0, pos: 8 });
    expect(s.discard.slice(-4)).toEqual([9, 5, 5, 5]);
    expect([0, 4, 8].map((i) => s.players[0].grid[i])).toEqual([null, null, null]);
  });

  it("R9: a flip can complete a column; the discarded card lands under the column", () => {
    const s0 = inPlay(2);
    s0.players[0].grid = grid([5, 1, 2, 3, 5, 2, 3, 4, 5, 3, 4, 1], [0, 4]);
    s0.deck.push(9);
    const s = run(
      s0,
      { type: "draw", seat: 0, source: "deck" },
      { type: "discardAndFlip", seat: 0, pos: 8 },
    );
    expect(s.discard.slice(-4)).toEqual([9, 5, 5, 5]);
    expect([0, 4, 8].map((i) => s.players[0].grid[i])).toEqual([null, null, null]);
  });

  it("R9: no removal when a matching column has a face-down card", () => {
    const s0 = inPlay(2);
    s0.players[0].grid = grid([5, 1, 2, 3, 5, 2, 3, 4, 9, 3, 4, 1], [0]);
    s0.deck.push(5);
    const s = run(s0, { type: "draw", seat: 0, source: "deck" }, { type: "swap", seat: 0, pos: 8 });
    expect(s.players[0].grid[0]).not.toBeNull();
    expect(s.discard.at(-1)).toBe(9);
  });
});

describe("guards", () => {
  it("rejects actions from a seat whose turn it is not", () => {
    expect(() => apply(inPlay(2, 0), { type: "draw", seat: 1, source: "deck" })).toThrow(RuleError);
  });

  it("rejects positions outside 0–11, non-integers, and removed slots", () => {
    const s0 = inPlay(2);
    s0.players[0].grid[0] = null;
    const s = apply(s0, { type: "draw", seat: 0, source: "deck" });
    for (const pos of [12, -1, 1.5, 0]) {
      expect(() => apply(s, { type: "swap", seat: 0, pos })).toThrow(RuleError);
    }
  });

  it("rejects flipping a card that is already face up", () => {
    const s0 = inPlay(2);
    s0.players[0].grid = grid(ZEROS, [0]);
    const s = apply(s0, { type: "draw", seat: 0, source: "deck" });
    expect(() => apply(s, { type: "discardAndFlip", seat: 0, pos: 0 })).toThrow(RuleError);
    const f = apply(createGame(names(2), seed(1)), { type: "flip", seat: 0, pos: 0 });
    expect(() => apply(f, { type: "flip", seat: 0, pos: 0 })).toThrow(RuleError);
  });

  it("rejects invalid seats, sources, and action types", () => {
    const f = createGame(names(2), seed(1));
    for (const seat of [-1, 2, 0.5]) {
      expect(() => apply(f, { type: "flip", seat, pos: 0 })).toThrow(RuleError);
    }
    const bad = { type: "draw", seat: 0, source: "hand" } as unknown as Action;
    expect(() => apply(inPlay(2), bad)).toThrow(RuleError);
    expect(() => apply(f, { type: "bogus" } as unknown as Action)).toThrow(RuleError);
  });

  it("rejects fewer than 2 or more than 8 players, and blank names", () => {
    expect(() => createGame(names(1), seed(1))).toThrow(RuleError);
    expect(() => createGame(names(9), seed(1))).toThrow(RuleError);
    expect(() => createGame(["A", "  "], seed(1))).toThrow(RuleError);
  });

  it("never mutates the input state", () => {
    const s = inPlay(2);
    const snapshot = structuredClone(s);
    apply(s, { type: "draw", seat: 0, source: "deck" });
    expect(() => apply(s, { type: "swap", seat: 0, pos: 0 })).toThrow(RuleError);
    expect(s).toEqual(snapshot);
  });
});

describe("legalActions", () => {
  it("lists exactly the playable actions, and each applies without throwing", () => {
    const fromDeck = apply(inPlay(2), { type: "draw", seat: 0, source: "deck" });
    const fromDiscard = apply(inPlay(2), { type: "draw", seat: 0, source: "discard" });
    const cases: [GameState, number][] = [
      [createGame(names(2), seed(1)), 24],
      [inPlay(2), 2],
      [fromDeck, 24],
      [fromDiscard, 12],
    ];
    for (const [s, count] of cases) {
      const actions = legalActions(s);
      expect(actions).toHaveLength(count);
      for (const a of actions) expect(() => apply(s, a)).not.toThrow();
    }
  });
});

// Grids with no column of three equal values, so nothing is removed unless a test wants it.
const A20 = [1, 2, 3, 4, 2, 3, 4, 1, 0, 0, 0, 0];
const A15 = [1, 2, 3, 4, 1, 2, 1, 1, 0, 0, 0, 0];
const B10 = [1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0];
const Z0 = [1, -1, 2, -2, -1, 1, -2, 2, 0, 0, 0, 0];
const NEG2 = [-2, 1, -1, 0, 0, -1, 0, 1, 1, 0, -1, 0];
const N5 = [-1, -1, -1, -1, -1, 0, 0, 0, 0, 0, 0, 0];

/** 2 players. Seat 0 reveals its last card (pos 11) and ends the round; seat 1 takes the final turn. */
function finishRound(g0: (Card | null)[], g1: (Card | null)[], totals = [0, 0]): GameState {
  const s = inPlay(2);
  s.players[0].grid = grid(g0, upExcept(11));
  s.players[1].grid = grid(g1, [0]);
  s.players.forEach((p, i) => {
    p.total = totals[i];
  });
  return run(
    s,
    { type: "draw", seat: 0, source: "deck" },
    { type: "discardAndFlip", seat: 0, pos: 11 },
    { type: "draw", seat: 1, source: "deck" },
    { type: "discardAndFlip", seat: 1, pos: 1 },
  );
}

describe("round end", () => {
  it("R10: revealing the last card sets ender; each other player gets exactly one more turn", () => {
    const s0 = inPlay(4, 2);
    s0.players[2].grid = grid(A20, upExcept(0));
    let s = run(
      s0,
      { type: "draw", seat: 2, source: "deck" },
      { type: "discardAndFlip", seat: 2, pos: 0 },
    );
    expect(s.ender).toBe(2);
    for (const seat of [3, 0, 1]) {
      expect(s.phase).toBe("draw");
      expect(s.current).toBe(seat);
      s = run(s, { type: "draw", seat, source: "deck" }, { type: "discardAndFlip", seat, pos: 5 });
    }
    expect(s.phase).toBe("roundOver");
  });

  it("R10: a fully removed grid counts as revealed", () => {
    const s0 = inPlay(2);
    s0.players[0].grid = grid(
      [7, null, null, null, 7, null, null, null, 3, null, null, null],
      [0, 4],
    );
    s0.deck.push(7);
    const s = run(s0, { type: "draw", seat: 0, source: "deck" }, { type: "swap", seat: 0, pos: 8 });
    expect(s.players[0].grid.every((slot) => slot === null)).toBe(true);
    expect(s.ender).toBe(0);
    expect(s.current).toBe(1);
  });

  it("R11: final reveal flips everything and removes newly matching columns", () => {
    const s = finishRound(B10, [4, 1, 2, 3, 4, 2, 3, 1, 4, 3, 1, 2]);
    const g1 = s.players[1].grid;
    expect([0, 4, 8].map((i) => g1[i])).toEqual([null, null, null]);
    expect(g1.every((slot) => slot === null || slot.up)).toBe(true);
    expect(s.players[1].scores).toEqual([18]);
  });

  it("R12: round score is the sum of remaining cards", () => {
    const g1 = [null, 2, 3, 4, null, 3, 4, 1, null, 0, 0, 0];
    const s = finishRound(B10, g1);
    expect(s.players.map((p) => p.scores)).toEqual([[sum(B10)], [sum(g1)]]);
    expect(s.players.map((p) => p.total)).toEqual([sum(B10), sum(g1)]);
    expect(s.phase).toBe("roundOver");
  });

  it("R12: ender not strictly lowest with a positive score is doubled", () => {
    const s = finishRound(A20, B10);
    expect(s.doubled).toBe(true);
    expect(s.players.map((p) => p.scores[0])).toEqual([40, 10]);
  });

  it("R12: tie with another player doubles", () => {
    const s = finishRound(A15, A15);
    expect(s.players.map((p) => p.scores[0])).toEqual([30, 15]);
  });

  it("R12: ender strictly lowest is not doubled", () => {
    const s = finishRound(B10, A20);
    expect(s.doubled).toBe(false);
    expect(s.players.map((p) => p.scores[0])).toEqual([10, 20]);
  });

  it("R12: ender with score ≤ 0 is never doubled", () => {
    for (const g0 of [Z0, NEG2]) {
      expect(sum(g0)).toBeGreaterThan(sum(N5));
      const s = finishRound(g0, N5);
      expect(s.doubled).toBe(false);
      expect(s.players[0].scores).toEqual([sum(g0)]);
    }
  });

  it("R13: drawing from an empty deck reshuffles the discard except its top card", () => {
    const s0 = inPlay(2);
    s0.deck = [];
    s0.discard = [3, 4, 5, 9];
    const s = apply(s0, { type: "draw", seat: 0, source: "deck" });
    expect(s.discard).toEqual([9]);
    expect([...s.deck, s.drawn].sort((a, b) => (a as number) - (b as number))).toEqual([3, 4, 5]);
  });
});

describe("game end and next round", () => {
  it("R14: reaching 100 ends the game; lowest total wins", () => {
    const s = finishRound(A20, B10, [90, 0]);
    expect(s.phase).toBe("gameOver");
    expect(s.winners).toEqual([1]);
  });

  it("R14: ties share the win", () => {
    const s = finishRound(B10, A20, [95, 85]);
    expect(s.players.map((p) => p.total)).toEqual([105, 105]);
    expect(s.winners).toEqual([0, 1]);
  });

  it("R15: nextRound redeals a full 150-card deck and returns to flip phase", () => {
    const s = apply(finishRound(B10, A20), { type: "nextRound" });
    expect(s.round).toBe(2);
    expect(s.phase).toBe("flip");
    expect(s.ender).toBeNull();
    for (const p of s.players) {
      expect(p.grid.every((slot) => slot && !slot.up)).toBe(true);
    }
    expect(s.deck).toHaveLength(150 - 24 - 1);
    expect(s.discard).toHaveLength(1);
    expect(s.players.map((p) => p.total)).toEqual([10, 20]);
  });

  it("R4: start-player rule also applies in round 2", () => {
    const s = apply(finishRound(B10, A20), { type: "nextRound" });
    s.players[0].grid = grid([1, 2, ...ZEROS.slice(2)]);
    s.players[1].grid = grid([6, 6, ...ZEROS.slice(2)]);
    const flipped = run(
      s,
      { type: "flip", seat: 0, pos: 0 },
      { type: "flip", seat: 0, pos: 1 },
      { type: "flip", seat: 1, pos: 0 },
      { type: "flip", seat: 1, pos: 1 },
    );
    expect(flipped.current).toBe(1);
  });

  it("rejects every action after game over, and nextRound outside roundOver", () => {
    const over = finishRound(A20, B10, [90, 0]);
    expect(legalActions(over)).toEqual([]);
    expect(() => apply(over, { type: "nextRound" })).toThrow(RuleError);
    expect(() => apply(over, { type: "draw", seat: over.current, source: "deck" })).toThrow(
      RuleError,
    );
    expect(() => apply(inPlay(2), { type: "nextRound" })).toThrow(RuleError);
  });
});
