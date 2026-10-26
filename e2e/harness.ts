// Test-only table harness helpers: build exact game states with the engine and render them through
// window.__SKYJO_TABLE__ (see src/client/App.tsx) instead of playing up to them.
import { expect, type Page } from "@playwright/test";
import { apply, createGame, type GameState, legalActions } from "../src/engine/game";
import { type GameView, toView } from "../src/engine/view";
import type { Wait } from "../src/protocol";

/** A game one move into its last turns: someone revealed everything; the next player is to draw. */
export function lastTurnGame(players: number, seed: number): GameState {
  const names = Array.from({ length: players }, (_, i) => `Player ${i + 1}`);
  let state = createGame(names, [seed, 0, 0, 0]);
  while (state.ender === null || state.phase !== "draw") {
    const legal = legalActions(state);
    // Discard-and-flip (listed last) always reveals a card, so the round heads for its end.
    state = apply(state, legal[state.phase === "place" ? legal.length - 1 : 0]);
  }
  return state;
}

/** The finished round: everyone takes their last turn the same way. */
export function roundOver(players: number, seed: number): GameState {
  let state = lastTurnGame(players, seed);
  while (state.phase === "draw" || state.phase === "place") {
    const legal = legalActions(state);
    state = apply(state, legal[state.phase === "place" ? legal.length - 1 : 0]);
  }
  return state;
}

/** A game right after the opening flip: the starting player is to draw. */
export function firstTurn(players: number, seed: number): GameState {
  const names = Array.from({ length: players }, (_, i) => `Player ${i + 1}`);
  let state = createGame(names, [seed, 0, 0, 0]);
  while (state.phase === "flip") state = apply(state, legalActions(state)[0]);
  return state;
}

/**
 * Every state of a round from its first draw to its summary. Turns alternate: one player draws from
 * the deck and throws it away, flipping a card; the next takes the discard into a face-down slot.
 */
export function playedRound(players: number, seed: number): GameState[] {
  const states = [firstTurn(players, seed)];
  for (let state = states[0], turn = 0; state.phase === "draw" || state.phase === "place"; ) {
    const legal = legalActions(state);
    const grid = state.players[state.current].grid;
    if (state.phase === "draw") state = apply(state, legal[turn++ % 2]);
    else if (state.drawnFrom === "deck") state = apply(state, legal[legal.length - 1]);
    else state = apply(state, legal.find((a) => a.type === "swap" && !grid[a.pos]?.up) ?? legal[0]);
    states.push(state);
  }
  return states;
}

/**
 * A knockout game (R16) the seeded engine plays the same way, to game over: every state on the
 * way, so a test can pick a round summary, a later round and the end.
 */
export function knockoutGame(names: string[], seed: number): GameState[] {
  const states = [createGame(names, [seed, 0, 0, 0], { knockout: true })];
  let state = states[0];
  while (state.phase !== "gameOver") {
    const legal = legalActions(state);
    state = apply(state, legal[state.phase === "place" ? legal.length - 1 : 0]);
    states.push(state);
  }
  return states;
}

export interface Shown {
  view: GameView;
  seat: number | null;
  lead?: boolean;
  connected?: boolean[];
  auto?: boolean[];
  wait?: Wait[];
}

export async function show(page: Page, table: Shown) {
  await page.addInitScript((t) => {
    (window as unknown as { __SKYJO_TABLE__: unknown }).__SKYJO_TABLE__ = t;
  }, table);
  await page.goto("/");
  await expect(page.getByTestId("table")).toBeVisible();
}

/** The table as seen by the player about to move (seat = current). */
export const atTurnStart = (players: number, seed = 3): Shown => {
  const state = lastTurnGame(players, seed);
  return { view: toView(state), seat: state.current };
};
