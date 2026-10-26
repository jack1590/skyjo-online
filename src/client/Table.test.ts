import { describe, expect, it } from "vitest";
import { createGame } from "../engine/game";
import { type GameView, toView } from "../engine/view";
import { translator } from "./i18n";
import { overTitle } from "./Table";

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
