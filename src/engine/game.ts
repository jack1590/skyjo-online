import { shuffle } from "./rng";

export type Card = number;
export interface Slot {
  card: Card;
  up: boolean;
}
/** 12 slots, index = row * COLS + col. `null` = removed with its column. */
export type Grid = (Slot | null)[];
export interface Player {
  name: string;
  grid: Grid;
  total: number;
  /** Round scores after doubling, one per finished round. */
  scores: number[];
}
export type Phase = "flip" | "draw" | "place" | "roundOver" | "gameOver";
export interface GameState {
  rng: number;
  round: number;
  phase: Phase;
  current: number;
  players: Player[];
  /** Top card is the last element. */
  deck: Card[];
  /** Top card is the last element. */
  discard: Card[];
  drawn: Card | null;
  drawnFrom: "deck" | "discard" | null;
  ender: number | null;
  /** Whether the ender's score was doubled in the last finished round. */
  doubled: boolean;
  winners: number[];
}
export type Action =
  | { type: "flip"; seat: number; pos: number }
  | { type: "draw"; seat: number; source: "deck" | "discard" }
  | { type: "swap"; seat: number; pos: number }
  | { type: "discardAndFlip"; seat: number; pos: number }
  | { type: "nextRound" };

export class RuleError extends Error {}

export const ROWS = 3;
export const COLS = 4;
export const TARGET = 100;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

export function newDeck(): Card[] {
  const deck: Card[] = [];
  const add = (card: Card, n: number) => {
    for (let i = 0; i < n; i++) deck.push(card);
  };
  add(-2, 5);
  add(-1, 10);
  add(0, 15);
  for (let card = 1; card <= 12; card++) add(card, 10);
  return deck;
}

export function createGame(names: string[], seed: number): GameState {
  if (names.length < MIN_PLAYERS || names.length > MAX_PLAYERS) {
    throw new RuleError(`A game needs ${MIN_PLAYERS}–${MAX_PLAYERS} players`);
  }
  if (names.some((name) => !name.trim())) throw new RuleError("Names cannot be blank");
  const state: GameState = {
    rng: seed | 0,
    round: 0,
    phase: "flip",
    current: 0,
    players: names.map((name) => ({ name, grid: [], total: 0, scores: [] })),
    deck: [],
    discard: [],
    drawn: null,
    drawnFrom: null,
    ender: null,
    doubled: false,
    winners: [],
  };
  deal(state);
  return state;
}

/** R2/R15: fresh shuffle of all 150 cards, new grids, one card starts the discard. */
function deal(s: GameState): void {
  [s.deck, s.rng] = shuffle(newDeck(), s.rng);
  for (const p of s.players) {
    p.grid = s.deck.splice(0, ROWS * COLS).map((card) => ({ card, up: false }));
  }
  s.discard = s.deck.splice(-1);
  s.round++;
  s.phase = "flip";
  s.current = 0;
  s.drawn = null;
  s.drawnFrom = null;
  s.ender = null;
  s.doubled = false;
}
