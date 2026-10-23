import type { Card, GameState, Phase } from "./game";

/** A slot as anyone may see it: the card if face up, "down" if face down, null if removed. */
export type ViewSlot = Card | "down" | null;

export interface PlayerView {
  name: string;
  grid: ViewSlot[];
  total: number;
  scores: number[];
}

export interface GameView {
  round: number;
  phase: Phase;
  current: number;
  ender: number | null;
  doubled: boolean;
  winners: number[];
  players: PlayerView[];
  deckCount: number;
  discardTop: Card | null;
  drawn: Card | null;
  drawnFrom: GameState["drawnFrom"];
}

/** Public projection. Face-down values, deck order, and RNG state never leave the engine. */
export function toView(s: GameState): GameView {
  return {
    round: s.round,
    phase: s.phase,
    current: s.current,
    ender: s.ender,
    doubled: s.doubled,
    winners: [...s.winners],
    players: s.players.map((p) => ({
      name: p.name,
      grid: p.grid.map((slot) => (slot === null ? null : slot.up ? slot.card : "down")),
      total: p.total,
      scores: [...p.scores],
    })),
    deckCount: s.deck.length,
    discardTop: s.discard.at(-1) ?? null,
    drawn: s.drawn,
    drawnFrom: s.drawnFrom,
  };
}
