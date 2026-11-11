// The design mockups' game state (docs/screenshots/m27/target-*.jpg, m28/target-*.jpg): Sofi's
// turn in round 3, and that round's summary. Read by table.spec.ts (M27) and theme.spec.ts (M28).
import type { GameView, PlayerView } from "../src/engine/view";
import type { Shown } from "./harness";

const X = "down" as const;
const m27Players = (): PlayerView[] =>
  (
    [
      ["Sofi", 41, [4, X, 0, 9, 4, 12, -2, X, X, 5, X, 1]],
      ["Leo", 28, [1, X, 6, X, 0, 3, X, X, X, 7, 2, X]],
      ["Mamá", 39, [null, 5, X, -1, null, X, 2, X, null, 0, X, 6]],
      ["Abuelo", 48, [10, X, 4, X, X, 8, X, 3, 6, X, X, 0]],
    ] as const
  ).map(([name, total, grid]) => ({
    name,
    total,
    grid: [...grid],
    scores: [20, total - 20],
    out: null,
  }));
export const m27View = (): GameView => ({
  round: 3,
  phase: "place",
  current: 0,
  ender: null,
  doubled: false,
  winners: [],
  players: m27Players(),
  deckCount: 71,
  discardTop: 8,
  drawn: 2,
  drawnFrom: "deck",
  turn: 5,
  knockout: false,
});
/** Sofi holds a 2 from the deck, with 22 s on her clock. */
export const m27Table = (): Shown => ({
  view: m27View(),
  seat: 0,
  wait: [{ seat: 0, inMs: 22_000, reason: "timer" }],
});
/** Round 3 is over: Mamá ended it on 18, Leo scored 14, so her 18 counted double. */
export const m27Summary = (): Shown => {
  const view = m27View();
  const results = [
    [21, 62],
    [14, 42],
    [36, 75],
    [44, 92],
  ];
  return {
    view: {
      ...view,
      phase: "roundOver",
      ender: 2,
      doubled: true,
      drawn: null,
      drawnFrom: null,
      players: view.players.map((p, i) => ({
        ...p,
        grid: p.grid.map((slot) => (slot === X ? 5 : slot)),
        total: results[i][1],
        scores: [...p.scores, results[i][0]],
      })),
    },
    seat: 0,
    lead: true,
  };
};
