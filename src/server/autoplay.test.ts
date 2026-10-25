import { it } from "vitest";
import { apply, createGame } from "../engine/game";
import { autoMove } from "./room";

// Its own file so vitest runs it beside room.test.ts, not after it (6–7 s).
it("BUG-1: in 1,000 seeded tables of 2–8 seats with every seat on autoMove, every round ends", () => {
  for (let seed = 0; seed < 1000; seed++) {
    const players = 2 + (seed % 7);
    let g = createGame(
      Array.from({ length: players }, (_, i) => `P${i}`),
      [seed, 1, 2, 3],
    );
    for (let moves = 0; g.phase !== "roundOver" && g.phase !== "gameOver"; moves++) {
      if (moves > 2_000) throw new Error(`seed ${seed} did not end its round`);
      const seat =
        g.phase === "flip"
          ? g.players.findIndex((p) => p.grid.filter((s) => s?.up).length < 2)
          : g.current;
      g = apply(g, autoMove(g, seat, true));
    }
  }
});
