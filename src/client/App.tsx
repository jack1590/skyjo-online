import { useEffect, useState } from "react";
import { apply, createGame, type GameState } from "../engine/game";
import type { Rng } from "../engine/rng";
import { type GameView, toView } from "../engine/view";
import { Home } from "./Home";
import { Table } from "./Table";

interface LocalGame {
  names: string[];
  state: GameState;
}

const SAVE_KEY = "skyjo:hotseat:v1";

/** `?seed=N` makes local games reproducible for E2E tests; otherwise the browser CSPRNG seeds them. */
function newSeed(): Rng {
  const fixed = Number(new URLSearchParams(window.location.search).get("seed"));
  if (Number.isInteger(fixed) && fixed !== 0) return [fixed, 0, 0, 0];
  return Array.from(crypto.getRandomValues(new Int32Array(4))) as Rng;
}

/** Hot-seat: the bottom grid belongs to whoever has to act next. */
function actor(view: GameView): number {
  if (view.phase !== "flip") return view.current;
  return view.players.findIndex(
    (p) => p.grid.filter((slot) => typeof slot === "number").length < 2,
  );
}

/** Phones evict background tabs, so a hot-seat game survives reloads. */
function loadSaved(): LocalGame | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) ?? "null");
    return Array.isArray(saved?.state?.players) ? saved : null;
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

  if (!game) {
    return <Home onStart={(names) => setGame({ names, state: createGame(names, newSeed()) })} />;
  }
  const view = toView(game.state);
  return (
    <Table
      view={view}
      seat={actor(view)}
      onAction={(action) => setGame({ ...game, state: apply(game.state, action) })}
      onPlayAgain={() => setGame({ ...game, state: createGame(game.names, newSeed()) })}
      onExit={() => setGame(null)}
    />
  );
}
