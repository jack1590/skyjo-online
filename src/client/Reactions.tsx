// Reactions (M23): laugh, love and anger pop on the reactor's own seat; the migajero's pigeon flies
// to the last mover with a sign. Purely for fun, like the throws: nothing here touches the game.
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { REACTIONS, type Reaction, type ReactionKind } from "../protocol";
import crumbs from "./art/mark-crumbs.webp";
import heart from "./art/mark-heart.webp";
import steam from "./art/mark-steam.webp";
import tear from "./art/mark-tear.webp";
import angerFace from "./art/react-anger.webp";
import laughFace from "./art/react-laugh.webp";
import loveFace from "./art/react-love.webp";
import pigeon from "./art/react-pigeon.webp";
import { useI18n } from "./i18n";
import { play } from "./sound";
import { buzzAt, flight, follow, type Spot, useResting, WIND, windUp } from "./Toss";

/** Everything is gone by then, under the 3 s cooldown, so a seat never stacks its own reactions. */
export const END_REACT = 2700;
/** The migajero's sign hangs on a little longer. */
const END_MIGAJERO = 2800;
/** The pigeon lands (its flight is WIND + 700 ms). */
export const LAND = 820;
/** coo.mp3's first coo, ms into the file: it starts this much before the landing. */
const COO_ONSET = 40;
/** The fan: each item's angle from the button, and how far out (px). */
const FAN = [90, 120, 150, 180];
const REACH = 104;

const FACE: Record<ReactionKind, string> = {
  laugh: laughFace,
  love: loveFace,
  anger: angerFace,
  migajero: pigeon,
};

interface Shown {
  key: string;
  reaction: Reaction;
  at: Spot;
  from: Spot | null;
}

interface ReactionsProps {
  reaction: Reaction | undefined;
  on: boolean;
  /** Your seat (out players included). */
  you: number | null;
  /** Your clock is in its last 10 s: no buzz then. */
  warned: boolean;
  reduced: boolean;
  spot: (seat: number) => Spot | null;
  names: string[];
}

/** Every reaction on screen, over the table. Taps go through them. */
export function Reactions({ reaction, on, you, warned, reduced, spot, names }: ReactionsProps) {
  const { t } = useI18n();
  // The ref is the truth (reactions can arrive faster than renders); the state draws it.
  const live = useRef<Shown[]>([]);
  const [shown, setShown] = useState<Shown[]>([]);
  const set = (all: Shown[]) => {
    live.current = all;
    setShown(all);
  };
  const [said, setSaid] = useState("");
  const last = useRef<string | null>(null);
  const buzz = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(buzz.current), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reaction is the trigger
  useEffect(() => {
    const key = reaction && `${reaction.id}-${reaction.from}`;
    if (!reaction || !key || key === last.current) return;
    last.current = key;
    const { kind, from, to } = reaction;
    const at = spot(to ?? from);
    if (!on || !at) return;
    // One migajero per target: someone else's second is dropped, sound and buzz too; yours takes
    // the place of the one there.
    const there = (s: Shown) => s.reaction.kind === "migajero" && s.reaction.to === to;
    if (kind === "migajero" && from !== you && live.current.some(there)) return;
    const next = { key, reaction, at, from: to === undefined ? null : spot(from) };
    // One per seat too: its next can only come after this one is gone (the cooldown).
    set([
      ...live.current.filter((s) => s.reaction.from !== from && !(kind === "migajero" && there(s))),
      next,
    ]);
    if (kind === "laugh") play("giggle");
    else if (kind === "love") play("sigh");
    else if (kind === "anger") play("grumble");
    else {
      if (!reduced) play("flap");
      play("coo", reduced ? 0 : LAND - COO_ONSET);
      play("flap", END_REACT - 400);
    }
    if (from === you) return;
    const name = names[from] ?? "";
    setSaid(t(`said_${kind}`, { name, to: names[to ?? -1] ?? "" }));
    if (kind === "migajero" && to === you) {
      buzz.current = buzzAt([15, 60, 15], reduced ? 0 : LAND, warned) ?? buzz.current;
    }
  }, [reaction]);
  return (
    <>
      {shown.map((s) => (
        <Pop
          key={s.key}
          shown={s}
          you={you}
          reduced={reduced}
          spot={spot}
          name={names[s.reaction.from] ?? ""}
          onDone={() => set(live.current.filter((x) => x.key !== s.key))}
        />
      ))}
      <span className="sr-only" role="status">
        {said}
      </span>
    </>
  );
}

/** The panel's little bounce (added on top of whatever it's doing), at each of `at` (ms). */
const bounce = (el: HTMLElement, dy: number, at: number[]) =>
  at.map((delay) =>
    el.animate(
      [{ transform: "none" }, { transform: `translateY(${dy}px)` }, { transform: "none" }],
      { duration: 180, delay, easing: "ease-out", composite: "add", id: "react-bounce" },
    ),
  );

/** Whether a seat's point is off its panel head: the panel is clamped to the strip's edge. */
const offHead = (s: Spot) => {
  const head = (s.panel.querySelector(".opp-head") ?? s.el).getBoundingClientRect();
  return Math.abs(head.left + head.width / 2 - s.x) > 2;
};

interface PopProps {
  shown: Shown;
  you: number | null;
  reduced: boolean;
  spot: (seat: number) => Spot | null;
  name: string;
  onDone: () => void;
}

function Pop({ shown, you, reduced, spot, name, onDone }: PopProps) {
  const { t } = useI18n();
  const { reaction, at, from } = shown;
  const { kind } = reaction;
  const box = useRef<HTMLSpanElement>(null);
  const fly = useRef<HTMLSpanElement>(null);
  const migajero = kind === "migajero";
  // Just under an opponent's panel head, so their name still says who; on your own seat, a little
  // above your name.
  const opp = at.panel.querySelector(".opp-head") !== null;
  const mine = !migajero && reaction.from === you;
  const x = at.x;
  const y = at.y + (opp ? 28 : mine ? -24 : 0);
  const dx = from ? from.x - x : 0;
  const dy = from ? from.y - y : 0;
  const face = dx <= 0 ? 1 : -1;
  // Near the top of the screen, the bubble and the sign go under the sticker.
  const below = y < 120;
  // A panel scrolled out of the strip gets its reaction at the strip's edge: then the bubble says who.
  const [named, setNamed] = useState(() => offHead(at));
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per reaction
  useLayoutEffect(() => {
    const done = setTimeout(onDone, migajero ? END_MIGAJERO : END_REACT);
    // The bubble and the sign stay on screen.
    const keepOnScreen = (cx: number) => {
      for (const el of box.current?.querySelectorAll<HTMLElement>(".react-gag, .react-sign") ??
        []) {
        const w = el.offsetWidth;
        const left = cx - w / 2;
        const shift = Math.min(Math.max(left, 8), window.innerWidth - 8 - w) - left;
        el.style.marginLeft = `${Math.round(shift)}px`;
      }
    };
    keepOnScreen(x);
    // The strip scrolls to follow the turn, maybe under a reaction: it moves with its seat, and
    // names the reactor only while their panel is out of view.
    const stop = follow(
      box.current,
      () => spot(reaction.to ?? reaction.from),
      at,
      (now) => {
        keepOnScreen(now.x);
        setNamed(offHead(now));
      },
    );
    const anims: Animation[] = [];
    if (!reduced) {
      if (migajero && from && fly.current) {
        const plan = flight("pigeon", dx, dy, Math.min(from.y, y) - 40);
        anims.push(
          fly.current.animate(plan.frames, { duration: plan.land, easing: "linear", fill: "both" }),
        );
        if (from.el !== at.el) anims.push(windUp(from.el));
        anims.push(...bounce(at.panel, 3, [LAND]));
      }
      if (kind === "laugh") anims.push(...bounce(at.panel, -3, [0, 400]));
      if (kind === "anger") anims.push(...bounce(at.panel, 2, [250, 550]));
    }
    return () => {
      clearTimeout(done);
      stop();
      for (const a of anims) a.cancel();
    };
  }, []);
  return (
    <span
      ref={box}
      className={`react${below ? " below" : ""}`}
      data-kind={kind}
      data-testid="reaction"
      aria-hidden="true"
      style={{ left: x, top: y, "--face": face, "--wind": `${WIND}ms` } as CSSProperties}
    >
      <span className="react-body">
        {kind === "anger" && <i className="react-glow" />}
        <span className="react-fly" ref={fly}>
          <span className="react-art">
            <img className="react-face" src={FACE[kind]} alt="" />
          </span>
        </span>
        {!reduced && <span className="react-fx">{FX[kind]}</span>}
      </span>
      {migajero ? (
        <span className="react-sign" data-testid="migajero-sign">
          <b>{t("migajeroSign")}</b>
          <small>{t("reactedBy", { name })}</small>
        </span>
      ) : (
        <b className="react-gag">
          {named ? t("reactionFrom", { name, gag: t(`gag_${kind}`) }) : t(`gag_${kind}`)}
        </b>
      )}
    </span>
  );
}

const at = (x: number, y: number, d: number) =>
  ({ "--x": `${x}px`, "--y": `${y}px`, "--d": `${d}ms` }) as CSSProperties;

/** What springs off each sticker: tears, hearts, steam, crumbs. Timed by --d (ms from the start). */
const FX: Record<ReactionKind, ReactNode> = {
  laugh: [300, 800].flatMap((d) =>
    [-1, 1].map((side) => (
      <img key={`${d}${side}`} className="tear" src={tear} alt="" style={at(28 * side, 20, d)} />
    )),
  ),
  love: [-22, 0, 22].map((x, i) => (
    <img key={x} className="heart" src={heart} alt="" style={at(x, -50, 350 + i * 150)} />
  )),
  anger: [250, 650].flatMap((d) =>
    [-1, 1].map((side) => (
      <img
        key={`${d}${side}`}
        className="steam"
        src={steam}
        alt=""
        style={{ ...at(44 * side, -30, d), "--x0": `${20 * side}px` } as CSSProperties}
      />
    )),
  ),
  migajero: [
    [-30, -6],
    [24, -14],
    [6, 22],
  ].map(([x, y]) => <img key={x} className="crumb" src={crumbs} alt="" style={at(x, y, LAND)} />),
};

interface ReactButtonProps {
  /** Beside your grid's third row, in your name bar (no room beside it), or in the corner (no grid). */
  place: "side" | "bar" | "corner";
  /** Reacting is allowed again at this time (ms), after your last throw or reaction. */
  until: number;
  /** The migajero's target, or null when it's greyed out. */
  target: number | null;
  reduced: boolean;
  onReact: (kind: ReactionKind, to?: number) => void;
}

/** The round button and its fan of four reactions, around your right thumb. */
export function ReactButton({ place, until, target, reduced, onReact }: ReactButtonProps) {
  const { t } = useI18n();
  const resting = useResting(until);
  const button = useRef<HTMLButtonElement>(null);
  const fan = useRef<HTMLDivElement>(null);
  // Where the fan opens (the button's centre), or null when it's shut.
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const [closing, setClosing] = useState(false);
  const close = () => {
    if (!open || closing) return;
    if (reduced) setOpen(null);
    else setClosing(true);
  };
  useFanDismiss(open !== null && !closing, [button, fan], close, () => button.current?.focus());
  useEffect(() => {
    if (!closing) return;
    const id = setTimeout(
      () => {
        setOpen(null);
        setClosing(false);
      },
      120 + 3 * 20,
    );
    return () => clearTimeout(id);
  }, [closing]);
  // Resting while open (you just sent from another phone, or a throw): the fan goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resting is the trigger
  useEffect(() => {
    if (resting) close();
  }, [resting]);
  const toggle = () => {
    if (resting) return;
    if (open) return close();
    const r = button.current?.getBoundingClientRect();
    if (r) setOpen({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  };
  // In your name bar the fan opens down over your grid; elsewhere, up.
  const down = place === "bar";
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`react-btn ${place}`}
        data-testid="react-button"
        aria-label={t("reactions")}
        title={t("reactions")}
        aria-expanded={open !== null && !closing}
        // Not `disabled`: it keeps the focus after you pick a reaction.
        aria-disabled={resting || undefined}
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M8.2 14.2c1.9 2.2 5.7 2.2 7.6 0" />
          <circle className="eye" cx="9" cy="10" r="1.2" />
          <circle className="eye" cx="15" cy="10" r="1.2" />
        </svg>
        <span className="react-plus">{open && !closing ? "×" : "+"}</span>
      </button>
      {/* On <body>: an animation on the bar or the table (a throw's knock, a quake) would carry a
          fixed fan inside it away from your thumb. */}
      {open &&
        createPortal(
          <div
            ref={fan}
            className={`react-fan${closing ? " closing" : ""}`}
            data-testid="react-fan"
            style={{ left: open.x, top: open.y }}
          >
            {REACTIONS.map((kind, i) => {
              const angle = (FAN[i] * Math.PI) / 180;
              const off = kind === "migajero" && target === null;
              return (
                <button
                  key={kind}
                  type="button"
                  className="react-item"
                  data-kind={kind}
                  aria-label={t(`react_${kind}`)}
                  title={t(`react_${kind}`)}
                  disabled={off}
                  style={
                    {
                      "--x": `${Math.round(Math.cos(angle) * REACH)}px`,
                      "--y": `${Math.round(Math.sin(angle) * REACH) * (down ? 1 : -1)}px`,
                      "--i": i,
                      "--n": REACTIONS.length - 1 - i,
                    } as CSSProperties
                  }
                  onClick={() => {
                    onReact(kind, kind === "migajero" ? (target ?? undefined) : undefined);
                    navigator.vibrate?.(10);
                    setOpen(null);
                    setClosing(false);
                    button.current?.focus();
                  }}
                >
                  <img className="react-pick" src={FACE[kind]} alt="" />
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Closes the fan on Escape and on a tap anywhere outside it and its button. The tap still goes on
 * to whatever it hit (nothing is prevented), so a card tap on your turn is never lost. A scroll or
 * resize closes it too: it was placed where the button was when it opened.
 */
function useFanDismiss(
  on: boolean,
  inside: RefObject<HTMLElement | null>[],
  close: () => void,
  refocus: () => void,
) {
  const latest = useRef({ close, refocus });
  latest.current = { close, refocus };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are stable
  useEffect(() => {
    if (!on) return;
    const down = (e: PointerEvent) => {
      if (!inside.some((r) => r.current?.contains(e.target as Node))) latest.current.close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      latest.current.close();
      latest.current.refocus();
    };
    const moved = () => latest.current.close();
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [on]);
}
