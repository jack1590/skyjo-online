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

/** Returns the next state; throws RuleError on an illegal action. Never mutates `state`. */
export function apply(state: GameState, action: Action): GameState {
  const s = structuredClone(state);
  switch (action.type) {
    case "flip":
      flipInitial(s, action.seat, action.pos);
      break;
    case "draw":
      draw(s, action.seat, action.source);
      break;
    case "swap": {
      const slot = placeTarget(s, action.seat, action.pos);
      s.discard.push(slot.card);
      slot.card = s.drawn as Card;
      slot.up = true;
      endTurn(s, action.seat);
      break;
    }
    case "discardAndFlip": {
      const slot = placeTarget(s, action.seat, action.pos);
      check(s.drawnFrom === "deck", "A card taken from the discard must be swapped in");
      check(!slot.up, "That card is already face up");
      s.discard.push(s.drawn as Card);
      slot.up = true;
      endTurn(s, action.seat);
      break;
    }
    case "nextRound":
      check(s.phase === "roundOver", `Not allowed now (${s.phase})`);
      deal(s);
      break;
    default:
      throw new RuleError("Unknown action");
  }
  return s;
}

/** Every action currently allowed. During the flip phase this covers all seats at once. */
export function legalActions(s: GameState): Action[] {
  const seat = s.current;
  const positions = (grid: Grid, faceDownOnly: boolean) =>
    grid.flatMap((slot, pos) => (slot && !(faceDownOnly && slot.up) ? [pos] : []));
  switch (s.phase) {
    case "flip":
      return s.players.flatMap((p, seat) =>
        upCount(p.grid) < 2
          ? positions(p.grid, true).map((pos): Action => ({ type: "flip", seat, pos }))
          : [],
      );
    case "draw":
      // The discard pile is never empty at the start of a turn: every turn ends by discarding.
      return [
        { type: "draw", seat, source: "deck" },
        { type: "draw", seat, source: "discard" },
      ];
    case "place": {
      const grid = s.players[seat].grid;
      return [
        ...positions(grid, false).map((pos): Action => ({ type: "swap", seat, pos })),
        ...(s.drawnFrom === "deck"
          ? positions(grid, true).map((pos): Action => ({ type: "discardAndFlip", seat, pos }))
          : []),
      ];
    }
    case "roundOver":
      return [{ type: "nextRound" }];
    default:
      return [];
  }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RuleError(message);
}

function upCount(grid: Grid): number {
  return grid.filter((slot) => slot?.up).length;
}

function slotAt(s: GameState, seat: number, pos: number): Slot {
  check(Number.isInteger(pos) && pos >= 0 && pos < ROWS * COLS, "Invalid position");
  const slot = s.players[seat].grid[pos];
  check(slot, "That card was removed");
  return slot;
}

function requireTurn(s: GameState, seat: number, phase: Phase): void {
  check(s.phase === phase, `Not allowed now (${s.phase})`);
  check(seat === s.current, "Not your turn");
}

/** R3/R4: each seat flips 2; when all have, the highest visible sum starts (lowest seat on ties). */
function flipInitial(s: GameState, seat: number, pos: number): void {
  check(s.phase === "flip", `Not allowed now (${s.phase})`);
  check(Number.isInteger(seat) && seat >= 0 && seat < s.players.length, "Invalid seat");
  check(upCount(s.players[seat].grid) < 2, "Already flipped two cards");
  const slot = slotAt(s, seat, pos);
  check(!slot.up, "That card is already face up");
  slot.up = true;
  if (s.players.some((p) => upCount(p.grid) < 2)) return;
  const sums = s.players.map((p) => visibleSum(p.grid));
  s.current = sums.indexOf(Math.max(...sums));
  s.phase = "draw";
}

function visibleSum(grid: Grid): number {
  return grid.reduce((sum, slot) => sum + (slot?.up ? slot.card : 0), 0);
}

/** R6/R7, plus R13: an empty deck is rebuilt from the discard pile minus its top card. */
function draw(s: GameState, seat: number, source: "deck" | "discard"): void {
  requireTurn(s, seat, "draw");
  if (source === "deck") {
    if (s.deck.length === 0) {
      [s.deck, s.rng] = shuffle(s.discard.slice(0, -1), s.rng);
      s.discard = s.discard.slice(-1);
    }
    s.drawn = s.deck.pop() as Card;
  } else {
    check(source === "discard", "Unknown source");
    check(s.discard.length > 0, "The discard pile is empty");
    s.drawn = s.discard.pop() as Card;
  }
  s.drawnFrom = source;
  s.phase = "place";
}

function placeTarget(s: GameState, seat: number, pos: number): Slot {
  requireTurn(s, seat, "place");
  return slotAt(s, seat, pos);
}

/** R9: a column of three equal face-up cards goes onto the discard pile. */
function removeColumns(s: GameState, seat: number): void {
  const grid = s.players[seat].grid;
  for (let col = 0; col < COLS; col++) {
    const column = Array.from({ length: ROWS }, (_, row) => row * COLS + col);
    const first = grid[col];
    if (!first || !column.every((i) => grid[i]?.up && grid[i].card === first.card)) continue;
    for (const i of column) {
      s.discard.push(first.card);
      grid[i] = null;
    }
  }
}

/** R10: the first player with nothing face down becomes the ender; play stops when it is their turn again. */
function endTurn(s: GameState, seat: number): void {
  s.drawn = null;
  s.drawnFrom = null;
  removeColumns(s, seat);
  if (s.ender === null && !s.players[seat].grid.some((slot) => slot && !slot.up)) s.ender = seat;
  s.current = (seat + 1) % s.players.length;
  if (s.current === s.ender) endRound(s, s.ender);
  else s.phase = "draw";
}

/** R11 reveal, R12 scoring and doubling, R14 game end. */
function endRound(s: GameState, ender: number): void {
  s.players.forEach((p, seat) => {
    for (const slot of p.grid) if (slot) slot.up = true;
    removeColumns(s, seat);
  });
  const scores = s.players.map((p) => visibleSum(p.grid));
  const enderScore = scores[ender];
  s.doubled = enderScore > 0 && scores.some((score, seat) => seat !== ender && score <= enderScore);
  if (s.doubled) scores[ender] = enderScore * 2;
  s.players.forEach((p, seat) => {
    p.scores.push(scores[seat]);
    p.total += scores[seat];
  });
  const totals = s.players.map((p) => p.total);
  if (totals.some((total) => total >= TARGET)) {
    const best = Math.min(...totals);
    s.winners = totals.flatMap((total, seat) => (total === best ? [seat] : []));
    s.phase = "gameOver";
  } else {
    s.phase = "roundOver";
  }
}
