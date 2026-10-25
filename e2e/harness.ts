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
export const roundOver = (players: number, seed: number) => finalMove(players, seed).after;

/** The round's last move: the table just before it (`before`) and the finished round (`after`). */
export function finalMove(players: number, seed: number) {
  let before = lastTurnGame(players, seed);
  let after = before;
  while (after.phase === "draw" || after.phase === "place") {
    before = after;
    const legal = legalActions(after);
    after = apply(after, legal[after.phase === "place" ? legal.length - 1 : 0]);
  }
  return { before, after };
}

/** A game right after the opening flip: the starting player is to draw. */
export function firstTurn(players: number, seed: number): GameState {
  const names = Array.from({ length: players }, (_, i) => `Player ${i + 1}`);
  let state = createGame(names, [seed, 0, 0, 0]);
  while (state.phase === "flip") state = apply(state, legalActions(state)[0]);
  return state;
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
