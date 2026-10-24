// Card movement: compares the previous view with the new one, works out what travelled where,
// and animates those elements from their old position (FLIP) with the Web Animations API.
// Works for every player's moves, online or hot-seat, because it only needs views.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GameView } from "../engine/view";

export const slotKey = (seat: number, pos: number) => `slot-${seat}-${pos}`;

const REDUCE = "(prefers-reduced-motion: reduce)";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCE).matches);
  useEffect(() => {
    const query = window.matchMedia(REDUCE);
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

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
    // The turn ended: the held card went into the grid (swap) or onto the discard pile. At round
    // end the final reveal changes other slots too, so prefer the slot that now holds the card.
    const seat = prev.current;
    const before = prev.players[seat].grid;
    const after = cur.players[seat].grid;
    const changed = after.flatMap((slot, i) => (slot !== null && slot !== before[i] ? [i] : []));
    const pos = changed.find((i) => after[i] === prev.drawn) ?? changed[0] ?? -1;
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

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

function fly(el: HTMLElement, from: DOMRect) {
  const to = el.getBoundingClientRect();
  if (!to.width) return;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const scale = from.width / to.width;
  el.animate(
    [
      { transformOrigin: "0 0", transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
      { transformOrigin: "0 0", transform: "none" },
    ],
    { duration: 380, easing: EASE },
  );
}

const flipIn = (el: HTMLElement) =>
  el.animate([{ transform: "rotateY(90deg)" }, { transform: "none" }], {
    duration: 300,
    easing: "ease-out",
  });

const measure = (els: Map<string, HTMLElement>) =>
  new Map([...els].map(([k, el]) => [k, el.getBoundingClientRect()] as const));

/**
 * Registers card elements under keys and animates what changed whenever the view changes.
 * Positions are re-measured after scrolls and resizes, so flights start where cards really were.
 * Does nothing (and measures nothing) when the user prefers reduced motion.
 */
export function useFlights(view: GameView) {
  const els = useRef(new Map<string, HTMLElement>());
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const prev = useRef<GameView | null>(null);
  const rects = useRef(new Map<string, DOMRect>());
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = view;
    if (reduced) return;
    if (before) {
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
    rects.current = measure(els.current);
  }, [view, reduced]);

  useEffect(() => {
    if (reduced) return;
    let frame = 0;
    const remeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        rects.current = measure(els.current);
      });
    };
    window.addEventListener("scroll", remeasure, true); // capture: .table scrolls, not the window
    window.addEventListener("resize", remeasure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", remeasure, true);
      window.removeEventListener("resize", remeasure);
    };
  }, [reduced]);

  /** Stable ref callback per key, so React doesn't detach and reattach every card each render. */
  return (key: string) => {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (el) => {
        if (el) els.current.set(key, el);
        else els.current.delete(key);
      };
      refs.current.set(key, ref);
    }
    return ref;
  };
}

/** Eases from `from` to `to` over 0.8 s (or jumps under reduced motion). */
export function useCountUp(from: number, to: number): number {
  const reduced = useReducedMotion();
  const [n, setN] = useState(reduced ? to : from);
  useEffect(() => {
    if (reduced) {
      setN(to);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / 800);
      setN(Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [from, to, reduced]);
  return n;
}
