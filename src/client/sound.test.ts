import { afterEach, describe, expect, it, vi } from "vitest";
import { type Action, apply, createGame, type GameState } from "../engine/game";
import { toView } from "../engine/view";
import { soundsBetween } from "./sound";

/** A fake AudioContext that records what the unlock does to it. */
function fakeAudio(state: "suspended" | "running" | "interrupted") {
  const started: number[] = [];
  const calls: string[] = [];
  const ctx = {
    state,
    sampleRate: 48000,
    destination: {},
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    createBuffer: (_c: number, length: number) => ({ length }),
    createBufferSource: () => ({
      buffer: null as { length: number } | null,
      connect() {},
      start() {
        started.push(this.buffer?.length ?? -1);
      },
    }),
    decodeAudioData: async () => ({}),
    async resume() {
      calls.push("resume");
      ctx.state = "running";
    },
    async suspend() {
      calls.push("suspend");
      ctx.state = "suspended";
    },
  };
  // `new AudioContext()` hands back this one object.
  vi.stubGlobal("AudioContext", function fake() {
    return ctx;
  });
  vi.stubGlobal("fetch", async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }));
  return { ctx, started, calls };
}

/** sound.ts keeps the context in module state, so each test gets a fresh module. */
const load = () => import("./sound");

describe("unlockAudio", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("creates the context on the first gesture and unlocks it iOS-style: silent buffer + resume", async () => {
    const { ctx, started, calls } = fakeAudio("suspended");
    const { unlockAudio } = await load();
    unlockAudio();
    expect(started).toEqual([1]); // a 1-frame silent buffer, started inside the gesture
    expect(calls).toEqual(["resume"]);
    expect(ctx.state).toBe("running");
  });

  it("does nothing once the context runs (no clicks or glitches on every tap)", async () => {
    const { started, calls } = fakeAudio("running");
    const { unlockAudio } = await load();
    unlockAudio();
    unlockAudio();
    expect(started).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("treats iOS's 'interrupted' like suspended", async () => {
    const { ctx, calls } = fakeAudio("suspended");
    const { unlockAudio } = await load();
    unlockAudio();
    ctx.state = "interrupted";
    unlockAudio();
    expect(calls).toEqual(["resume", "resume"]);
  });

  it("recoverAudio suspends then resumes, and is a no-op before the first gesture", async () => {
    const { calls } = fakeAudio("running");
    const { recoverAudio, unlockAudio } = await load();
    recoverAudio();
    expect(calls).toEqual([]);
    unlockAudio();
    recoverAudio();
    await vi.waitFor(() => expect(calls).toEqual(["suspend", "resume"]));
  });

  it("is silent, not broken, where Web Audio doesn't exist", async () => {
    vi.stubGlobal("AudioContext", undefined);
    const { unlockAudio, recoverAudio } = await load();
    expect(() => {
      unlockAudio();
      recoverAudio();
    }).not.toThrow();
  });
});

/** 2 players past the flip phase, seat 0 about to draw, with its own grid and next deck card. */
function table(grid: number[], up: number[], nextDraw: number): GameState {
  const s = createGame(["A", "B"], [1, 0, 0, 0]);
  s.phase = "draw";
  s.current = 0;
  s.players[0].grid = grid.map((card, i) => ({ card, up: up.includes(i) }));
  s.deck.push(nextDraw);
  return s;
}

const sounds = (s: GameState, seat: number, ...actions: Action[]) => {
  const before = actions.slice(0, -1).reduce(apply, s);
  return soundsBetween(toView(before), toView(apply(before, actions.at(-1) as Action)), seat);
};

const GRID = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const draw: Action = { type: "draw", seat: 0, source: "deck" };

describe("soundsBetween", () => {
  it("a brand-new game deals with a sound; joining a game in progress is silent", () => {
    const fresh = createGame(["A", "B"], [1, 0, 0, 0]);
    expect(soundsBetween(null, toView(fresh), 0)).toEqual(["deal"]);
    expect(soundsBetween(null, toView(table(GRID, [0, 1], 0)), 0)).toEqual([]);
  });

  it("an update that changes nothing on the table (e.g. presence) is silent", () => {
    const view = toView(table(GRID, [0, 1], 0));
    expect(soundsBetween(view, { ...view }, 0)).toEqual([]);
  });

  it("a spectator never hears 'your turn' or a win", () => {
    const s = table(GRID, [0, 1], 0);
    const over = { ...toView(s), phase: "gameOver" as const, winners: [1] };
    expect(soundsBetween(toView(s), over, null)).toEqual(["end"]);
    expect(
      sounds(table(GRID, [0, 1], 0), 0, draw, { type: "swap", seat: 0, pos: 5 }),
    ).not.toContain("turn");
  });

  it("drawing slides a card", () => {
    expect(sounds(table(GRID, [0, 1], 0), 1, draw)).toEqual(["draw"]);
  });

  it("a swap places the card and discards the old one; the next player hears their turn", () => {
    expect(sounds(table(GRID, [0, 1], 0), 1, draw, { type: "swap", seat: 0, pos: 5 })).toEqual([
      "place",
      "discard",
      "turn",
    ]);
  });

  it("discard-and-flip discards and flips", () => {
    expect(
      sounds(table(GRID, [0, 1], 0), 0, draw, { type: "discardAndFlip", seat: 0, pos: 5 }),
    ).toEqual(["discard", "flip"]);
  });

  it("a completed column chimes", () => {
    const s = table([5, 1, 2, 3, 5, 2, 3, 4, 9, 3, 4, 1], [0, 4], 5);
    expect(sounds(s, 1, draw, { type: "swap", seat: 0, pos: 8 })).toContain("column");
  });

  it("a new round deals", () => {
    const s = table(GRID, [0, 1], 0);
    expect(soundsBetween(toView(s), { ...toView(s), round: 2, phase: "flip" }, 0)).toEqual([
      "deal",
    ]);
  });

  it("game over: the winner hears a win, everyone else the end", () => {
    const s = table(GRID, [0, 1], 0);
    const over = { ...toView(s), phase: "gameOver" as const, winners: [1] };
    expect(soundsBetween(toView(s), over, 1)).toContain("win");
    expect(soundsBetween(toView(s), over, 0)).toContain("end");
  });
});

describe("nudge (M8)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** A phone whose sounds are decoded, with `muted` remembered from an earlier visit. */
  async function phone(muted: boolean) {
    const audio = fakeAudio("running");
    const vibrate = vi.fn();
    vi.stubGlobal("navigator", { vibrate, userActivation: { hasBeenActive: true } });
    vi.stubGlobal("localStorage", { getItem: () => (muted ? "1" : "0"), setItem() {} });
    const sound = await load();
    sound.unlockAudio();
    await new Promise((done) => setTimeout(done, 10)); // fetch and decode
    return { ...sound, vibrate, ticks: () => audio.started.length };
  }
  const own = { seat: 1, inMs: 4_000, reason: "timer" } as const;

  it("M8: the 5 s tick and vibration fire once per turn, only for the phone's own clock", async () => {
    const { nudge, vibrate, ticks } = await phone(false);
    nudge(own, 6, "r1-1");
    nudge(undefined, 5, "r1-1"); // another player's turn, or watching: no clock of its own
    nudge({ ...own, reason: "auto" }, 0, "r1-1");
    expect([vibrate.mock.calls.length, ticks()]).toEqual([0, 0]);
    nudge(own, 5, "r1-1");
    nudge(own, 4, "r1-1");
    nudge(own, 5, "r1-1"); // a draw at 25 s gave it 10 s more
    expect([vibrate.mock.calls.length, ticks()]).toEqual([1, 1]);
    nudge(own, 5, "r1-1-next");
    expect([vibrate.mock.calls.length, ticks()]).toEqual([2, 2]);
  });

  it("M8: never when muted", async () => {
    const { nudge, vibrate, ticks } = await phone(true);
    nudge(own, 5, "r1-1");
    expect([vibrate.mock.calls.length, ticks()]).toEqual([0, 0]);
  });
});
