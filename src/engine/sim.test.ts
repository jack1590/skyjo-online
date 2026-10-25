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
  RuleError,
  type Slot,
} from "./game";
import type { Rng } from "./rng";
import { names, type Pick, playRandom, simulate } from "./simkit";
import { toView } from "./view";

const seed = (n: number): Rng => [n, 0, 0, 0];

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
    simulate(false);
  });

  it("rejects random illegal actions, out players' included (R16)", () => {
    let checked = 0;
    for (let seed = 0; seed < 100; seed++) {
      const players = 2 + (seed % 7);
      playRandom(
        players,
        seed,
        (s, pick) => {
          const legal = new Set(legalActions(s).map(actionKey));
          const action = randomAction(pick, players);
          if (legal.has(actionKey(action))) return;
          expect(() => apply(s, action)).toThrow(RuleError);
          checked++;
        },
        seed % 2 === 1,
      );
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
  it("toView never exposes face-down values or deck order, with knockout off and on", () => {
    for (let seed = 0; seed < 50; seed++) {
      playRandom(
        2 + (seed % 7),
        seed,
        (s) => {
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
          expect(view.knockout).toBe(s.knockout);
          expect(view.players.map((p) => p.out)).toEqual(s.players.map((p) => p.out));
        },
        seed % 2 === 1,
      );
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
