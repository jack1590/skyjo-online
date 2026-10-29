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
import type { GameView } from "../engine/view";
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
import { buzzAt, flight, type Spot, useResting, WIND } from "./Toss";

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

/**
 * Who the migajero is at: the last mover, the nearest seat before `current` still in (R16), while
 * the next player's turn runs. None in the opening flip, at a round's first turn, or when it's you.
 */
export function lastMover(view: GameView, you: number | null): number | null {
  if ((view.phase !== "draw" && view.phase !== "place") || view.turn < 1) return null;
  const n = view.players.length;
  for (let i = 1; i < n; i++) {
    const seat = (view.current - i + n) % n;
    if (view.players[seat].out === null) return seat === you ? null : seat;
  }
  return null;
}

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
  const [shown, setShown] = useState<Shown[]>([]);
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
    // One per seat: its next can only come after this one is gone (the cooldown).
    setShown((all) => [
      ...all.filter((s) => s.reaction.from !== from),
      { key, reaction, at, from: to === undefined ? null : spot(from) },
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
          onDone={() => setShown((all) => all.filter((x) => x !== s))}
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
  // Over an opponent's panel head; on your own seat, a little above your name.
  const mine = !migajero && reaction.from === you;
  const x = at.x;
  const y = at.y - (mine ? 24 : 0);
  const dx = from ? from.x - x : 0;
  const dy = from ? from.y - y : 0;
  const face = dx <= 0 ? 1 : -1;
  // Near the top of the screen, the bubble and the sign go under the sticker.
  const below = y < 120;
  // A panel scrolled out of the strip gets its reaction at the strip's edge: then the bubble says who.
  const head = (at.panel.querySelector(".opp-head") ?? at.el).getBoundingClientRect();
  const named = Math.abs(head.left + head.width / 2 - at.x) > 2;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per reaction
  useLayoutEffect(() => {
    const done = setTimeout(onDone, migajero ? END_MIGAJERO : END_REACT);
    // The strip scrolls to follow the turn, maybe under a reaction: it moves with its seat.
    let raf = 0;
    const follow = () => {
      const now = spot(reaction.to ?? reaction.from);
      if (now && box.current) box.current.style.translate = `${now.x - at.x}px ${now.y - at.y}px`;
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    // The bubble and the sign stay on screen.
    for (const el of box.current?.querySelectorAll<HTMLElement>(".react-gag, .react-sign") ?? []) {
      const w = el.offsetWidth;
      const left = x - w / 2;
      const shift = Math.min(Math.max(left, 8), window.innerWidth - 8 - w) - left;
      el.style.marginLeft = `${Math.round(shift)}px`;
    }
    const anims: Animation[] = [];
    if (!reduced) {
      if (migajero && from && fly.current) {
        const plan = flight("pigeon", dx, dy, Math.min(from.y, y) - 40);
        anims.push(
          fly.current.animate(plan.frames, { duration: plan.land, easing: "linear", fill: "both" }),
        );
        if (from.el !== at.el) {
          anims.push(
            from.el.animate(
              [
                { transform: "none" },
                { transform: "scale(0.88)", offset: 0.5 },
                { transform: "scale(1.1)", offset: 0.8 },
                { transform: "none" },
              ],
              { duration: 240, easing: "ease-out", composite: "add" },
            ),
          );
        }
        anims.push(...bounce(at.panel, 3, [LAND]));
      }
      if (kind === "laugh") anims.push(...bounce(at.panel, -3, [0, 400]));
      if (kind === "anger") anims.push(...bounce(at.panel, 2, [250, 550]));
    }
    return () => {
      clearTimeout(done);
      cancelAnimationFrame(raf);
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
        disabled={resting}
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
      {open && (
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
                }}
              >
                <img className="react-pick" src={FACE[kind]} alt="" />
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * Closes the fan on Escape and on a tap anywhere outside it and its button. The tap still goes on
 * to whatever it hit (nothing is prevented), so a card tap on your turn is never lost.
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
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
    };
  }, [on]);
}
