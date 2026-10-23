import { describe, expect, it } from "vitest";
import { type Action, legalActions } from "../engine/game";
import type { Rng } from "../engine/rng";
import { type ClientMsg, parseClientMsg } from "../protocol";
import { type Conn, IDLE_MS, newRoom, Room, RoomError, STALL_MS } from "./room";

function setup() {
  let now = 1_000_000;
  let seeds = 0;
  const deps = {
    now: () => now,
    seed: (): Rng => [++seeds, 7, 7, 7],
  };
  const room = new Room(newRoom("ABCDE", now), deps);
  const live: Conn[] = [];
  const send = (c: Conn, msg: ClientMsg) => room.receive(c, msg, live);
  const connect = (token: string) => {
    const c: Conn = { token: null, seenAt: now };
    live.push(c);
    send(c, { t: "hello", token });
    return c;
  };
  const drop = (c: Conn) => {
    live.splice(live.indexOf(c), 1);
    room.closed(c);
  };
  /** Keeps every live socket fresh, like the client's 20 s pings. */
  const advance = (ms: number, ping = true) => {
    now += ms;
    if (ping) for (const c of live) c.seenAt = now;
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
  return { room, live, send, connect, drop, advance, seated, errorOf, seedCalls: () => seeds };
}

/**
 * Sends a legal move for whichever seat must act, through that seat's socket. While placing it
 * picks discard-and-flip (listed last), so every turn reveals a card and rounds always end.
 */
function stepAny(t: ReturnType<typeof setup>, conns: Conn[]) {
  const game = t.room.data.game;
  if (!game) throw new Error("no game");
  const legal = legalActions(game);
  const action = legal[game.phase === "place" ? legal.length - 1 : 0] as Action;
  const seat = "seat" in action ? action.seat : t.room.data.host;
  t.send(conns[seat], { t: "act", action: "seat" in action ? { ...action, seat: 99 } : action });
}

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

  it("messages before hello are rejected", () => {
    const t = setup();
    const c: Conn = { token: null, seenAt: 0 };
    expect(t.errorOf(() => t.send(c, { t: "join", name: "X" }))).toBe("bad-message");
  });
});

describe("play", () => {
  it("moves use the sender's seat, never the payload's", () => {
    const t = setup();
    const [a, b] = t.seated(2);
    t.send(a, { t: "start" });
    t.send(b, { t: "act", action: { type: "flip", seat: 0, pos: 3 } });
    const grids = t.room.data.game?.players.map((p) => p.grid[3]?.up);
    expect(grids).toEqual([false, true]);
  });

  it("out-of-turn moves and spectator moves are rejected", () => {
    const t = setup();
    const [a, b] = t.seated(2);
    t.send(a, { t: "start" });
    for (const c of [a, b]) {
      t.send(c, { t: "act", action: { type: "flip", seat: 0, pos: 0 } });
      t.send(c, { t: "act", action: { type: "flip", seat: 0, pos: 1 } });
    }
    const current = t.room.data.game?.current ?? 0;
    const idle = [a, b][1 - current];
    const move: ClientMsg = { t: "act", action: { type: "draw", seat: 0, source: "deck" } };
    expect(t.errorOf(() => t.send(idle, move))).toBe("illegal-move");
    const watcher = t.connect("token-w-abcdef");
    expect(t.errorOf(() => t.send(watcher, move))).toBe("not-allowed");
  });

  it("a returning token reclaims its seat", () => {
    const t = setup();
    const [a] = t.seated(2);
    t.drop(a);
    const again = t.connect("token-0-abcdef");
    expect(t.room.view(again, t.live).you).toBe(0);
  });

  it("a full game through the room reaches game over; views never leak secrets", () => {
    const t = setup();
    const conns = t.seated(3);
    const watcher = t.connect("token-w-abcdef");
    t.send(conns[0], { t: "start" });
    for (let i = 0; t.room.data.game?.phase !== "gameOver"; i++) {
      expect(i).toBeLessThan(20_000);
      stepAny(t, conns);
      for (const c of [...conns, watcher]) {
        const json = JSON.stringify(t.room.view(c, t.live));
        expect(json).not.toMatch(/token-|"deck":|"rng":|"seenAt":/);
      }
    }
    // Start + one fresh seed per round after the first.
    expect(t.seedCalls()).toBe(t.room.data.game?.round);
  });

  it("the host advances rounds; anyone may once the host is away", () => {
    const t = setup();
    const conns = t.seated(2);
    t.send(conns[0], { t: "start" });
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

  it("rematch deals a new game with the same seats plus late joiners", () => {
    const t = setup();
    const conns = t.seated(2);
    t.send(conns[0], { t: "start" });
    while (t.room.data.game?.phase !== "gameOver") {
      if (t.room.data.game?.phase === "roundOver") {
        t.send(conns[0], { t: "act", action: { type: "nextRound" } });
      } else stepAny(t, conns);
    }
    const late = t.connect("token-late-abcdef");
    t.send(late, { t: "join", name: "Late" });
    expect(t.errorOf(() => t.send(conns[1], { t: "rematch" }))).toBe("not-allowed");
    t.send(conns[0], { t: "rematch" });
    expect(t.room.data.game?.players.map((p) => p.name)).toEqual(["P0", "P1", "Late"]);
    expect(t.room.data.game?.round).toBe(1);
  });

  it("nobody can join or leave mid-game", () => {
    const t = setup();
    const [a] = t.seated(2);
    t.send(a, { t: "start" });
    const late = t.connect("token-late-abcdef");
    expect(t.errorOf(() => t.send(late, { t: "join", name: "Late" }))).toBe("not-allowed");
    expect(t.errorOf(() => t.send(a, { t: "leave" }))).toBe("not-allowed");
  });
});

describe("stall guard", () => {
  it("flips two cards for a seat gone 60 s during the initial flip", () => {
    const t = setup();
    const [a, b] = t.seated(2);
    t.send(a, { t: "start" });
    t.drop(b);
    t.advance(STALL_MS - 1);
    expect(t.room.tick(t.live)).toBe(false);
    t.advance(1);
    expect(t.room.tick(t.live)).toBe(true);
    expect(t.room.data.game?.players[1].grid.filter((s) => s?.up)).toHaveLength(2);
  });

  it("plays draw, discard, flip for the current player gone 60 s", () => {
    const t = setup();
    const conns = t.seated(2);
    t.send(conns[0], { t: "start" });
    while (t.room.data.game?.phase === "flip") stepAny(t, conns);
    const current = t.room.data.game?.current ?? 0;
    const before = t.room.data.game?.players[current].grid.filter((s) => s?.up).length ?? 0;
    t.drop(conns[current]);
    t.advance(STALL_MS);
    t.room.tick(t.live);
    expect(t.room.data.game?.current).toBe(1 - current);
    expect(t.room.data.game?.players[current].grid.filter((s) => s?.up).length).toBe(before + 1);
  });

  it("a silent socket counts as gone; a pinging one is never moved for", () => {
    const t = setup();
    const [a, b] = t.seated(2);
    t.send(a, { t: "start" });
    t.advance(10 * STALL_MS); // both keep pinging
    expect(t.room.tick(t.live)).toBe(false);
    b.seenAt -= STALL_MS; // b's phone went to sleep without closing the socket
    expect(t.room.tick(t.live)).toBe(true);
    expect(t.room.view(a, t.live).seats[1].connected).toBe(false);
  });

  it("nextAlarm points at the earliest stall deadline, else the idle deadline", () => {
    const t = setup();
    const [a, b] = t.seated(2);
    expect(t.room.nextAlarm(t.live)).toBe(t.room.data.updatedAt + IDLE_MS);
    t.send(a, { t: "start" });
    t.drop(b);
    expect(t.room.nextAlarm(t.live)).toBe(t.room.data.seats[1].seenAt + STALL_MS);
  });

  it("an empty room is idle after 24 h", () => {
    const t = setup();
    const [a] = t.seated(1);
    t.drop(a);
    t.advance(IDLE_MS, false);
    expect(t.room.isIdle(t.live)).toBe(true);
  });
});

describe("parseClientMsg", () => {
  it("rejects malformed frames", () => {
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
      '{"t":"act","action":null}',
      '{"t":"act","action":{"type":"swap"}}',
      '{"t":"act","action":{"type":"draw","source":"hand"}}',
      `{"t":"join","name":"${"x".repeat(2000)}"}`,
    ]) {
      expect(parseClientMsg(raw)).toBeNull();
    }
  });

  it("never copies a seat from the payload", () => {
    expect(parseClientMsg('{"t":"act","action":{"type":"swap","seat":3,"pos":2,"x":1}}')).toEqual({
      t: "act",
      action: { type: "swap", seat: -1, pos: 2 },
    });
  });
});
