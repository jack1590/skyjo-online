import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import type { Action } from "../engine/game";
import type { GameView, ViewSlot } from "../engine/view";
import { Card } from "./Card";

interface TableProps {
  view: GameView;
  /** Seat shown at the bottom; its taps become actions. */
  seat: number;
  onAction: (action: Action) => void;
  onPlayAgain: () => void;
  onExit: () => void;
  /** Replaces the prompt line, e.g. a hot-seat "Pass to …" button. */
  banner?: ReactNode;
}

const where = (pos: number) => `row ${Math.floor(pos / 4) + 1}, column ${(pos % 4) + 1}`;
const upCount = (grid: ViewSlot[]) => grid.filter((slot) => typeof slot === "number").length;

export function Table({ view, seat, onAction, onPlayAgain, onExit, banner }: TableProps) {
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

  const me = players[seat];
  const playing = phase === "draw" || phase === "place";
  const myTurn = phase === "flip" ? upCount(me.grid) < 2 : playing && view.current === seat;
  const discardMode = discarding && myTurn && phase === "place" && view.drawnFrom === "deck";

  const act = (action: Action) => {
    setDiscarding(false);
    onAction(action);
  };

  const onMyCard = (pos: number, slot: ViewSlot) => {
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

  const onDeck =
    myTurn && phase === "draw" ? () => act({ type: "draw", seat, source: "deck" }) : undefined;
  let onDiscard: (() => void) | undefined;
  if (myTurn && phase === "draw" && view.discardTop !== null) {
    onDiscard = () => act({ type: "draw", seat, source: "discard" });
  } else if (myTurn && phase === "place" && view.drawnFrom === "deck") {
    onDiscard = () => setDiscarding(!discarding);
  }

  const n = players.length;
  const others = Array.from({ length: n - 1 }, (_, i) => (seat + 1 + i) % n);
  const compact = others.length >= 4;
  const lastTurns = view.ender !== null && playing;

  let pill = "";
  if (playing) pill = `${lastTurns ? "Last turn · " : ""}${players[view.current].name}`;
  else if (phase === "flip") pill = "Flip 2 cards";

  return (
    <div className="table" data-testid="table" data-phase={phase} data-current={view.current}>
      <header className="bar">
        <span className="round">Round {view.round}</span>
        {summary && peek ? (
          <button type="button" className="btn primary" onClick={() => setPeek(false)}>
            Show scores
          </button>
        ) : (
          <span className={`turn${lastTurns ? " final" : ""}`} key={`${phase}-${view.current}`}>
            {pill}
          </span>
        )}
        <button
          type="button"
          className="btn icon"
          aria-label="Quit to home"
          onClick={() => window.confirm("Leave this game?") && onExit()}
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
          return (
            <div key={i} className={`opp${active ? " active" : ""}`} data-testid="opponent">
              <div className="opp-head">
                <span className="opp-name">{p.name}</span>
                <span className="opp-total">{p.total}</span>
              </div>
              <div className="mini">
                {p.grid.map((slot, pos) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: grid position is the identity
                  <Card key={pos} slot={slot} size="sm" label={`${p.name}, ${where(pos)}`} />
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
            label="Deck"
            testId="deck"
            highlight={!!onDeck}
            onClick={onDeck}
          />
          <span className="pile-label">Deck · {view.deckCount}</span>
        </div>
        {view.drawn !== null && (
          <div className="pile">
            <Card
              slot={view.drawn}
              size="md"
              label="Drawn card"
              testId="drawn"
              highlight={!discardMode}
              onClick={discardMode ? () => setDiscarding(false) : undefined}
            />
            <span className="pile-label">{discardMode ? "Tap to keep" : "Drawn"}</span>
          </div>
        )}
        <div className="pile">
          <Card
            slot={view.discardTop}
            size="md"
            label="Discard pile"
            testId="discard"
            highlight={!!onDiscard}
            onClick={onDiscard}
          />
          <span className="pile-label">Discard</span>
        </div>
      </section>

      {banner ?? (
        <p className="prompt" aria-live="polite">
          {prompt(view, seat, myTurn, discardMode)}
        </p>
      )}

      <section className="mine">
        <div className="mine-head">
          <strong>{me.name}</strong>
          <span>{me.total} pts</span>
        </div>
        <div className="grid-wrap">
          <div className={`grid${myTurn ? " active" : ""}`} data-testid="my-grid" data-seat={seat}>
            {me.grid.map((slot, pos) => (
              <Card
                // biome-ignore lint/suspicious/noArrayIndexKey: grid position is the identity
                key={pos}
                slot={slot}
                size="lg"
                label={`${me.name}, ${where(pos)}`}
                onClick={onMyCard(pos, slot)}
              />
            ))}
          </div>
        </div>
      </section>

      {summary && !peek && (
        <Summary
          view={view}
          onPeek={() => setPeek(true)}
          onNext={() => act({ type: "nextRound" })}
          onPlayAgain={onPlayAgain}
          onExit={onExit}
        />
      )}
    </div>
  );
}

function prompt(view: GameView, seat: number, myTurn: boolean, discardMode: boolean): string {
  const me = view.players[seat];
  const last = view.ender !== null ? "Last turn! " : "";
  switch (view.phase) {
    case "flip": {
      const left = 2 - upCount(me.grid);
      return myTurn
        ? `${me.name}: flip ${left} card${left === 1 ? "" : "s"}`
        : "Waiting for others to flip…";
    }
    case "draw":
      return myTurn
        ? `${last}${me.name}: draw from the deck or take the discard`
        : `Waiting for ${view.players[view.current].name}…`;
    case "place":
      if (!myTurn) return `Waiting for ${view.players[view.current].name}…`;
      if (view.drawnFrom === "discard") return "Tap a card in your grid to swap it in";
      return discardMode
        ? "Tap a face-down card to flip it, or the drawn card to keep it"
        : "Tap a grid card to swap, or the discard pile to throw it away";
    default:
      return "";
  }
}

interface SummaryProps {
  view: GameView;
  onPeek: () => void;
  onNext: () => void;
  onPlayAgain: () => void;
  onExit: () => void;
}

function Summary({ view, onPeek, onNext, onPlayAgain, onExit }: SummaryProps) {
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
              ? `${winners.join(" & ")} win${winners.length === 1 ? "s" : ""}!`
              : `Round ${view.round} over`}
          </h2>
          <button type="button" className="btn" onClick={onPeek}>
            View table
          </button>
        </div>
        <table className="scores">
          <thead>
            <tr>
              <th>Player</th>
              <th>Round</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.seat} className={view.winners.includes(p.seat) ? "win" : undefined}>
                <td>
                  {p.name}
                  {p.seat === view.ender && <span className="tag">ended</span>}
                </td>
                <td>
                  {p.scores.at(-1)}
                  {p.seat === view.ender && view.doubled && <span className="tag x2">×2</span>}
                </td>
                <td>{p.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {over ? (
          <div className="actions">
            <button type="button" className="btn" onClick={onExit}>
              Home
            </button>
            <button type="button" className="btn primary" onClick={onPlayAgain}>
              Play again
            </button>
          </div>
        ) : (
          <button type="button" className="btn primary" onClick={onNext}>
            Next round
          </button>
        )}
      </div>
    </div>
  );
}
