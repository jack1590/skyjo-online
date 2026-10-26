import { describe, expect, it } from "vitest";
import { type Action, apply, createGame, type GameState, legalActions } from "../engine/game";
import { type GameView, toView } from "../engine/view";
import { translator } from "./i18n";
import { faceUpSum, overTitle, prompt } from "./Table";

/** A finished game with these totals and winners (the lowest totals, R14). */
function over(totals: number[], winners: number[]): GameView {
  const view = toView(
    createGame(["Ana", "Ben", "Cris", "Dani"].slice(0, totals.length), [1, 0, 0, 0]),
  );
  return {
    ...view,
    phase: "gameOver",
    winners,
    players: view.players.map((p, i) => ({ ...p, total: totals[i] })),
  };
}

describe("overTitle (UX-17)", () => {
  const en = translator("en");

  it("the winner reads 'You win!', everyone else their place, and a spectator who won", () => {
    const view = over([104, 61, 88], [1]);
    expect([0, 1, 2, null].map((you) => overTitle(en, "en", view, you))).toEqual([
      "You placed 3rd",
      "You win!",
      "You placed 2nd",
      "Ben wins!",
    ]);
  });

  it("R14: equal lowest totals share the win, and the next place counts both", () => {
    const view = over([70, 104, 70, 90], [0, 2]);
    expect([0, 1, 2, 3, null].map((you) => overTitle(en, "en", view, you))).toEqual([
      "You share the win!",
      "You placed 4th",
      "You share the win!",
      "You placed 3rd",
      "Ana & Cris win!",
    ]);
  });

  it("a tie below the winner shares that place", () => {
    const view = over([50, 101, 101], [0]);
    expect([1, 2].map((you) => overTitle(en, "en", view, you))).toEqual([
      "You placed 2nd",
      "You placed 2nd",
    ]);
  });

  it("in Spanish and Portuguese, with their ordinals", () => {
    const view = over([104, 61, 88], [1]);
    expect(overTitle(translator("es"), "es", view, 0)).toBe("Quedaste en 3.er lugar");
    expect(overTitle(translator("es"), "es", view, 1)).toBe("¡Ganaste!");
    expect(overTitle(translator("pt"), "pt", view, 2)).toBe("Você ficou em 2º lugar");
    expect(overTitle(translator("pt"), "pt", view, 1)).toBe("Você venceu!");
  });
});

/** A round played to its end: deck draws, thrown away to flip a card. Every state on the way. */
function played(players: number, seed: number): GameState[] {
  const names = ["Ana", "Ben", "Cris", "Dani", "Eli"].slice(0, players);
  const states = [createGame(names, [seed, 0, 0, 0])];
  for (let s = states[0]; s.phase !== "roundOver" && s.phase !== "gameOver"; states.push(s)) {
    s = apply(s, legalActions(s).at(s.phase === "place" ? -1 : 0) as Action);
  }
  return states;
}

describe("faceUpSum (UX-15)", () => {
  it("UX-15: is the sum of the numeric slots: face-down and removed slots count 0", () => {
    expect(faceUpSum([5, "down", null, -2, 0, "down", 12, null, -1, "down", 3, 1])).toBe(18);
    expect(faceUpSum(["down", "down"])).toBe(0);
    expect(faceUpSum([])).toBe(0);
  });

  it("UX-15: matches the engine: the face-up cards on every turn, and at the reveal, each round score (before doubling)", () => {
    for (const seed of [1, 2, 3]) {
      const states = played(4, seed);
      for (const s of states) {
        const view = toView(s);
        s.players.forEach((p, i) => {
          const up = p.grid.reduce((sum, slot) => sum + (slot?.up ? slot.card : 0), 0);
          expect(faceUpSum(view.players[i].grid)).toBe(up);
        });
      }
      const end = toView(states.at(-1) as GameState);
      end.players.forEach((p, i) => {
        const score = p.scores.at(-1) ?? 0;
        expect(faceUpSum(p.grid)).toBe(i === end.ender && end.doubled ? score / 2 : score);
      });
    }
  });
});

describe("prompt (UX-16)", () => {
  const en = translator("en");
  /** Each player still in gets this pair as their first two cards, and flips them (R3). */
  function flipPairs(s: GameState, pairs: number[][]): GameState {
    let next = s;
    s.players.forEach((p, seat) => {
      if (p.out !== null) return;
      pairs[seat].forEach((card, pos) => {
        p.grid[pos] = { card, up: false };
      });
    });
    s.players.forEach((p, seat) => {
      if (p.out === null) for (const pos of [0, 1]) next = apply(next, { type: "flip", seat, pos });
    });
    return next;
  }
  /** Ana, Ben and Cris after the flip: Ana 5 + 7, Ben 9 + 8, Cris the given pair. */
  function flipped(cris: [number, number]): GameView {
    const s = createGame(["Ana", "Ben", "Cris"], [1, 0, 0, 0]);
    return toView(flipPairs(s, [[5, 7], [9, 8], cris]));
  }
  const notes = (view: GameView) =>
    [0, 1, 2].map((seat) => prompt(en, view, seat, seat === view.current, false));

  it("UX-16, R4: at the first draw, everyone reads who starts and why; the start player is also told to draw", () => {
    const view = flipped([1, 2]);
    expect(notes(view)).toEqual([
      "Ben starts: highest pair (17)",
      "You start: highest pair (17). Draw from the deck or take the discard",
      "Ben starts: highest pair (17)",
    ]);
  });

  it("UX-16, R4: a tie goes to the first seat, and the line says it was a tie", () => {
    const view = flipped([10, 7]);
    expect(view.current).toBe(1);
    expect(notes(view)[0]).toBe("Ben starts: highest pair (17, tied)");
  });

  it("UX-16, R4: negative pairs read with a real minus sign", () => {
    const s = createGame(["Ana", "Ben"], [1, 0, 0, 0]);
    const next = flipPairs(s, [
      [-2, -1],
      [-2, -2],
    ]);
    expect(prompt(en, toView(next), 1, false, false)).toBe("Ana starts: highest pair (−3)");
  });

  it("UX-16, R4, R16: in knockout, only players still in count: a player who is out isn't a tie", () => {
    const s = createGame(["Ana", "Ben", "Cris"], [1, 0, 0, 0], { knockout: true });
    // Ana went out before this round: no cards, so her sum is 0, like Ben's winning pair.
    s.players[0].out = 0;
    s.players[0].grid = [];
    const next = flipPairs(s, [[], [0, 0], [-1, 0]]);
    expect(next.current).toBe(1);
    expect(prompt(en, toView(next), 2, false, false)).toBe("Ben starts: highest pair (0)");
  });

  it("UX-16: after the first turn, it's back to waiting", () => {
    const view = flipped([1, 2]);
    const s = { ...view, turn: 1 };
    expect(prompt(en, s, 0, false, false)).toBe("Waiting for Ben…");
  });

  /** Your draw (seat 0), late in the round, with only the cards at `down` face down. */
  function lastCard(down: number[], ender: number | null = null): GameView {
    const s = createGame(["Ana", "Ben"], [1, 0, 0, 0]);
    s.phase = "draw";
    s.current = 0;
    s.turn = 9;
    s.ender = ender;
    s.players[0].grid = s.players[0].grid.map(
      (slot, i) => slot && { ...slot, up: !down.includes(i) },
    );
    return toView(s);
  }

  it("UX-16: with one face-down card left on your turn, every step of it says that revealing it ends the round", () => {
    const line = "Revealing your last card ends the round";
    const view = lastCard([7]);
    expect(prompt(en, view, 0, true, false)).toBe(line);
    for (const [drawnFrom, discardMode] of [
      ["deck", false],
      ["deck", true],
      ["discard", false],
    ] as const) {
      const placing = { ...view, phase: "place" as const, drawn: 4, drawnFrom };
      expect(prompt(en, placing, 0, true, discardMode)).toBe(line);
    }
  });

  it("UX-16: not with two face-down cards, not on someone else's turn, and not once the round is in its last turns", () => {
    expect(prompt(en, lastCard([3, 7]), 0, true, false)).toBe(
      "Draw from the deck or take the discard",
    );
    expect(prompt(en, { ...lastCard([7]), current: 1 }, 0, false, false)).toBe("Waiting for Ben…");
    expect(prompt(en, lastCard([7], 1), 0, true, false)).toBe(
      "Last turn! Draw from the deck or take the discard",
    );
  });
});
