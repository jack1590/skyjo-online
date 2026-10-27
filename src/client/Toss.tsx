// Throws (M21): a player throws a bomb, a beer, a donkey… at another, and the whole table sees it fly
// and land with a gag. Purely for fun: nothing here touches the game.
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { TOSS_ITEMS, type Toss, type TossItem } from "../protocol";
import { useI18n } from "./i18n";
import { play, type Sound } from "./sound";

/** How long an item flies; it lands, and makes its sound, after this. */
export const FLIGHT_MS = 650;
/** The gag after landing: the item squashes, bits fly out and a bubble says something. */
const GAG_MS = 900;
/** At most this many throws on screen; more are dropped, not queued. */
const MAX_FLYING = 3;
const THROWS_KEY = "skyjo:throws";

const SOUND: Record<TossItem, Sound> = {
  bomb: "boom",
  beer: "splat",
  donkey: "bray",
  tomato: "splat",
  slipper: "splat",
  kiss: "kiss",
};

/** The target's phone only. Unlike the turn buzz (40), the nudge (200) and the switch ([30, 60, 30]). */
const BUZZ: Record<TossItem, number[]> = {
  bomb: [60, 30, 140],
  beer: [40, 40, 40, 40],
  donkey: [30, 50, 30, 50, 90],
  tomato: [50],
  slipper: [25, 20, 60],
  kiss: [15, 30, 15],
};

/** What flies out on impact: sparks, foam, dust, juice, stars, hearts. */
const SPLASH: Record<TossItem, string> = {
  bomb: "#ffb02e",
  beer: "#f6d36b",
  donkey: "#c9b28f",
  tomato: "#e2412f",
  slipper: "#7fd0f5",
  kiss: "#ff7aa8",
};
const DROPS = [0, 60, 120, 180, 240, 300].map((deg) => ({
  "--x": `${Math.round(Math.cos((deg * Math.PI) / 180) * 34)}px`,
  "--y": `${Math.round(Math.sin((deg * Math.PI) / 180) * 34)}px`,
}));

/** Original art, drawn for this game. */
export const ART: Record<TossItem, ReactNode> = {
  bomb: (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="18" cy="23" r="13" fill="#2b2d33" />
      <circle cx="13" cy="18" r="3.5" fill="#fff" opacity=".35" />
      <rect
        x="21"
        y="7"
        width="7"
        height="6"
        rx="1.5"
        transform="rotate(35 25 10)"
        fill="#555a63"
      />
      <path d="M28 8q3-5 7-3" stroke="#c8a165" strokeWidth="2" fill="none" />
      <circle cx="35" cy="5" r="3" fill="#ffb02e" />
      <circle cx="35" cy="5" r="1.5" fill="#fff4c2" />
    </svg>
  ),
  beer: (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <path d="M28 16h3a5 5 0 0 1 0 12h-3" stroke="#e8eef2" strokeWidth="3.5" fill="none" />
      <rect x="8" y="12" width="21" height="25" rx="3" fill="#f2a516" />
      <rect x="11" y="18" width="3" height="15" rx="1.5" fill="#ffd36b" />
      <circle cx="11" cy="11" r="5" fill="#fff" />
      <circle cx="18" cy="9" r="6" fill="#fff" />
      <circle cx="25" cy="11" r="5" fill="#fff" />
    </svg>
  ),
  donkey: (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <path d="M10 2l6 15-7 2z" fill="#8a8f98" />
      <path d="M28 2l-4 15 7 1z" fill="#8a8f98" />
      <path d="M11.5 5l3.5 10-3 1z" fill="#e7b7c0" />
      <path d="M26.5 5l-2.5 10 3 .5z" fill="#e7b7c0" />
      <ellipse cx="20" cy="22" rx="10" ry="9" fill="#9aa0a8" />
      <ellipse cx="20" cy="31" rx="9" ry="7" fill="#e9e4da" />
      <path d="M14 14q6-4 12 0" stroke="#4b4f56" strokeWidth="3" fill="none" />
      <circle cx="15.5" cy="20" r="2" fill="#1d1f24" />
      <circle cx="24.5" cy="20" r="2" fill="#1d1f24" />
      <circle cx="16.5" cy="30" r="1.3" fill="#5b5249" />
      <circle cx="23.5" cy="30" r="1.3" fill="#5b5249" />
      <rect
        x="17"
        y="34"
        width="6"
        height="3"
        rx="1"
        fill="#fff"
        stroke="#5b5249"
        strokeWidth=".8"
      />
    </svg>
  ),
  tomato: (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="23" r="14" fill="#e2412f" />
      <circle cx="14" cy="18" r="3.5" fill="#fff" opacity=".35" />
      <path d="M20 10l-6-2 4 4-5 2h6l1 4 1-4h6l-5-2 4-4z" fill="#3e9b3a" />
    </svg>
  ),
  slipper: (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <ellipse cx="20" cy="21" rx="10" ry="17" fill="#2c9cdb" transform="rotate(-20 20 21)" />
      <ellipse cx="20" cy="21" rx="7.5" ry="14" fill="#7fd0f5" transform="rotate(-20 20 21)" />
      <path
        d="M15 25L19 12l9 9"
        stroke="#f25c7a"
        strokeWidth="3.5"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="19" cy="12" r="2.2" fill="#f25c7a" />
    </svg>
  ),
  kiss: (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <path d="M4 20q7-10 12-8 4 2 4 2t4-2q5-2 12 8-6 10-16 10T4 20z" fill="#e8336b" />
      <path d="M4 20q16 4 32 0" stroke="#a51c48" strokeWidth="2" fill="none" />
      <ellipse cx="13" cy="16" rx="3" ry="1.5" fill="#fff" opacity=".4" />
    </svg>
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

/** A point on screen a throw flies from or to, and the element that shakes when hit. */
export interface Spot {
  x: number;
  y: number;
  el: HTMLElement;
}

interface Flying {
  key: string;
  toss: Toss;
  from: Spot;
  to: Spot;
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
}

/** Every throw in the air, over the table. Taps go through them. */
export function Tosses({ toss, on, you, warned, reduced, spot }: TossesProps) {
  const [flying, setFlying] = useState<Flying[]>([]);
  const last = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new throw is the trigger
  useEffect(() => {
    const key = toss && `${toss.id}-${toss.from}`;
    if (!toss || !key || key === last.current) return;
    last.current = key;
    const to = spot(toss.to);
    if (!on || !to) return;
    const from = spot(toss.from) ?? to;
    // One at a time per target, and a few at most: a pile-up would hide the table.
    setFlying((f) =>
      f.length >= MAX_FLYING || f.some((x) => x.toss.to === toss.to)
        ? f
        : [...f, { key, toss, from, to }],
    );
    const lands = reduced ? 0 : FLIGHT_MS;
    play(SOUND[toss.item], lands);
    if (toss.to === you && !warned && navigator.userActivation?.hasBeenActive) {
      setTimeout(() => navigator.vibrate?.(BUZZ[toss.item]), lands);
    }
  }, [toss]);
  return flying.map((f) => (
    <Flight
      key={f.key}
      toss={f.toss}
      from={f.from}
      to={f.to}
      reduced={reduced}
      onDone={() => setFlying((all) => all.filter((x) => x !== f))}
    />
  ));
}

interface FlightProps extends Omit<Flying, "key"> {
  reduced: boolean;
  onDone: () => void;
}

function Flight({ toss, from, to, reduced, onDone }: FlightProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLSpanElement>(null);
  const [landed, setLanded] = useState(reduced);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per throw
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || reduced) return;
    const dx = from.x - to.x;
    const dy = from.y - to.y;
    const lift = Math.min(90, Math.hypot(dx, dy) / 4 + 30);
    const donkey = toss.item === "donkey";
    // An arc with a spin; the donkey hops over instead, upright.
    const frames = Array.from({ length: 13 }, (_, i) => {
      const p = i / 12;
      const up = donkey ? Math.abs(Math.sin(3 * Math.PI * p)) * 36 : 4 * p * (1 - p) * lift;
      const turn = donkey ? 0 : 1.5 * p;
      return {
        transform: `translate(${dx * (1 - p)}px, ${dy * (1 - p) - up}px) rotate(${turn}turn)`,
      };
    });
    const flight = el.animate(frames, { duration: FLIGHT_MS, easing: "linear" });
    flight.onfinish = () => {
      setLanded(true);
      to.el.animate(
        [
          { transform: "none" },
          { transform: "translateX(-4px) rotate(-2deg)" },
          { transform: "translateX(4px) rotate(2deg)" },
          { transform: "none" },
        ],
        { duration: 300 },
      );
    };
    return () => flight.cancel();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: counts from the landing
  useEffect(() => {
    if (!landed) return;
    const id = setTimeout(onDone, GAG_MS);
    return () => clearTimeout(id);
  }, [landed]);
  return (
    <span
      ref={ref}
      className={`toss${landed ? " landed" : ""}`}
      data-item={toss.item}
      data-testid="toss"
      aria-hidden="true"
      style={{ left: to.x, top: to.y, "--splash": SPLASH[toss.item] } as CSSProperties}
    >
      {ART[toss.item]}
      {landed &&
        DROPS.map((d) => (
          <span key={d["--x"] + d["--y"]} className="drop" style={d as CSSProperties} />
        ))}
      {landed && <span className="gag">{t(`gag_${toss.item}`)}</span>}
    </span>
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
              {ART[item]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
