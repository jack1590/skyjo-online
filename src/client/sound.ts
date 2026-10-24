// Sound effects: tiny CC0 recordings (Kenney, see README) in public/sfx, decoded once into Web
// Audio buffers. Which sounds play is derived from consecutive views, like the card flights.
import { useEffect, useRef, useState } from "react";
import type { GameView } from "../engine/view";
import type { Wait } from "../protocol";
import { flightsBetween } from "./motion";

/** tick.mp3, the 5 s warning, is generated for this project (ffmpeg, two decaying sines). */
const NAMES = [
  "flip",
  "draw",
  "place",
  "discard",
  "deal",
  "column",
  "turn",
  "win",
  "end",
  "tick",
] as const;
export type Sound = (typeof NAMES)[number];

/** Sounds that announce something rather than accompany a card; they land just after the card. */
const LATE = new Set<Sound>(["column", "turn", "win", "end"]);
/** Several sounds can start together (place + discard + flip + column); keep the sum from clipping. */
const VOLUME = 0.6;

const MUTED_KEY = "skyjo:muted";
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers = new Map<Sound, AudioBuffer>();
/** Files are fetched at startup so even the first tap's sound is ready; decoding needs the context. */
let files: Promise<(readonly [Sound, ArrayBuffer])[]> | null = null;

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
}
let muted = readMuted();

/** Starts downloading the sounds (72 KB, also precached by the service worker). */
export function preloadSounds() {
  files ??= Promise.all(
    NAMES.map(
      async (name) => [name, await (await fetch(`/sfx/${name}.mp3`)).arrayBuffer()] as const,
    ),
  ).catch(() => []); // offline before the service worker cached them: the game just stays silent
}

/**
 * Browsers only start audio inside a user gesture, so main.tsx calls this on every tap and key
 * press. The first call creates the context and decodes the sounds. Every call while the context
 * isn't running unlocks it the way Howler and unmute-ios-audio do: start a silent buffer *and*
 * resume(), inside the gesture. resume() is what the spec asks for; the buffer is what older iOS
 * needs. Both cover "suspended" and iOS's non-standard "interrupted" (after an app switch).
 * (No `navigator.audioSession.type`: WebKit already picks "ambient" for a page that only uses
 * Web Audio, so sounds follow the ring/silent switch like other casual games.)
 */
export function unlockAudio() {
  if (!ctx) {
    if (typeof AudioContext === "undefined") return; // very old browsers: silently no sound
    const audio = new AudioContext();
    ctx = audio;
    master = audio.createGain();
    master.gain.value = VOLUME;
    master.connect(audio.destination);
    preloadSounds();
    void files?.then((loaded) => {
      for (const [name, data] of loaded) {
        audio
          .decodeAudioData(data.slice(0))
          .then((buffer) => buffers.set(name, buffer))
          .catch(() => {
            // A file that won't decode just stays silent.
          });
      }
    });
  }
  if (ctx.state === "running") return;
  const silence = ctx.createBufferSource();
  silence.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  silence.connect(ctx.destination);
  silence.start();
  void ctx.resume().catch(() => {
    // Not in a gesture yet (or iOS refused): the next tap tries again.
  });
}

/**
 * After an app switch, the lock screen or another app's sound, iOS can leave the context silent
 * while it still reports "running", or stuck in "interrupted" where resume() alone does nothing
 * (WebKit bugs 276016, 283419, 291892). Suspending and resuming once the page is visible again is
 * the documented way out; main.tsx calls this on visibilitychange.
 */
export function recoverAudio() {
  const audio = ctx;
  if (!audio || audio.state === "closed") return;
  void audio
    .suspend()
    .then(() => audio.resume())
    .catch(() => {
      // Still locked: the next tap runs unlockAudio.
    });
}

function play(name: Sound) {
  const buffer = buffers.get(name);
  // A suspended context would queue sounds and blast them all at once later; drop them instead.
  if (muted || !ctx || !master || ctx.state !== "running" || !buffer) return;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(master);
  source.start(ctx.currentTime + (LATE.has(name) ? 0.25 : 0));
}

/** A table that has just been dealt: nobody has turned a card yet. */
const freshDeal = (v: GameView) =>
  v.phase === "flip" && v.players.every((p) => p.grid.every((slot) => slot === "down"));

/** What to play between two views of the same table, as seen from `seat` (null = watching). */
export function soundsBetween(prev: GameView | null, cur: GameView, seat: number | null): Sound[] {
  if (!prev) return freshDeal(cur) ? ["deal"] : []; // first view: only a brand-new game makes a sound
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

/** Plays the sounds for each change of `view`, including the deal when a new game appears. */
export function useSounds(view: GameView, seat: number | null) {
  const prev = useRef<GameView | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = view;
    for (const name of soundsBetween(before, view, seat)) play(name);
  }, [view, seat]);
}

let nudged: string | null = null;

/**
 * The turn-ending nudge (M8): one vibration and one soft tick when this phone's own clock reaches
 * 5 s, once per turn, never when muted. Only the acting player has a clock of its own: their seat's
 * `wait` entry, with reason "timer". `turn` names the turn, so a draw's extra time can't nudge twice.
 */
export function nudge(own: Wait | undefined, left: number | null, turn: string) {
  if (own?.reason !== "timer" || left === null || left > 5 || muted || nudged === turn) return;
  nudged = turn;
  // Browsers block vibrate before the first tap on the page (e.g. right after a reload).
  if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(200);
  play("tick");
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
