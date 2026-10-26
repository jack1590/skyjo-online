import { afterEach, describe, expect, it, vi } from "vitest";
import { type Action, apply, createGame, type GameState } from "../engine/game";
import { toView } from "../engine/view";
import {
  COLUMN,
  FLIP_MS,
  flipDelays,
  IN_MS,
  LIFT_MS,
  path,
  revealStep,
  slotKey,
  thrown,
} from "./motion";
import { type Sound, soundsBetween } from "./sound";

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

  it("UX-3: play says whether a sound started: not before the first gesture, nor before its file is decoded", async () => {
    fakeAudio("running");
    const { play, unlockAudio } = await load();
    expect(play("flip")).toBe(false);
    unlockAudio();
    await vi.waitFor(() => expect(play("flip")).toBe(true));
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

/** Just the names, in order (each sound comes with its delay). */
const names = (timed: [Sound, number][]) => timed.map(([name]) => name);

const sounds = (s: GameState, seat: number, ...actions: Action[]) => {
  const before = actions.slice(0, -1).reduce(apply, s);
  return names(
    soundsBetween(toView(before), toView(apply(before, actions.at(-1) as Action)), seat),
  );
};

const GRID = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const upExcept = (pos: number) => [...Array(12).keys()].filter((i) => i !== pos);
const draw: Action = { type: "draw", seat: 0, source: "deck" };

describe("soundsBetween", () => {
  it("a brand-new game deals with a sound; joining a game in progress is silent", () => {
    const fresh = createGame(["A", "B"], [1, 0, 0, 0]);
    expect(names(soundsBetween(null, toView(fresh), 0))).toEqual(["deal"]);
    expect(names(soundsBetween(null, toView(table(GRID, [0, 1], 0)), 0))).toEqual([]);
  });

  it("an update that changes nothing on the table (e.g. presence) is silent", () => {
    const view = toView(table(GRID, [0, 1], 0));
    expect(names(soundsBetween(view, { ...view }, 0))).toEqual([]);
  });

  it("a spectator never hears 'your turn' or a win", () => {
    const s = table(GRID, [0, 1], 0);
    const over = { ...toView(s), phase: "gameOver" as const, winners: [1] };
    expect(names(soundsBetween(toView(s), over, null))).toEqual(["end"]);
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

  it("UX-19: throwing the card away sounds as it lands on the pile, Undo as you pick it up, and the flip that follows only flips", () => {
    const s = apply(table(GRID, [0, 1], 0), draw);
    const held = toView(s);
    const flipped = toView(apply(s, { type: "discardAndFlip", seat: 0, pos: 5 }));
    expect(names(soundsBetween(held, thrown(held), 0))).toEqual(["discard"]);
    expect(names(soundsBetween(thrown(held), held, 0))).toEqual(["draw"]);
    expect(names(soundsBetween(thrown(held), flipped, 0))).toEqual(["flip"]);
    // The clock ran out and the server swapped it in: it is placed, and the old card discarded.
    const swapped = toView(apply(s, { type: "swap", seat: 0, pos: 5 }));
    expect(names(soundsBetween(thrown(held), swapped, 0))).toEqual(["place", "discard"]);
  });

  it("UX-3: the sound you heard as you tapped isn't played again when the server's answer arrives, once; other players' still are", () => {
    const s = table(GRID, [0, 1], 0);
    const held = apply(s, draw);
    const swapped = apply(held, { type: "swap", seat: 0, pos: 5 });
    const answer = (
      from: GameState,
      to: GameState,
      seat: number,
      heard: { current: Sound | null },
    ) => names(soundsBetween(toView(from), toView(to), seat, undefined, heard));
    const heard = { current: "draw" as Sound | null };
    expect(answer(s, held, 1, heard), "watching seat 0 draw").toEqual(["draw"]);
    expect(heard.current, "not used up by someone else's card").toBe("draw");
    expect(answer(s, held, 0, heard)).toEqual([]);
    expect(heard.current, "used up").toBe(null);
    expect(answer(s, held, 0, heard), "only once").toEqual(["draw"]);
    // The card going in sounded at the tap; the one leaving still sounds as it lands.
    expect(answer(held, swapped, 0, { current: "place" })).toEqual(["discard"]);
    // The opening flip, where everyone taps at once: only your own card was heard already.
    const fresh = createGame(["A", "B"], [1, 0, 0, 0]);
    const mine = apply(fresh, { type: "flip", seat: 0, pos: 0 });
    expect(answer(fresh, mine, 0, { current: "flip" })).toEqual([]);
    const theirs = apply(mine, { type: "flip", seat: 1, pos: 3 });
    expect(answer(mine, theirs, 0, { current: "flip" })).toEqual(["flip"]);
  });

  /** A card's sounds and announcements, as useFlights times a flight that starts at `start`. */
  const flight = (start: number, { hit, duration }: { hit: number; duration: number }) => ({
    start,
    hit: start + hit,
    end: start + duration,
  });
  const card = (x: number, y: number, width: number) => ({
    x: x - width / 2,
    y: y - (width * 7) / 10,
    width,
    height: (width * 7) / 5,
  });
  // A phone's piles (medium cards).
  const drawn = card(195, 250, 58);
  const pile = card(297, 250, 58);

  it("UX-23: a swap's sounds peak as its cards land: the discard 210 ms and the place 160 ms before (±30 ms of touching down and of settling); the card going in starts ≥ 80 ms after the one leaving, and all is done in 560 ms", () => {
    const s = apply(table(GRID, [0, 1], 0), draw);
    const before = toView(s);
    const after = toView(apply(s, { type: "swap", seat: 0, pos: 5 }));
    // A slot low and high in your grid, then one in an opponent's.
    for (const slot of [card(150, 560, 80), card(240, 400, 80), card(60, 90, 26)]) {
      const out = flight(0, path(slot, pile, { lift: LIFT_MS, turn: true }));
      const into = flight(IN_MS, path(drawn, slot));
      const timing = new Map([
        ["discard", out],
        [slotKey(0, 5), into],
      ]);
      expect(into.start - out.start).toBeGreaterThanOrEqual(80);
      expect(Math.max(out.end, into.end)).toBeLessThanOrEqual(560);
      const at = new Map(soundsBetween(before, after, 1, timing));
      const loudest = {
        discard: (at.get("discard") ?? -1) + 210,
        place: (at.get("place") ?? -1) + 160,
      };
      for (const [name, f, lift] of [
        ["discard", out, LIFT_MS],
        ["place", into, 0],
      ] as const) {
        const touchdown = f.start + lift + 0.88 * (f.end - f.start - lift);
        expect(Math.abs(loudest[name] - touchdown), `${name} vs touching down`).toBeLessThanOrEqual(
          30,
        );
        expect(Math.abs(loudest[name] - f.end), `${name} vs settled`).toBeLessThanOrEqual(30);
      }
    }
  });

  it("UX-22: a draw sounds as the card reaches your hand; without motion, at once", () => {
    const s = table(GRID, [0, 1], 0);
    const [before, after] = [toView(s), toView(apply(s, draw))];
    const timing = new Map([["drawn", { start: 0, hit: 320, end: 340 }]]);
    expect(soundsBetween(before, after, 1, timing)).toEqual([["draw", 320 - 130]]);
    expect(soundsBetween(before, after, 1)).toEqual([["draw", 0]]);
  });

  it("UX-26: a swap that completes a column places and discards as its cards land, chimes as the column pulses, and 'your turn' sounds once the column is on the pile; without motion, 250 ms after the cards", () => {
    // Seat 0 completes a column (5, 5, 5 in column 0) by swapping its last card in; seat 1 is next.
    const s = apply(table([5, 1, 2, 3, 5, 2, 3, 4, 9, 3, 4, 1], [0, 4], 5), draw);
    const before = toView(s);
    const after = toView(apply(s, { type: "swap", seat: 0, pos: 8 }));
    const slot = card(150, 560, 80);
    const out = flight(0, path(slot, pile, { lift: LIFT_MS }));
    const into = flight(IN_MS, path(drawn, slot));
    const pulse = Math.max(out.end, into.end) + COLUMN.beat;
    const end = pulse + COLUMN.pulse + 2 * COLUMN.gap + COLUMN.fly;
    const timing = new Map([
      ["discard", out],
      [slotKey(0, 8), into],
      ["column", { start: pulse, hit: pulse, end }],
    ]);
    expect(soundsBetween(before, after, 1, timing)).toEqual([
      ["place", into.hit - 160],
      ["discard", out.hit - 210],
      ["column", pulse],
      ["turn", end],
    ]);
    const now = new Map(soundsBetween(before, after, 1));
    expect([now.get("discard"), now.get("column"), now.get("turn")]).toEqual([0, 250, 250]);
  });

  it("M19 (M10 PO): the sound you heard as you tapped is used up by the answer when it completes a column: a discard-and-flip's flip, a swap's place", () => {
    const answer = (grid: number[], action: Action, sound: Sound) => {
      const held = apply(table(grid, [0, 4], 5), draw);
      const heard = { current: sound as Sound | null };
      const out = soundsBetween(toView(held), toView(apply(held, action)), 0, undefined, heard);
      return { sounds: names(out), heard: heard.current };
    };
    // Column 0: 9, 9 and a face-down 9, turned over after throwing the 5 away.
    const flipped = answer(
      [9, 1, 2, 3, 9, 2, 3, 4, 9, 3, 4, 1],
      { type: "discardAndFlip", seat: 0, pos: 8 },
      "flip",
    );
    expect(flipped).toEqual({ sounds: ["discard", "column"], heard: null });
    // Column 0: 5, 5 and a face-down card the 5 is swapped into.
    const swapped = answer(
      [5, 1, 2, 3, 5, 2, 3, 4, 9, 3, 4, 1],
      { type: "swap", seat: 0, pos: 8 },
      "place",
    );
    expect(swapped).toEqual({ sounds: ["discard", "column"], heard: null });
  });

  it("a completed column chimes", () => {
    const s = table([5, 1, 2, 3, 5, 2, 3, 4, 9, 3, 4, 1], [0, 4], 5);
    expect(sounds(s, 1, draw, { type: "swap", seat: 0, pos: 8 })).toContain("column");
  });

  it("a new round deals", () => {
    const s = table(GRID, [0, 1], 0);
    expect(names(soundsBetween(toView(s), { ...toView(s), round: 2, phase: "flip" }, 0))).toEqual([
      "deal",
    ]);
  });

  it("game over: the winner hears a win, everyone else the end", () => {
    const s = table(GRID, [0, 1], 0);
    const over = { ...toView(s), phase: "gameOver" as const, winners: [1] };
    expect(names(soundsBetween(toView(s), over, 1))).toContain("win");
    expect(names(soundsBetween(toView(s), over, 0))).toContain("end");
  });

  it("M13: the game-over cue fires once: not again on a later view of the same game over, nor on opening a finished game", () => {
    const s = table(GRID, [0, 1], 0);
    const over = { ...toView(s), phase: "gameOver" as const, winners: [1] };
    for (const seat of [0, 1, null]) {
      expect(names(soundsBetween(toView(s), over, seat))).toHaveLength(1);
      expect(names(soundsBetween(over, { ...over }, seat))).toEqual([]);
      expect(names(soundsBetween(null, over, seat))).toEqual([]);
    }
  });

  it("M13 (M17 PO): going out (R16) sounds at that round's summary, for that player only, once", () => {
    const s = table(GRID, [0, 1], 0);
    const view = toView(s);
    // Seat 1 reached 100 this round and is out; the game goes on.
    const players = view.players.map((p, i) => (i === 1 ? { ...p, out: view.round } : p));
    const summary = { ...view, phase: "roundOver" as const, players };
    expect(soundsBetween(view, summary, 1)).toEqual([["out", 250]]);
    for (const seat of [0, null]) expect(names(soundsBetween(view, summary, seat))).toEqual([]);
    expect(names(soundsBetween(summary, { ...summary }, 1))).toEqual([]);
    // Out in the game's last round: game over's cue, not the out one.
    const over = { ...summary, phase: "gameOver" as const, winners: [0] };
    expect(names(soundsBetween(view, over, 1))).toEqual(["end"]);
  });

  it("M14: the round's last turns start with a cue for everyone, once; it stands in for the next player's 'your turn'", () => {
    // Seat 0 reveals its last face-down card (R10): seat 1's turn is the first of the last turns.
    const s = apply(table(GRID, upExcept(5), 0), draw);
    const ended = apply(s, { type: "discardAndFlip", seat: 0, pos: 5 });
    expect(ended.ender).toBe(0);
    for (const seat of [0, 1, null]) {
      expect(names(soundsBetween(toView(s), toView(ended), seat))).toEqual([
        "discard",
        "flip",
        "last",
      ]);
    }
    // Seat 1's last turn: nothing new about the round, so no second cue.
    const next = apply(apply(ended, { type: "draw", seat: 1, source: "deck" }), {
      type: "swap",
      seat: 1,
      pos: 0,
    });
    expect(names(soundsBetween(toView(ended), toView(next), 0))).not.toContain("last");
    expect(names(soundsBetween(toView(ended), toView(ended), 1))).toEqual([]);
    expect(names(soundsBetween(null, toView(ended), 1))).toEqual([]);
  });

  it("M14: with motion, the last-round cue sounds once the ender's cards have landed", () => {
    const s = apply(table(GRID, upExcept(5), 0), draw);
    const ended = toView(apply(s, { type: "discardAndFlip", seat: 0, pos: 5 }));
    const timing = new Map([["discard", { start: 0, hit: 300, end: 420 }]]);
    expect(soundsBetween(toView(s), ended, null, timing)).toContainEqual(["last", 420]);
  });

  /** A's last turn, after B (seat 1) ended: C's 3 face-down cards turn over, then A's. */
  function lastTurn() {
    // Low cards, no equal column: the round ends well under 100.
    const LOW = [0, 1, 2, 3, 1, 2, 3, 0, 2, 3, 0, 1];
    const s = createGame(["A", "B", "C"], [1, 0, 0, 0]);
    s.phase = "draw";
    s.current = 0;
    s.ender = 1;
    const deal = (down: number[]) => LOW.map((card, i) => ({ card, up: !down.includes(i) }));
    s.players[0].grid = deal([3, 4, 9]);
    s.players[1].grid = deal([]);
    s.players[2].grid = deal([10, 1, 6]);
    s.deck.push(0);
    const before = toView(apply(s, draw));
    const after = toView(apply(apply(s, draw), { type: "discardAndFlip", seat: 0, pos: 4 }));
    return { before, after, over: { ...after, phase: "gameOver" as const, winners: [2] } };
  }

  /** When each final-reveal flip starts and ends, as useFlights plays them. */
  const reveal = (flips: string[], tapped?: string) =>
    new Map(
      flipDelays(flips, revealStep(flips.length), tapped).map(([key, start]) => [
        key,
        { start, hit: start + FLIP_MS.sm, end: start + FLIP_MS.sm },
      ]),
    );
  const ORDER = [
    slotKey(2, 1),
    slotKey(2, 6),
    slotKey(2, 10),
    slotKey(0, 3),
    slotKey(0, 4),
    slotKey(0, 9),
  ];

  it("UX-27: with motion, each player's cards turn over with a flip sound as they start, and game over sounds when the summary shows", () => {
    const { before, after, over } = lastTurn();
    const step = revealStep(6);
    const timing = reveal(ORDER);
    expect(soundsBetween(before, after, 0, timing)).toEqual([
      ["discard", 0],
      ["flip", 0],
      ["flip", 3 * step],
    ]);
    // 250 ms after the summary shows, 600 ms after the last card has turned.
    const shows = 5 * step + FLIP_MS.sm + 600 + 250;
    expect(soundsBetween(before, over, 0, timing)).toContainEqual(["end", shows]);
    expect(soundsBetween(before, over, 2, timing)).toContainEqual(["win", shows]);
    // Going out (M13) sounds as its summary shows, too.
    const players = after.players.map((p, i) => (i === 0 ? { ...p, out: after.round } : p));
    const summary = { ...after, phase: "roundOver" as const, players };
    expect(soundsBetween(before, summary, 0, timing)).toContainEqual(["out", shows]);
  });

  it("UX-27 (PO, PR #25): on the phone that tapped the last card, the flip sounds follow the order the cards turn: that card first, everyone else a step later", () => {
    const { before, after } = lastTurn();
    const step = revealStep(6);
    // A tapped slot-0-4: it turns at 0, C's cards from 1 step, A's other two from 4 steps.
    const flips = soundsBetween(before, after, 0, reveal(ORDER, slotKey(0, 4))).filter(
      ([name]) => name === "flip",
    );
    expect(flips).toEqual([
      ["flip", 0],
      ["flip", step],
      ["flip", 4 * step],
    ]);
  });

  it("UX-27: with reduced motion, nothing is staggered, so everything sounds at once", () => {
    const { before, over } = lastTurn();
    expect(soundsBetween(before, over, 0)).toEqual([
      ["discard", 0],
      ["flip", 0],
      ["end", 250],
    ]);
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

  it("M8: once per turn, every lap: the same turn key comes round again", async () => {
    const { nudge, vibrate } = await phone(false);
    nudge(own, 5, "1-1"); // seat 1's turn
    nudge(undefined, 5, "1-0"); // seat 0's turn: no clock of its own here
    nudge(own, 5, "1-1"); // seat 1 again, next lap
    expect(vibrate.mock.calls.length).toBe(2);
  });

  it("M8: muted, it still vibrates but makes no tick", async () => {
    const { nudge, vibrate, ticks } = await phone(true);
    nudge(own, 5, "r1-1");
    nudge(own, 4, "r1-1");
    expect([vibrate.mock.calls.length, ticks()]).toEqual([1, 0]);
  });

  const later = () => new Promise((done) => setTimeout(done, 5));

  it("M14: the last-round cue and the results vibrate with their sounds; the winner's pattern is the longest, going out's short", async () => {
    const { cue, BUZZ, vibrate, ticks } = await phone(false);
    for (const name of ["last", "win", "out", "end", "flip"] as const) cue(name);
    await later();
    expect(ticks()).toBe(5);
    expect(vibrate.mock.calls).toEqual([[BUZZ.last], [BUZZ.win], [BUZZ.out]]);
    const length = (name: Sound) => (BUZZ[name] ?? []).reduce((a, b) => a + b, 0);
    expect(length("win")).toBeGreaterThan(3 * length("out"));
  });

  it("M14: muted, like the nudge, the cues still vibrate but make no sound", async () => {
    const { cue, BUZZ, vibrate, ticks } = await phone(true);
    cue("win");
    cue("out");
    await later();
    expect([vibrate.mock.calls, ticks()]).toEqual([[[BUZZ.win], [BUZZ.out]], 0]);
  });

  it("M14: no vibration before the first tap on the page (browsers block it)", async () => {
    const { cue, vibrate } = await phone(false);
    vi.stubGlobal("navigator", { vibrate, userActivation: { hasBeenActive: false } });
    cue("win");
    await later();
    expect(vibrate).not.toHaveBeenCalled();
  });
});
