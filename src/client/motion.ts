// Card movement: compares the previous view with the new one, works out what travelled where,
// and animates those elements from their old position (FLIP) with the Web Animations API.
// Works for every player's moves (and for spectators), because it only needs views.
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
  /** targets of moves whose card was face down where it left from, so it turns face up on the way */
  turns: Set<string>;
  /** element keys whose card turned face up in place, in seat order from the ender's left */
  flips: string[];
  /** The round just ended: the final reveal's flips are staggered (UX-27). */
  reveal: boolean;
}

/** What moved between two views, as element keys ("deck", "drawn", "discard", slotKey). */
export function flightsBetween(prev: GameView, cur: GameView): Flights {
  const moves = new Map<string, string>();
  const turns = new Set<string>();
  const flips: string[] = [];
  const n = cur.players.length;
  const reveal =
    cur.phase !== prev.phase && (cur.phase === "roundOver" || cur.phase === "gameOver");
  if (prev.round !== cur.round || prev.players.length !== n) {
    return { moves, turns, flips, reveal: false }; // a fresh deal: nothing travels
  }
  // A card thrown away on this phone (`thrown`, the only place phase with no card in hand) is
  // still held until the server answers, but it lies on the discard pile.
  const away = prev.phase === "place" && prev.drawn === null;
  const held = away ? prev.discardTop : prev.drawn;
  if (prev.drawn === null && cur.drawn !== null) {
    // From a pile, or back from the discard pile (Undo), face up.
    moves.set("drawn", cur.drawnFrom === "discard" || away ? "discard" : "deck");
    if (cur.drawnFrom !== "discard" && !away) turns.add("drawn");
  }
  if (held !== null && cur.drawn === null) {
    // The turn ended: the held card went into the grid (swap) or onto the discard pile. At round
    // end the final reveal changes other slots too, so prefer the slot that now holds the card.
    const seat = prev.current;
    const before = prev.players[seat].grid;
    const after = cur.players[seat].grid;
    const changed = after.flatMap((slot, i) => (slot !== null && slot !== before[i] ? [i] : []));
    const pos = changed.find((i) => after[i] === held) ?? changed[0] ?? -1;
    const revealedOnly = before[pos] === "down" && cur.discardTop === held;
    const swapped =
      pos !== -1 && (prev.drawnFrom === "discard" || (after[pos] === held && !revealedOnly));
    if (swapped) {
      // A thrown card the server swapped in (your clock ran out) leaves from the pile.
      moves.set(slotKey(seat, pos), away ? "discard" : "drawn");
      moves.set("discard", slotKey(seat, pos));
      if (before[pos] === "down") turns.add("discard");
    } else if (!away) {
      moves.set("discard", "drawn"); // a thrown card is already there
    }
  }
  // Seat order from the ender's left, then row by row: the final reveal's order (UX-27).
  for (let i = 1; i <= n; i++) {
    const seat = ((cur.ender ?? 0) + i) % n;
    cur.players[seat].grid.forEach((slot, pos) => {
      const was = prev.players[seat].grid[pos];
      const key = slotKey(seat, pos);
      // A completed column leaves for the discard pile.
      if (slot === null && was !== null) {
        moves.set("discard", key);
        if (was === "down") turns.add("discard");
        else turns.delete("discard");
      } else if (was === "down" && typeof slot === "number" && !moves.has(key)) flips.push(key);
    });
  }
  return { moves, turns, flips, reveal };
}

/**
 * The table while you throw the drawn card away (UX-19): it already lies on the discard pile, on
 * this phone only, until you turn a card over, which sends the one discard-and-flip.
 */
export const thrown = (view: GameView): GameView => ({
  ...view,
  discardTop: view.drawn,
  drawn: null,
});

/** How long a card takes to turn over where it lies, by its size (UX-24). */
export const FLIP_MS = { lg: 380, md: 340, sm: 260 } as const;

/** The final reveal (UX-27): flip i of n starts at i·step, all within 2.5 s. */
export const revealStep = (n: number) => Math.min(110, 2500 / n);
/** The round summary shows this long after the final reveal's last card has turned (UX-27). */
export const SUMMARY_MS = 600;
/** When a change's last animation ends (ms), from its timing; 0 when nothing moved. */
export const settled = (timing: Timing) => Math.max(0, ...[...timing.values()].map((t) => t.end));

/** When each flip starts: the final reveal's `step` apart, after the card you tapped (UX-27). */
export function flipDelays(flips: string[], step: number, tapped?: string | null) {
  const order =
    tapped && flips.includes(tapped) ? [tapped, ...flips.filter((k) => k !== tapped)] : flips;
  return order.map((key, i) => [key, i * step] as const);
}

/** CSS's `cubic-bezier(x1, y1, x2, y2)`, as a function of the fraction of time gone. */
export function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, u: number) =>
    3 * a * u * (1 - u) ** 2 + 3 * b * u ** 2 * (1 - u) + u ** 3;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let [lo, hi] = [0, 1];
    for (let i = 0; i < 30; i++) {
      const u = (lo + hi) / 2;
      if (at(x1, x2, u) < t) lo = u;
      else hi = u;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}

/** UX-22: a flight of d px lasts 260–460 ms. */
export const flightMs = (d: number) => Math.min(460, Math.max(260, 180 + 0.55 * d));
/** UX-23: a card leaving a grid is picked up for 80 ms first; the one coming in starts at 90 ms. */
export const LIFT_MS = 80;
export const IN_MS = 90;

/** How far along its way a flight is (UX-22): it starts gently instead of snapping, then slows. */
const travel = bezier(0.3, 0, 0.2, 1);
const FLIP_EASE = "cubic-bezier(0.45, 0, 0.25, 1)";
/** How far a card has turned (0–1, edge-on at 0.5): each half eases like a flip (UX-24). */
const half = bezier(0.45, 0, 0.25, 1);
const turned = (u: number) => (u < 0.5 ? half(2 * u) / 2 : 0.5 + half(2 * u - 1) / 2);
/** 0, up to 1 halfway, back to 0 as the card lands at 0.88: a flight's lift, lean and arc. */
const bump = (t: number) =>
  t < 0.5 ? Math.sin(Math.PI * t) : t < 0.88 ? Math.cos(((t - 0.5) / 0.38) * (Math.PI / 2)) : 0;
/** The times of a flight's frames: its landing at 0.88, squashed at 0.94, at rest at 1. */
const TIMES = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.88, 0.94, 1];

type Rect = Pick<DOMRect, "x" | "y" | "width" | "height">;
/**
 * One frame of a flight, at `offset` of its time: the card's centre in px from where it lands,
 * its lean (deg), its scale, and how far it is turned away (deg: 180 shows its back).
 */
interface Frame {
  offset: number;
  x: number;
  y: number;
  rotate: number;
  scale: number;
  turn: number;
}

/**
 * A card's flight from `from` to `to` (UX-22): it lifts to 1.06, leans 3° the way it goes and, on
 * a long trip up or down, arcs up, all at their most halfway; then it lands and settles. With
 * `lift`, it is first picked up for that many ms where it is and stays up for the first half of
 * the way (UX-23). A card that left face down (`turn`) turns face up on the way: within that first
 * half after a lift, else edge-on halfway, taking at least a medium card's flip (UX-25, UX-24).
 * A card that lay tilted (`tilt`, deg: one thrown on the pile, UX-19) straightens on its way.
 */
export function path(from: Rect, to: Rect, { lift = 0, turn = false, tilt = 0 } = {}) {
  const dx = from.x + from.width / 2 - (to.x + to.width / 2);
  const dy = from.y + from.height / 2 - (to.y + to.height / 2);
  const s = from.width / to.width;
  const d = Math.hypot(dx, dy);
  const fly = Math.max(flightMs(d), turn && !lift ? FLIP_MS.md : 0);
  const duration = lift + fly;
  const arc = Math.abs(dy) > 80 ? Math.min(24, 0.12 * d) : 0;
  const lean = Math.abs(dx) < 1 ? 0 : -3 * Math.sign(dx);
  const back = turn ? 180 : 0;
  const frames: Frame[] = lift
    ? [{ offset: 0, x: dx, y: dy, rotate: tilt, scale: s, turn: back }]
    : [];
  for (const t of TIMES) {
    const p = travel(t);
    const up = lift && t < 0.5 ? 1 : bump(t);
    frames.push({
      offset: (lift + t * fly) / duration,
      x: dx * (1 - p),
      y: dy * (1 - p) - arc * bump(t),
      rotate: lean * bump(t) + tilt * (1 - p),
      scale: (s + (1 - s) * p) * (1 + 0.06 * up) * (t === 0.94 ? 0.97 : 1),
      turn: back * (1 - turned(Math.min(1, lift ? 2 * t : t))),
    });
  }
  // Rounded, so a CSS value is never written as 1e-7 (nor -0).
  const r = (v: number) => Math.round(v * 1e4) / 1e4 || 0;
  return {
    /** When a card that turns is edge-on: a quarter into its flight after a lift, else halfway. */
    edge: (lift + (lift ? 0.25 : 0.5) * fly) / duration,
    /** When it hits (ms): the bottom of its settle, 0.06 of its flight from touching down. */
    hit: lift + 0.94 * fly,
    frames: frames.map((f) => ({
      offset: f.offset,
      x: r(f.x),
      y: r(f.y),
      rotate: r(f.rotate),
      scale: r(f.scale),
      turn: r(f.turn),
    })),
    duration,
  };
}

/**
 * A card turning face up where it lies (UX-24): from its back, edge-on halfway, then its face. Large
 * and medium cards rise 4 px and grow 8% on the way; small ones (opponents') only turn. The
 * perspective is 6 card widths, so every size turns alike.
 */
export function flipFrames(size: keyof typeof FLIP_MS, w: number): Keyframe[] {
  const at = (y: number, turn: number, scale: number) => ({
    transform: `perspective(${6 * w}px) translateY(${y}px) rotateY(${turn}deg) scale(${scale})`,
    easing: FLIP_EASE,
  });
  const lift = size !== "sm";
  return [at(0, 180, 1), at(lift ? -4 : 0, 90, lift ? 1.08 : 1), at(0, 0, 1)];
}

/** Mark this file's animations, so measuring can tell a card in motion from one at rest. */
const FLIGHT = "flight";
const FLIP = "flip";
const BACK = "back";
const ours = (a: Animation) => a.id === FLIGHT || a.id === FLIP || a.id === BACK;

/** One animation to start: its element, keyframes and timing, and its role (`data-motion`). */
interface Job {
  el: HTMLElement;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  role?: string;
  /** For a card that turns over: the offset at which it is edge-on, when its back hides (UX-24). */
  edge?: number;
}

/**
 * Starts the jobs and keeps each card marked in motion until it stops (`data-motion`, see
 * styles.css: above the table, "in" above the rest, and its back face). Every card is marked
 * before any starts: animating a pseudo-element reads styles, so marking cards in between would
 * recompute them once per card (300–470 ms frames at the start of an 8-seat reveal, 4× CPU).
 */
function start(jobs: Job[]) {
  for (const { el, role = "" } of jobs) el.dataset.motion = role;
  for (const { el, keyframes, options, edge } of jobs) {
    const done = () => {
      if (!el.getAnimations().some(ours)) delete el.dataset.motion;
    };
    const timing = { ...options, fill: "backwards" as const };
    el.animate(keyframes, timing).finished.then(done, done);
    if (edge === undefined) continue;
    const shown = [
      { opacity: 1 },
      { opacity: 1, offset: edge },
      { opacity: 0, offset: edge },
      { opacity: 0 },
    ];
    el.animate(shown, { ...timing, id: BACK, pseudoElement: "::before" });
  }
}

/**
 * When each animation of the last change starts, hits home and ends (ms), by element key; for its
 * sounds and the round summary.
 */
export type Timing = Map<string, { start: number; hit: number; end: number }>;

const flying = (el: HTMLElement) => el.getAnimations().some(ours);

/** Where a card sits, and how far it lies tilted (deg). */
type Place = Rect & { tilt?: number };

/**
 * A card's place. One lying tilted (`data-tilt`, UX-19's thrown card) is measured as if straight:
 * its own size around its centre, since its bounding box grows with the tilt.
 */
function place(el: HTMLElement): Place {
  const r = el.getBoundingClientRect();
  const tilt = Number(el.dataset.tilt);
  if (!tilt) return r;
  const [width, height] = [el.offsetWidth, el.offsetHeight];
  return { x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height, tilt };
}

/**
 * Where each card sits. A card in flight keeps the place it was last measured at rest, so no
 * flight ever starts from another flight's frame (UX-1).
 */
const measure = (els: Map<string, HTMLElement>, old: Map<string, Place>) =>
  new Map([...els].map(([k, el]) => [k, (flying(el) && old.get(k)) || place(el)] as const));

/**
 * Registers card elements under keys and animates what changed whenever the view changes.
 * Positions are re-measured after scrolls and resizes, so flights start where cards really were.
 * Does nothing (and measures nothing) when the user prefers reduced motion. `timing` holds when
 * the last change's animations start and end, for its sounds. `pending` is the key of a card
 * lifted by a tap (UX-3): it is measured there, so its flight starts where it is.
 */
export function useFlights(
  view: GameView,
  tapped?: { current: string | null },
  pending?: string | null,
) {
  const els = useRef(new Map<string, HTMLElement>());
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const prev = useRef<GameView | null>(null);
  const rects = useRef(new Map<string, Place>());
  const timing = useRef<Timing>(new Map());
  const measureAgain = useRef(() => {});
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = view;
    const times: Timing = new Map();
    timing.current = times;
    if (reduced) return;
    if (before && before.round !== view.round) {
      // A fresh deal: the last round's reveal must not turn the new cards over.
      for (const el of els.current.values()) {
        for (const a of el.getAnimations({ subtree: true })) if (ours(a)) a.cancel();
      }
    }
    // Every new position is read before any flight starts, so none holds a first frame (UX-1).
    const was = rects.current;
    const now = measure(els.current, was);
    rects.current = now;
    if (!before) return;
    const { moves, turns, flips, reveal } = flightsBetween(before, view);
    const jobs: Job[] = [];
    for (const [to, from] of moves) {
      const el = els.current.get(to);
      const a = was.get(from);
      const b = now.get(to);
      if (!el || !a || !b?.width) continue;
      // A swap (UX-23): the card leaving a grid is picked up first, and the one going in waits.
      const lift = from.startsWith("slot-") ? LIFT_MS : 0;
      const delay = from === "drawn" && to !== "discard" ? IN_MS : 0;
      const turn = turns.has(to);
      const { frames, duration, edge, hit } = path(a, b, { lift, turn, tilt: a.tilt });
      // Around the card's centre, like its own `scale` (the lifted discard, UX-21), so the two
      // compose; that scale also scales the offset.
      const k = Number.parseFloat(getComputedStyle(el).scale) || 1;
      const keyframes = frames.map((f) => ({
        offset: f.offset,
        transform:
          `translate(${f.x / k}px, ${f.y / k}px) rotate(${f.rotate}deg) scale(${f.scale})` +
          (turn ? ` perspective(${(6 * b.width) / k}px) rotateY(${f.turn}deg)` : ""),
      }));
      const options = { duration, delay, id: FLIGHT };
      jobs.push({ el, keyframes, options, role: delay ? "in" : "", edge: turn ? edge : undefined });
      times.set(to, { start: delay, hit: delay + hit, end: delay + duration });
    }
    for (const [key, delay] of flipDelays(
      flips,
      reveal ? revealStep(flips.length) : 0,
      tapped?.current,
    )) {
      const el = els.current.get(key);
      const w = now.get(key)?.width;
      if (!el || !w) continue;
      const size = el.classList.contains("sm") ? "sm" : el.classList.contains("md") ? "md" : "lg";
      const options = { duration: FLIP_MS[size], delay, id: FLIP };
      jobs.push({ el, keyframes: flipFrames(size, w), options, edge: 0.5 });
      times.set(key, { start: delay, hit: delay + FLIP_MS[size], end: delay + FLIP_MS[size] });
    }
    start(jobs);
    measureAgain.current(); // and again once they land
  }, [view, reduced, tapped]);

  useLayoutEffect(() => {
    if (pending && !reduced) rects.current = measure(els.current, rects.current);
  }, [pending, reduced]);

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
        const flights = [...els.current.values()].flatMap((el) => el.getAnimations().filter(ours));
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
  const reg = (key: string) => {
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
  return { reg, timing };
}

/**
 * True while a final reveal plays (UX-27), so the round summary waits for it: from the view that
 * ends the round until `SUMMARY_MS` after its last animation ends (useFlights' `timing`, set in
 * its layout effect before this effect runs). Never with reduced motion.
 */
export function useRevealing(view: GameView, timing: { current: Timing }): boolean {
  const reduced = useReducedMotion();
  const [last, setLast] = useState(view);
  const [hold, setHold] = useState(false);
  // Derived during render, not in an effect, so the summary's first render already waits.
  if (view !== last) {
    setLast(view);
    if (flightsBetween(last, view).reveal && !reduced) setHold(true);
  }
  useEffect(() => {
    if (!hold) return;
    const id = setTimeout(() => setHold(false), settled(timing.current) + SUMMARY_MS);
    return () => clearTimeout(id);
  }, [hold, timing]);
  return hold;
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
