import { describe, expect, it } from "vitest";
import { type Action, type GameState, legalActions, newDeck } from "../engine/game";
import { toView } from "../engine/view";
import { type Key, LOCALES, translator } from "./i18n";
import { begin, type Lesson, next, play, RIVAL, STEPS, tap } from "./lesson";
import { endedNote } from "./Table";

const cards = (s: GameState) =>
  [
    ...s.deck,
    ...s.discard,
    ...s.players.flatMap((p) => p.grid.flatMap((slot) => (slot ? [slot.card] : []))),
    ...(s.drawn === null ? [] : [s.drawn]),
  ].sort((a, b) => a - b);

/** Plays a step the way a player would: its taps (last first when `reversed`), then the rival. */
function through(lesson: Lesson, reversed = false): Lesson {
  const step = STEPS[lesson.step];
  if (!step.taps) return next(lesson);
  let l = lesson;
  for (const action of reversed ? [...step.taps].reverse() : step.taps) {
    const after = tap(l, action);
    if (!after) throw new Error(`step ${lesson.step} refused its own tap`);
    l = after;
  }
  while (l.queue.length) l = play(l);
  return l;
}

/** The lesson at the start of each step, and after the last one. */
function lessons(reversed = false): Lesson[] {
  const all = [begin("You")];
  for (const _ of STEPS) all.push(through(all.at(-1) as Lesson, reversed));
  return all;
}

const view = (l: Lesson) => toView(l.state);
const mine = (l: Lesson) => view(l).players[0].grid;

describe("the tutorial's script (M31)", () => {
  it("R1: the stacked deal is a whole deck, 12 cards each face down and one on the discard", () => {
    const { state } = begin("You");
    expect(cards(state)).toEqual(newDeck().sort((a, b) => a - b));
    expect(state.players.map((p) => p.grid.filter((slot) => slot && !slot.up).length)).toEqual([
      12, 12,
    ]);
    expect(state.players.map((p) => p.name)).toEqual(["You", RIVAL]);
    expect([state.phase, state.discard.length]).toEqual(["flip", 1]);
  });

  it("every step is legal engine play, in either order of its taps, and conserves the cards", () => {
    for (const reversed of [false, true]) {
      for (const l of lessons(reversed)) {
        expect(cards(l.state)).toEqual(newDeck().sort((a, b) => a - b));
      }
    }
    expect(lessons(true).at(-1)?.state).toEqual(lessons().at(-1)?.state);
  });

  it("a step takes only its own taps: every other legal move, and any tap while the rival plays, is refused", () => {
    const same = (a: Action, b: Action) => JSON.stringify(a) === JSON.stringify(b);
    for (const l of lessons().slice(0, -1)) {
      const asked = STEPS[l.step].taps ?? [];
      // Only the player is ever asked to tap.
      expect(asked.every((a) => "seat" in a && a.seat === 0)).toBe(true);
      for (const action of legalActions(l.state)) {
        expect(tap(l, action) !== null).toBe(asked.some((a) => same(a, action)));
      }
      const after = asked.length ? tap(l, asked[0]) : null;
      if (after?.queue.length) {
        for (const action of legalActions(after.state)) expect(tap(after, action)).toBeNull();
      }
    }
  });

  it("R3, R4: you flip a −2 and a 12, Leo a lower pair, so you start", () => {
    const l = lessons()[1];
    expect(mine(l).filter((slot) => typeof slot === "number")).toEqual([-2, 12]);
    expect([view(l).phase, view(l).current]).toEqual(["draw", 0]);
    // Next: the lesson about low cards points at those two, and waits for "Next".
    expect(STEPS[1]).toMatchObject({ at: [8, 9] });
    expect(STEPS[1].taps).toBeUndefined();
  });

  it("R7, R8: the discard's 3 replaces your 12, which goes onto the pile", () => {
    const [before, held, after] = lessons().slice(2);
    expect(view(before).discardTop).toBe(3);
    expect([view(held).drawn, view(held).drawnFrom]).toEqual([3, "discard"]);
    expect(mine(after)[9]).toBe(3);
    // Leo then drew an 8 and threw it away.
    expect([view(after).discardTop, view(after).current, view(after).phase]).toEqual([
      8,
      0,
      "draw",
    ]);
  });

  it("R6: you draw an 11 from the deck, throw it away and flip a 3 under your first", () => {
    const [held, after] = lessons().slice(5);
    expect([view(held).drawn, view(held).drawnFrom]).toEqual([11, "deck"]);
    expect([mine(after)[5], mine(after)[9]]).toEqual([3, 3]);
    // Leo then swapped a 3 out of his grid: it is on the pile for you.
    expect(view(after).discardTop).toBe(3);
  });

  it("R9: the third 3 clears the column, with a 3 left on top of the pile", () => {
    const l = lessons()[8];
    expect([1, 5, 9].map((pos) => mine(l)[pos])).toEqual([null, null, null]);
    expect(view(l).discardTop).toBe(3);
  });

  it("skipping ahead is engine play too: your turn, one card face down, a 1 on the pile", () => {
    const l = lessons()[9];
    expect(mine(l).filter((slot) => slot === "down")).toHaveLength(1);
    expect(mine(l)[0]).toBe("down");
    expect([view(l).phase, view(l).current, view(l).discardTop, view(l).ender]).toEqual([
      "draw",
      0,
      1,
      null,
    ]);
  });

  it("R10, R12: your last card ends the round, Leo plays once more and scores lower, so your 9 doubles", () => {
    const end = lessons().at(-1) as Lesson;
    expect(end.step).toBe(STEPS.length);
    const v = view(end);
    expect([v.phase, v.ender, v.doubled]).toEqual(["roundOver", 0, true]);
    expect(v.players.map((p) => p.total)).toEqual([18, 7]);
    // The summary's own sentence explains it (M27).
    expect(endedNote(translator("en"), v)).toContain("scored lower");
    // Nothing more to tap or play.
    expect(tap(end, { type: "nextRound" })).toBeNull();
    expect(next(end)).toBe(end);
  });

  it("each instruction is 8 words or fewer in English, Spanish and Portuguese", () => {
    const keys = STEPS.flatMap((s) => [s.say, ...(s.thrown ? [s.thrown.say] : [])]);
    expect(keys.length).toBeGreaterThan(STEPS.length);
    for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      const t = translator(locale);
      for (const key of [...keys, "tutorRival"] as Key[]) {
        const words = t(key, { name: RIVAL }).split(/\s+/);
        expect([locale, key, words.length <= 8]).toEqual([locale, key, true]);
      }
    }
  });
});
