import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import type { Action } from "../engine/game";
import type { GameView, ViewSlot } from "../engine/view";
import { Card } from "./Card";
import { type T, useI18n } from "./i18n";
import { slotKey, useCountUp, useFlights, useReducedMotion } from "./motion";

interface TableProps {
  view: GameView;
  /** Seat shown at the bottom; its taps become actions. Null = watching. */
  seat: number | null;
  /** May advance rounds and rematch (always in hot-seat; host or stand-in online). */
  lead?: boolean;
  /** Online: per seat, whether that player is connected. */
  connected?: boolean[];
  /** Online play: "Your turn" pill and a buzz when your turn starts. */
  online?: boolean;
  /** Online: the offline seat the table waits on, and ms until the server moves for it. */
  wait?: { seat: number; inMs: number } | null;
  onAction: (action: Action) => void;
  onPlayAgain: () => void;
  onExit: () => void;
  /** Replaces the prompt line, e.g. a hot-seat "Pass to …" button. */
  banner?: ReactNode;
}

const where = (t: T, pos: number) =>
  t("where", { row: Math.floor(pos / 4) + 1, col: (pos % 4) + 1 });
const upCount = (grid: ViewSlot[]) => grid.filter((slot) => typeof slot === "number").length;

export function Table(props: TableProps) {
  const {
    view,
    seat,
    onAction,
    onPlayAgain,
    onExit,
    banner,
    lead = true,
    connected,
    online,
    wait,
  } = props;
  const { t } = useI18n();
  const { phase, players } = view;
  const summary = phase === "roundOver" || phase === "gameOver";
  const [discarding, setDiscarding] = useState(false);
  // Hides the summary sheet so players can look at the revealed grids.
  const [peek, setPeek] = useState(false);
  // Local modes never outlive the turn or summary they started in (the server may move for us).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are triggers, not inputs
  useEffect(() => setDiscarding(false), [view.round, view.current, phase]);
  useEffect(() => {
    if (!summary) setPeek(false);
  }, [summary]);

  const me = seat === null ? null : players[seat];
  const playing = phase === "draw" || phase === "place";
  const myTurn =
    me !== null && (phase === "flip" ? upCount(me.grid) < 2 : playing && view.current === seat);
  useEffect(() => {
    // Browsers block vibrate before the first tap on the page (e.g. right after a reload).
    if (online && myTurn && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(40);
  }, [online, myTurn]);
  const discardMode = discarding && myTurn && phase === "place" && view.drawnFrom === "deck";

  const reg = useFlights(view);

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

  const waitSeconds = useCountdown(wait);

  const act = (action: Action) => {
    setDiscarding(false);
    onAction(action);
  };

  const onMyCard = (seat: number, pos: number, slot: ViewSlot) => {
    if (!myTurn || slot === null) return undefined;
    if (phase === "flip") {
      return slot === "down" ? () => act({ type: "flip", seat, pos }) : undefined;
    }
    if (phase !== "place") return undefined;
    if (discardMode) {
      return slot === "down" ? () => act({ type: "discardAndFlip", seat, pos }) : undefined;
    }
    return () => act({ type: "swap", seat, pos });
  };

  let onDeck: (() => void) | undefined;
  let onDiscard: (() => void) | undefined;
  if (seat !== null && myTurn && phase === "draw") {
    onDeck = () => act({ type: "draw", seat, source: "deck" });
    if (view.discardTop !== null) onDiscard = () => act({ type: "draw", seat, source: "discard" });
  } else if (myTurn && phase === "place" && view.drawnFrom === "deck") {
    onDiscard = () => setDiscarding(!discarding);
  }

  const n = players.length;
  // Opponents in turn order after you; a spectator sees everyone.
  const others =
    seat === null
      ? players.map((_, i) => i)
      : Array.from({ length: n - 1 }, (_, i) => (seat + 1 + i) % n);
  const compact = others.length >= 4;
  const lastTurns = view.ender !== null && playing;

  let pill = "";
  if (playing) {
    const name = online && view.current === seat ? t("yourTurn") : players[view.current].name;
    pill = lastTurns ? t("lastTurnPill", { name }) : name;
  } else if (phase === "flip") {
    pill = t("flipTwo");
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
          <span className={`turn${lastTurns ? " final" : ""}`} key={`${phase}-${view.current}`}>
            {pill}
          </span>
        )}
        <button
          type="button"
          className="btn icon"
          aria-label={t("quit")}
          onClick={() => window.confirm(t("confirmLeave")) && onExit()}
        >
          ✕
        </button>
      </header>

      <section
        className={`opponents${compact ? " compact" : ""}`}
        style={{ "--cols": compact ? 4 : others.length } as CSSProperties}
      >
        {others.map((i) => {
          const p = players[i];
          const active = phase === "flip" ? upCount(p.grid) < 2 : playing && view.current === i;
          const away = connected?.[i] === false;
          return (
            <div
              key={i}
              className={`opp${active ? " active" : ""}${away ? " away" : ""}`}
              data-testid="opponent"
            >
              <div className="opp-head">
                <span className="opp-name">
                  {away && <span className="sr-only">{t("offline")} </span>}
                  {p.name}
                </span>
                <span className="opp-total">{p.total}</span>
              </div>
              <div className="mini">
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
              </div>
            </div>
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
            onClick={onDeck}
            cardRef={reg("deck")}
          />
          <span className="pile-label">{t("deckCount", { n: view.deckCount })}</span>
        </div>
        {view.drawn !== null && (
          <div className="pile">
            <Card
              slot={view.drawn}
              size="md"
              label={t("drawnCard")}
              testId="drawn"
              cardRef={reg("drawn")}
              highlight={!discardMode}
              onClick={discardMode ? () => setDiscarding(false) : undefined}
            />
            <span className="pile-label">{discardMode ? t("tapToKeep") : t("drawn")}</span>
          </div>
        )}
        <div className="pile">
          <Card
            slot={view.discardTop}
            size="md"
            label={t("discardPile")}
            testId="discard"
            highlight={!!onDiscard}
            onClick={onDiscard}
            cardRef={reg("discard")}
          />
          <span className="pile-label">{t("discard")}</span>
        </div>
      </section>

      {wait && waitSeconds !== null && wait.seat !== seat && (
        <p className="offline-note">
          {/* Announce who is offline once; the ticking seconds would be re-read every second. */}
          <span role="status">{t("offlineNote", { name: players[wait.seat]?.name ?? "" })}</span>
          <span aria-hidden="true"> · {t("autoMoveIn", { s: waitSeconds })}</span>
        </p>
      )}

      {banner ?? (
        <p className="prompt" aria-live="polite">
          {seat === null ? t("watching") : prompt(t, view, seat, myTurn, discardMode, online)}
        </p>
      )}

      {me && seat !== null && (
        <section className="mine">
          <div className="mine-head">
            <strong>{me.name}</strong>
            <span>{t("pts", { n: me.total })}</span>
          </div>
          <div className="grid-wrap">
            <div
              ref={gridRef}
              className={`grid${myTurn ? " active" : ""}`}
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
                  onClick={onMyCard(seat, pos, slot)}
                  cardRef={reg(slotKey(seat, pos))}
                />
              ))}
            </div>
          </div>
        </section>
      )}

      {summary && !peek && (
        <Summary
          view={view}
          lead={lead}
          onPeek={() => setPeek(true)}
          onNext={() => act({ type: "nextRound" })}
          onPlayAgain={onPlayAgain}
          onExit={onExit}
        />
      )}
    </div>
  );
}

function prompt(
  t: T,
  view: GameView,
  seat: number,
  myTurn: boolean,
  discardMode: boolean,
  online?: boolean,
) {
  const me = view.players[seat];
  const waiting = t("waiting", { name: view.players[view.current].name });
  switch (view.phase) {
    case "flip": {
      const n = 2 - upCount(me.grid);
      if (!myTurn) return t("waitingFlip");
      // Online the pill already says "Your turn"; hot-seat needs the name to know who holds the phone.
      if (online) return n === 1 ? t("flipOnePlain") : t("flipManyPlain", { n });
      return n === 1 ? t("flipOne", { name: me.name }) : t("flipMany", { name: me.name, n });
    }
    case "draw":
      if (!myTurn) return waiting;
      return (
        (view.ender !== null ? t("lastTurn") : "") +
        (online ? t("drawPlain") : t("draw", { name: me.name }))
      );
    case "place":
      if (!myTurn) return waiting;
      if (view.drawnFrom === "discard") return t("swapIn");
      return discardMode ? t("discardMode") : t("place");
    default:
      return "";
  }
}

interface SummaryProps {
  view: GameView;
  lead: boolean;
  onPeek: () => void;
  onNext: () => void;
  onPlayAgain: () => void;
  onExit: () => void;
}

function Summary({ view, lead, onPeek, onNext, onPlayAgain, onExit }: SummaryProps) {
  const { t } = useI18n();
  const over = view.phase === "gameOver";
  const winners = view.winners.map((i) => view.players[i].name);
  const rows = view.players.map((p, seat) => ({ ...p, seat }));
  if (over) rows.sort((a, b) => a.total - b.total);
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
            {rows.map((p) => (
              <tr key={p.seat} className={view.winners.includes(p.seat) ? "win" : undefined}>
                <td>
                  {p.name}
                  {p.seat === view.ender && <span className="tag">{t("ended")}</span>}
                </td>
                <td>
                  {p.seat === view.ender && view.doubled ? (
                    // "57 ×2 = 114": the doubling already happened, and the base is visible.
                    <>
                      {(p.scores.at(-1) ?? 0) / 2}
                      <span className="tag x2">×2</span> = {p.scores.at(-1)}
                    </>
                  ) : (
                    p.scores.at(-1)
                  )}
                </td>
                <td>
                  <CountUp from={p.total - (p.scores.at(-1) ?? 0)} to={p.total} />
                </td>
              </tr>
            ))}
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

/** Seconds left until `wait.inMs` (counted from when it arrived), ticking once a second. */
function useCountdown(wait: { seat: number; inMs: number } | null | undefined): number | null {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setDeadline(wait ? Date.now() + wait.inMs : null);
    setNow(Date.now());
  }, [wait]);
  useEffect(() => {
    if (deadline === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline]);
  return deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
}
