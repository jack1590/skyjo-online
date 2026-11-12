// The first-game tutorial (M31): the script in lesson.ts on the real Table, with one coach bubble
// pointing at what to tap. No room, no network: the engine runs here, for this one scripted round.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Action } from "../engine/game";
import { toView } from "../engine/view";
import { useI18n } from "./i18n";
import { begin, next, play, RIVAL, STEPS, type Target, tap } from "./lesson";
import { useReducedMotion } from "./motion";
import { Table } from "./Table";

/** The rival's moves come this far apart, so each one's cards land before the next. */
const RIVAL_MS = 1100;
/** A ring stands this far (px) off its target, outside a tappable card's own outline. */
const RING = 6;
/** The bubble stands this far (px) off what it points at: its tail spans it. */
const GAP = 14;
const noop = () => undefined;

interface Props {
  /** The round was played to its summary, and "Continue" tapped. */
  onDone: () => void;
  /** Skipped, or left by the table's ✕. */
  onExit: () => void;
}

export function Tutorial({ onDone, onExit }: Props) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const [lesson, setLesson] = useState(() => begin(t("tutorMe")));
  // The same view object while the game stands still: the table tells a tap's answer by it.
  const view = useMemo(() => toView(lesson.state), [lesson.state]);
  const waiting = lesson.queue.length > 0;
  // Each move leaves a new queue, which starts the wait for the next one.
  useEffect(() => {
    if (!lesson.queue.length) return;
    const id = setTimeout(() => setLesson(play), reduced ? 150 : RIVAL_MS);
    return () => clearTimeout(id);
  }, [lesson.queue, reduced]);

  const onAction = (action: Action) => {
    // The summary's button: there is no next round.
    if (action.type === "nextRound") {
      onDone();
      return;
    }
    const after = tap(lesson, action);
    // Not what this step asks for: the table then does nothing, as for a tap that wasn't sent.
    if (!after) return null;
    setLesson(after);
  };
  const step = STEPS[lesson.step];
  return (
    <div className="tutorial" data-testid="tutorial" data-step={waiting ? "rival" : lesson.step}>
      <Table
        view={view}
        seat={0}
        lead
        onAction={onAction}
        onPlayAgain={noop}
        onExit={onExit}
        ending={{
          why: t("tutorDoubled", { other: RIVAL, n: view.players[0].total / 2 }),
          next: t("tutorContinue"),
        }}
      />
      {step && (
        <Coach
          say={waiting ? { say: "tutorRival" } : step}
          versus={step.say === "tutorLow"}
          onNext={waiting || step.taps ? undefined : () => setLesson(next)}
          onSkip={onExit}
        />
      )}
    </div>
  );
}

/** The table's element for a target. Its piles have no class of their own, only test ids. */
const find = (at: Target) =>
  document.querySelector<HTMLElement>(
    typeof at === "number"
      ? `.mine .grid > .card:nth-child(${at + 1})`
      : `.piles [data-testid="${at}"]`,
  );

interface CoachProps {
  say: Pick<(typeof STEPS)[number], "say" | "at" | "thrown">;
  /** The two targets are a good card and a bad one. */
  versus: boolean;
  /** Set on a step with nothing to tap. */
  onNext?: () => void;
  onSkip: () => void;
}

/**
 * The coach: one instruction in a bubble beside what it points at, and a ring on each target. Over
 * a card of yours (the script's targets have only face-down cards above them), under a pile (on
 * the table's own prompt, which the tutorial hides), or the other way with no room. With no target
 * it sits on that prompt's line, clear of the piles and the rival. Placed after every render and
 * every frame, like the throws (`follow`), so it stays on a card that is lifted or still landing.
 */
function Coach({ say, versus, onNext, onSkip }: CoachProps) {
  const { t } = useI18n();
  // The table's own mode, read from its grid: the drawn card lies thrown on the pile.
  const [thrown, setThrown] = useState(false);
  const now = (thrown && say.thrown) || say;
  const bubble = useRef<HTMLDivElement>(null);
  const rings = useRef<(HTMLElement | null)[]>([]);
  const place = () => {
    const el = bubble.current;
    if (!el) return;
    const rects = (now.at ?? []).map((target) => find(target)?.getBoundingClientRect());
    rings.current.forEach((ring, i) => {
      const r = rects[i];
      if (!ring) return;
      ring.style.display = r ? "block" : "";
      if (r) {
        ring.style.translate = `${r.left - RING}px ${r.top - RING}px`;
        ring.style.width = `${r.width + 2 * RING}px`;
        ring.style.height = `${r.height + 2 * RING}px`;
      }
    });
    const [w, h] = [el.offsetWidth, el.offsetHeight];
    const vw = document.documentElement.clientWidth;
    const r = rects[0];
    // The table's own prompt, hidden here: the line between the piles and your cards.
    const line = document.querySelector(".table > .prompt")?.getBoundingClientRect();
    if (!r) {
      const y = line ? line.top + (line.height - h) / 2 : window.innerHeight - h - 16;
      el.dataset.side = "none";
      el.style.translate = `${(vw - w) / 2}px ${y}px`;
      return;
    }
    const x = r.left + r.width / 2;
    const left = Math.max(8, Math.min(x - w / 2, vw - w - 8));
    // Under a pile means under its caption too.
    const [over, under] = [r.top - h - GAP, Math.max(r.bottom + GAP, line?.top ?? 0)];
    const above = typeof now.at?.[0] === "number" ? over >= 8 : under + h > window.innerHeight - 8;
    el.dataset.side = above ? "above" : "below";
    el.style.translate = `${left}px ${above ? over : under}px`;
    el.style.setProperty("--tail", `${x - left}px`);
  };
  // Before each render paints: a new instruction is never seen where the last one was.
  useLayoutEffect(place);
  const latest = useRef(place);
  latest.current = place;
  useEffect(() => {
    let frame = 0;
    const each = () => {
      frame = requestAnimationFrame(each);
      setThrown(document.querySelector(".mine .grid.discarding") !== null);
      latest.current();
    };
    each();
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <>
      {[0, 1].map((i) => (
        <span
          key={i}
          ref={(el) => {
            rings.current[i] = el;
          }}
          className={`coach-ring${versus ? (i ? " bad" : " good") : ""}`}
          aria-hidden="true"
        />
      ))}
      <div ref={bubble} className="coach" data-testid="coach">
        {/* One live region for the whole lesson, so a screen reader hears each instruction. */}
        <p role="status">{t(now.say, { name: RIVAL })}</p>
        <button type="button" className="coach-skip" onClick={onSkip}>
          {t("tutorSkip")}
        </button>
        {onNext && (
          <button type="button" className="btn primary" onClick={onNext}>
            {t("tutorNext")}
          </button>
        )}
      </div>
    </>
  );
}
