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

const names = (n: number) => Array.from({ length: n }, (_, i) => `P${i}`);
const ZEROS = Array<Card>(12).fill(0);

/** 12 cards in reading order; positions in `up` start face up ("all" = every card); null = removed. */
function grid(cards: (Card | null)[], up: number[] | "all" = []): Grid {
  return cards.map((card, i) =>
    card === null ? null : { card, up: up === "all" || up.includes(i) },
  );
}

/** A game past the flip phase with `current` about to draw. Push onto `deck` to set the next draw. */
function inPlay(players: number, current = 0): GameState {
  const s = createGame(names(players), 1);
  s.phase = "draw";
  s.current = current;
  return s;
}

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

describe("flip phase", () => {
  it("R3: each player flips exactly two cards; a third flip is rejected", () => {
    let s = createGame(names(2), 1);
    s = run(s, { type: "flip", seat: 0, pos: 0 }, { type: "flip", seat: 0, pos: 5 });
    expect(() => apply(s, { type: "flip", seat: 0, pos: 3 })).toThrow(RuleError);
    expect(s.phase).toBe("flip");
    s = run(s, { type: "flip", seat: 1, pos: 2 }, { type: "flip", seat: 1, pos: 3 });
    expect(s.phase).toBe("draw");
    expect(s.players[0].grid.filter((slot) => slot?.up)).toHaveLength(2);
  });

  const flipFirstTwo = (pairs: [Card, Card][]) => {
    const s = createGame(names(pairs.length), 1);
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
    const f = apply(createGame(names(2), 1), { type: "flip", seat: 0, pos: 0 });
    expect(() => apply(f, { type: "flip", seat: 0, pos: 0 })).toThrow(RuleError);
  });

  it("rejects invalid seats, sources, and action types", () => {
    const f = createGame(names(2), 1);
    for (const seat of [-1, 2, 0.5]) {
      expect(() => apply(f, { type: "flip", seat, pos: 0 })).toThrow(RuleError);
    }
    const bad = { type: "draw", seat: 0, source: "hand" } as unknown as Action;
    expect(() => apply(inPlay(2), bad)).toThrow(RuleError);
    expect(() => apply(f, { type: "bogus" } as unknown as Action)).toThrow(RuleError);
  });

  it("rejects fewer than 2 or more than 8 players, and blank names", () => {
    expect(() => createGame(names(1), 1)).toThrow(RuleError);
    expect(() => createGame(names(9), 1)).toThrow(RuleError);
    expect(() => createGame(["A", "  "], 1)).toThrow(RuleError);
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
      [createGame(names(2), 1), 24],
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
