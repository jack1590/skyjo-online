// Card movement: compares the previous view with the new one, works out what travelled where,
// and animates those elements from their old position (FLIP). Works for every player's moves,
// online or hot-seat, because it only needs views.
import { animate } from "motion";
import { useReducedMotion } from "motion/react";
import { type RefObject, useLayoutEffect, useRef } from "react";
import type { GameView } from "../engine/view";

export const slotKey = (seat: number, pos: number) => `slot-${seat}-${pos}`;

interface Flights {
  /** target element key → key of the element it came from */
  moves: Map<string, string>;
  /** element keys whose card turned face up in place */
  flips: string[];
}

/** What moved between two views, as element keys ("deck", "drawn", "discard", slotKey). */
export function flightsBetween(prev: GameView, cur: GameView): Flights {
  const moves = new Map<string, string>();
  const flips: string[] = [];
  if (prev.round !== cur.round || prev.players.length !== cur.players.length) {
    return { moves, flips }; // a fresh deal: nothing travels
  }
  if (prev.drawn === null && cur.drawn !== null) {
    moves.set("drawn", cur.drawnFrom === "discard" ? "discard" : "deck");
  }
  if (prev.drawn !== null && cur.drawn === null) {
    // The turn ended: the held card went into the grid (swap) or onto the discard pile.
    const seat = prev.current;
    const before = prev.players[seat].grid;
    const after = cur.players[seat].grid;
    const pos = after.findIndex((slot, i) => slot !== null && slot !== before[i]);
    const revealedOnly = before[pos] === "down" && cur.discardTop === prev.drawn;
    const swapped =
      pos !== -1 && (prev.drawnFrom === "discard" || (after[pos] === prev.drawn && !revealedOnly));
    if (swapped) {
      moves.set(slotKey(seat, pos), "drawn");
      moves.set("discard", slotKey(seat, pos));
    } else {
      moves.set("discard", "drawn");
    }
  }
  cur.players.forEach((p, seat) => {
    p.grid.forEach((slot, pos) => {
      const was = prev.players[seat].grid[pos];
      const key = slotKey(seat, pos);
      // A completed column leaves for the discard pile.
      if (slot === null && was !== null) moves.set("discard", key);
      else if (was === "down" && typeof slot === "number" && !moves.has(key)) flips.push(key);
    });
  });
  return { moves, flips };
}

const EASE = [0.2, 0.8, 0.2, 1] as const;

function fly(el: HTMLElement, from: DOMRect) {
  const to = el.getBoundingClientRect();
  if (!to.width) return;
  el.style.transformOrigin = "0 0";
  animate(
    el,
    {
      x: [from.left - to.left, 0],
      y: [from.top - to.top, 0],
      scale: [from.width / to.width, 1],
    },
    { duration: 0.38, ease: EASE },
  ).then(() => {
    el.style.transformOrigin = "";
  });
}

const flipIn = (el: HTMLElement) =>
  animate(el, { rotateY: [90, 0] }, { duration: 0.3, ease: "easeOut" });

/**
 * After every render, animates what changed since the previous view. Elements register in `els`
 * under their keys. Does nothing when the user prefers reduced motion.
 */
export function useFlights(view: GameView, els: RefObject<Map<string, HTMLElement>>) {
  const prev = useRef<GameView | null>(null);
  const rects = useRef(new Map<string, DOMRect>());
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const before = prev.current;
    if (before && before !== view && !reduced) {
      const { moves, flips } = flightsBetween(before, view);
      for (const [to, from] of moves) {
        const el = els.current.get(to);
        const rect = rects.current.get(from);
        if (el && rect) fly(el, rect);
      }
      for (const key of flips) {
        const el = els.current.get(key);
        if (el) flipIn(el);
      }
    }
    prev.current = view;
    rects.current = new Map([...els.current].map(([k, el]) => [k, el.getBoundingClientRect()]));
  });
}
