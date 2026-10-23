import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type Action,
  apply,
  type Card,
  createGame,
  type GameState,
  legalActions,
  newDeck,
  RuleError,
  type Slot,
} from "./game";
import { nextRandom, type Rng } from "./rng";
import { toView } from "./view";

const names = (n: number) => Array.from({ length: n }, (_, i) => `P${i}`);
const seed = (n: number): Rng => [n, 0, 0, 0];

/** Count of each card value, index = value + 2. */
function histogram(cards: Card[]): number[] {
  const counts = Array<number>(15).fill(0);
  for (const card of cards) counts[card + 2]++;
  return counts;
}
const FULL_DECK = histogram(newDeck()).join();

function cardsInPlay(s: GameState): Card[] {
  const cards = [...s.deck, ...s.discard];
  for (const p of s.players) for (const slot of p.grid) if (slot) cards.push(slot.card);
  if (s.drawn !== null) cards.push(s.drawn);
  return cards;
}

type Pick = (n: number) => number;

/** Plays one game choosing uniformly among legal actions; `onStep` sees each state before its move. */
function playRandom(players: number, seed: number, onStep?: (s: GameState, pick: Pick) => void) {
  let rng: Rng = [seed, 7, 7, 7];
  const pick: Pick = (n) => {
    let v: number;
    [v, rng] = nextRandom(rng);
    return Math.floor(v * n);
  };
  let s = createGame(names(players), [seed, 0, 0, 0]);
  const actions: Action[] = [];
  while (s.phase !== "gameOver") {
    onStep?.(s, pick);
    const legal = legalActions(s);
    const action = legal[pick(legal.length)] as Action;
    s = apply(s, action);
    actions.push(action);
    if (actions.length > 20_000) throw new Error(`seed ${seed} did not finish`);
  }
  return { s, actions };
}

const actionKey = (a: Action) =>
  JSON.stringify([
    a.type,
    "seat" in a ? a.seat : null,
    "pos" in a ? a.pos : null,
    "source" in a ? a.source : null,
  ]);

function randomAction(pick: Pick, players: number): Action {
  const seat = pick(players + 1);
  const pos = pick(14) - 1;
  switch (pick(5)) {
    case 0:
      return { type: "flip", seat, pos };
    case 1:
      return { type: "draw", seat, source: pick(2) ? "deck" : "discard" };
    case 2:
      return { type: "swap", seat, pos };
    case 3:
      return { type: "discardAndFlip", seat, pos };
    default:
      return { type: "nextRound" };
  }
}

describe("simulation", () => {
  it("simulates 1000 seeded games (2–8 players) to completion", () => {
    for (let seed = 0; seed < 1000; seed++) {
      const players = 2 + (seed % 7);
      const { s } = playRandom(players, seed, (state) => {
        if (histogram(cardsInPlay(state)).join() !== FULL_DECK) {
          throw new Error(`seed ${seed}: cards not conserved`);
        }
        const turnTaker = state.players[state.current].grid;
        if (state.phase === "draw" && !turnTaker.some((slot) => slot && !slot.up)) {
          throw new Error(`seed ${seed}: turn-taker has no face-down card`);
        }
      });
      expect(s.phase).toBe("gameOver");
      expect(s.players.some((p) => p.total >= 100)).toBe(true);
      for (const p of s.players) expect(p.total).toBe(p.scores.reduce((a, b) => a + b, 0));
    }
  }, 60_000);

  it("rejects random illegal actions", () => {
    let checked = 0;
    for (let seed = 0; seed < 100; seed++) {
      const players = 2 + (seed % 7);
      playRandom(players, seed, (s, pick) => {
        const legal = new Set(legalActions(s).map(actionKey));
        const action = randomAction(pick, players);
        if (legal.has(actionKey(action))) return;
        expect(() => apply(s, action)).toThrow(RuleError);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("same seed and same actions produce identical states", () => {
    expect(playRandom(5, 123)).toEqual(playRandom(5, 123));
  });
});

/** Same public state, different secrets: hidden cards (face-down + deck) reversed, new RNG state. */
function withHiddenCardsReversed(s: GameState): GameState {
  const t = structuredClone(s);
  const faceDown = t.players.flatMap((p) =>
    p.grid.filter((slot): slot is Slot => slot !== null && !slot.up),
  );
  const hidden = [...faceDown.map((slot) => slot.card), ...t.deck].reverse();
  for (const slot of faceDown) slot.card = hidden.shift() as Card;
  t.deck = hidden;
  t.rng = [1, 2, 3, 4];
  return t;
}

describe("view", () => {
  it("toView never exposes face-down values or deck order", () => {
    for (let seed = 0; seed < 50; seed++) {
      playRandom(2 + (seed % 7), seed, (s) => {
        const view = toView(s);
        s.players.forEach((p, i) => {
          const expected = p.grid.map((slot) =>
            slot === null ? null : slot.up ? slot.card : "down",
          );
          expect(view.players[i]?.grid).toEqual(expected);
        });
        expect(toView(withHiddenCardsReversed(s))).toEqual(view);
        expect(view.deckCount).toBe(s.deck.length);
        expect(view.discardTop).toBe(s.discard.at(-1) ?? null);
        expect(Object.keys(view)).not.toContain("deck");
        expect(Object.keys(view)).not.toContain("rng");
      });
    }
  });

  it("R6: the drawn card is visible to everyone", () => {
    const s = apply(
      { ...createGame(names(2), seed(1)), phase: "draw" as const, current: 0 },
      { type: "draw", seat: 0, source: "deck" },
    );
    expect(toView(s).drawn).toBe(s.drawn);
    expect(toView(s).drawnFrom).toBe("deck");
  });
});

describe("purity", () => {
  it("engine is pure", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const src = readFileSync(join(dir, file), "utf8");
      for (const [, from] of src.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
        expect(from).toMatch(/^\.\//);
      }
      expect(src).not.toMatch(/Math\.random|\bDate\b|\bwindow\b|\bdocument\b|\bprocess\b/);
    }
  });
});
