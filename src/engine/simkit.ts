// Test-only: seeded random play for the engine simulations (sim.test.ts, sim-knockout.test.ts),
// so the two long runs sit in separate files that vitest runs side by side. The app never imports
// it, and coverage leaves it out.
import {
  type Action,
  apply,
  type Card,
  createGame,
  type GameState,
  legalActions,
  newDeck,
} from "./game";
import { nextRandom, type Rng } from "./rng";

export const names = (n: number) => Array.from({ length: n }, (_, i) => `P${i}`);

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

export type Pick = (n: number) => number;

/** Plays one game choosing uniformly among legal actions; `onStep` sees each state before its move. */
export function playRandom(
  players: number,
  seed: number,
  onStep?: (s: GameState, pick: Pick) => void,
  knockout = false,
) {
  let rng: Rng = [seed, 7, 7, 7];
  const pick: Pick = (n) => {
    let v: number;
    [v, rng] = nextRandom(rng);
    return Math.floor(v * n);
  };
  let s = createGame(names(players), [seed, 0, 0, 0], { knockout });
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

/** The seats an action set may move for; nextRound has none. */
const actors = (actions: Action[]) =>
  new Set(actions.flatMap((a) => ("seat" in a ? [a.seat] : [])));

/**
 * 1,000 seeded games of 2–8 players played to game over; throws at the first broken invariant:
 * cards conserved, the turn-taker has a face-down card, totals add up, and (R16) players who are
 * out hold no cards and never act, and one player left is the winner.
 */
export function simulate(knockout: boolean): void {
  for (let seed = 0; seed < 1000; seed++) {
    const fail = (what: string) => {
      throw new Error(`seed ${seed}: ${what}`);
    };
    const { s } = playRandom(
      2 + (seed % 7),
      seed,
      (state) => {
        if (histogram(cardsInPlay(state)).join() !== FULL_DECK) fail("cards not conserved");
        const turnTaker = state.players[state.current].grid;
        if (state.phase === "draw" && !turnTaker.some((slot) => slot && !slot.up)) {
          fail("turn-taker has no face-down card");
        }
        // R16: from the round after they went out, players hold no cards and never act.
        const acting = actors(legalActions(state));
        state.players.forEach((p, seat) => {
          if (p.out === null || p.out === state.round) return;
          if (p.grid.length || acting.has(seat)) fail("out seat plays");
        });
      },
      knockout,
    );
    if (!s.players.some((p) => p.total >= 100)) fail("ended under 100");
    if (s.players.some((p) => p.total !== p.scores.reduce((a, b) => a + b, 0))) fail("totals");
    const left = s.players.filter((p) => p.out === null);
    if (!knockout && left.length < s.players.length) fail("out with knockout off");
    if (knockout && left.length > 1) fail("more than one left");
    if (left.length === 1 && knockout && String(s.winners) !== String(s.players.indexOf(left[0]))) {
      fail("the one left didn't win");
    }
  }
}
