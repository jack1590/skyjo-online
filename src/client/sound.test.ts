import { describe, expect, it } from "vitest";
import { type Action, apply, createGame, type GameState } from "../engine/game";
import { toView } from "../engine/view";
import { soundsBetween } from "./sound";

/** 2 players past the flip phase, seat 0 about to draw, with its own grid and next deck card. */
function table(grid: number[], up: number[], nextDraw: number): GameState {
  const s = createGame(["A", "B"], [1, 0, 0, 0]);
  s.phase = "draw";
  s.current = 0;
  s.players[0].grid = grid.map((card, i) => ({ card, up: up.includes(i) }));
  s.deck.push(nextDraw);
  return s;
}

const sounds = (s: GameState, seat: number, ...actions: Action[]) => {
  const before = actions.slice(0, -1).reduce(apply, s);
  return soundsBetween(toView(before), toView(apply(before, actions.at(-1) as Action)), seat);
};

const GRID = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const draw: Action = { type: "draw", seat: 0, source: "deck" };

describe("soundsBetween", () => {
  it("drawing slides a card", () => {
    expect(sounds(table(GRID, [0, 1], 0), 1, draw)).toEqual(["draw"]);
  });

  it("a swap places the card and discards the old one; the next player hears their turn", () => {
    expect(sounds(table(GRID, [0, 1], 0), 1, draw, { type: "swap", seat: 0, pos: 5 })).toEqual([
      "place",
      "discard",
      "turn",
    ]);
  });

  it("discard-and-flip discards and flips", () => {
    expect(
      sounds(table(GRID, [0, 1], 0), 0, draw, { type: "discardAndFlip", seat: 0, pos: 5 }),
    ).toEqual(["discard", "flip"]);
  });

  it("a completed column chimes", () => {
    const s = table([5, 1, 2, 3, 5, 2, 3, 4, 9, 3, 4, 1], [0, 4], 5);
    expect(sounds(s, 1, draw, { type: "swap", seat: 0, pos: 8 })).toContain("column");
  });

  it("a new round deals", () => {
    const s = table(GRID, [0, 1], 0);
    expect(soundsBetween(toView(s), { ...toView(s), round: 2, phase: "flip" }, 0)).toEqual([
      "deal",
    ]);
  });

  it("game over: the winner hears a win, everyone else the end", () => {
    const s = table(GRID, [0, 1], 0);
    const over = { ...toView(s), phase: "gameOver" as const, winners: [1] };
    expect(soundsBetween(toView(s), over, 1)).toContain("win");
    expect(soundsBetween(toView(s), over, 0)).toContain("end");
  });
});
