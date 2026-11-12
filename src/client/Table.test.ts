import { describe, expect, it } from "vitest";
import { type Action, apply, createGame, type GameState, legalActions } from "../engine/game";
import { type GameView, toView, type ViewSlot } from "../engine/view";
import { translator } from "./i18n";
import {
  endedNote,
  faceUpSum,
  kindLine,
  overTitle,
  prompt,
  roundHighlight,
  roundTitle,
} from "./Table";

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

/** A round's summary: each player's round score (the ender's as it counted), who ended it. */
function ended(
  scores: number[],
  ender: number,
  doubled: boolean,
  outBefore: number[] = [],
): GameView {
  const view = over(scores, []);
  return {
    ...view,
    phase: "roundOver",
    round: 2,
    ender,
    doubled,
    players: view.players.map((p, i) => ({
      ...p,
      scores: [0, scores[i]],
      out: outBefore.includes(i) ? 1 : null,
    })),
  };
}

describe("endedNote (M27, R12)", () => {
  const en = translator("en");

  it("doubled: names the lowest scorer and the score before it doubled", () => {
    expect(endedNote(en, ended([36, 14, 21], 0, true))).toBe(
      "Ana ended the round, but Ben scored lower, so Ana's 18 counts double.",
    );
  });

  it("doubled on a tie: ties double too", () => {
    expect(endedNote(en, ended([20, 10, 31], 0, true))).toBe(
      "Ana ended the round, but Ben scored the same, so Ana's 10 counts double.",
    );
  });

  it("not doubled: the ender scored strictly lowest", () => {
    expect(endedNote(en, ended([9, 14, 21], 0, false))).toBe(
      "Ana ended the round with the lowest score.",
    );
  });

  it("no sentence when a score of 0 or less wasn't the lowest, and none mid-round", () => {
    expect(endedNote(en, ended([0, -2, 21], 0, false))).toBeNull();
    expect(endedNote(en, { ...ended([9, 14, 21], 0, false), phase: "draw" })).toBeNull();
  });

  it("R16: players out before the round don't count", () => {
    // Ben, out since round 1, has no score this round: Cris's 21 is the one to beat.
    expect(endedNote(en, ended([9, 0, 21], 0, false, [1]))).toBe(
      "Ana ended the round with the lowest score.",
    );
  });

  it("in Spanish and Portuguese", () => {
    const view = ended([36, 14, 21], 0, true);
    expect(endedNote(translator("es"), view)).toBe(
      "Ana cerró la ronda, pero Ben sumó menos: los 18 de Ana cuentan doble.",
    );
    expect(endedNote(translator("pt"), view)).toBe(
      "Ana encerrou a rodada, mas Ben somou menos: os 18 de Ana contam em dobro.",
    );
  });
});

/** Round 2's summary with these round scores; `grids` and `out` (R16) per seat where given. */
function summary(
  scores: number[],
  { grids = [], out = [] }: { grids?: ViewSlot[][]; out?: (number | null)[] } = {},
): GameView {
  const view = toView(
    createGame(["Ana", "Ben", "Cris", "Dani"].slice(0, scores.length), [1, 0, 0, 0]),
  );
  return {
    ...view,
    round: 2,
    phase: "roundOver",
    players: view.players.map((p, i) => ({
      ...p,
      grid: grids[i] ?? Array<ViewSlot>(12).fill(3),
      scores: [20, scores[i]],
      out: out[i] ?? null,
    })),
  };
}

/** A revealed grid with its first `n` columns removed (R9). */
const cleared = (n: number): ViewSlot[] =>
  Array.from({ length: 12 }, (_, pos) => (pos % 4 < n ? null : 3));

describe("roundTitle (M30)", () => {
  const en = translator("en");

  it("M30: the round's winner reads that they won it, everyone else who did", () => {
    const view = summary([12, 4, 30]);
    expect([0, 1, 2, null].map((you) => roundTitle(en, view, you))).toEqual([
      "Ben won round 2!",
      "You won round 2!",
      "Ben won round 2!",
      "Ben won round 2!",
    ]);
  });

  it("M30: equal lowest scores share the round", () => {
    const view = summary([4, 4, 30]);
    expect([0, 2].map((you) => roundTitle(en, view, you))).toEqual([
      "You share round 2!",
      "Ana & Ben share round 2!",
    ]);
  });

  it("M30 (R16): a player out before the round can't win it, whatever their last score was", () => {
    const view = summary([-5, 9, 30], { out: [1], grids: [[]] });
    expect(roundTitle(en, view, 0)).toBe("Ben won round 2!");
  });

  it("M30: in Spanish and Portuguese", () => {
    const view = summary([12, 4, 4]);
    expect(roundTitle(translator("es"), view, 1)).toBe("¡Compartes la ronda 2!");
    expect(roundTitle(translator("es"), view, 0)).toBe("¡Ben & Cris comparten la ronda 2!");
    expect(roundTitle(translator("pt"), summary([1, 2]), 0)).toBe("Você venceu a rodada 2!");
    expect(roundTitle(translator("pt"), summary([1, 2]), 1)).toBe("Ana venceu a rodada 2!");
  });
});

describe("roundHighlight (M30)", () => {
  const en = translator("en");

  it("M30: whoever cleared the most columns, from 2 up; a tie goes to the lower round score", () => {
    expect(roundHighlight(en, summary([12, 4, 30], { grids: [cleared(2)] }))).toBe(
      "Ana cleared 2 columns.",
    );
    const tied = summary([12, 4, 30], { grids: [cleared(2), cleared(1), cleared(2)] });
    expect(roundHighlight(en, tied)).toBe("Ana cleared 2 columns.");
    const more = summary([12, 4, 30], { grids: [cleared(2), cleared(1), cleared(3)] });
    expect(roundHighlight(en, more)).toBe("Cris cleared 3 columns.");
  });

  it("M30: else the lowest score when it is below zero, with a real minus sign", () => {
    expect(roundHighlight(en, summary([12, -5, -2]))).toBe("Ben scored −5: below zero.");
    // Columns come first.
    expect(roundHighlight(en, summary([12, -5, 30], { grids: [cleared(2)] }))).toBe(
      "Ana cleared 2 columns.",
    );
  });

  it("M30: an ordinary round has none: one column, a score of 0", () => {
    expect(roundHighlight(en, summary([12, 0, 30], { grids: [cleared(1)] }))).toBeNull();
  });

  it("M30 (R16): a player out before the round has no cards and no score: never the highlight", () => {
    const view = summary([-9, 4, 30], { out: [1], grids: [[]] });
    expect(roundHighlight(en, view)).toBeNull();
  });

  it("M30: in Spanish and Portuguese", () => {
    const view = summary([12, 4], { grids: [cleared(2)] });
    expect(roundHighlight(translator("es"), view)).toBe("Ana eliminó 2 columnas.");
    expect(roundHighlight(translator("pt"), view)).toBe("Ana eliminou 2 colunas.");
    expect(roundHighlight(translator("es"), summary([-1, 4]))).toBe("Ana sumó −1: bajo cero.");
    expect(roundHighlight(translator("pt"), summary([-1, 4]))).toBe("Ana fez −1: abaixo de zero.");
  });
});

describe("kindLine (M30)", () => {
  it("M30: every place has a line of its own: the winner, second, the middle, last; a spectator none", () => {
    const en = translator("en");
    const view = over([104, 61, 88, 95], [1]);
    const lines = [1, 2, 3, 0].map((you) => kindLine(en, view, you));
    expect(new Set(lines).size).toBe(4);
    for (const line of lines) expect(line).toBeTruthy();
    expect(kindLine(en, view, null)).toBeNull();
    // A shared win has its own; with 2 players the loser is second, not last.
    const shared = over([70, 104, 70], [0, 2]);
    expect(kindLine(en, shared, 0)).not.toBe(lines[0]);
    expect(kindLine(en, over([104, 61], [1]), 0)).toBe(lines[1]);
    // Two tied behind the winner are both second.
    expect(kindLine(en, over([50, 101, 101], [0]), 2)).toBe(lines[1]);
  });

  it("M30: in every language, for every place", () => {
    const view = over([104, 61, 88, 95], [1]);
    for (const locale of ["en", "es", "pt"] as const) {
      const lines = [0, 1, 2, 3].map((you) => kindLine(translator(locale), view, you));
      expect(new Set(lines).size, locale).toBe(4);
    }
  });
});
