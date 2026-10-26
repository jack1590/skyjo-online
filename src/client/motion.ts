// Card movement: compares the previous view with the new one, works out what travelled where,
// and animates those elements from their old position (FLIP) with the Web Animations API.
// Works for every player's moves (and for spectators), because it only needs views.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GameView } from "../engine/view";
import back from "./art/back.webp";

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
  /** element keys whose card turned face up in place, in seat order from the ender's left */
  flips: string[];
  /** The round just ended: the final reveal's flips are staggered (UX-27). */
  reveal: boolean;
}

/** What moved between two views, as element keys ("deck", "drawn", "discard", slotKey). */
export function flightsBetween(prev: GameView, cur: GameView): Flights {
  const moves = new Map<string, string>();
  const flips: string[] = [];
  const n = cur.players.length;
  const reveal =
    cur.phase !== prev.phase && (cur.phase === "roundOver" || cur.phase === "gameOver");
  if (prev.round !== cur.round || prev.players.length !== n) {
    return { moves, flips, reveal: false }; // a fresh deal: nothing travels
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
  // Seat order from the ender's left, then row by row: the final reveal's order (UX-27).
  for (let i = 1; i <= n; i++) {
    const seat = ((cur.ender ?? 0) + i) % n;
    cur.players[seat].grid.forEach((slot, pos) => {
      const was = prev.players[seat].grid[pos];
      const key = slotKey(seat, pos);
      // A completed column leaves for the discard pile.
      if (slot === null && was !== null) moves.set("discard", key);
      else if (was === "down" && typeof slot === "number" && !moves.has(key)) flips.push(key);
    });
  }
  return { moves, flips, reveal };
}

/** The final reveal (UX-27): flip i of n starts at i·step, all within 2.5 s. */
export const revealStep = (n: number) => Math.min(110, 2500 / n);
const FLIP_MS = 300;
/**
 * How long the round summary waits for a final reveal of n flips: 600 ms past the last one. With
 * nothing left to turn it still waits as long, for the last move's flights.
 */
export const revealMs = (n: number) => Math.max(0, n - 1) * revealStep(n) + FLIP_MS + 600;

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** Marks this file's animations, so measuring can tell a card in flight from one at rest. */
const FLIGHT = "flight";
const BACK = `url(${back})`;

/**
 * The transform that puts `el`, at rest at `to`, over `from`. Around the card's centre, like its
 * own `scale` (the lifted discard, UX-21), so the two compose; that scale also scales the offset.
 */
function offset(el: HTMLElement, from: DOMRect, to: DOMRect) {
  const k = Number.parseFloat(getComputedStyle(el).scale) || 1;
  const dx = (from.x + from.width / 2 - (to.x + to.width / 2)) / k;
  const dy = (from.y + from.height / 2 - (to.y + to.height / 2)) / k;
  return { dx, dy, s: from.width / to.width };
}

function fly(el: HTMLElement, from: DOMRect, to: DOMRect) {
  const { dx, dy, s } = offset(el, from, to);
  el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${s})` }, { transform: "none" }], {
    duration: 380,
    easing: EASE,
    id: FLIGHT,
  });
}

/**
 * Plays `el` through three transforms (start, halfway, end) and turns it over halfway, when it is
 * edge-on: its back before, its face after. Its number hides with the back. The picture changes in
 * an effect of its own, so the transform stays on the compositor.
 */
function turnOver(el: HTMLElement, [a, b, c]: string[], options: KeyframeAnimationOptions) {
  const face = el.style.backgroundImage;
  const timing = { ...options, id: FLIGHT };
  el.animate([{ transform: a }, { transform: b }, { transform: c }], timing);
  const swap = <T>(back: T, front: T) => [
    back,
    { ...back, offset: 0.5 },
    { ...front, offset: 0.5 },
    front,
  ];
  el.animate(swap({ backgroundImage: BACK }, { backgroundImage: face }), timing);
  el.querySelector(".num")?.animate(swap({ opacity: 0 }, { opacity: 1 }), timing);
}

/** A deck draw (UX-25): leaves the top of the deck face down, lifts, and turns face up halfway. */
function draw(el: HTMLElement, from: DOMRect, to: DOMRect) {
  const { dx, dy, s } = offset(el, from, to);
  const at = (x: number, y: number, scale: number, turn: number) =>
    `perspective(500px) translate(${x}px, ${y}px) scale(${scale}) rotateY(${turn}deg)`;
  turnOver(
    el,
    [at(dx, dy, s, 0), at(dx / 2, dy / 2 - 12, ((s + 1) / 2) * 1.08, 90), at(0, 0, 1, 0)],
    {
      duration: 420,
      easing: "ease-in-out",
    },
  );
}

/** Turns a card face up in place; `delay` staggers the final reveal (UX-27). */
const flipIn = (el: HTMLElement, delay: number) =>
  turnOver(el, ["rotateY(0deg)", "rotateY(90deg)", "rotateY(0deg)"], {
    duration: FLIP_MS,
    delay,
    easing: "ease-in-out",
    fill: "backwards", // face down while it waits its turn
  });

const flying = (el: HTMLElement) => el.getAnimations().some((a) => a.id === FLIGHT);

/**
 * Where each card sits. A card in flight keeps the place it was last measured at rest, so no
 * flight ever starts from another flight's frame (UX-1).
 */
const measure = (els: Map<string, HTMLElement>, old: Map<string, DOMRect>) =>
  new Map(
    [...els].map(
      ([k, el]) => [k, (flying(el) && old.get(k)) || el.getBoundingClientRect()] as const,
    ),
  );

/**
 * Registers card elements under keys and animates what changed whenever the view changes.
 * Positions are re-measured after scrolls and resizes, so flights start where cards really were.
 * Does nothing (and measures nothing) when the user prefers reduced motion.
 */
export function useFlights(view: GameView, tapped?: { current: string | null }) {
  const els = useRef(new Map<string, HTMLElement>());
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const prev = useRef<GameView | null>(null);
  const rects = useRef(new Map<string, DOMRect>());
  const measureAgain = useRef(() => {});
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = view;
    if (reduced) return;
    if (before && before.round !== view.round) {
      // A fresh deal: the last round's reveal must not turn the new cards over.
      for (const el of els.current.values()) {
        for (const a of el.getAnimations({ subtree: true })) if (a.id === FLIGHT) a.cancel();
      }
    }
    // Every new position is read before any flight starts, so none holds a first frame (UX-1).
    const was = rects.current;
    const now = measure(els.current, was);
    rects.current = now;
    if (!before) return;
    const { moves, flips, reveal } = flightsBetween(before, view);
    for (const [to, from] of moves) {
      const el = els.current.get(to);
      const a = was.get(from);
      const b = now.get(to);
      if (!el || !a || !b?.width) continue;
      (to === "drawn" && from === "deck" ? draw : fly)(el, a, b);
    }
    const step = reveal ? revealStep(flips.length) : 0;
    // The card you tapped to end the round turns at once; the reveal follows it (UX-27).
    const mine = tapped?.current;
    const order = mine && flips.includes(mine) ? [mine, ...flips.filter((k) => k !== mine)] : flips;
    order.forEach((key, i) => {
      const el = els.current.get(key);
      if (el) flipIn(el, i * step);
    });
    measureAgain.current(); // and again once they land
  }, [view, reduced, tapped]);

  useEffect(() => {
    if (reduced) return;
    let frame = 0;
    let on = true;
    const remeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        rects.current = measure(els.current, rects.current);
        // Cards in flight kept their old place: read them all once more when they've landed (not
        // every frame, which would be main-thread work during a whole final reveal).
        const flights = [...els.current.values()].flatMap((el) =>
          el.getAnimations().filter((a) => a.id === FLIGHT),
        );
        if (flights.length) {
          void Promise.allSettled(flights.map((a) => a.finished)).then(() => on && remeasure());
        }
      });
    };
    // WebKit can run the app before the stylesheet has loaded, so the first positions may be an
    // unstyled page's: read them again now, and at once when the page has loaded.
    const settle = () => {
      rects.current = measure(els.current, rects.current);
    };
    settle();
    window.addEventListener("load", settle);
    window.addEventListener("scroll", remeasure, true); // capture: .table scrolls, not the window
    window.addEventListener("resize", remeasure);
    measureAgain.current = remeasure;
    return () => {
      on = false;
      measureAgain.current = () => {};
      cancelAnimationFrame(frame);
      window.removeEventListener("load", settle);
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

/**
 * True while a final reveal plays (UX-27), so the round summary waits for it: from the view that
 * ends the round until 600 ms after its last flip (`revealMs`). Never with reduced motion.
 */
export function useRevealing(view: GameView): boolean {
  const reduced = useReducedMotion();
  const [last, setLast] = useState(view);
  const [hold, setHold] = useState(0);
  // Derived during render, not in an effect, so the summary's first render already waits.
  if (view !== last) {
    setLast(view);
    const { flips, reveal } = flightsBetween(last, view);
    if (reveal && !reduced) setHold(revealMs(flips.length));
  }
  useEffect(() => {
    if (!hold) return;
    const id = setTimeout(() => setHold(0), hold);
    return () => clearTimeout(id);
  }, [hold]);
  return hold > 0;
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
