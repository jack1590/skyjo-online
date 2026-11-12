// The first-game tutorial's script (M31): one short round against one scripted rival, on a stacked
// deal. Pure: every move, the player's and the rival's, goes through the engine's `apply`, so the
// table shows real play. Not a local mode: there is nothing to choose, only the next tap.
import { type Action, apply, type Card, createGame, type GameState, newDeck } from "../engine/game";
import type { Key } from "./i18n";

const ME = 0;
const LEO = 1;
/** The rival's name: a name, the same in every language. */
export const RIVAL = "Leo";

/** What a step points at: one of your grid's positions, or a pile. */
export type Target = number | "deck" | "discard";

export interface Step {
  /** The instruction, 8 words or fewer. */
  say: Key;
  /** What it points at: the bubble at the first, a ring on each. */
  at?: Target[];
  /** Once the drawn card lies thrown on the pile (the table's own mode): what to say and point at. */
  thrown?: { say: Key; at: Target[] };
  /** The taps it waits for, in any order. None: it waits for "Next". */
  taps?: Action[];
  /** The rival's moves that follow, shown one at a time. */
  rival?: Action[];
  /** On "Next", the round plays on until you have one card face down. */
  ahead?: true;
}

const flip = (seat: number, pos: number): Action => ({ type: "flip", seat, pos });
const draw = (seat: number, source: "deck" | "discard"): Action => ({ type: "draw", seat, source });
const swap = (seat: number, pos: number): Action => ({ type: "swap", seat, pos });
const toss = (seat: number, pos: number): Action => ({ type: "discardAndFlip", seat, pos });

// The deal, by grid position (row * 4 + col). Yours: a −2 and a 12 to flip (8, 9), a 3 under a 10
// over that 12 (column 1), and 9 points left at the end. Leo's adds up to 7 once he swaps his 3.
const MINE: Card[] = [9, 10, 1, 4, 0, 3, 2, -1, -2, 12, 3, 1];
const THEIRS: Card[] = [3, 4, 0, -1, 0, -2, 2, 1, 0, -1, 3, 0];
const DISCARD: Card = 3;
/** The deck's cards in the order they are drawn: Leo's 8, your 11, Leo's 1, 15 while skipping
 * ahead (the last one, a 1, is the pile's top for your last turn), then Leo's last. */
const DRAWS: Card[] = [8, 11, 1, 7, 9, 6, 12, 8, 10, 5, 11, 7, 9, 6, 12, 8, 10, 1, 7];

export const STEPS: Step[] = [
  {
    say: "tutorFlip",
    at: [8, 9],
    taps: [flip(ME, 8), flip(ME, 9)],
    rival: [flip(LEO, 0), flip(LEO, 1)],
  },
  { say: "tutorLow", at: [8, 9] },
  { say: "tutorTake", at: ["discard"], taps: [draw(ME, "discard")] },
  { say: "tutorSwap", at: [9], taps: [swap(ME, 9)], rival: [draw(LEO, "deck"), toss(LEO, 2)] },
  { say: "tutorDraw", at: ["deck"], taps: [draw(ME, "deck")] },
  {
    say: "tutorThrow",
    at: ["discard"],
    thrown: { say: "tutorTurn", at: [5] },
    taps: [toss(ME, 5)],
    rival: [draw(LEO, "deck"), swap(LEO, 0)],
  },
  { say: "tutorTakeAgain", at: ["discard"], taps: [draw(ME, "discard")] },
  { say: "tutorColumn", at: [1], taps: [swap(ME, 1)] },
  { say: "tutorAhead", ahead: true },
  { say: "tutorLastTake", at: ["discard"], taps: [draw(ME, "discard")] },
  { say: "tutorLast", at: [0], taps: [swap(ME, 0)], rival: [draw(LEO, "deck"), toss(LEO, 3)] },
];

/** Where the lesson is: the game, the step, its taps still to come, the rival's moves to show. */
export interface Lesson {
  state: GameState;
  /** `STEPS.length` once the round is over. */
  step: number;
  left: Action[];
  queue: Action[];
}

const enter = (state: GameState, step: number): Lesson => ({
  state,
  step,
  left: STEPS[step]?.taps ?? [],
  queue: [],
});

/** A new lesson: the engine's own game, with the deal above in place of a shuffle. */
export function begin(me: string): Lesson {
  const state = createGame([me, RIVAL], [0]);
  const left = newDeck();
  const take = (cards: Card[]) => cards.map((card) => left.splice(left.indexOf(card), 1)[0]);
  state.players[ME].grid = take(MINE).map((card) => ({ card, up: false }));
  state.players[LEO].grid = take(THEIRS).map((card) => ({ card, up: false }));
  state.discard = take([DISCARD]);
  // The top of the deck is its last card.
  const draws = take(DRAWS).reverse();
  state.deck = [...left, ...draws];
  return enter(state, 0);
}

const same = (a: Action, b: Action) => JSON.stringify(a) === JSON.stringify(b);

/** The player's tap. Null when the step doesn't ask for it: the table then ignores it. */
export function tap(l: Lesson, action: Action): Lesson | null {
  if (l.queue.length || !l.left.some((a) => same(a, action))) return null;
  const state = apply(l.state, action);
  const left = l.left.filter((a) => !same(a, action));
  if (left.length) return { ...l, state, left };
  const queue = STEPS[l.step].rival ?? [];
  return queue.length ? { state, step: l.step, left, queue } : enter(state, l.step + 1);
}

/** The rival's next move. */
export function play(l: Lesson): Lesson {
  const [action, ...queue] = l.queue;
  const state = apply(l.state, action);
  return queue.length ? { ...l, state, queue } : enter(state, l.step + 1);
}

/** "Next", on a step with nothing to tap. */
export function next(l: Lesson): Lesson {
  const step = STEPS[l.step];
  if (!step || step.taps) return l;
  return enter(step.ahead ? ahead(l.state) : l.state, l.step + 1);
}

/** Both draw from the deck, throw it away and flip a card, until you have one face down. */
function ahead(state: GameState): GameState {
  let s = state;
  const down = (seat: number) =>
    s.players[seat].grid.flatMap((slot, pos) => (slot && !slot.up ? [pos] : []));
  while (s.current !== ME || down(ME).length > 1) {
    const seat = s.current;
    s = apply(s, draw(seat, "deck"));
    s = apply(s, toss(seat, down(seat).at(-1) as number));
  }
  return s;
}
