import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Action, places } from "../engine/game";
import type { GameView, PlayerView, ViewSlot } from "../engine/view";
import { TURN_MS, type Wait } from "../protocol";
import { Card } from "./Card";
import { type T, useI18n } from "./i18n";
import { slotKey, thrown, useCountUp, useFlights, useReducedMotion, useRevealing } from "./motion";
import { nudge, play, type Sound, useMuted, useSounds } from "./sound";

interface TableProps {
  view: GameView;
  /** Seat shown at the bottom; its taps become actions. Null = watching. */
  seat: number | null;
  /** May advance rounds and rematch: the host, or a stand-in while the host is away. */
  lead: boolean;
  /** Per seat, whether that player is connected. */
  connected?: boolean[];
  /** Per seat, whether Auto-play is on. */
  auto?: boolean[];
  /** The seats the table waits on whose clock runs (RoomView.clocks). */
  wait?: Wait[];
  /**
   * The seq of your message awaiting the server's answer (useRoom), if any. Unset in the harness,
   * which has no server: there a tap is answered by the next view.
   */
  waiting?: number | null;
  /** Sends a move: returns its seq, or null when it couldn't (the harness returns nothing). */
  onAction: (action: Action) => number | null | undefined;
  /** Ticks or unticks Auto-play for your own seat. */
  onAuto?: (on: boolean) => void;
  onPlayAgain: () => void;
  onExit: () => void;
}

const where = (t: T, pos: number) =>
  t("where", { row: Math.floor(pos / 4) + 1, col: (pos % 4) + 1 });
const upCount = (grid: ViewSlot[]) => grid.filter((slot) => typeof slot === "number").length;
/** Orange in a clock's last 10 s, red in its last 5. */
const hurry = (left: number | null) => (left === null ? "" : left <= 5 ? " danger" : " warn");
/** Out (R16) before this round: no cards and no turns. */
const isOut = (p: PlayerView | undefined, round: number) =>
  p !== undefined && p.out !== null && p.out < round;
/** This round's score, once the round is over; none for a player out before it (R16). */
const lastScore = (p: PlayerView, round: number) => (isOut(p, round) ? 0 : (p.scores.at(-1) ?? 0));

export function Table(props: TableProps) {
  const { view, onAction, onAuto, onPlayAgain, onExit, lead, connected, auto } = props;
  // A player who is out watches the rest of the game the way a spectator does.
  const seat = isOut(view.players[props.seat ?? -1], view.round) ? null : props.seat;
  const wait = props.wait ?? [];
  const { t } = useI18n();
  const { phase, players } = view;
  const summary = phase === "roundOver" || phase === "gameOver";
  const [discarding, setDiscarding] = useState(false);
  // Hides the summary sheet so players can look at the revealed grids.
  const [peek, setPeek] = useState(false);
  // The card you last tapped to turn over, so a final reveal turns it first (UX-27).
  const tapped = useRef<string | null>(null);
  // Local modes never outlive the turn or summary they started in (the server may move for us).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are triggers, not inputs
  useEffect(() => {
    setDiscarding(false);
    tapped.current = null;
  }, [view.round, view.current, phase]);
  useEffect(() => {
    if (!summary) setPeek(false);
  }, [summary]);

  const me = seat === null ? null : players[seat];
  const playing = phase === "draw" || phase === "place";
  // While Auto-play is on the server plays for you: it isn't your turn to tap.
  const myAuto = seat !== null && auto?.[seat] === true;
  const myTurn =
    me !== null &&
    !myAuto &&
    (phase === "flip" ? upCount(me.grid) < 2 : playing && view.current === seat);
  useEffect(() => {
    // Browsers block vibrate before the first tap on the page (e.g. right after a reload).
    if (myTurn && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(40);
  }, [myTurn]);
  const discardMode = discarding && myTurn && phase === "place" && view.drawnFrom === "deck";
  // Thrown away, the drawn card lies on the discard pile until you flip a card (UX-19).
  const shown = useMemo(() => (discardMode ? thrown(view) : view), [view, discardMode]);

  // The tap the server is answering (UX-3): its card stays lifted until the answer to its message,
  // and its sound, played at the tap, isn't played again with it (`heard`, which the answer uses up).
  const [tap, setTap] = useState<{ key: string; seq?: number; view: GameView } | null>(null);
  const pending =
    tap && (tap.seq === undefined ? tap.view === view : props.waiting === tap.seq) ? tap.key : null;
  const heard = useRef<Sound | null>(null);
  // Undo puts a fresh card on the pile: the one under the thrown card shows at once, straight, and
  // no throw still in flight carries it (UX-19).
  const [undos, setUndos] = useState(0);
  // Undo's button goes with it: a keyboard user's focus moves to the pile instead of dropping.
  const stack = useRef<HTMLSpanElement>(null);
  const refocus = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each Undo
  useEffect(() => {
    if (refocus.current) stack.current?.querySelector("button")?.focus();
    refocus.current = false;
  }, [undos]);

  const { reg, timing } = useFlights(shown, tapped, pending);
  const revealing = useRevealing(shown, timing);
  // While the final reveal plays, totals stay as they were, so the cards tell the result first;
  // the summary then counts them up (UX-27).
  const total = (p: PlayerView) => (revealing ? p.total - lastScore(p, view.round) : p.total);
  useSounds(shown, seat, timing, heard);
  const [muted, toggleMuted] = useMuted();
  // Tapping an opponent opens their grid full size; your own turn closes it.
  const [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => {
    if (myTurn) setZoom(null);
  }, [myTurn]);

  // On short screens the grid can be below the fold: bring it into view when your turn starts.
  const gridRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!myTurn) return;
    // Wait for layout to settle (fonts, the first paint) before deciding whether to scroll.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const grid = gridRef.current;
        const r = grid?.getBoundingClientRect();
        if (grid && r && (r.top < 0 || r.bottom > window.innerHeight)) {
          grid.scrollIntoView({ block: "end", behavior: reduced ? "auto" : "smooth" });
        }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [myTurn, reduced]);

  // Your own clock: a bar for the whole turn, then the seconds, a warning and a nudge.
  const own = wait.find((w) => w.seat === seat);
  const myClock = useClock(own?.reason === "timer" ? own.inMs : undefined);
  const turn = `${view.round}-${phase === "flip" ? "flip" : view.current}`;
  useEffect(() => nudge(own, myClock.left, turn), [own, myClock.left, turn]);
  const warned = myClock.left !== null;
  const [said, setSaid] = useState("");
  // Screen readers hear the warning once, not every second.
  // biome-ignore lint/correctness/useExhaustiveDependencies: announced when the warning starts
  useEffect(() => setSaid(warned ? t("secondsLeft", { s: myClock.left ?? 0 }) : ""), [warned]);
  // The first offline seat the table waits on, counting down to its auto-play.
  const offline = wait.find((w) => w.reason === "offline" && w.seat !== seat);
  const offlineLeft = useClock(offline?.inMs, TURN_MS / 1000).left;

  const away = useAway(myAuto);
  // Tapping your cards, the deck or the discard while Auto-play is on points at the switch, so no
  // tap is silently ignored.
  // Each tap alternates the shake's animation name, so it always restarts: re-adding the same
  // name in the frame the last shake ended starts nothing in Chromium.
  const [nudges, setNudges] = useState(0);
  const pointAtSwitch = () => {
    setNudges((n) => n + 1);
    navigator.vibrate?.([30, 60, 30]);
  };
  const releaseWakeLock = useWakeLock();
  const exit = () => {
    releaseWakeLock();
    onExit();
  };

  // Keep whoever is playing in view in the opponent strip, so their move is visible.
  const oppRefs = useRef(new Map<number, HTMLElement>());
  useEffect(() => {
    if (!playing || view.current === seat) return;
    oppRefs.current.get(view.current)?.scrollIntoView({
      inline: "center",
      block: "nearest",
      behavior: reduced ? "auto" : "smooth",
    });
  }, [view.current, playing, seat, reduced]);

  /**
   * A tap that asks the server for a move (UX-3): its sound, a buzz and a lift at once, not when
   * the answer comes. One at a time (no extra messages): the lifted card shows it's on its way.
   */
  const ask = (key: string, sound: Sound, action: Action) => () => {
    if (pending) return;
    const seq = onAction(action);
    if (seq === null) return; // not sent: no connection
    tapped.current = key;
    setTap({ key, seq, view });
    // Only a sound that started is skipped later (none before the first one has decoded).
    heard.current = play(sound) ? sound : null;
    navigator.vibrate?.(10);
  };

  const onMyCard = (seat: number, pos: number, slot: ViewSlot) => {
    if (myAuto && slot !== null) return pointAtSwitch;
    if (!myTurn || slot === null) return undefined;
    const key = slotKey(seat, pos);
    if (phase === "flip") {
      return slot === "down" ? ask(key, "flip", { type: "flip", seat, pos }) : undefined;
    }
    if (phase !== "place") return undefined;
    if (discardMode) {
      return slot === "down" ? ask(key, "flip", { type: "discardAndFlip", seat, pos }) : undefined;
    }
    return ask(key, "place", { type: "swap", seat, pos });
  };

  let onDeck: (() => void) | undefined;
  let onDiscard: (() => void) | undefined;
  if (seat !== null && myTurn && phase === "draw") {
    onDeck = ask("deck", "draw", { type: "draw", seat, source: "deck" });
    if (view.discardTop !== null) {
      onDiscard = ask("discard", "draw", { type: "draw", seat, source: "discard" });
    }
  } else if (myTurn && phase === "place" && view.drawnFrom === "deck") {
    // Throws the drawn card away, or takes it back: nothing is sent until you flip a card (UX-19).
    onDiscard = () => {
      if (pending) return;
      if (discarding) setUndos((n) => n + 1);
      setDiscarding(!discarding);
    };
  }
  const discardTap = myAuto ? pointAtSwitch : onDiscard;

  const n = players.length;
  // Opponents in turn order after you; a spectator sees everyone.
  const others =
    seat === null
      ? players.map((_, i) => i)
      : Array.from({ length: n - 1 }, (_, i) => (seat + 1 + i) % n);
  const lastTurns = view.ender !== null && playing;
  const fromDiscard = view.drawn !== null && view.drawnFrom === "discard";

  let pill = "";
  if (playing) {
    const name = players[view.current].name;
    if (view.current === seat) pill = lastTurns ? t("yourLastTurn") : t("yourTurn");
    else if (auto?.[view.current]) pill = t("autoPill", { name });
    else pill = lastTurns ? t("lastTurnPill", { name }) : name;
  } else if (phase === "flip") {
    pill = t("flipTwo");
  }
  if (myClock.left !== null) pill += ` · ${myClock.left}`;

  let note: ReactNode = seat === null ? t("watching") : prompt(t, view, seat, myTurn, discardMode);
  if (myAuto) note = t("autoPrompt");
  else if (offline && offlineLeft !== null && !myTurn) {
    note = (
      <>
        {t("offlineNote", { name: players[offline.seat]?.name ?? "" })}
        {/* The ticking seconds aren't re-read every second. */}
        <span aria-hidden="true"> · {t("autoPlayIn", { s: offlineLeft })}</span>
      </>
    );
  }

  return (
    <div
      className="table"
      data-testid="table"
      data-phase={phase}
      data-current={view.current}
      data-myturn={myTurn}
    >
      <header className="bar">
        <span className="round">{t("round", { n: view.round })}</span>
        {summary && peek ? (
          <button type="button" className="btn primary" onClick={() => setPeek(false)}>
            {t("showScores")}
          </button>
        ) : (
          // Pops once per turn (UX-10): the key changes with the player, not with the phase.
          <span
            className={`turn${lastTurns ? " final" : ""}${hurry(myClock.left)}`}
            key={`${view.round}-${view.current}`}
            data-testid="pill"
          >
            {pill}
          </span>
        )}
        <button
          type="button"
          className="btn icon"
          aria-label={t("sound")}
          aria-pressed={!muted}
          onClick={toggleMuted}
        >
          {muted ? "🔇" : "🔊"}
        </button>
        <button
          type="button"
          className="btn icon"
          aria-label={t("quit")}
          onClick={() => window.confirm(t("confirmLeave")) && exit()}
        >
          ✕
        </button>
      </header>

      <section
        className={`opponents${seat === null ? " watch" : others.length > 3 ? " many" : ""}`}
        data-testid="opponents"
      >
        {others.map((i) => {
          const p = players[i];
          const out = isOut(p, view.round);
          const active =
            !out && (phase === "flip" ? upCount(p.grid) < 2 : playing && view.current === i);
          const gone = connected?.[i] === false;
          const clock = wait.find((w) => w.seat === i && w.reason !== "auto");
          return (
            <button
              type="button"
              key={i}
              ref={(el) => {
                if (el) oppRefs.current.set(i, el);
                else oppRefs.current.delete(i);
              }}
              className={`opp${active ? " active" : ""}${gone ? " away" : ""}${clock ? " timed" : ""}${out ? " out" : ""}`}
              data-testid="opponent"
              aria-label={`${gone ? `${t("offline")}: ` : ""}${auto?.[i] ? `${t("autoPlay")}: ` : ""}${out ? `${p.name}, ${t("outWatching")}` : t("showCards", { name: p.name })}, ${t("pts", { n: total(p) })}`}
              // No cards to show.
              disabled={out}
              onClick={() => setZoom(i)}
            >
              <span className="opp-head">
                <span className="opp-name">
                  {auto?.[i] && <Bot />}
                  {p.name}
                </span>
                {clock && <Ring inMs={clock.inMs} />}
                <span className="opp-total">{total(p)}</span>
              </span>
              {out ? (
                <span className="out-note">{t("outWatching")}</span>
              ) : (
                <span className="mini">
                  {p.grid.map((slot, pos) => (
                    <Card
                      // biome-ignore lint/suspicious/noArrayIndexKey: grid position is the identity
                      key={pos}
                      slot={slot}
                      size="sm"
                      label={`${p.name}, ${where(t, pos)}`}
                      cardRef={reg(slotKey(i, pos))}
                    />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </section>

      <section className="piles">
        <div className="pile">
          <Card
            slot="down"
            size="md"
            label={t("deck")}
            testId="deck"
            highlight={!!onDeck}
            onClick={myAuto ? pointAtSwitch : onDeck}
            cardRef={reg("deck")}
            pending={pending === "deck"}
          />
          <span className="pile-label">{t("deckCount", { n: view.deckCount })}</span>
        </div>
        {/* Always there, empty unless you hold a card from the deck, so the piles never move (UX-2).
            Held, never highlighted: the highlights are what to tap (UX-4). */}
        {shown.drawn !== null && shown.drawnFrom === "deck" ? (
          <div className="pile held">
            <Card
              slot={shown.drawn}
              size="md"
              label={t("drawnCard")}
              testId="drawn"
              cardRef={reg("drawn")}
            />
            <span className="pile-label">{t("drawn")}</span>
          </div>
        ) : (
          <div className="pile empty" aria-hidden={discardMode ? undefined : "true"}>
            <span className="card md">
              {/* Where the thrown card came from: take it back (UX-19). */}
              {discardMode && (
                <button
                  type="button"
                  className="btn undo"
                  onClick={(e) => {
                    refocus.current = document.activeElement === e.currentTarget;
                    onDiscard?.();
                  }}
                >
                  <span aria-hidden="true">↶ </span>
                  {t("undo")}
                </button>
              )}
            </span>
            <span className="pile-label">&nbsp;</span>
          </div>
        )}
        <div className="pile">
          {/* A card taken from the discard is held up over its pile, not moved aside (UX-21). The
              pile's place takes a tap while its card is still flying in, away from it (M9 PO). */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the card is the button; this only catches taps the card isn't under yet */}
          <span
            ref={stack}
            className={`stack${fromDiscard ? " taken" : ""}`}
            onClick={(e) => e.target === e.currentTarget && discardTap?.()}
          >
            <Card
              key={undos}
              slot={shown.discardTop}
              size="md"
              label={t("discardPile")}
              testId="discard"
              // In discard mode tapping it only takes the card back: your face-down cards are the
              // targets (UX-18).
              highlight={!!onDiscard && !discardMode}
              onClick={discardTap}
              cardRef={reg("discard")}
              pending={pending === "discard"}
              tilt={discardMode ? 4 : undefined}
            />
            {fromDiscard && (
              <Card
                slot={view.drawn}
                size="md"
                label={t("fromDiscard")}
                testId="drawn"
                cardRef={reg("drawn")}
              />
            )}
          </span>
          <span className="pile-label">{fromDiscard ? t("fromDiscard") : t("discard")}</span>
        </div>
      </section>

      {/* One line for every note, so your cards keep their size (UX-12). */}
      <p className="prompt" aria-live="polite" data-testid="prompt">
        {note}
      </p>

      {me && seat !== null && (
        <section className="mine">
          {/* Auto-play lives here: a quiet switch, or while on, a bar holding the same switch. */}
          <div
            className={`mine-head${myAuto ? " auto-on" : ""}${nudges ? ` nudge-${nudges % 2}` : ""}`}
            data-testid="mine-head"
          >
            {myAuto ? (
              <span className="auto-note">{t(away ? "autoAway" : "autoOn")}</span>
            ) : (
              <span className="me">
                <strong>{me.name}</strong> <span className="pts">{t("pts", { n: total(me) })}</span>
              </span>
            )}
            {/* Nothing left to play once you're out (R16), even at that round's summary. */}
            {me.out === null && (
              <label className="auto">
                {!myAuto && t("autoPlay")}
                <span className="switch">
                  <input
                    type="checkbox"
                    aria-label={t("autoPlay")}
                    checked={myAuto}
                    onChange={(e) => onAuto?.(e.target.checked)}
                  />
                </span>
              </label>
            )}
            {myClock.until !== null && (
              <Drain
                key={myClock.until}
                until={myClock.until}
                className={`clock${hurry(myClock.left)}`}
                testId="clock"
              />
            )}
            <span className="sr-only" role="status">
              {said}
            </span>
          </div>
          <div className="grid-wrap">
            <div
              ref={gridRef}
              className={`grid${myTurn ? " active" : ""}${discardMode ? " discarding" : ""}`}
              data-testid="my-grid"
              data-seat={seat}
            >
              {me.grid.map((slot, pos) => (
                <Card
                  // biome-ignore lint/suspicious/noArrayIndexKey: grid position is the identity
                  key={pos}
                  slot={slot}
                  size="lg"
                  label={`${me.name}, ${where(t, pos)}`}
                  highlight={discardMode && slot === "down"}
                  onClick={onMyCard(seat, pos, slot)}
                  cardRef={reg(slotKey(seat, pos))}
                  pending={pending === slotKey(seat, pos)}
                />
              ))}
            </div>
          </div>
        </section>
      )}

      {zoom !== null && players[zoom] && !isOut(players[zoom], view.round) && (
        <Zoom view={view} seat={zoom} total={total(players[zoom])} onClose={() => setZoom(null)} />
      )}

      {/* The summary waits for the final reveal (UX-27). */}
      {summary && !peek && !revealing && (
        <Summary
          view={view}
          lead={lead}
          auto={auto}
          onPeek={() => setPeek(true)}
          onNext={() => onAction({ type: "nextRound" })}
          onPlayAgain={onPlayAgain}
          onExit={exit}
        />
      )}
    </div>
  );
}

function prompt(t: T, view: GameView, seat: number, myTurn: boolean, discardMode: boolean) {
  const me = view.players[seat];
  const waiting = t("waiting", { name: view.players[view.current].name });
  switch (view.phase) {
    case "flip": {
      const n = 2 - upCount(me.grid);
      if (!myTurn) return t("waitingFlip");
      return n === 1 ? t("flipOnePlain") : t("flipManyPlain", { n });
    }
    case "draw":
      if (!myTurn) return waiting;
      return (view.ender !== null ? t("lastTurn") : "") + t("drawPlain");
    case "place":
      if (!myTurn) return waiting;
      if (view.drawnFrom === "discard") return t("swapIn");
      return discardMode ? t("discardMode") : t("place");
    default:
      return "";
  }
}

/**
 * One opponent's grid at full size, opened by tapping their panel; follows the live view. A native
 * modal <dialog> gives focus handling, Escape and an inert background; tapping outside closes it.
 */
interface ZoomProps {
  view: GameView;
  seat: number;
  /** Their total as the table shows it (held during the final reveal). */
  total: number;
  onClose: () => void;
}

function Zoom({ view, seat, total, onClose }: ZoomProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const p = view.players[seat];
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the dialog natively; this only adds tap-outside
    <dialog
      ref={ref}
      className="zoom"
      aria-labelledby="zoom-title"
      data-testid="zoom"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <div className="sheet">
        <div className="sheet-head">
          <h2 id="zoom-title">
            {p.name} · {t("pts", { n: total })}
          </h2>
          <button type="button" className="btn" onClick={onClose}>
            {t("close")}
          </button>
        </div>
        <div className="zoom-grid">
          {p.grid.map((slot, pos) => (
            <Card
              // biome-ignore lint/suspicious/noArrayIndexKey: grid position is the identity
              key={pos}
              slot={slot}
              size="md"
              label={`${p.name}, ${where(t, pos)}`}
            />
          ))}
        </div>
      </div>
    </dialog>
  );
}

interface SummaryProps {
  view: GameView;
  lead: boolean;
  auto?: boolean[];
  onPeek: () => void;
  onNext: () => void;
  onPlayAgain: () => void;
  onExit: () => void;
}

function Summary({ view, lead, auto, onPeek, onNext, onPlayAgain, onExit }: SummaryProps) {
  const { t } = useI18n();
  const over = view.phase === "gameOver";
  const winners = view.winners.map((i) => view.players[i].name);
  const rows = view.players.map((p, seat) => ({ ...p, seat }));
  // The final ranking (R14, R16) is the engine's.
  const place = places(view);
  if (over) rows.sort((a, b) => place[a.seat] - place[b.seat]);
  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="summary-title"
      data-testid={over ? "game-over" : "round-summary"}
    >
      <div className="sheet">
        <div className="sheet-head">
          <h2 id="summary-title">
            {over
              ? t(winners.length === 1 ? "winsOne" : "winsMany", { names: winners.join(" & ") })
              : t("roundOver", { n: view.round })}
          </h2>
          <button type="button" className="btn" onClick={onPeek}>
            {t("viewTable")}
          </button>
        </div>
        <table className="scores">
          <thead>
            <tr>
              <th>{t("colPlayer")}</th>
              <th>{t("colRound")}</th>
              <th>{t("colTotal")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              // Players out before this round (R16) have no score in it.
              const played = !isOut(p, view.round);
              const last = lastScore(p, view.round);
              return (
                <tr key={p.seat} className={view.winners.includes(p.seat) ? "win" : undefined}>
                  <td>
                    {auto?.[p.seat] && <Bot />}
                    {p.name}
                    {p.seat === view.ender && <span className="tag">{t("ended")}</span>}
                    {/* A winner may have reached 100 too, when nobody was left under it. */}
                    {p.out !== null && !view.winners.includes(p.seat) && (
                      <span className="tag" data-testid="out-tag">
                        {t("outInRound", { n: p.out })}
                      </span>
                    )}
                  </td>
                  <td>
                    {!played ? (
                      "–"
                    ) : p.seat === view.ender && view.doubled ? (
                      // "57 ×2 = 114": the doubling already happened, and the base is visible.
                      <>
                        {last / 2}
                        <span className="tag x2">×2</span> = {last}
                      </>
                    ) : (
                      last
                    )}
                  </td>
                  <td>
                    <CountUp from={p.total - last} to={p.total} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!lead && <p className="prompt">{t("waitingHost")}</p>}
        {over ? (
          <div className="actions">
            <button type="button" className="btn" onClick={onExit}>
              {t("home")}
            </button>
            {lead && (
              <button type="button" className="btn primary" onClick={onPlayAgain}>
                {t("playAgain")}
              </button>
            )}
          </div>
        ) : (
          lead && (
            <button type="button" className="btn primary" onClick={onNext}>
              {t("nextRound")}
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** Totals tick up from last round's value. */
function CountUp({ from, to }: { from: number; to: number }) {
  return <>{useCountUp(from, to)}</>;
}

/**
 * A server wait as a deadline on this phone's clock (`until`, ms), kept through each broadcast's
 * network jitter, plus the whole seconds left once within `within` s (`left`, null before). It
 * re-renders only then, at most once a second, never for the whole turn.
 */
function useClock(inMs: number | undefined, within = 10) {
  // Derived during render, not in an effect: a new turn's first render never shows the last one's.
  const [seen, setSeen] = useState<{ inMs?: number; until: number | null }>({ until: null });
  let until = seen.until;
  if (inMs !== seen.inMs) {
    const next = inMs === undefined ? null : Date.now() + inMs;
    until = next !== null && until !== null && Math.abs(until - next) < 250 ? until : next;
    setSeen({ inMs, until });
  }
  const ms = until === null ? 0 : until - Date.now();
  const s = Math.max(0, Math.ceil(ms / 1000));
  const [, render] = useState(0);
  useEffect(() => {
    if (until === null || s === 0) return;
    // Again when the seconds change, or when they come within range.
    const id = setTimeout(() => render((n) => n + 1), ms - (Math.min(s, within + 1) - 1) * 1000);
    return () => clearTimeout(id);
  });
  return { until, left: until !== null && s <= within ? s : null };
}

/**
 * Drains once, ending at `until`: one CSS animation TURN_MS long, started part-way in with a
 * negative delay, so nothing re-renders while it runs. Keyed by `until`, it restarts per deadline.
 */
function Drain({
  until,
  className,
  testId,
}: {
  until: number;
  className: string;
  testId?: string;
}) {
  const [delay] = useState(() => until - Date.now() - TURN_MS);
  return (
    <span
      className={className}
      data-testid={testId}
      aria-hidden="true"
      style={{ animationDuration: `${TURN_MS}ms`, animationDelay: `${delay}ms` }}
    />
  );
}

/** A waited-on opponent's panel: its border drains, and shows the seconds in the last 10. */
function Ring({ inMs }: { inMs: number }) {
  const { until, left } = useClock(inMs);
  if (until === null) return null;
  return (
    <>
      <Drain key={until} until={until} className={`ring${hurry(left)}`} />
      {left !== null && <span className={`opp-left${hurry(left)}`}>{left}</span>}
    </>
  );
}

/** The mark of a seat on Auto-play, on its panel and in the round summary. */
function Bot() {
  const { t } = useI18n();
  return (
    <span className="bot" role="img" aria-label={t("autoPlay")}>
      🤖
    </span>
  );
}

/**
 * Whether Auto-play was on while you were away: already on when this table opened, switched on
 * within 10 s of the page coming back into view (the server did it while the phone was locked or
 * in the background), or still on when the page was hidden.
 */
function useAway(on: boolean): boolean {
  const [away, setAway] = useState(on);
  const back = useRef(0);
  useEffect(() => {
    if (!on) setAway(false);
    else if (document.hidden || Date.now() - back.current < 10_000) setAway(true);
    const onVisibility = () => {
      if (!document.hidden) back.current = Date.now();
      else if (on) setAway(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [on]);
  return away;
}

/**
 * Keeps the screen on during a game (UX-6): at 6–8 seats the wait between turns outlasts iOS's
 * 30 s auto-lock, and a locked phone goes stale and onto Auto-play. The browser drops the lock
 * when the page is hidden, so it's asked for again when it's back. Returns the release for Home.
 */
function useWakeLock(): () => void {
  const release = useRef(() => {});
  useEffect(() => {
    let on = true;
    let held: WakeLockSentinel | null = null;
    const request = () => {
      if (!on || document.visibilityState !== "visible" || !navigator.wakeLock) return;
      navigator.wakeLock.request("screen").then(
        (sentinel) => {
          if (on) held = sentinel;
          else void sentinel.release();
        },
        () => {}, // refused (battery saver, an iframe): the phone may lock as before
      );
    };
    release.current = () => {
      on = false;
      void held?.release();
    };
    request();
    document.addEventListener("visibilitychange", request);
    return () => {
      document.removeEventListener("visibilitychange", request);
      release.current();
    };
  }, []);
  return useCallback(() => release.current(), []);
}
