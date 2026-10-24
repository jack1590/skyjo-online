import { describe, expect, it } from "vitest";
import { type Action, legalActions } from "../engine/game";
import type { Rng } from "../engine/rng";
import { type ClientMsg, parseClientMsg } from "../protocol";
import {
  allowMessage,
  type Conn,
  IDLE_MS,
  newConn,
  newRoom,
  Room,
  RoomError,
  STALE_MS,
  STALL_MS,
} from "./room";

function setup() {
  let now = 1_000_000;
  let seeds = 0;
  const deps = { now: () => now, seed: (): Rng => [++seeds, 7, 7, 7] };
  const room = new Room(newRoom("ABCDE", now), deps);
  const live: Conn[] = [];
  const send = (c: Conn, msg: ClientMsg) => room.receive(c, msg, live);
  const connect = (token: string) => {
    const c = newConn(now);
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
      { name: "P0", connected: true },
      { name: "P1", connected: true },
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
    expect(t.errorOf(() => t.send(newConn(0), { t: "join", name: "X" }))).toBe("bad-message");
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
    expect(t.send(a, { t: "hello", token: "token-0-abcdef" })).toBe(false);
    expect(t.send(a, { t: "start" })).toBe(true);
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

  it("a full game through the room reaches game over; views never leak secrets", () => {
    const t = setup();
    const conns = t.seated(3);
    const watcher = t.connect("token-w-abcdef");
    t.send(conns[0], { t: "start" });
    for (let i = 0; t.room.data.game?.phase !== "gameOver"; i++) {
      expect(i).toBeLessThan(20_000);
      stepAny(t, conns);
      const state = t.room.data.game;
      for (const c of [...conns, watcher]) {
        const view = t.room.view(c, t.live);
        expect(JSON.stringify(view)).not.toMatch(/token-|"deck":|"rng":|"seenAt":/);
        // Every face-down card reaches every client, its own player included, only as "down".
        state?.players.forEach((p, seat) => {
          p.grid.forEach((slot, pos) => {
            if (slot && !slot.up) expect(view.game?.players[seat].grid[pos]).toBe("down");
          });
        });
      }
    }
    // Start + one fresh seed per round after the first.
    expect(t.seedCalls()).toBe(t.room.data.game?.round);
  });

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

describe("stall guard", () => {
  it("flips two cards for a seat gone 60 s during the initial flip", () => {
    const t = setup();
    const [a, b] = startedGame(t, 2);
    t.drop(b);
    t.advance(STALL_MS - 1, [a]);
    expect(t.room.tick(t.live)).toBe(false);
    t.advance(1, [a]);
    expect(t.room.tick(t.live)).toBe(true);
    expect(upCount(t, 1)).toBe(2);
  });

  it("plays draw, discard, flip for the current player gone 60 s", () => {
    const t = setup();
    const conns = startedGame(t, 2);
    pastFlips(t, conns);
    const current = t.room.data.game?.current ?? 0;
    const before = upCount(t, current);
    t.drop(conns[current]);
    t.advance(STALL_MS);
    t.room.tick(t.live);
    expect(t.room.data.game?.current).toBe(1 - current);
    expect(upCount(t, current)).toBe(before + 1);
  });

  it("a seat that went quiet before its turn still gets 60 s once its turn starts", () => {
    const t = setup();
    const conns = startedGame(t, 3);
    pastFlips(t, conns);
    const current = t.room.data.game?.current ?? 0;
    const next = (current + 1) % 3;
    const others = conns.filter((_, i) => i !== next);
    t.advance(STALL_MS + 1_000, others); // `next` stops pinging (phone locked) while `current` thinks
    stepAny(t, conns);
    stepAny(t, conns); // current finishes: now it's next's turn
    expect(t.room.data.game?.current).toBe(next);
    expect(t.room.tick(t.live)).toBe(false);
    t.advance(STALL_MS, others);
    expect(t.room.tick(t.live)).toBe(true);
  });

  it("a silent socket counts as gone; a pinging one is never moved for", () => {
    const t = setup();
    const [a] = startedGame(t, 2);
    t.advance(10 * STALL_MS); // both keep pinging
    expect(t.room.tick(t.live)).toBe(false);
    t.advance(STALL_MS, [a]); // b's phone sleeps without closing the socket
    expect(t.room.tick(t.live)).toBe(true);
    expect(t.room.view(a, t.live).seats[1].connected).toBe(false);
  });

  it("with everyone gone nothing is auto-played", () => {
    const t = setup();
    const conns = startedGame(t, 4);
    for (const c of conns) t.drop(c);
    t.advance(10 * STALL_MS, []);
    expect(t.room.tick(t.live)).toBe(false);
    expect(t.room.data.game?.phase).toBe("flip");
  });

  it("a long-dead socket closing late doesn't restart its seat's stall clock", () => {
    const t = setup();
    const [a, b] = startedGame(t, 2);
    t.advance(STALL_MS, [a]);
    t.drop(b); // the server only now notices the close
    expect(t.room.tick(t.live)).toBe(true);
  });
});

describe("scheduling", () => {
  it("nextAlarm is always in the future after tick, through a whole game", () => {
    const t = setup();
    const conns = startedGame(t, 3);
    for (let i = 0; t.room.data.game?.phase !== "gameOver" && i < 20_000; i++) {
      if (i % 7 === 0) t.advance(STALL_MS, conns.slice(1)); // seat 0 drifts in and out
      t.room.tick(t.live);
      expect(t.room.nextAlarm(t.live)).toBeGreaterThan(t.now());
      // tick() may have ended the round or the game, so read the phase fresh.
      const phase: string | undefined = t.room.data.game?.phase;
      if (phase === "roundOver") t.send(conns[1], { t: "act", action: { type: "nextRound" } });
      else if (phase !== "gameOver") stepAny(t, conns);
    }
    expect(t.room.data.game?.phase).toBe("gameOver");
  });

  it("an idle room is idle after 24 h even with a forgotten tab open", () => {
    const t = setup();
    t.seated(2);
    t.advance(IDLE_MS); // tabs keep pinging, nobody sends a message
    expect(t.room.isIdle()).toBe(true);
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
    const c = newConn(0);
    for (let i = 0; i < 120; i++) expect(allowMessage(c, 1_000)).toBe(true);
    expect(allowMessage(c, 2_000)).toBe(false);
    expect(allowMessage(c, 11_000)).toBe(true);
  });
});
