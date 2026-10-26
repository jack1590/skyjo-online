// Card movement: compares the previous view with the new one, works out what travelled where,
// and animates those elements from their old position (FLIP) with the Web Animations API.
// Works for every player's moves (and for spectators), because it only needs views.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GameView, ViewSlot } from "../engine/view";
import { art, formatCard } from "./Card";

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

/** One card's way, from the element it was in to the one it is in now (keys: see flightsBetween). */
export interface Move {
  to: string;
  from: string;
  /** It left face down, so it turns face up on the way. */
  turn: boolean;
  /**
   * The card a stand-in shows on its way (UX-26), when no element will: a completed column's card,
   * and what goes onto the pile under it ("down": nobody saw it).
   */
  card?: ViewSlot;
  /** A card of a completed column (R9): it leaves for the pile once the rest has landed (UX-26). */
  column?: true;
}

interface Flights {
  /** Every card that travelled, in the order they land: the discard pile's are stacked so. */
  moves: Move[];
  /**
   * Element keys whose card turned face up in place, in seat order from the ender's left; a
   * completed column's card too, before it leaves.
   */
  flips: string[];
  /** The round just ended: the final reveal's flips are staggered (UX-27). */
  reveal: boolean;
}

/** What moved between two views, as element keys ("deck", "drawn", "discard", slotKey). */
export function flightsBetween(prev: GameView, cur: GameView): Flights {
  const moves: Move[] = [];
  const flips: string[] = [];
  const n = cur.players.length;
  const reveal =
    cur.phase !== prev.phase && (cur.phase === "roundOver" || cur.phase === "gameOver");
  if (prev.round !== cur.round || prev.players.length !== n) {
    return { moves, flips, reveal: false }; // a fresh deal: nothing travels
  }
  // Completed columns (R9), the mover's first, as the engine stacks them on the pile. A column's
  // card is the one its face-up cards share (the view never shows a card that left face down).
  const removed: { seat: number; pos: number; card: ViewSlot }[] = [];
  for (const seat of new Set([prev.current, ...cur.players.keys()])) {
    const [was, now] = [prev.players[seat].grid, cur.players[seat].grid];
    for (let col = 0; col < 4; col++) {
      const column = [col, col + 4, col + 8];
      if (!column.every((i) => was[i] !== null && now[i] === null)) continue;
      const up = column.flatMap((i) => (typeof was[i] === "number" ? [was[i]] : []));
      const card = up.find((c) => up.indexOf(c) !== up.lastIndexOf(c)) ?? up[0] ?? cur.discardTop;
      for (const pos of column) removed.push({ seat, pos, card });
    }
  }
  // When a column leaves, the pile will show it, not what went there before: those fly as copies.
  const copied = removed.length > 0;
  // A card thrown away on this phone (`thrown`, the only place phase with no card in hand) is
  // still held until the server answers, but it lies on the discard pile.
  const away = prev.phase === "place" && prev.drawn === null;
  const held = away ? prev.discardTop : prev.drawn;
  if (prev.drawn === null && cur.drawn !== null) {
    // From a pile, or back from the discard pile (Undo), face up.
    const from = cur.drawnFrom === "discard" || away ? "discard" : "deck";
    moves.push({ to: "drawn", from, turn: from === "deck" });
  }
  if (held !== null && cur.drawn === null) {
    // The turn ended: the held card went into the grid (swap) or onto the discard pile. At round
    // end the final reveal changes other slots too, so prefer the slot that now holds the card.
    const seat = prev.current;
    const before = prev.players[seat].grid;
    const after = cur.players[seat].grid;
    const changed = after.flatMap((slot, i) => (slot !== null && slot !== before[i] ? [i] : []));
    // A swap that completed a column went into the one slot of it that didn't show the card
    // (UX-26). Not a face-down one when the card was thrown here: that's the card you turned over.
    const into = removed.find(
      (r) =>
        r.seat === seat &&
        r.card === held &&
        before[r.pos] !== held &&
        !(away && before[r.pos] === "down"),
    )?.pos;
    // Certain when that slot showed another card; else the final reveal may have turned up the
    // card elsewhere, which then is where it went.
    const sure = into !== undefined && typeof before[into] === "number" ? into : undefined;
    const pos = sure ?? changed.find((i) => after[i] === held) ?? into ?? changed[0] ?? -1;
    const revealedOnly = before[pos] === "down" && cur.discardTop === held;
    const swapped =
      pos === into ||
      (pos !== -1 && (prev.drawnFrom === "discard" || (after[pos] === held && !revealedOnly)));
    if (swapped) {
      // A thrown card the server swapped in (your clock ran out) leaves from the pile.
      const from = away ? "discard" : "drawn";
      moves.push({
        to: slotKey(seat, pos),
        from,
        turn: false,
        ...(pos === into && { card: held }),
      });
      const out = slotKey(seat, pos);
      const turn = !copied && before[pos] === "down";
      moves.push({ to: "discard", from: out, turn, ...(copied && { card: before[pos] }) });
    } else if (!away) {
      // A thrown card is already there.
      moves.push({ to: "discard", from: "drawn", turn: false, ...(copied && { card: held }) });
    }
  }
  for (const { seat, pos, card } of removed) {
    moves.push({ to: "discard", from: slotKey(seat, pos), turn: false, card, column: true });
  }
  // Seat order from the ender's left, then row by row: the final reveal's order (UX-27).
  for (let i = 1; i <= n; i++) {
    const seat = ((cur.ender ?? 0) + i) % n;
    cur.players[seat].grid.forEach((slot, pos) => {
      const key = slotKey(seat, pos);
      const turned = prev.players[seat].grid[pos] === "down" && slot !== "down";
      if (turned && !moves.some((m) => m.to === key)) flips.push(key);
    });
  }
  return { moves, flips, reveal };
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
/**
 * UX-26: once the rest of a change has landed, a beat; then a completed column's cards pulse, and
 * leave for the pile one `gap` after another, each flying `fly` ms.
 */
export const COLUMN = { beat: 120, pulse: 220, gap: 70, fly: 380 } as const;

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
/** Rounded, so a CSS value is never written as 1e-7 (nor -0). */
const round = (v: number) => Math.round(v * 1e4) / 1e4 || 0;
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
 * `ms` sets how long it flies (a column's cards, UX-26).
 */
export function path(from: Rect, to: Rect, { lift = 0, turn = false, tilt = 0, ms = 0 } = {}) {
  const dx = from.x + from.width / 2 - (to.x + to.width / 2);
  const dy = from.y + from.height / 2 - (to.y + to.height / 2);
  const s = from.width / to.width;
  const d = Math.hypot(dx, dy);
  const fly = ms || Math.max(flightMs(d), turn && !lift ? FLIP_MS.md : 0);
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
  return {
    /** When a card that turns is edge-on: a quarter into its flight after a lift, else halfway. */
    edge: (lift + (lift ? 0.25 : 0.5) * fly) / duration,
    /** When it hits (ms): the bottom of its settle, 0.06 of its flight from touching down. */
    hit: lift + 0.94 * fly,
    frames: frames.map((f) => ({
      offset: f.offset,
      x: round(f.x),
      y: round(f.y),
      rotate: round(f.rotate),
      scale: round(f.scale),
      turn: round(f.turn),
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
/** A completed column's card on its way to the pile (UX-26). */
const LEAVE = "column";
const ours = (a: Animation) => [FLIGHT, FLIP, BACK, LEAVE].includes(a.id);

/** One animation to start: its element, keyframes and timing, and its role (`data-motion`). */
interface Job {
  el: HTMLElement;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  role?: string;
  /** For a card that turns over: the offset at which it is edge-on, when its back hides (UX-24). */
  edge?: number;
  /** Called once it has ended (or was cancelled). */
  done?: () => void;
}

/**
 * Starts the jobs and keeps each card marked in motion until it stops (`data-motion`, see
 * styles.css: above the table, "in" above the rest, and its back face). Every card is marked
 * before any starts: animating a pseudo-element reads styles, so marking cards in between would
 * recompute them once per card (300–470 ms frames at the start of an 8-seat reveal, 4× CPU).
 */
function start(jobs: Job[]) {
  for (const { el, role = "" } of jobs) el.dataset.motion = role;
  return jobs.map(({ el, keyframes, options, edge, done: then }) => {
    const done = () => {
      if (!el.getAnimations().some(ours)) delete el.dataset.motion;
      then?.();
    };
    const timing = { fill: "backwards" as const, ...options };
    const animation = el.animate(keyframes, timing);
    animation.finished.then(done, done);
    if (edge !== undefined) {
      const shown = [
        { opacity: 1 },
        { opacity: 1, offset: edge },
        { opacity: 0, offset: edge },
        { opacity: 0 },
      ];
      el.animate(shown, { ...timing, id: BACK, pseudoElement: "::before" });
    }
    return animation;
  });
}

/** A frame (`turn`: with its turn, about a perspective of 6 card widths) as a `transform`. */
const transform = (f: Omit<Frame, "offset">, w: number, turn: boolean, k = 1) =>
  `translate(${round(f.x / k)}px, ${round(f.y / k)}px) rotate(${f.rotate}deg) scale(${round(f.scale)})` +
  (turn ? ` perspective(${round((6 * w) / k)}px) rotateY(${f.turn}deg)` : "");

/** Hidden for `ms` while a stand-in shows its card (UX-8, UX-26). */
const hide = (el: HTMLElement, ms: number, done?: () => void): Job => ({
  el,
  keyframes: [{ opacity: 0 }, { opacity: 0 }],
  options: { duration: ms, id: FLIGHT },
  role: "hide",
  done,
});

type Size = keyof typeof FLIP_MS;
const sizeOf = (el: HTMLElement): Size =>
  el.classList.contains("sm") ? "sm" : el.classList.contains("md") ? "md" : "lg";

/**
 * A stand-in for a card on its way (UX-8, UX-26, UX-30): fixed over the page where `box` is, so no
 * scrolling strip clips it, and never tapped (styles.css). It looks like `look`: a card element, or
 * a card of `size` showing that card (by default a medium one, like the pile's), its number
 * `num` px tall (else as its size has it). `under`: the one under a card flying onto the pile.
 * `hidden`: seen only while its animations say so.
 */
function standIn(
  look: HTMLElement | ViewSlot,
  box: Rect,
  { size = "md" as Size, num = 0, under = false, hidden = false } = {},
) {
  const el = document.createElement("span");
  if (look instanceof HTMLElement) {
    el.className = look.className;
    el.style.backgroundImage = look.style.backgroundImage;
    el.innerHTML = look.innerHTML;
    // Its number is sized by the grid it's in (container units), which the stand-in isn't.
    const text = look.querySelector(".num");
    num = text ? Number.parseFloat(getComputedStyle(text).fontSize) : 0;
  } else if (look !== null) {
    el.className = `card ${size} ${look === "down" ? "down" : "up"}`;
    el.style.backgroundImage = `url(${art(look)})`;
    // A large card's width comes from your grid; its number is a share of it.
    if (size === "lg") el.style.setProperty("--w", `${box.width}px`);
    if (typeof look === "number") el.innerHTML = `<span class="num">${formatCard(look)}</span>`;
  }
  const text = el.querySelector<HTMLElement>(".num");
  if (num && text) text.style.fontSize = `${num}px`;
  el.dataset.copy = under ? "under" : "";
  if (hidden) el.style.opacity = "0";
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, {
    left: `${box.x}px`,
    top: `${box.y}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  });
  document.body.append(el);
  return el;
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
  /** Stand-ins on the page (`standIn`), gone with the table. */
  const copies = useRef(new Set<HTMLElement>());
  /** The last change's stand-ins and the cards they hide, which can outlast it (UX-26). */
  const lingering = useRef<Animation[]>([]);
  /**
   * Ends them at once: before the next move's flights, a tap, or a scroll (stand-ins are fixed to
   * the page), so the table shows its cards again, at rest.
   */
  const endStandIns = useRef(() => {
    for (const a of lingering.current) a.finish();
    lingering.current = [];
  });
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = view;
    const times: Timing = new Map();
    timing.current = times;
    if (reduced) return;
    if (before && before.round !== view.round) {
      // A fresh deal: the last round's reveal must not turn the new cards over.
      for (const el of [...els.current.values(), ...copies.current]) {
        for (const a of el.getAnimations({ subtree: true })) if (ours(a)) a.cancel();
      }
      lingering.current = [];
    }
    const { moves, flips, reveal } = before
      ? flightsBetween(before, view)
      : { moves: [], flips: [], reveal: false };
    // Not for an update that moves nothing (presence, clocks): that would cut a column short.
    if (moves.length || flips.length) endStandIns.current();
    // Every new position is read before any flight starts, so none holds a first frame (UX-1).
    const was = rects.current;
    const now = measure(els.current, was);
    rects.current = now;
    if (!before) return;
    const jobs: Job[] = [];
    const pile = now.get("discard");
    const column = moves.filter((m) => m.column);
    const leaves = (key: string) => column.some((m) => m.from === key);
    // This change's stand-ins that stay until its column is on the pile (UX-26).
    const made: HTMLElement[] = [];
    const keep = (el: HTMLElement) => {
      copies.current.add(el);
      return el;
    };
    const drop = (el: HTMLElement) => () => {
      el.remove();
      copies.current.delete(el);
    };
    /** Raised over the other stand-ins until its job ends (UX-23: the card in, the one out). */
    const raise = (el: HTMLElement) => {
      el.style.zIndex = "4";
      return () => el.style.removeProperty("z-index");
    };
    /** How a column's card got to its slot in this change: flown in, or turned over there. */
    const arrived = new Map<string, { flight: ReturnType<typeof path>; delay: number }>();
    const turned = new Map<string, { delay: number; size: Size }>();

    for (const m of moves) {
      if (m.column) continue;
      const el = els.current.get(m.to);
      const a = was.get(m.from);
      const b = now.get(m.to);
      if (!el || !a || !b?.width) continue;
      // A swap (UX-23): the card leaving a grid is picked up first, and the one going in waits.
      const lift = m.from.startsWith("slot-") ? LIFT_MS : 0;
      const delay = m.from === "drawn" && m.to !== "discard" ? IN_MS : 0;
      const flight = path(a, b, { lift, turn: m.turn, tilt: a.tilt });
      const { frames, duration, edge, hit } = flight;
      times.set(m.to, { start: delay, hit: delay + hit, end: delay + duration });
      if (leaves(m.to)) {
        arrived.set(m.to, { flight, delay }); // its column's stand-in flies it in
        continue;
      }
      const options = { duration, delay, id: FLIGHT };
      const role = delay ? "in" : "";
      const back = m.turn ? edge : undefined;
      const keyframes: Keyframe[] = frames.map((f) => ({
        offset: f.offset,
        transform: transform(f, b.width, m.turn),
      }));
      if (m.card !== undefined) {
        // Onto the pile, under a column (UX-26): no element will show this card. One nobody saw
        // (it left face down) fades as it lands, as no discard lies face down.
        const copy = keep(standIn(m.card, b));
        made.push(copy);
        if (m.card === "down") {
          const n = keyframes.length;
          for (const [i, k] of keyframes.entries()) k.opacity = i < n - 2 ? 1 : i < n - 1 ? 0.4 : 0;
        }
        const fill = "forwards" as const;
        jobs.push({ el: copy, keyframes, options: { ...options, fill }, role, done: raise(copy) });
      } else if (el.closest(".opponents")) {
        // Into an opponent's grid: their scrolling strip would clip it (UX-8).
        const copy = keep(standIn(el, b));
        jobs.push({ el: copy, keyframes, options, role, edge: back, done: drop(copy) });
        jobs.push(hide(el, delay + duration));
      } else {
        // Around the card's centre, like its own `scale` (the lifted discard, UX-21), so the two
        // compose; that scale also scales the offset.
        const k = Number.parseFloat(getComputedStyle(el).scale) || 1;
        for (const [i, f] of frames.entries())
          keyframes[i].transform = transform(f, b.width, m.turn, k);
        jobs.push({ el, keyframes, options, role, edge: back });
      }
    }
    for (const [key, delay] of flipDelays(
      flips,
      reveal ? revealStep(flips.length) : 0,
      tapped?.current,
    )) {
      const el = els.current.get(key);
      const w = now.get(key)?.width;
      if (!el || !w) continue;
      const size = sizeOf(el);
      times.set(key, { start: delay, hit: delay + FLIP_MS[size], end: delay + FLIP_MS[size] });
      if (leaves(key)) {
        turned.set(key, { delay, size }); // its column's stand-in turns over first
        continue;
      }
      // A turn in place stays among the cards around it ("flip": no z-index). Raising every card
      // of an 8-seat reveal cost WebKit a 75–90 ms frame as it started (M11 PO).
      const options = { duration: FLIP_MS[size], delay, id: FLIP };
      jobs.push({ el, keyframes: flipFrames(size, w), options, edge: 0.5, role: "flip" });
    }

    // A completed column (UX-26): a beat once the rest has landed, then its cards pulse where they
    // lie, and leave one after another; the pile shows its own card again once they're all on it.
    const discard = els.current.get("discard");
    const pulse = settled(times) + COLUMN.beat;
    const leave = pulse + COLUMN.pulse;
    const end = leave + (column.length - 1) * COLUMN.gap + COLUMN.fly;
    if (column.length && pile && discard) {
      times.set("column", { start: pulse, hit: pulse, end });
      column.forEach((m, i) => {
        const el = els.current.get(m.from);
        const at = now.get(m.from);
        if (!el || !at) return;
        const go = leave + i * COLUMN.gap;
        // Until it leaves, a stand-in of its own card where it lies: its size, and its number's
        // (an opponent's, like styles.css's `.card.sm .num`, from their grid's width).
        const size = sizeOf(el);
        const num = size === "sm" ? Math.max(12, 0.15 * (el.parentElement?.clientWidth ?? 0)) : 0;
        const card = keep(standIn(m.card ?? null, at, { size, num, hidden: true }));
        const rest = (t: number, scale = 1) => ({ t, x: 0, y: 0, rotate: 0, scale, turn: 0 });
        type Pose = ReturnType<typeof rest> & { easing?: string };
        const pose = (t: number, { x, y, rotate, scale, turn }: Frame): Pose => ({
          t,
          x,
          y,
          rotate,
          scale,
          turn,
        });
        let poses: Pose[] = [rest(0)];
        let edge: number | undefined;
        let done: (() => void) | undefined;
        const into = arrived.get(m.from);
        const flip = turned.get(m.from);
        if (into) {
          const { flight, delay } = into;
          poses = [
            pose(0, flight.frames[0]),
            ...flight.frames.map((f) => pose(delay + f.offset * flight.duration, f)),
          ];
          done = raise(card); // the card flown in passes over the column's others
        } else if (flip) {
          const ms = FLIP_MS[flip.size];
          const up = flip.size !== "sm";
          poses = [
            { ...rest(0), turn: 180 },
            { ...rest(flip.delay), turn: 180, easing: FLIP_EASE },
            {
              ...rest(flip.delay + ms / 2, up ? 1.08 : 1),
              y: up ? -4 : 0,
              turn: 90,
              easing: FLIP_EASE,
            },
            rest(flip.delay + ms),
          ];
          edge = (flip.delay + ms / 2) / go;
        }
        poses.push(rest(pulse), rest(pulse + COLUMN.pulse / 2, 1.1), rest(leave), rest(go));
        const lead = poses.map(({ t, easing, ...f }) => ({
          offset: t / go,
          transform: transform(f, at.width, true),
          opacity: 1,
          ...(easing && { easing }),
        }));
        jobs.push({ el: card, keyframes: lead, options: { duration: go, id: FLIGHT }, edge, done });
        // Then one like the pile's flies there, from where it lay.
        const flyer = keep(standIn(m.card ?? null, pile, { hidden: true }));
        made.push(card, flyer);
        const { frames } = path(at, pile, { ms: COLUMN.fly });
        const keyframes = frames.map((f) => ({
          offset: f.offset,
          transform: transform(f, pile.width, false),
          opacity: 1,
        }));
        const options = { delay: go, duration: COLUMN.fly, id: LEAVE, fill: "forwards" as const };
        // Over the column's other cards as it leaves past them, then stacked as it lands.
        jobs.push({ el: flyer, keyframes, options, done: raise(flyer) });
        jobs.push(hide(el, go));
      });
      jobs.push(
        hide(discard, end, () => {
          for (const el of made) drop(el)();
        }),
      );
    }

    // The pile shows the card a flight will cover until it lands (UX-30), or the column does.
    const lands = column.length ? end : times.get("discard")?.end;
    if (pile && lands && before.discardTop !== null && !moves.some((m) => m.from === "discard")) {
      const under = keep(standIn(before.discardTop, pile, { under: true }));
      if (column.length) made.push(under);
      const options = { duration: lands, id: FLIGHT };
      const done = column.length ? undefined : drop(under);
      jobs.push({ el: under, keyframes: [{ opacity: 1 }, { opacity: 1 }], options, done });
    }
    // Added to, so an update that moves nothing (ended nothing) keeps the last change's.
    const started = start(jobs);
    lingering.current.push(
      ...started.filter((_, i) => jobs[i].el.dataset.copy !== undefined || jobs[i].role === "hide"),
    );
    measureAgain.current(); // and again once they land
  }, [view, reduced, tapped]);

  useLayoutEffect(() => {
    if (!pending || reduced) return;
    endStandIns.current(); // the card you tapped shows, lifted, where it lies
    rects.current = measure(els.current, rects.current);
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
    // Stand-ins are fixed to the page, so a scroll or a resize ends them first.
    const moved = () => {
      endStandIns.current();
      remeasure();
    };
    window.addEventListener("scroll", moved, true); // capture: .table scrolls, not the window
    window.addEventListener("resize", moved);
    measureAgain.current = remeasure;
    const left = copies.current;
    const end = endStandIns.current;
    return () => {
      end(); // no card stays hidden (reduced motion switched on mid-column)
      for (const el of left) el.remove();
      on = false;
      measureAgain.current = () => {};
      cancelAnimationFrame(frame);
      window.removeEventListener("load", settle);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
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
