// Sound effects: tiny CC0 recordings (Kenney, see README) in public/sfx, decoded once into Web
// Audio buffers. Which sounds play is derived from consecutive views, like the card flights.
import { useEffect, useRef, useState } from "react";
import type { GameView } from "../engine/view";
import { flightsBetween } from "./motion";

const NAMES = ["flip", "draw", "place", "discard", "deal", "column", "turn", "win", "end"] as const;
export type Sound = (typeof NAMES)[number];

/** Sounds that announce something rather than accompany a card; they land just after the card. */
const LATE = new Set<Sound>(["column", "turn", "win", "end"]);

const MUTED_KEY = "skyjo:muted";
let ctx: AudioContext | null = null;
const buffers = new Map<Sound, AudioBuffer>();

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
}
let muted = readMuted();

/**
 * Browsers only start audio after a user gesture, so main.tsx calls this on every tap. The first
 * call creates the context and loads the sounds; later calls resume it if the OS suspended it.
 */
export function unlockAudio() {
  if (ctx) {
    if (ctx.state === "suspended") void ctx.resume();
    return;
  }
  // iOS 17+: like other casual games, stay quiet when the ring/silent switch is on silent.
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (session) session.type = "ambient";
  const audio = new AudioContext();
  ctx = audio;
  for (const name of NAMES) {
    fetch(`/sfx/${name}.mp3`)
      .then((r) => r.arrayBuffer())
      .then((data) => audio.decodeAudioData(data))
      .then((buffer) => buffers.set(name, buffer))
      .catch(() => {
        // A missing sound just stays silent.
      });
  }
}

function play(name: Sound) {
  const buffer = buffers.get(name);
  if (muted || !ctx || !buffer) return;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(ctx.currentTime + (LATE.has(name) ? 0.25 : 0));
}

/** What to play between two views of the same table, as seen from `seat` (null = watching). */
export function soundsBetween(prev: GameView, cur: GameView, seat: number | null): Sound[] {
  if (prev.round !== cur.round) return cur.phase === "flip" ? ["deal"] : [];
  const out = new Set<Sound>();
  const { moves, flips } = flightsBetween(prev, cur);
  for (const [to, from] of moves) {
    if (to === "drawn") out.add("draw");
    else if (to === "discard") out.add("discard");
    else if (from === "drawn") out.add("place");
  }
  if (flips.length) out.add("flip");
  const removed = cur.players.some((p, s) =>
    p.grid.some((slot, i) => slot === null && prev.players[s]?.grid[i] !== null),
  );
  if (removed) out.add("column");
  const myTurn = (v: GameView) => seat !== null && v.phase === "draw" && v.current === seat;
  if (myTurn(cur) && !myTurn(prev)) out.add("turn");
  if (cur.phase === "gameOver" && prev.phase !== "gameOver") {
    out.add(seat !== null && cur.winners.includes(seat) ? "win" : "end");
  }
  return [...out];
}

/** Plays the sounds for each change of `view`. */
export function useSounds(view: GameView, seat: number | null) {
  const prev = useRef<GameView | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = view;
    if (before) for (const name of soundsBetween(before, view, seat)) play(name);
  }, [view, seat]);
}

/** The mute switch, remembered across visits. */
export function useMuted(): [boolean, () => void] {
  const [value, setValue] = useState(muted);
  const toggle = () => {
    muted = !muted;
    setValue(muted);
    try {
      localStorage.setItem(MUTED_KEY, muted ? "1" : "0");
    } catch {
      // Not remembered next visit; still applies now.
    }
  };
  return [value, toggle];
}
