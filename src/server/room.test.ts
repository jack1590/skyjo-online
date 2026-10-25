import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Action, apply, createGame, type GameState, legalActions } from "../engine/game";
import { nextRandom, type Rng } from "../engine/rng";
import { type ClientMsg, parseClientMsg, TURN_MS } from "../protocol";
import {
  AUTO_FIRST_MS,
  AUTO_NEXT_MS,
  allowIp,
  allowMessage,
  autoMove,
  type Conn,
  dead,
  EMPTY_IDLE_MS,
  HELLO_MS,
  IDLE_MS,
  IP_MESSAGES_PER_MINUTE,
  ipKey,
  MAX_SOCKETS,
  newConn,
  newRoom,
  peerKey,
  Room,
  RoomError,
  STALE_MS,
  silent,
} from "./room";

function setup() {
  let now = 1_000_000;
  let seeds = 0;
  const deps = { now: () => now, seed: (): Rng => [++seeds, 7, 7, 7] };
  const room = new Room(newRoom("ABCDE", now), deps);
  const live: Conn[] = [];
  const send = (c: Conn, msg: ClientMsg) => room.receive(c, msg, live);
  const connect = (token: string) => {
    const c = newConn(now, null);
    live.push(c);
    send(c, { t: "hello", token });
    return c;
  };
  const drop = (c: Conn) => {
    live.splice(live.indexOf(c), 1);
    room.closed(c);
  };
  /** Moves the clock. Sockets in `pinging` stay fresh, like the client's 20 s pings. */
  const advance = (ms: number, pinging: Conn[] = live) => {
    now += ms;
    for (const c of pinging) c.seenAt = now;
  };
  const seated = (n: number) => {
    const conns = Array.from({ length: n }, (_, i) => connect(`token-${i}-abcdef`));
    for (const [i, c] of conns.entries()) send(c, { t: "join", name: `P${i}` });
    return conns;
  };
  const errorOf = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof RoomError) return e.code;
      throw e;
    }
    return null;
  };
  return {
    room,
    live,
    send,
    connect,
    drop,
    advance,
    seated,
    errorOf,
    now: () => now,
    seedCalls: () => seeds,
  };
}
type Setup = ReturnType<typeof setup>;

/**
 * Sends a legal move for whichever seat must act, through that seat's socket. While placing it
 * picks discard-and-flip (listed last), so every turn reveals a card and rounds always end.
 */
function stepAny(t: Setup, conns: Conn[]) {
  const game = t.room.data.game;
  if (!game) throw new Error("no game");
  const legal = legalActions(game);
  const action = legal[game.phase === "place" ? legal.length - 1 : 0] as Action;
  const seat = "seat" in action ? action.seat : t.room.data.host;
  t.send(conns[seat], { t: "act", action: "seat" in action ? { ...action, seat: 99 } : action });
}

const startedGame = (t: Setup, n: number) => {
  const conns = t.seated(n);
  t.send(conns[0], { t: "start" });
  return conns;
};

const pastFlips = (t: Setup, conns: Conn[]) => {
  while (t.room.data.game?.phase === "flip") stepAny(t, conns);
};

const upCount = (t: Setup, seat: number) =>
  t.room.data.game?.players[seat].grid.filter((s) => s?.up).length ?? 0;

describe("lobby", () => {
  it("joining takes the next seat; the first seat hosts", () => {
    const t = setup();
    const [a, b] = t.seated(2);
    expect(t.room.view(a, t.live)).toMatchObject({ you: 0, host: 0, lead: true });
    expect(t.room.view(b, t.live)).toMatchObject({ you: 1, lead: false });
    expect(t.room.view(b, t.live).seats).toEqual([
      { name: "P0", connected: true, auto: false },
      { name: "P1", connected: true, auto: false },
    ]);
  });

  it("rejects blank and duplicate names; trims and strips invisible characters", () => {
    const t = setup();
    t.seated(1);
    const c = t.connect("token-x-abcdef");
    expect(t.errorOf(() => t.send(c, { t: "join", name: "   " }))).toBe("bad-name");
    expect(t.errorOf(() => t.send(c, { t: "join", name: "p0" }))).toBe("name-taken");
    t.send(c, { t: "join", name: "  Ana​‮  " });
    expect(t.room.data.seats[1].name).toBe("Ana");
    const d = t.connect("token-y-abcdef");
    t.send(d, { t: "join", name: `${"x".repeat(15)}😀😀` });
    expect(t.room.data.seats[2].name).toBe(`${"x".repeat(15)}😀`);
  });

  it("a 9th player stays a spectator", () => {
    const t = setup();
    t.seated(8);
    const ninth = t.connect("token-9-abcdef");
    expect(t.errorOf(() => t.send(ninth, { t: "join", name: "Late" }))).toBe("room-full");
    expect(t.room.view(ninth, t.live)).toMatchObject({ you: null, lead: false });
  });

  it("only the host starts, with at least 2 players", () => {
    const t = setup();
    const [a] = t.seated(1);
    expect(t.errorOf(() => t.send(a, { t: "start" }))).toBe("not-allowed");
    const b = t.connect("token-b-abcdef");
    t.send(b, { t: "join", name: "B" });
    expect(t.errorOf(() => t.send(b, { t: "start" }))).toBe("not-allowed");
    t.send(a, { t: "start" });
    expect(t.room.data.game?.phase).toBe("flip");
  });

  it("when the host leaves the lobby, the next seat hosts", () => {
    const t = setup();
    const [a, b] = t.seated(3);
    t.send(a, { t: "leave" });
    expect(t.room.view(b, t.live)).toMatchObject({ you: 0, host: 0, lead: true });
  });

  it("the host can remove an offline (ghost) seat, never an online one", () => {
    const t = setup();
    const [a, b, c] = t.seated(3);
    expect(t.errorOf(() => t.send(a, { t: "kick", seat: 1 }))).toBe("not-allowed");
    t.drop(b);
    expect(t.errorOf(() => t.send(c, { t: "kick", seat: 1 }))).toBe("not-allowed"); // not host
    t.send(a, { t: "kick", seat: 1 });
    expect(t.room.data.seats.map((s) => s.name)).toEqual(["P0", "P2"]);
  });

  it("messages before hello are rejected", () => {
    const t = setup();
    expect(t.errorOf(() => t.send(newConn(0, null), { t: "join", name: "X" }))).toBe("bad-message");
  });

  it("acks the highest seq handled, failed messages included", () => {
    const t = setup();
    const [a] = t.seated(1);
    t.errorOf(() => t.send(a, { t: "start", seq: 7 }));
    expect(a.ack).toBe(7);
    t.send(a, { t: "hello", token: "token-0-abcdef", seq: 3 });
    expect(a.ack).toBe(7);
  });

  it("only joins, leaves, starts, and moves need persisting", () => {
    const t = setup();
    const [a] = t.seated(2);
    expect(t.send(a, { t: "hello", token: "token-0-abcdef" })).not.toBe("data");
    expect(t.send(a, { t: "start" })).toBe("data");
  });

  it("SEC-3: a hello changes other views only when it changes who is online", () => {
    const t = setup();
    const [a, b] = t.seated(2);
    expect(t.send(a, { t: "hello", token: "token-0-abcdef" })).toBe("none");
    const secondTab = t.connect("token-1-abcdef"); // b was already online
    expect(t.send(secondTab, { t: "hello", token: "token-1-abcdef" })).toBe("none");
    t.advance(STALE_MS, [b, secondTab]); // a's phone went quiet
    expect(t.send(a, { t: "hello", token: "token-0-abcdef" })).toBe("view");
  });

  it("SEC-3: only a seated socket's close needs persisting", () => {
    const t = setup();
    const [a] = t.seated(2);
    const watcher = t.connect("token-w-abcdef");
    t.live.splice(t.live.indexOf(watcher), 1);
    expect(t.room.closed(watcher)).toBe(false);
    expect(t.room.closed(newConn(t.now(), null))).toBe(false); // never said hello
    t.live.splice(t.live.indexOf(a), 1);
    expect(t.room.closed(a)).toBe(true);
  });
});

describe("play", () => {
  it("moves use the sender's seat, never the payload's", () => {
    const t = setup();
    const [, b] = startedGame(t, 2);
    t.send(b, { t: "act", action: { type: "flip", seat: 0, pos: 3 } });
    expect(t.room.data.game?.players.map((p) => p.grid[3]?.up)).toEqual([false, true]);
  });

  it("out-of-turn moves and spectator moves are rejected", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    const idle = conns[1 - (t.room.data.game?.current ?? 0)];
    const move: ClientMsg = { t: "act", action: { type: "draw", seat: 0, source: "deck" } };
    expect(t.errorOf(() => t.send(idle, move))).toBe("illegal-move");
    const watcher = t.connect("token-w-abcdef");
    expect(t.errorOf(() => t.send(watcher, move))).toBe("not-allowed");
  });

  it("a returning token reclaims its seat", () => {
    const t = setup();
    const [a] = t.seated(2);
    t.drop(a);
    expect(t.room.view(t.connect("token-0-abcdef"), t.live).you).toBe(0);
  });

  for (const knockout of [false, true]) {
    it(`a full game through the room reaches game over; views never leak secrets, with a seat on auto-play${knockout ? "; M17: with knockout on, out seats are never waited on, and the right player wins" : ""}`, () => {
      const t = setup();
      const conns = t.seated(3);
      const watcher = t.connect("token-w-abcdef");
      t.send(conns[0], { t: "knockout", on: knockout });
      t.send(conns[0], { t: "start" });
      t.send(conns[1], { t: "auto", on: true });
      for (let i = 0; t.room.data.game?.phase !== "gameOver"; i++) {
        expect(i).toBeLessThan(20_000);
        // The server plays seat 1's steps as they come due; the others play at once.
        t.advance(AUTO_FIRST_MS);
        if (!t.room.tick(t.live)) stepAny(t, conns);
        const state = t.room.data.game;
        for (const c of [...conns, watcher]) {
          const view = t.room.view(c, t.live);
          expect(JSON.stringify(view)).not.toMatch(/token-|"deck":|"rng":|"seenAt":/);
          // Every face-down card reaches every client, its own player included, only as "down".
          state?.players.forEach((p, seat) => {
            p.grid.forEach((slot, pos) => {
              if (slot && !slot.up) expect(view.game?.players[seat].grid[pos]).toBe("down");
            });
            if (p.out === null) return;
            expect(view.clocks.map((w) => w.seat)).not.toContain(seat);
            expect(view.seats[seat].auto).toBe(false);
          });
        }
      }
      // Start + one fresh seed per round after the first.
      const game = t.room.data.game;
      expect(t.seedCalls()).toBe(game?.round);
      if (!knockout || !game) return;
      // R16 on this seeded deal: Seat 1 went out in an earlier round than the last.
      expect(game.players.some((p) => p.out !== null && p.out < game.round)).toBe(true);
      const left = game.players.flatMap((p, seat) => (p.out === null ? [seat] : []));
      const among = left.length
        ? left
        : [0, 1, 2].filter((s) => game.players[s].out === game.round);
      const best = Math.min(...among.map((s) => game.players[s].total));
      expect(game.winners).toEqual(among.filter((s) => game.players[s].total === best));
    });
  }

  it("the host advances rounds; anyone may once the host is away", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    while (t.room.data.game?.phase !== "roundOver" && t.room.data.game?.phase !== "gameOver") {
      stepAny(t, conns);
    }
    if (t.room.data.game.phase === "gameOver") return; // seed ended the game in round 1
    const next: ClientMsg = { t: "act", action: { type: "nextRound" } };
    expect(t.errorOf(() => t.send(conns[1], next))).toBe("not-allowed");
    t.drop(conns[0]);
    t.send(conns[1], next);
    expect(t.room.data.game?.phase).toBe("flip");
  });

  it("rematch returns to the lobby with the same seats; late joiners join there", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    while (t.room.data.game?.phase !== "gameOver") {
      if (t.room.data.game?.phase === "roundOver") {
        t.send(conns[0], { t: "act", action: { type: "nextRound" } });
      } else stepAny(t, conns);
    }
    const late = t.connect("token-late-abcdef");
    expect(t.errorOf(() => t.send(late, { t: "join", name: "Late" }))).toBe("not-allowed");
    expect(t.errorOf(() => t.send(conns[1], { t: "rematch" }))).toBe("not-allowed");
    t.send(conns[0], { t: "rematch" });
    expect(t.room.data.game).toBeNull();
    t.send(late, { t: "join", name: "Late" });
    t.send(conns[0], { t: "start" });
    expect(t.room.data.game?.players.map((p) => p.name)).toEqual(["P0", "P1", "Late"]);
  });

  it("nobody can join or leave mid-game", () => {
    const t = setup();
    const [a] = startedGame(t, 2);
    const late = t.connect("token-late-abcdef");
    expect(t.errorOf(() => t.send(late, { t: "join", name: "Late" }))).toBe("not-allowed");
    expect(t.errorOf(() => t.send(a, { t: "leave" }))).toBe("not-allowed");
  });
});

const autoSeats = (t: Setup) => t.room.data.seats.map((s) => s.auto === true);
const drawMsg: ClientMsg = { t: "act", action: { type: "draw", seat: 0, source: "deck" } };
const nextRound: ClientMsg = { t: "act", action: { type: "nextRound" } };

/** A 3-seat knockout game at round 1's summary: seat 0, the host, on Auto-play until it went out. */
function hostOut(t: Setup) {
  const conns = t.seated(3);
  t.send(conns[0], { t: "knockout", on: true });
  t.send(conns[0], { t: "start" });
  t.send(conns[0], { t: "auto", on: true });
  const game = t.room.data.game;
  // Out at the end of round 1 whatever it scores; the others can't be.
  for (const [seat, p] of game?.players.entries() ?? []) p.total = seat === 0 ? 150 : -200;
  while (t.room.data.game?.phase !== "roundOver") stepAny(t, conns);
  expect(t.room.data.game.players.map((p) => p.out)).toEqual([1, null, null]);
  return conns;
}

describe("knockout (M17, R16)", () => {
  it("M17: only whoever may lead switches it, only in the lobby; everyone sees it, and start deals with it", () => {
    const t = setup();
    const [a, b] = t.seated(2);
    const watcher = t.connect("token-w-abcdef");
    const on: ClientMsg = { t: "knockout", on: true };
    expect(t.errorOf(() => t.send(b, on))).toBe("not-allowed");
    expect(t.errorOf(() => t.send(watcher, on))).toBe("not-allowed");
    expect(t.send(a, on)).toBe("data");
    expect(t.send(a, on)).toBe("none");
    for (const c of [a, b, watcher]) expect(t.room.view(c, t.live).knockout).toBe(true);
    // With the host away, the stand-in leads with the same setting, and may change it.
    t.drop(a);
    expect(t.send(b, { t: "knockout", on: false })).toBe("data");
    expect(t.room.view(watcher, t.live).knockout).toBe(false);
    t.send(b, on);
    t.send(b, { t: "start" });
    expect(t.room.data.game?.knockout).toBe(true);
    expect(t.room.view(watcher, t.live).game?.knockout).toBe(true);
    expect(t.errorOf(() => t.send(b, { t: "knockout", on: false }))).toBe("not-allowed");
    expect(parseClientMsg('{"t":"knockout","on":true,"seat":1}')).toEqual(on);
    for (const raw of ['{"t":"knockout"}', '{"t":"knockout","on":"yes"}']) {
      expect(parseClientMsg(raw)).toBeNull();
    }
  });

  it("M17: the option survives a reload from storage and a rematch; a game saved before 2.2.0 loads with knockout off", () => {
    const t = setup();
    const conns = t.seated(2);
    t.send(conns[0], { t: "knockout", on: true });
    const deps = { now: t.now, seed: (): Rng => [1, 2, 3, 4] };
    const reload = () => new Room(JSON.parse(JSON.stringify(t.room.data)), deps);
    expect(reload().view(conns[1], t.live).knockout).toBe(true);
    t.send(conns[0], { t: "start" });
    expect(reload().data.game?.knockout).toBe(true);
    while (t.room.data.game?.phase !== "gameOver") {
      if (t.room.data.game?.phase === "roundOver") t.send(conns[0], nextRound);
      else stepAny(t, conns);
    }
    t.send(conns[0], { t: "rematch" });
    expect(t.room.view(conns[1], t.live).knockout).toBe(true);
    t.send(conns[0], { t: "start" });
    expect(t.room.data.game?.knockout).toBe(true);
    const old = JSON.parse(JSON.stringify(t.room.data));
    delete old.knockout;
    delete old.game.knockout;
    for (const p of old.game.players) delete p.out;
    const loaded = new Room(old, deps);
    expect(loaded.data.game?.knockout).toBe(false);
    expect(loaded.data.game?.players.map((p) => p.out)).toEqual([null, null]);
    expect(loaded.view(conns[0], t.live).knockout).toBe(false);
  });

  it("M17: going out ends a seat's Auto-play, and it can't tick it again; a host who is out still leads", () => {
    const t = setup();
    const conns = hostOut(t);
    expect(autoSeats(t)).toEqual([false, false, false]);
    expect(t.errorOf(() => t.send(conns[1], nextRound))).toBe("not-allowed");
    expect(t.room.view(conns[0], t.live).lead).toBe(true);
    t.send(conns[0], nextRound);
    expect(t.room.data.game?.phase).toBe("flip");
    expect(t.errorOf(() => t.send(conns[0], { t: "auto", on: true }))).toBe("not-allowed");
    const flip: ClientMsg = { t: "act", action: { type: "flip", seat: 0, pos: 0 } };
    expect(t.errorOf(() => t.send(conns[0], flip))).toBe("illegal-move");
  });

  it("M17: an out seat is never waited on, no clock and no Auto-play, and doesn't count as playing by hand: the others' Auto-play ends the round", () => {
    const t = setup();
    const conns = hostOut(t);
    t.send(conns[0], nextRound);
    const playing = () => ["flip", "draw", "place"].includes(t.room.data.game?.phase ?? "");
    for (let i = 0; playing(); i++) {
      expect(i).toBeLessThan(2_000);
      expect(t.room.view(conns[0], t.live).clocks.map((w) => w.seat)).not.toContain(0);
      t.advance(TURN_MS);
      t.room.tick(t.live);
      expect(t.room.data.seats[0].auto).toBe(false);
      expect(t.room.data.game?.players[0].grid).toEqual([]);
    }
    expect(autoSeats(t)).toEqual([false, true, true]);
    expect(t.room.data.game?.round).toBe(2);
  });

  it("M17, BUG-1: an out seat and a lone spectator keep nothing running", () => {
    const t = setup();
    const conns = hostOut(t);
    t.send(conns[0], nextRound);
    pastFlips(t, conns);
    const watcher = t.connect("token-w-abcdef");
    t.drop(conns[1]);
    t.drop(conns[2]);
    const before = structuredClone(t.room.data.game);
    for (const leaving of [conns[0], null]) {
      expect(t.room.view(watcher, t.live).clocks).toEqual([]);
      expect(t.room.nextAlarm(t.live)).toBeGreaterThan(t.now() + 2 * TURN_MS);
      t.advance(2 * TURN_MS);
      t.room.tick(t.live);
      expect(t.room.data.game).toEqual(before); // nothing played
      if (leaving) t.drop(leaving); // then the spectator is alone
    }
  });
});

describe("turn clock (M8)", () => {
  it("M8: nothing happens at 30 s − 1 ms; at 30 s the waited-on seat's move is played and its auto-play is on", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    const current = t.room.data.game?.current ?? 0;
    t.advance(TURN_MS - 1);
    expect(t.room.tick(t.live)).toBe(false);
    t.advance(1);
    expect(t.room.tick(t.live)).toBe(true);
    expect(t.room.data.game?.phase).toBe("place"); // it drew
    expect(autoSeats(t)).toEqual([0, 1].map((s) => s === current));
  });

  it("M8: a draw at 25 s moves the place deadline to 35 s; a draw at 5 s leaves it at 30 s", () => {
    for (const [drawAt, deadline] of [
      [25_000, 35_000],
      [5_000, TURN_MS],
    ]) {
      const t = setup();
      const conns = startedGame(t, 2);
      pastFlips(t, conns);
      const current = t.room.data.game?.current ?? 0;
      t.advance(drawAt);
      t.send(conns[current], drawMsg);
      t.advance(deadline - drawAt - 1);
      expect(t.room.tick(t.live)).toBe(false);
      t.advance(1);
      expect(t.room.tick(t.live)).toBe(true);
      expect(t.room.data.game?.current).toBe(1 - current);
    }
  });

  it("M8: in the opening flip, every seat that hasn't flipped is auto-flipped 30 s after the deal, whoever else flips meanwhile; seats that have flipped are left alone", () => {
    const t = setup();
    const [a, b] = startedGame(t, 3);
    const flip = (c: Conn, pos: number) =>
      t.send(c, { t: "act", action: { type: "flip", seat: 0, pos } });
    t.advance(10_000);
    flip(a, 0);
    t.advance(10_000);
    flip(a, 1);
    t.advance(5_000);
    flip(b, 0);
    t.advance(TURN_MS - 25_000 - 1);
    expect(t.room.tick(t.live)).toBe(false);
    t.advance(1);
    expect(t.room.tick(t.live)).toBe(true);
    expect([0, 1, 2].map((s) => upCount(t, s))).toEqual([2, 2, 1]);
    expect(autoSeats(t)).toEqual([false, true, true]);
    // The second flip is its own step, like every auto-play step after the first.
    expect(t.room.nextAlarm(t.live)).toBe(t.now() + AUTO_NEXT_MS);
    t.advance(AUTO_NEXT_MS);
    expect(t.room.tick(t.live)).toBe(true);
    expect(t.room.data.game?.phase).toBe("draw");
    // Auto-play flips the first face-down cards in reading order.
    expect(t.room.data.game?.players[2].grid.map((s) => s?.up)).toEqual(
      Array.from({ length: 12 }, (_, i) => i < 2),
    );
  });

  it("M8: an auto seat draws 1.5 s into its turn and places 0.7 s later, each its own step, and nextAlarm says exactly when", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    const current = t.room.data.game?.current ?? 0;
    t.send(conns[1 - current], { t: "auto", on: true }); // ticked before its turn
    stepAny(t, conns);
    stepAny(t, conns); // current draws and places: the auto seat's turn begins
    const start = t.now();
    expect(t.room.nextAlarm(t.live)).toBe(start + AUTO_FIRST_MS);
    t.advance(AUTO_FIRST_MS - 1);
    expect(t.room.tick(t.live)).toBe(false);
    t.advance(1);
    expect(t.room.tick(t.live)).toBe(true);
    expect(t.room.data.game?.phase).toBe("place");
    expect(t.room.nextAlarm(t.live)).toBe(start + AUTO_FIRST_MS + AUTO_NEXT_MS);
    t.advance(AUTO_NEXT_MS - 1);
    expect(t.room.tick(t.live)).toBe(false);
    t.advance(1);
    expect(t.room.tick(t.live)).toBe(true);
    expect(t.room.data.game?.current).toBe(current);
  });

  it("M8: a step that comes due between tick() and nextAlarm() is checked again at once, not dropped", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    t.send(conns[t.room.data.game?.current ?? 0], { t: "auto", on: true });
    // An adapter's timer fires a millisecond early: tick() finds nothing due yet...
    t.advance(AUTO_FIRST_MS - 1);
    expect(t.room.tick(t.live)).toBe(false);
    // ...and by the time it asks for the next alarm, the draw is due.
    t.advance(1);
    expect(t.room.nextAlarm(t.live)).toBe(t.now() + 1);
  });

  it("M8: unticking stops auto-play and starts a fresh 30 s; you can tick it yourself, and only for your own seat", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    const current = t.room.data.game?.current ?? 0;
    const me = conns[current];
    t.advance(20_000);
    expect(t.send(me, { t: "auto", on: true })).toBe("data");
    expect(autoSeats(t)).toEqual([0, 1].map((s) => s === current));
    expect(t.room.tick(t.live)).toBe(true); // 20 s in, the draw is overdue: it comes at once
    expect(t.room.data.game?.phase).toBe("place");
    expect(t.send(me, { t: "auto", on: false })).toBe("data");
    expect(t.send(me, { t: "auto", on: false })).toBe("none"); // nothing changed, nothing to write
    t.advance(TURN_MS - 1);
    expect(t.room.tick(t.live)).toBe(false);
    t.advance(1);
    expect(t.room.tick(t.live)).toBe(true);
    expect(t.room.data.game?.current).toBe(1 - current);
    // The message names no seat, and a spectator has none.
    expect(parseClientMsg('{"t":"auto","on":true,"seat":1}')).toEqual({ t: "auto", on: true });
    const watcher = t.connect("token-w-abcdef");
    expect(t.errorOf(() => t.send(watcher, { t: "auto", on: true }))).toBe("not-allowed");
  });

  it("M8: an offline seat gets the same 30 s, then goes on auto-play", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    const current = t.room.data.game?.current ?? 0;
    t.drop(conns[current]);
    t.advance(TURN_MS - 1);
    expect(t.room.tick(t.live)).toBe(false);
    t.advance(1);
    expect(t.room.tick(t.live)).toBe(true);
    expect(autoSeats(t)[current]).toBe(true);
  });

  it("M8, BUG-1: a lone player off Auto-play, on their own turn with everyone else offline, has no clock", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    const current = t.room.data.game?.current ?? 0;
    t.drop(conns[1 - current]);
    t.advance(10 * TURN_MS);
    expect(t.room.tick(t.live)).toBe(false);
    expect(t.room.view(conns[current], t.live).clocks).toEqual([]);
  });

  it("M8: a clock that wasn't running, with nobody else there, starts afresh when someone comes back", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    const current = t.room.data.game?.current ?? 0;
    t.drop(conns[1 - current]);
    t.advance(2 * TURN_MS); // thinking alone: no clock
    t.connect(`token-${1 - current}-abcdef`);
    t.advance(TURN_MS - 1);
    expect(t.room.tick(t.live)).toBe(false);
    t.advance(1);
    expect(t.room.tick(t.live)).toBe(true);
  });

  it("M8: a phone that went quiet before its turn shows as offline once stale, before its clock runs out", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    const current = t.room.data.game?.current ?? 0;
    const next = conns[1 - current];
    t.advance(20_000, [conns[current]]); // next's phone locks while current thinks
    stepAny(t, conns);
    stepAny(t, conns);
    expect(t.room.data.game?.current).toBe(1 - current);
    expect(t.room.nextAlarm(t.live)).toBe(next.seenAt + STALE_MS);
    t.advance(STALE_MS - 20_000, [conns[current]]);
    expect(t.room.view(conns[current], t.live).clocks).toEqual([
      { seat: 1 - current, inMs: TURN_MS - 25_000, reason: "offline" },
    ]);
  });

  it("M8: with everyone gone nothing is auto-played", () => {
    const t = setup();
    const conns = startedGame(t, 4);
    for (const c of conns) t.drop(c);
    t.advance(10 * TURN_MS, []);
    expect(t.room.tick(t.live)).toBe(false);
    expect(t.room.data.game?.phase).toBe("flip");
  });

  it("M8: wait lists every waited-on seat, with ms until the server moves and why", () => {
    const t = setup();
    const conns = startedGame(t, 4);
    for (const pos of [0, 1])
      t.send(conns[3], { t: "act", action: { type: "flip", seat: 0, pos } });
    t.drop(conns[1]);
    t.send(conns[2], { t: "auto", on: true });
    t.advance(1_000);
    expect(t.room.view(conns[3], t.live).clocks).toEqual([
      { seat: 0, inMs: TURN_MS - 1_000, reason: "timer" },
      { seat: 1, inMs: TURN_MS - 1_000, reason: "offline" },
      { seat: 2, inMs: AUTO_FIRST_MS - 1_000, reason: "auto" },
    ]);
    expect(t.room.view(conns[3], t.live).seats.map((s) => s.auto)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it("M8: while the host is on auto-play, anyone seated may lead: start, next round, rematch; a new game starts with Auto-play off", () => {
    const t = setup();
    const conns = t.seated(2);
    t.send(conns[0], { t: "auto", on: true });
    expect(t.room.view(conns[1], t.live).lead).toBe(true);
    t.send(conns[1], { t: "start" });
    expect(autoSeats(t)).toEqual([false, false]); // nobody is played for before the deal's clock runs out
    t.send(conns[0], { t: "auto", on: true });
    while (t.room.data.game?.phase !== "gameOver") {
      if (t.room.data.game?.phase === "roundOver") {
        t.send(conns[1], { t: "act", action: { type: "nextRound" } });
      } else stepAny(t, conns);
    }
    t.send(conns[1], { t: "rematch" });
    expect(t.room.data.game).toBeNull();
    // Still away in the lobby: the others may start without the host.
    expect(t.room.view(conns[1], t.live).lead).toBe(true);
  });

  it("M8: ticking Auto-play on and off gives a fresh clock once per move, so it can't hold a turn open", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    const current = t.room.data.game?.current ?? 0;
    // From the turn's start, on and off faster than auto-play's first step (1.5 s): when every
    // untick restarted the clock, nothing was ever played.
    let toggles = 0;
    while (t.room.data.game?.current === current && toggles < 200) {
      t.send(conns[current], { t: "auto", on: toggles++ % 2 === 0 });
      t.advance(400);
      t.room.tick(t.live);
    }
    expect(t.room.data.game?.current).toBe(1 - current);
    expect(toggles * 400).toBeLessThan(TURN_MS);
  });
});

/** Runs the room's alarms for `ms`, as an adapter does, every socket pinging. Returns the moves. */
function runAlarms(t: Setup, ms: number) {
  const end = t.now() + ms;
  let moves = 0;
  for (let at = t.room.nextAlarm(t.live); at <= end; at = t.room.nextAlarm(t.live)) {
    t.advance(at - t.now());
    if (t.room.tick(t.live)) moves++;
  }
  t.advance(end - t.now());
  return moves;
}

const AUTO_TURN_MS = AUTO_FIRST_MS + AUTO_NEXT_MS;

describe("everyone on Auto-play (BUG-1)", () => {
  it("BUG-1: with both seats on Auto-play and connected, the current seat draws at +2 s and places 1.2 s later, and play reaches the round summary, where it waits", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    const current = t.room.data.game?.current ?? 0;
    const start = t.now();
    for (const c of conns) t.send(c, { t: "auto", on: true });
    expect(t.room.nextAlarm(t.live)).toBe(start + AUTO_FIRST_MS);
    t.advance(AUTO_FIRST_MS - 1);
    expect(t.room.tick(t.live)).toBe(false);
    t.advance(1);
    expect(t.room.tick(t.live)).toBe(true);
    expect(t.room.data.game).toMatchObject({ phase: "place", current });
    expect(t.room.nextAlarm(t.live)).toBe(start + AUTO_TURN_MS);
    t.advance(AUTO_NEXT_MS);
    expect(t.room.tick(t.live)).toBe(true);
    expect(t.room.data.game?.current).toBe(1 - current);
    runAlarms(t, 60 * 60_000);
    expect(t.room.data.game?.phase).toBe("roundOver");
    expect(t.room.data.game?.round).toBe(1);
    // Next round is a tap: until then nothing is due but presence checks.
    expect(runAlarms(t, 10 * 60_000)).toBe(0);
    t.send(conns[1], { t: "act", action: { type: "nextRound" } });
    expect(runAlarms(t, AUTO_TURN_MS)).toBe(2); // each step flips a card for both seats
    expect(t.room.data.game).toMatchObject({ round: 2, phase: "draw" });
  });

  it("BUG-1: with both on Auto-play, one connected and the other offline, the table still plays", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    const current = t.room.data.game?.current ?? 0;
    for (const c of conns) t.send(c, { t: "auto", on: true });
    t.drop(conns[1]);
    expect(runAlarms(t, 2 * AUTO_TURN_MS)).toBe(4); // each seat draws and places
    expect(t.room.data.game).toMatchObject({ phase: "draw", current });
  });

  it("BUG-1: with both on Auto-play and nobody connected, nothing plays and no auto step is scheduled", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    for (const c of conns) t.send(c, { t: "auto", on: true });
    for (const c of conns) t.drop(c);
    t.advance(10 * TURN_MS);
    expect(t.room.tick(t.live)).toBe(false);
    // The room's only alarm is its idle expiry.
    expect(t.room.nextAlarm(t.live)).toBe(t.room.data.updatedAt + IDLE_MS);
  });

  it("BUG-1: a player off Auto-play whose only connected opponent is on Auto-play has a 30 s clock, then goes on Auto-play", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    const current = t.room.data.game?.current ?? 0;
    t.send(conns[1 - current], { t: "auto", on: true });
    expect(t.room.view(conns[current], t.live).clocks).toEqual([
      { seat: current, inMs: TURN_MS, reason: "timer" },
    ]);
    t.advance(TURN_MS);
    expect(t.room.tick(t.live)).toBe(true);
    expect(autoSeats(t)).toEqual([true, true]);
  });

  it("BUG-1: in the opening flip, two present players who don't flip for 30 s both go on Auto-play, both flip twice, and the first turn starts", () => {
    const t = setup();
    startedGame(t, 2);
    t.advance(TURN_MS);
    expect(t.room.tick(t.live)).toBe(true);
    expect(autoSeats(t)).toEqual([true, true]);
    expect([upCount(t, 0), upCount(t, 1)]).toEqual([1, 1]);
    t.advance(AUTO_NEXT_MS);
    expect(t.room.tick(t.live)).toBe(true);
    expect([upCount(t, 0), upCount(t, 1)]).toEqual([2, 2]);
    expect(t.room.data.game?.phase).toBe("draw");
    t.advance(AUTO_FIRST_MS);
    expect(t.room.tick(t.live)).toBe(true);
    expect(t.room.data.game?.phase).toBe("place");
  });

  it("BUG-1: with a connected player off Auto-play, an auto seat never turns over its last face-down card early; with nobody off it, it does and the round ends", () => {
    for (const [human, ender] of [
      [true, null],
      [false, 0],
    ] as const) {
      const t = setup();
      const conns = startedGame(t, 2);
      for (const c of human ? [conns[0]] : conns) t.send(c, { t: "auto", on: true });
      // Seat 0 drew a 12 with one face-down card left; its highest face-up card is 11.
      t.room.data.game = placing(GRID, ALL_BUT_LAST, 12);
      t.advance(AUTO_NEXT_MS);
      expect(t.room.tick(t.live)).toBe(true);
      expect(t.room.data.game?.ender).toBe(ender);
      expect(t.room.data.game?.players[0].grid[11]?.up).toBe(!human);
    }
  });
});

/** Seat 0 of a 2-player game placing `drawn`: its grid, with the positions in `up` face up. */
function placing(grid: number[], up: number[], drawn: number, from: "deck" | "discard" = "deck") {
  const g = createGame(["A", "B"], [1, 0, 0, 0]);
  g.phase = "place";
  g.current = 0;
  g.drawn = drawn;
  g.drawnFrom = from;
  g.players[0].grid = grid.map((card, i) => ({ card, up: up.includes(i) }));
  return g;
}
const GRID = [5, 5, 5, 9, 5, 5, 5, 11, 5, 5, 5, 5];
const ALL_BUT_LAST = Array.from({ length: 11 }, (_, i) => i);

describe("autoMove (M8)", () => {
  it("M8: swaps a lower drawn card into the highest face-up card", () => {
    expect(autoMove(placing(GRID, [0, 3, 7], 4), 0)).toEqual({ type: "swap", seat: 0, pos: 7 });
  });

  it("M8: otherwise discards it and flips the first face-down card", () => {
    expect(autoMove(placing(GRID, [0, 3, 7], 12), 0)).toEqual({
      type: "discardAndFlip",
      seat: 0,
      pos: 1,
    });
  });

  it("M8: never flips the last face-down card while a swap is legal, unless the round is ending anyway", () => {
    expect(autoMove(placing(GRID, ALL_BUT_LAST, 12), 0)).toEqual({ type: "swap", seat: 0, pos: 7 });
    // On a last turn revealing it ends nothing, and R11 reveals it anyway: swapping a 12 in would cost.
    expect(autoMove({ ...placing(GRID, ALL_BUT_LAST, 12), ender: 1 }, 0)).toEqual({
      type: "discardAndFlip",
      seat: 0,
      pos: 11,
    });
    expect(autoMove(placing(GRID, ALL_BUT_LAST, 12, "discard"), 0)).toEqual({
      type: "swap",
      seat: 0,
      pos: 7,
    });
  });

  it("M8: a card taken from the discard (time ran out after taking it) replaces the first face-down card unless it beats a face-up one", () => {
    expect(autoMove(placing(GRID, [0, 3, 7], 12, "discard"), 0)).toEqual({
      type: "swap",
      seat: 0,
      pos: 1,
    });
    expect(autoMove(placing(GRID, [0, 3, 7], 6, "discard"), 0)).toEqual({
      type: "swap",
      seat: 0,
      pos: 7,
    });
  });

  it("M8: draws from the deck, and in the opening flip flips the first face-down card", () => {
    const g: GameState = createGame(["A", "B"], [1, 0, 0, 0]);
    expect(autoMove(g, 1)).toEqual({ type: "flip", seat: 1, pos: 0 });
    expect(autoMove({ ...g, phase: "draw", current: 1 }, 1)).toEqual({
      type: "draw",
      seat: 1,
      source: "deck",
    });
  });

  it("M8: in 1,000 seeded games with one seat always on autoMove and the others random, every game ends", () => {
    for (let seed = 0; seed < 1000; seed++) {
      const players = 2 + (seed % 7);
      const bot = seed % players;
      let g = createGame(
        Array.from({ length: players }, (_, i) => `P${i}`),
        [seed, 0, 0, 0],
      );
      let rng: Rng = [seed, 7, 7, 7];
      for (let moves = 0; g.phase !== "gameOver"; moves++) {
        if (moves > 20_000) throw new Error(`seed ${seed} did not finish`);
        const legal = legalActions(g);
        const botsTurn =
          g.phase === "flip"
            ? legal.some((a) => "seat" in a && a.seat === bot)
            : g.phase !== "roundOver" && g.current === bot;
        let pick: number;
        [pick, rng] = nextRandom(rng);
        g = apply(g, botsTurn ? autoMove(g, bot) : legal[Math.floor(pick * legal.length)]);
      }
    }
  });

  it("BUG-1: when the round may end, it turns over the last face-down card rather than swap a higher card in", () => {
    expect(autoMove(placing(GRID, ALL_BUT_LAST, 12), 0, true)).toEqual({
      type: "discardAndFlip",
      seat: 0,
      pos: 11,
    });
    expect(autoMove(placing(GRID, ALL_BUT_LAST, 12, "discard"), 0, true)).toEqual({
      type: "swap",
      seat: 0,
      pos: 11,
    });
    // A lower card still replaces the highest face-up one.
    expect(autoMove(placing(GRID, ALL_BUT_LAST, 4), 0, true)).toEqual({
      type: "swap",
      seat: 0,
      pos: 7,
    });
  });
});

describe("scheduling", () => {
  it("nextAlarm is always in the future after tick, through a whole game", () => {
    const t = setup();
    const conns = startedGame(t, 3);
    for (let i = 0; t.room.data.game?.phase !== "gameOver" && i < 20_000; i++) {
      if (i % 7 === 0) t.advance(TURN_MS, conns.slice(1)); // seat 0 drifts in and out
      t.room.tick(t.live);
      expect(t.room.nextAlarm(t.live)).toBeGreaterThan(t.now());
      // tick() may have ended the round or the game, so read the phase fresh.
      const phase: string | undefined = t.room.data.game?.phase;
      if (phase === "roundOver") t.send(conns[1], { t: "act", action: { type: "nextRound" } });
      else if (phase !== "gameOver") stepAny(t, conns);
    }
    expect(t.room.data.game?.phase).toBe("gameOver");
  });

  it("a room nobody joined is dropped after 10 minutes", () => {
    const t = setup();
    t.advance(EMPTY_IDLE_MS - 1);
    expect(t.room.isIdle(t.live)).toBe(false);
    t.advance(1);
    expect(t.room.isIdle(t.live)).toBe(true);
  });

  it("a creator waiting in an empty lobby keeps the room past 10 minutes", () => {
    const t = setup();
    t.connect("token-host-abcdef"); // created the room, hasn't joined yet
    t.advance(EMPTY_IDLE_MS);
    expect(t.room.isIdle(t.live)).toBe(false);
  });

  it("an idle room is idle after 24 h even with a forgotten tab open", () => {
    const t = setup();
    t.seated(2);
    t.advance(IDLE_MS); // tabs keep pinging, nobody sends a message
    expect(t.room.isIdle(t.live)).toBe(true);
    expect(t.room.nextAlarm(t.live)).toBeGreaterThan(t.now());
  });

  it("when the host goes quiet at the round summary, others may lead once the host is stale", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    while (t.room.data.game?.phase !== "roundOver" && t.room.data.game?.phase !== "gameOver") {
      stepAny(t, conns);
    }
    expect(t.room.nextAlarm(t.live)).toBe(conns[0].seenAt + STALE_MS);
    t.advance(STALE_MS, [conns[1]]);
    expect(t.room.view(conns[1], t.live).lead).toBe(true);
  });
});

describe("socket cap", () => {
  /**
   * A new socket says its first hello as `token`, through the admit rule as the adapters run it.
   * Returns the socket and the one admit chose to close (itself, when it's turned away).
   */
  const enter = (t: Setup, token: string) => {
    const conn = newConn(t.now(), null);
    t.live.push(conn);
    const out = t.room.admit(conn, token, t.live);
    if (out) t.live.splice(t.live.indexOf(out), 1);
    if (out !== conn) t.send(conn, { t: "hello", token });
    return { conn, out };
  };
  const watcher = (i: number) => `watcher-${i}-abcdef`;

  it("SEC-2: 8 players and 12 spectators get in; the 21st socket, a spectator, is turned away", () => {
    const t = setup();
    t.seated(8);
    for (let i = 0; i < MAX_SOCKETS - 8; i++) expect(enter(t, watcher(i)).out).toBeNull();
    const late = enter(t, watcher(99));
    expect(late.out).toBe(late.conn);
    expect(t.live).toHaveLength(MAX_SOCKETS);
  });

  it("SEC-2: at the cap a spectator's reconnect takes the place of its own lingering socket", () => {
    const t = setup();
    t.seated(8);
    const watchers = Array.from({ length: MAX_SOCKETS - 8 }, (_, i) => enter(t, watcher(i)).conn);
    const back = enter(t, watcher(4));
    expect(back.out).toBe(watchers[4]);
    expect(t.live).toHaveLength(MAX_SOCKETS);
  });

  it("SEC-2: at the cap a seated player always gets in, in place of its own lingering socket, else of the least recently seen spectator", () => {
    const t = setup();
    const players = t.seated(8);
    const watchers = Array.from({ length: MAX_SOCKETS - 8 }, (_, i) => {
      t.advance(1_000, players); // the players ping; watchers are seen when they arrive
      return enter(t, watcher(i)).conn;
    });
    // Seat 3's phone dropped without closing, and it reconnects while its old socket lingers.
    const back = enter(t, "token-3-abcdef");
    expect(back.out).toBe(players[3]);
    expect(t.room.view(back.conn, t.live).you).toBe(3);
    // Seat 5 left, and the room filled up while it was away.
    t.drop(players[5]);
    expect(enter(t, watcher(50)).out).toBeNull();
    const five = enter(t, "token-5-abcdef");
    expect(five.out).toBe(watchers[0]);
    expect(t.room.view(five.conn, t.live).you).toBe(5);
    expect(t.live).toHaveLength(MAX_SOCKETS);
  });

  it("SEC-2: in a full room a seat's new tab replaces its own oldest one, so seats can't grow it by more than one each", () => {
    const t = setup();
    const players = t.seated(8);
    t.drop(players[2]);
    t.advance(1_000, []); // seat 0's first socket is now its least recently seen
    const tabs = Array.from({ length: MAX_SOCKETS - 7 }, () => enter(t, "token-0-abcdef"));
    expect(tabs.map((tab) => tab.out)).toEqual(tabs.map(() => null));
    // Seat 2 has no socket to replace and no spectator to displace, and still gets in.
    expect(enter(t, "token-2-abcdef").out).toBeNull();
    expect(t.live).toHaveLength(MAX_SOCKETS + 1);
    expect(enter(t, "token-0-abcdef").out).toBe(players[0]);
    expect(enter(t, "token-2-abcdef").out?.token).toBe("token-2-abcdef");
    expect(t.live).toHaveLength(MAX_SOCKETS + 1);
  });

  it("SEC-2: a socket keeps the token of its first hello", () => {
    const t = setup();
    const [a] = t.seated(2);
    expect(t.errorOf(() => t.send(a, { t: "hello", token: "token-1-abcdef" }))).toBe("bad-message");
    expect(a.token).toBe("token-0-abcdef");
    expect(t.errorOf(() => t.send(a, { t: "hello", token: "token-0-abcdef" }))).toBeNull();
  });

  it("SEC-2: at the cap a socket not seen for 2 × STALE_MS goes before anyone is turned away", () => {
    const t = setup();
    const players = t.seated(4);
    // 16 phones that dropped without closing; the players keep pinging.
    const dropped = Array.from({ length: MAX_SOCKETS - 4 }, (_, i) => {
      t.advance(1_000, players);
      return enter(t, watcher(i)).conn;
    });
    t.advance(2 * STALE_MS - 16_000, players);
    const early = enter(t, watcher(98));
    expect(early.out).toBe(early.conn);
    t.advance(1_000, players);
    expect(enter(t, watcher(99)).out).toBe(dropped[0]);
    expect(dead(dropped[0], t.now())).toBe(true);
    expect(players.some((c) => dead(c, t.now()))).toBe(false);
  });

  it("SEC-6: sockets that never said hello hold no place, and are silent once 10 s old", () => {
    const t = setup();
    t.seated(2);
    const quiet = Array.from({ length: 30 }, () => {
      const conn = newConn(t.now(), null);
      t.live.push(conn);
      return conn;
    });
    for (let i = 0; i < MAX_SOCKETS - 2; i++) expect(enter(t, watcher(i)).out).toBeNull();
    t.advance(HELLO_MS - 1); // pings don't count as a hello
    expect(quiet.some((c) => silent(c, t.now()))).toBe(false);
    t.advance(1);
    expect(quiet.every((c) => silent(c, t.now()))).toBe(true);
    expect(t.live.filter((c) => silent(c, t.now()))).toEqual(quiet);
  });
});

describe("protocol", () => {
  it("parseClientMsg rejects malformed frames", () => {
    for (const raw of [
      null,
      42,
      "",
      "not json",
      "null",
      "[]",
      "{}",
      '{"t":"nope"}',
      '{"t":"hello","token":"short"}',
      '{"t":"join","name":5}',
      '{"t":"kick","seat":"1"}',
      '{"t":"act","action":null}',
      '{"t":"act","action":{"type":"swap"}}',
      '{"t":"act","action":{"type":"draw","source":"hand"}}',
      '{"t":"auto"}',
      '{"t":"auto","on":"yes"}',
      '{"t":"auto","on":1}',
      `{"t":"join","name":"${"x".repeat(2000)}"}`,
    ]) {
      expect(parseClientMsg(raw)).toBeNull();
    }
  });

  it("never copies a seat from the payload; keeps a valid seq", () => {
    expect(
      parseClientMsg('{"t":"act","seq":4,"action":{"type":"swap","seat":3,"pos":2,"x":1}}'),
    ).toEqual({ t: "act", seq: 4, action: { type: "swap", seat: -1, pos: 2 } });
    expect(parseClientMsg('{"t":"start","seq":-1}')).toEqual({ t: "start" });
  });

  it("a socket flooding more than 120 messages in 10 s is cut off", () => {
    const c = newConn(0, null);
    for (let i = 0; i < 120; i++) expect(allowMessage(c, 1_000)).toBe(true);
    expect(allowMessage(c, 2_000)).toBe(false);
    expect(allowMessage(c, 11_000)).toBe(true);
  });
});

describe("per-IP limits", () => {
  it("SEC-1: keys IPv4 by address and IPv6 by its /64", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7"); // Node's dual-stack form
    const home = [
      "2001:db8:1:2::a",
      "2001:0DB8:0001:0002:ffff:ffff:ffff:ffff",
      "2001:db8:1:2:3:4:5:6",
    ];
    expect(new Set(home.map(ipKey))).toEqual(new Set(["2001:db8:1:2::/64"]));
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("1::5:6:7:8:9")).toBe("1:0:0:5::/64");
    expect(ipKey("2001:db8:1:3::a")).not.toBe(ipKey("2001:db8:1:2::a"));
    expect(ipKey("unknown")).toBe("unknown");
    expect(ipKey("not:an:ip")).toBe("not:an:ip");
  });

  it("SEC-10: Node keys a socket by its peer, or by the address a local proxy forwards", () => {
    expect(peerKey("203.0.113.7", "198.51.100.1")).toBe("203.0.113.7"); // only a local proxy is trusted
    expect(peerKey("::ffff:192.168.1.20", undefined)).toBe("192.168.1.20");
    expect(peerKey("127.0.0.1", "2001:db8:1:2::a")).toBe("2001:db8:1:2::/64"); // cloudflared
    expect(peerKey("::1", "203.0.113.7")).toBe("203.0.113.7");
    expect(peerKey("127.0.0.1", undefined)).toBeNull(); // dev, E2E
    expect(peerKey("::ffff:127.0.0.1", undefined)).toBeNull();
  });

  it("SEC-10: one IP gets IP_MESSAGES_PER_MINUTE messages a minute across all its sockets", () => {
    const windows = new Map();
    for (let i = 0; i < IP_MESSAGES_PER_MINUTE; i++) {
      expect(allowIp(windows, "203.0.113.7", 1_000 + i)).toBe(true);
    }
    expect(allowIp(windows, "203.0.113.7", 30_000)).toBe(false);
    expect(allowIp(windows, "198.51.100.1", 30_000)).toBe(true);
    expect(allowIp(windows, "203.0.113.7", 61_000)).toBe(true);
  });

  it("SEC-10: forgets idle addresses once it tracks 10,000", () => {
    const windows = new Map();
    for (let i = 0; i < 10_000; i++) allowIp(windows, `ip-${i}`, 0);
    allowIp(windows, "fresh", 60_000);
    expect([...windows.keys()]).toEqual(["fresh"]);
  });

  it("SEC-1, SEC-11: wrangler.jsonc limits each IP to 30 /api requests, 10 rooms and IP_MESSAGES_PER_MINUTE units a minute", () => {
    const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""));
    const limits = Object.fromEntries(
      config.ratelimits.map((r: { name: string; simple: object }) => [r.name, r.simple]),
    );
    expect(limits).toEqual({
      API_REQUESTS: { limit: 30, period: 60 },
      ROOM_CREATION: { limit: 10, period: 60 },
      MESSAGES: { limit: IP_MESSAGES_PER_MINUTE, period: 60 },
    });
  });
});
