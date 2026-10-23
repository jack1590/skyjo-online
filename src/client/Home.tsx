import { type FormEvent, useState } from "react";
import { MAX_PLAYERS, MIN_PLAYERS } from "../engine/game";

const defaultName = (i: number) => `Player ${i + 1}`;

export function Home({ onStart }: { onStart: (names: string[]) => void }) {
  const [names, setNames] = useState([defaultName(0), defaultName(1)]);

  const setCount = (count: number) =>
    setNames((prev) => Array.from({ length: count }, (_, i) => prev[i] ?? defaultName(i)));

  const start = (e: FormEvent) => {
    e.preventDefault();
    onStart(names.map((name, i) => name.trim() || defaultName(i)));
  };

  return (
    <main className="home">
      <h1 className="logo">
        Skyjo <span>Online</span>
      </h1>
      <p className="tagline">Flip, swap, and keep your score low.</p>

      <form className="panel" onSubmit={start}>
        <h2>Play on this phone</h2>
        <div className="stepper">
          <button
            type="button"
            className="btn"
            aria-label="Fewer players"
            disabled={names.length <= MIN_PLAYERS}
            onClick={() => setCount(names.length - 1)}
          >
            −
          </button>
          <output aria-live="polite">{names.length} players</output>
          <button
            type="button"
            className="btn"
            aria-label="More players"
            disabled={names.length >= MAX_PLAYERS}
            onClick={() => setCount(names.length + 1)}
          >
            +
          </button>
        </div>
        {names.map((name, i) => (
          <input
            // Inputs are positional: a seat's name stays put when the count changes.
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
            key={i}
            className="name-input"
            value={name}
            maxLength={16}
            aria-label={`Player ${i + 1} name`}
            onChange={(e) => setNames(names.map((n, j) => (j === i ? e.target.value : n)))}
          />
        ))}
        <button type="submit" className="btn primary">
          Start game
        </button>
      </form>

      <details className="panel rules">
        <summary>How to play</summary>
        <ul>
          <li>
            Everyone gets 12 face-down cards in a 3 × 4 grid and flips any 2. The highest pair
            starts.
          </li>
          <li>On your turn, draw from the deck or take the top card of the discard pile.</li>
          <li>
            A deck card can replace any card in your grid, or you can throw it away and flip one of
            your face-down cards instead. A card from the discard pile must replace a grid card.
          </li>
          <li>Three equal face-up cards in a column disappear.</li>
          <li>
            Reveal your whole grid to end the round; everyone else gets one last turn. If you don't
            have the strictly lowest score, your positive score is doubled.
          </li>
          <li>When someone reaches 100 points the game ends. Lowest total wins.</li>
        </ul>
      </details>
    </main>
  );
}
