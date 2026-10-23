import { Component, type ReactNode, useEffect, useState } from "react";
import { apply, createGame, type GameState } from "../engine/game";
import type { Rng } from "../engine/rng";
import { type GameView, toView } from "../engine/view";
import { Home } from "./Home";
import { Table } from "./Table";

interface LocalGame {
  names: string[];
  state: GameState;
  /** Seat whose grid is at the bottom. It lags the actor until the phone is passed on. */
  seat: number;
}

const SAVE_KEY = "skyjo:hotseat:v2";

/** `?seed=N` makes local games reproducible for E2E tests; otherwise the browser CSPRNG seeds them. */
function newSeed(): Rng {
  const fixed = Number(new URLSearchParams(window.location.search).get("seed"));
  if (Number.isInteger(fixed) && fixed !== 0) return [fixed, 0, 0, 0];
  return Array.from(crypto.getRandomValues(new Int32Array(4))) as Rng;
}

/** Hot-seat: whoever has to act next. */
function actor(view: GameView): number {
  if (view.phase !== "flip") return view.current;
  return view.players.findIndex(
    (p) => p.grid.filter((slot) => typeof slot === "number").length < 2,
  );
}

function newGame(names: string[]): LocalGame {
  const state = createGame(names, newSeed());
  return { names, state, seat: actor(toView(state)) };
}

/** Phones evict background tabs, so a hot-seat game survives reloads. */
function loadSaved(): LocalGame | null {
  try {
    const saved: LocalGame | null = JSON.parse(localStorage.getItem(SAVE_KEY) ?? "null");
    if (!saved) return null;
    const view = toView(saved.state); // throws on a malformed state
    return view.players[saved.seat] && view.players[actor(view)] ? saved : null;
  } catch {
    return null;
  }
}

export function App() {
  const [game, setGame] = useState<LocalGame | null>(loadSaved);

  useEffect(() => {
    try {
      if (game) localStorage.setItem(SAVE_KEY, JSON.stringify(game));
      else localStorage.removeItem(SAVE_KEY);
    } catch {
      // Storage can be unavailable (private mode); the game just won't survive a reload.
    }
  }, [game]);

  if (!game) return <Home onStart={(names) => setGame(newGame(names))} />;

  const view = toView(game.state);
  const next = actor(view);
  // The player who just moved keeps seeing their grid until they hand the phone over.
  const handoff = (view.phase === "flip" || view.phase === "draw") && next !== game.seat;
  return (
    <Table
      view={view}
      seat={game.seat}
      onAction={(action) => setGame({ ...game, state: apply(game.state, action) })}
      onPlayAgain={() => setGame(newGame(game.names))}
      onExit={() => setGame(null)}
      banner={
        handoff ? (
          <button
            type="button"
            className="btn primary pass"
            onClick={() => setGame({ ...game, seat: next })}
          >
            Pass to {view.players[next].name} →
          </button>
        ) : undefined
      }
    />
  );
}

/** A render crash (e.g. an incompatible saved game) clears the save instead of white-screening on every load. */
export class Recover extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      // Nothing saved to clear.
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="home">
        <p>Something went wrong, so the saved game was cleared.</p>
        <button type="button" className="btn primary" onClick={() => window.location.reload()}>
          Start over
        </button>
      </main>
    );
  }
}
