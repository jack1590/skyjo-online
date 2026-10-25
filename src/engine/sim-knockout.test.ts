// The knockout (R16) simulations, in their own file so vitest runs them beside sim.test.ts.
import { describe, expect, it } from "vitest";
import { playRandom, simulate } from "./simkit";

describe("simulation, R16", () => {
  it("R16: simulates 1000 seeded games (2–8 players) to completion with knockout on", () => {
    simulate(true);
  });

  it("R16: with 2 players, knockout and R14 give the same winners on every seeded game", () => {
    for (let seed = 0; seed < 1000; seed += 7) {
      expect(playRandom(2, seed, undefined, true).s.winners).toEqual(playRandom(2, seed).s.winners);
    }
  });
});
