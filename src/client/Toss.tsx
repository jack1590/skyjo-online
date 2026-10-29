// Throws (M21, M22): a player throws a bomb, a beer, a donkey… at another, and the whole table sees
// it wind up, fly, hit and leave its mark. Purely for fun: nothing here touches the game.
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { TOSS_ITEMS, type Toss, type TossItem } from "../protocol";
import foam from "./art/mark-foam.webp";
import heart from "./art/mark-heart.webp";
import hoof from "./art/mark-hoof.webp";
import soot from "./art/mark-soot.webp";
import splat from "./art/mark-splat.webp";
import stars from "./art/mark-stars.webp";
import beer from "./art/toss-beer.webp";
import bomb from "./art/toss-bomb.webp";
import donkey from "./art/toss-donkey.webp";
import kiss from "./art/toss-kiss.webp";
import slipper from "./art/toss-slipper.webp";
import tomato from "./art/toss-tomato.webp";
import { useI18n } from "./i18n";
import { PEAK, play, type Sound } from "./sound";

/** The wind-up at the thrower's name before the item leaves (ms). */
export const WIND = 120;
/** Every throw's marks start fading at FADE and are gone at END, whatever the item. */
export const FADE = 2600;
export const END = 3000;
/** At most this many throws land on one player at once, and this many on screen. */
const PER_TARGET = 3;
const MAX_FLYING = 6;
/** The target's phone buzzes at most this often, so a dogpile is one buzz, not three. */
const BUZZ_GAP = 600;
/** Where each of a target's throws lands, a little apart (px), and how its mark is turned. */
const SLOT = [
  [0, 0],
  [-26, 4],
  [26, -4],
] as const;
const TILT = [-6, 10, -14];
const THROWS_KEY = "skyjo:throws";

const ITEM: Record<TossItem, string> = { bomb, beer, donkey, tomato, slipper, kiss };

const HIT: Record<TossItem, Sound> = {
  bomb: "boom",
  beer: "beer",
  donkey: "donkey",
  tomato: "tomato",
  slipper: "slipper",
  kiss: "kiss",
};

/** The target's phone only. Unlike the turn buzz (40), the nudge (200) and the switch ([30, 60, 30]). */
const HIT_BUZZ: Record<TossItem, number[]> = {
  bomb: [30, 20, 180],
  beer: [40, 40, 40, 40],
  donkey: [20, 60, 20, 60, 110],
  tomato: [70],
  slipper: [15, 25, 50],
  kiss: [10, 40, 10],
};

/**
 * Each item's flight: how long (ms), the beat between landing and hitting (the bomb's fuse, the
 * donkey rearing back), how high it arcs for its distance, and how it covers the ground: an ease-in
 * dives into the target, which reads as weight. The donkey hops instead, the kiss sways.
 */
const PLAN: Record<
  TossItem,
  {
    fly: number;
    beat: number;
    arc: number;
    ease: (t: number) => number;
    hops?: number;
    sway?: number;
    trail?: number;
  }
> = {
  bomb: { fly: 620, beat: 220, arc: 0.45, ease: (t) => t ** 1.4, trail: 50 },
  beer: { fly: 600, beat: 100, arc: 0.4, ease: (t) => t ** 1.3, trail: 45 },
  tomato: { fly: 560, beat: 0, arc: 0.5, ease: (t) => t ** 1.5, trail: 40 },
  slipper: { fly: 420, beat: 0, arc: 0.18, ease: (t) => t, trail: 28 },
  kiss: { fly: 760, beat: 0, arc: 0.3, ease: (t) => 1 - (1 - t) ** 2, sway: 12, trail: 90 },
  donkey: { fly: 720, beat: 160, arc: 0, ease: (t) => t, hops: 3 },
};
const r = (v: number) => Math.round(v * 10) / 10 || 0;
const o = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * The item's path from the thrower (dx, dy px from where it lands) to the target: it crouches and
 * pops at the thrower's name, then flies, biggest at the top of its arc (nearer the camera).
 * `room` is how far above the higher end the arc may go before it leaves the screen.
 * `ghost` is the same path for the trail, unseen during the wind-up and on arrival.
 */
export function flight(item: TossItem, dx: number, dy: number, room = Infinity) {
  const p = PLAN[item];
  const lift = Math.max(24, Math.min(160, Math.max(48, p.arc * Math.hypot(dx, dy)), room));
  const total = WIND + p.fly;
  const at = (x: number, y: number, s: string) => `translate(${r(x)}px, ${r(y)}px) scale(${s})`;
  const frames: Keyframe[] = [
    { offset: 0, transform: at(dx, dy, "0") },
    { offset: o(70 / total), transform: at(dx, dy + 4, "0.75, 0.6") },
    { offset: o(WIND / total), transform: at(dx, dy, "1.1") },
  ];
  for (let i = 1; i <= 20; i++) {
    const t = i / 20;
    const k = p.ease(t);
    const up = p.hops ? Math.abs(Math.sin(p.hops * Math.PI * t)) * 34 : 4 * t * (1 - t) * lift;
    const side = p.sway ? Math.sin(2 * Math.PI * t) * p.sway * (1 - t) : 0;
    const s = p.hops ? 1 : 1 + 0.6 * t * (1 - t);
    frames.push({
      offset: o((WIND + t * p.fly) / total),
      transform: at(dx * (1 - k) + side, dy * (1 - k) - up, `${r(s)}`),
    });
  }
  const ghost = (opacity: number) =>
    frames.map((f, i) => ({ ...f, opacity: i < 3 || i === frames.length - 1 ? 0 : opacity }));
  return { frames, ghost, fly: p.fly, land: total, hit: total + p.beat, trail: p.trail ?? 0 };
}

/** How the target's panel takes the hit (added on top of whatever it's doing). */
const KNOCK: Record<TossItem, (face: number) => string[]> = {
  bomb: () => [
    "none",
    "translate(-4px, 2px) rotate(-2deg)",
    "translate(4px, -2px) rotate(2deg)",
    "translate(-3px, 1px) rotate(-1deg)",
    "translate(2px, 0)",
    "none",
  ],
  beer: () => ["none", "rotate(-3deg)", "rotate(2deg)", "none"],
  tomato: () => ["none", "scale(1.05, 0.94)", "scale(0.98, 1.03)", "none"],
  slipper: () => ["none", "translateY(5px) rotate(3deg)", "translateY(-2px) rotate(-1deg)", "none"],
  kiss: () => ["none", "scale(1.06)", "none"],
  donkey: (f) => [
    "none",
    `translateX(${10 * f}px) rotate(${3 * f}deg)`,
    `translateX(${-4 * f}px)`,
    "none",
  ],
};
const KNOCK_MS: Record<TossItem, number> = {
  bomb: 300,
  beer: 300,
  tomato: 260,
  slipper: 320,
  kiss: 300,
  donkey: 340,
};
const QUAKE = [
  "none",
  "translate(-3px, 2px)",
  "translate(3px, -2px)",
  "translate(-2px, -1px)",
  "translate(2px, 1px)",
  "none",
];

/** What trails the item: smoke, foam, juice, afterimages, hearts. The donkey leaves dust instead. */
const GHOST: Partial<Record<TossItem, ReactNode>> = {
  bomb: <img src={soot} alt="" />,
  beer: <i />,
  tomato: <i />,
  slipper: <img src={slipper} alt="" />,
  kiss: <img src={heart} alt="" />,
};

/** Bits that fly out on impact, px from it: up and out, so they clear your cards. */
const BITS = [
  [-36, -18],
  [-20, -36],
  [4, -40],
  [26, -30],
  [38, -6],
];
const bits = (colours: string[]) =>
  BITS.map(([x, y], i) => (
    <i
      key={`${x},${y}`}
      className="bit"
      style={
        { "--x": `${x}px`, "--y": `${y}px`, "--c": colours[i % colours.length] } as CSSProperties
      }
    />
  ));
const PUFFS = [
  [-34, -30],
  [0, -44],
  [34, -26],
];

/** The flash, ring and bits at the point of impact. */
function burst(item: TossItem, dx: number, dy: number, fly: number): ReactNode {
  switch (item) {
    case "bomb":
      return (
        <>
          <i className="flash" />
          <i className="shock" />
          {PUFFS.map(([x, y]) => (
            <img
              key={x}
              className="puff"
              src={soot}
              alt=""
              style={{ "--x": `${x}px`, "--y": `${y}px` } as CSSProperties}
            />
          ))}
        </>
      );
    case "beer":
      return bits(["#fff6d8", "#f6d36b"]);
    case "tomato":
      return bits(["#e2412f", "#e2412f", "#ffe9a8"]);
    case "slipper":
      return <i className="shock" style={{ "--c": "#fff" } as CSSProperties} />;
    case "kiss":
      return <i className="shock" style={{ "--c": "#ff7aa8" } as CSSProperties} />;
    case "donkey":
      // A puff of dust where each hop touches down, then dust at the headbutt.
      return (
        <>
          {[1 / 3, 2 / 3].map((t) => (
            <i
              key={t}
              className="dust"
              style={
                {
                  "--x": `${r(dx * (1 - t))}px`,
                  "--y": `${r(dy * (1 - t) + 24)}px`,
                  "--at": `${Math.round(WIND + t * fly)}ms`,
                } as CSSProperties
              }
            />
          ))}
          {bits(["#d9c7a5"])}
        </>
      );
  }
}

/** The mark left on the target's panel: soot, foam, a splat, dizzy stars, a kiss, hoof prints. */
const MARK: Record<TossItem, ReactNode> = {
  bomb: (
    <>
      <img className="soot" src={soot} alt="" />
      <i className="wisp" />
      <i className="wisp" />
    </>
  ),
  beer: (
    <>
      <img className="foam" src={foam} alt="" />
      <i className="bub" />
      <i className="bub" />
      <i className="bub" />
    </>
  ),
  tomato: <img className="splat" src={splat} alt="" />,
  slipper: (
    <span className="orbit">
      <img className="stars" src={stars} alt="" />
    </span>
  ),
  kiss: (
    <>
      <i className="blush" />
      <img className="lips" src={kiss} alt="" />
      {[-18, 0, 18].map((x, i) => (
        <img
          key={x}
          className="heart"
          src={heart}
          alt=""
          style={{ "--x": `${x}px`, "--d": `${i * 150}ms` } as CSSProperties}
        />
      ))}
    </>
  ),
  donkey: (
    <>
      <img className="hoof" src={hoof} alt="" />
      <img className="hoof" src={hoof} alt="" />
    </>
  ),
};

/** The "Throws" switch, remembered across visits: off, you neither see nor hear throws, nor throw. */
export function useThrowsOn(): [boolean, () => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(THROWS_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOn(!on);
    try {
      localStorage.setItem(THROWS_KEY, on ? "0" : "1");
    } catch {
      // Not remembered next visit; still applies now.
    }
  };
  return [on, toggle];
}

/**
 * Where a seat's throws fly from and land (x, y on screen), the name that winds up for a throw
 * (`el`), and the panel that takes the hit and holds the mark, at (px, py) inside it.
 */
export interface Spot {
  x: number;
  y: number;
  el: HTMLElement;
  /** Takes the hit (the knock). */
  panel: HTMLElement;
  /** Holds the mark, clipped to it; (px, py) is the landing point inside it. */
  mark: HTMLElement;
  px: number;
  py: number;
}

interface Flying {
  key: string;
  toss: Toss;
  from: Spot;
  to: Spot;
  slot: number;
}

interface TossesProps {
  toss: Toss | undefined;
  on: boolean;
  /** Your seat (out players included), whose phone vibrates when hit. */
  you: number | null;
  /** Your clock is in its last 10 s: no buzz then, so the nudge stays the only one. */
  warned: boolean;
  reduced: boolean;
  spot: (seat: number) => Spot | null;
  /** Seat names, for the line a screen reader hears when you're hit. */
  names: string[];
}

/** Every throw in the air, over the table. Taps go through them. */
export function Tosses({ toss, on, you, warned, reduced, spot, names }: TossesProps) {
  const { t } = useI18n();
  // The ref is the truth (throws can arrive faster than renders); the state draws it.
  const live = useRef<Flying[]>([]);
  const [flying, setFlying] = useState<Flying[]>([]);
  const [said, setSaid] = useState("");
  const last = useRef<string | null>(null);
  const buzzed = useRef(-Infinity);
  // A buzz still on its way when the throws leave the screen (the summary, leaving) is called off.
  const buzz = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(buzz.current), []);
  const set = (all: Flying[]) => {
    live.current = all;
    setFlying(all);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new throw is the trigger
  useEffect(() => {
    const key = toss && `${toss.id}-${toss.from}`;
    if (!toss || !key || key === last.current) return;
    last.current = key;
    const to = spot(toss.to);
    if (!on || !to) return;
    const from = spot(toss.from) ?? to;
    // A few per target and on screen: a pile-up would hide the table. Someone else's extra throw
    // is dropped, sound and buzz too, so nobody can be spammed; yours always lands on your phone,
    // in place of the oldest that isn't yours.
    let all = live.current;
    const at = () => all.filter((f) => f.toss.to === toss.to);
    if (at().length >= PER_TARGET || all.length >= MAX_FLYING) {
      if (toss.from !== you) return;
      const pool = at().length >= PER_TARGET ? at() : all;
      const victim = pool.find((f) => f.toss.from !== you);
      if (!victim) return;
      all = all.filter((f) => f !== victim);
    }
    const slot = [0, 1, 2].find((s) => !at().some((f) => f.slot === s)) ?? 0;
    set([...all, { key, toss, from, to, slot }]);
    const plan = flight(toss.item, 0, 0);
    const hit = reduced ? 0 : plan.hit;
    if (!reduced) {
      play("whoosh", WIND - (PEAK.whoosh ?? 0));
      if (toss.item === "bomb") play("fuse", plan.land);
    }
    play(HIT[toss.item], Math.max(0, hit - (PEAK[HIT[toss.item]] ?? 0)));
    if (toss.to !== you) return;
    setSaid(t("tossedYou", { name: names[toss.from] ?? "", item: t(`item_${toss.item}`) }));
    const buzzAt = performance.now() + hit;
    if (!warned && navigator.userActivation?.hasBeenActive && buzzAt - buzzed.current >= BUZZ_GAP) {
      buzzed.current = buzzAt;
      buzz.current = setTimeout(() => navigator.vibrate?.(HIT_BUZZ[toss.item]), hit);
    }
  }, [toss]);
  const air = flying.map((f) => (
    <Flight
      key={f.key}
      flying={f}
      reduced={reduced}
      quake={f.toss.item === "bomb" && f.toss.to === you}
      spot={spot}
      onDone={() => set(live.current.filter((x) => x !== f))}
    />
  ));
  return (
    <>
      {air}
      <span className="sr-only" role="status">
        {said}
      </span>
    </>
  );
}

interface FlightProps {
  flying: Flying;
  reduced: boolean;
  /** A bomb at you: the whole table shakes. */
  quake: boolean;
  spot: (seat: number) => Spot | null;
  onDone: () => void;
}

function Flight({ flying, reduced, quake, spot, onDone }: FlightProps) {
  const { t } = useI18n();
  const { toss, from, to, slot } = flying;
  const { item } = toss;
  const box = useRef<HTMLSpanElement>(null);
  const fly = useRef<HTMLSpanElement>(null);
  const ghosts = useRef<(HTMLSpanElement | null)[]>([]);
  const [sx, sy] = SLOT[slot];
  const dx = from.x - (to.x + sx);
  const dy = from.y - (to.y + sy);
  const [plan] = useState(() => flight(item, dx, dy, Math.min(from.y, to.y + sy) - 16));
  const land = reduced ? 0 : plan.land;
  const hit = reduced ? 0 : plan.hit;
  const face = dx <= 0 ? 1 : -1;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per throw
  useLayoutEffect(() => {
    const done = setTimeout(onDone, END);
    // The strip scrolls to follow the turn, maybe under a throw: it moves with its target. `translate`
    // adds to the flight's transforms. ponytail: the launch point moves too, so a throw in the air
    // while the strip scrolls starts a little off its thrower; re-aim the arc if anyone notices.
    let raf = 0;
    const follow = () => {
      const now = spot(toss.to);
      if (now && box.current) box.current.style.translate = `${now.x - to.x}px ${now.y - to.y}px`;
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    const anims: Animation[] = [];
    if (!reduced) {
      const total = plan.land;
      const linear = { duration: total, easing: "linear" } as const;
      if (fly.current)
        anims.push(fly.current.animate(plan.frames, { ...linear, fill: "forwards" }));
      ghosts.current.forEach((g, i) => {
        const opacity = 0.5 - 0.12 * (i + 1);
        if (g)
          anims.push(
            g.animate(plan.ghost(opacity), {
              ...linear,
              delay: (i + 1) * plan.trail,
              fill: "both",
            }),
          );
      });
      const add = { composite: "add" } as const;
      const frames = (all: string[]) => all.map((transform) => ({ transform }));
      if (from !== to) {
        anims.push(
          from.el.animate(
            [
              { transform: "none" },
              { transform: "scale(0.88)", offset: 0.5 },
              { transform: "scale(1.1)", offset: 0.8 },
              { transform: "none" },
            ],
            { duration: 240, easing: "ease-out", ...add },
          ),
        );
      }
      anims.push(
        to.panel.animate(frames(KNOCK[item](face)), {
          duration: KNOCK_MS[item],
          delay: hit,
          easing: "ease-out",
          id: "toss-knock",
          ...add,
        }),
      );
      const root = document.getElementById("root");
      if (quake && root) {
        anims.push(
          root.animate(frames(QUAKE), { duration: 250, delay: hit, id: "toss-quake", ...add }),
        );
      }
    }
    return () => {
      clearTimeout(done);
      cancelAnimationFrame(raf);
      for (const a of anims) a.cancel();
    };
  }, []);
  const vars = { "--land": `${land}ms`, "--hit": `${hit}ms`, "--fade": `${FADE}ms` };
  const edge = to.x < 70 ? "-15%" : to.x > window.innerWidth - 70 ? "-85%" : "-50%";
  return (
    <>
      <span
        ref={box}
        className="toss"
        data-item={item}
        data-testid="toss"
        aria-hidden="true"
        style={
          {
            left: to.x + sx,
            top: to.y + sy,
            "--fly": `${plan.fly}ms`,
            "--face": face,
            "--slot": slot,
            "--gx": edge,
            // A line higher for each throw already there, but never off the top of the screen.
            "--gy": `${Math.max(-48 - slot * 24, 14 - (to.y + sy))}px`,
            ...vars,
          } as CSSProperties
        }
      >
        {!reduced &&
          GHOST[item] &&
          [0, 1, 2].map((i) => (
            <span
              key={i}
              className="toss-ghost"
              ref={(el) => {
                ghosts.current[i] = el;
              }}
            >
              {GHOST[item]}
            </span>
          ))}
        <span className="toss-fly" ref={fly}>
          <span className="toss-art">
            <img src={ITEM[item]} alt="" />
          </span>
        </span>
        {!reduced && <span className="toss-fx">{burst(item, dx, dy, plan.fly)}</span>}
        <b className="toss-gag">{t(`gag_${item}`)}</b>
      </span>
      {createPortal(
        <span
          className="toss-decal"
          data-item={item}
          data-testid="toss-decal"
          aria-hidden="true"
          style={
            {
              "--dx": `${r(to.px + sx)}px`,
              "--dy": `${r(to.py + sy)}px`,
              "--tilt": `${TILT[slot]}deg`,
              ...vars,
            } as CSSProperties
          }
        >
          {MARK[item]}
        </span>,
        to.mark,
      )}
    </>
  );
}

interface TrayProps {
  name: string;
  on: boolean;
  onToggle: () => void;
  /** Throws are allowed again at this time (ms), after your last one. */
  until: number;
  onToss: (item: TossItem) => void;
}

/** In an opponent's sheet: what you can throw at them, and the switch for throws. */
export function Tray({ name, on, onToggle, until, onToss }: TrayProps) {
  const { t } = useI18n();
  const [, rerender] = useState(0);
  const wait = until - Date.now();
  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => rerender((n) => n + 1), wait);
    return () => clearTimeout(id);
  }, [wait]);
  return (
    <div className="tray" data-testid="tray">
      <div className="tray-head">
        <span>{on ? t("throwAt", { name }) : ""}</span>
        <label className="auto">
          {t("throws")}
          <span className="switch">
            <input type="checkbox" aria-label={t("throws")} checked={on} onChange={onToggle} />
          </span>
        </label>
      </div>
      {on && (
        <div className="tray-items">
          {TOSS_ITEMS.map((item) => (
            <button
              key={item}
              type="button"
              className="tray-item"
              aria-label={t(`item_${item}`)}
              title={t(`item_${item}`)}
              data-item={item}
              disabled={wait > 0}
              onClick={() => onToss(item)}
            >
              <img src={ITEM[item]} alt="" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
