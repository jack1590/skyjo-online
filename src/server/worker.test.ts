import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Action, legalActions } from "../engine/game";
import type { ClientMsg, RoomView, ServerMsg } from "../protocol";
import {
  type Conn,
  EMPTY_IDLE_MS,
  IDLE_MS,
  IP_MESSAGES_PER_MINUTE,
  type Room,
  STALL_MS,
} from "./room";
import { RoomDO } from "./worker";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

/** A hibernatable WebSocket as the Durable Object sees it. */
class FakeSocket {
  sent: ServerMsg[] = [];
  private attachment: unknown = null;
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  /** The close code the object sent, if it closed this socket. */
  closed: number | null = null;
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code: number) {
    this.closed = code;
  }
}

vi.stubGlobal("WebSocketRequestResponsePair", class {});
vi.stubGlobal(
  "WebSocketPair",
  class {
    0 = new FakeSocket();
    1 = new FakeSocket();
  },
);
vi.stubGlobal("Response", class {}); // Node's Response refuses status 101
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
});

const PING_MS = 20_000;
const token = (i: number) => `token-${i}-abcdef`;
/** One home router: every phone in these tests shares it unless a test says otherwise. */
const HOME = "203.0.113.7";

/** The MESSAGES ratelimit binding: fixed windows on the wall clock, like Cloudflare's and miniflare's. */
function messageLimiter() {
  const counts = new Map<string, number>();
  return {
    limit: async ({ key }: { key: string }) => {
      const window = `${key}@${Math.floor(Date.now() / 60_000)}`;
      const n = (counts.get(window) ?? 0) + 1;
      counts.set(window, n);
      return { success: n <= IP_MESSAGES_PER_MINUTE };
    },
  };
}

/**
 * A RoomDO on a fake runtime that counts rows written (each `put` and each `setAlarm`), runs
 * alarms when the clock passes them, and answers pings without waking the object.
 */
async function harness(env = { MESSAGES: messageLimiter() }) {
  const sockets: FakeSocket[] = [];
  const pings = new Map<FakeSocket, number>();
  const data = new Map<string, unknown>();
  const storage = {
    puts: 0,
    alarmSets: 0,
    /** setAlarm calls that didn't move the alarm earlier: they buy nothing. */
    needless: 0,
    alarm: null as number | null,
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: unknown) => {
      storage.puts++;
      data.set(key, structuredClone(value));
    },
    setAlarm: async (at: number) => {
      storage.alarmSets++;
      if (storage.alarm !== null && at >= storage.alarm) storage.needless++;
      storage.alarm = at;
    },
    getAlarm: async () => storage.alarm,
    deleteAll: async () => data.clear(),
  };
  const ctx = {
    storage,
    acceptWebSocket: (ws: FakeSocket) => sockets.push(ws),
    getWebSockets: () => sockets,
    setWebSocketAutoResponse: () => {},
    getWebSocketAutoResponseTimestamp: (ws: FakeSocket) => {
      const at = pings.get(ws);
      return at === undefined ? null : new Date(at);
    },
  };
  let durable = new RoomDO(ctx as never, env as never);
  /** Every client message, by when it was sent (ms). */
  const log: number[] = [];
  await durable.create("ABCDE");
  /** The object's in-memory room and sockets, private to it. */
  const inside = () => durable as unknown as { room: Room | null; live(): Map<unknown, Conn> };

  const t = {
    storage,
    rows: () => storage.puts + storage.alarmSets,
    exists: () => data.has("room"),
    /** The object is evicted (hibernation) and a fresh instance handles the next event. */
    wake: () => {
      durable = new RoomDO(ctx as never, env as never);
    },
    log,
    connect: async (ip = HOME) => {
      const url = "https://skyjo-online.example.workers.dev/api/rooms/ABCDE/ws";
      await durable.fetch(new Request(url, { headers: { "cf-connecting-ip": ip } }));
      return sockets[sockets.length - 1];
    },
    send: (ws: FakeSocket, msg: ClientMsg | string) => {
      log.push(Date.now());
      return durable.webSocketMessage(
        ws as never,
        typeof msg === "string" ? msg : JSON.stringify(msg),
      );
    },
    close: async (ws: FakeSocket) => {
      await durable.webSocketClose(ws as never);
      sockets.splice(sockets.indexOf(ws), 1);
    },
    /** Moves the clock, running each alarm when it comes due. `pinging` sockets ping every 20 s. */
    advance: async (ms: number, pinging: FakeSocket[] = []) => {
      const end = Date.now() + ms;
      const ping = () => {
        for (const [i, ws] of pinging.entries()) {
          const offset = (i * PING_MS) / pinging.length;
          pings.set(ws, Date.now() - ((Date.now() - offset) % PING_MS));
        }
      };
      while (storage.alarm !== null && storage.alarm <= end) {
        vi.setSystemTime(storage.alarm);
        storage.alarm = null;
        ping();
        await durable.alarm();
      }
      vi.setSystemTime(end);
      ping();
    },
    /** The scheduled alarm is never later than the room's own next check. */
    onTime: () => {
      const due = inside().room?.nextAlarm([...inside().live().values()]);
      return due !== undefined && storage.alarm !== null && storage.alarm <= due;
    },
    game: () => inside().room?.data.game ?? null,
    seat: async (n: number) => {
      const conns: FakeSocket[] = [];
      for (let i = 0; i < n; i++) {
        const ws = await t.connect();
        await t.send(ws, { t: "hello", token: token(i) });
        await t.send(ws, { t: "join", name: `P${i}` });
        conns.push(ws);
      }
      return conns;
    },
  };
  return t;
}

const lastView = (ws: FakeSocket): RoomView => {
  const msg = ws.sent.filter((m) => m.t === "state").at(-1);
  if (msg?.t !== "state") throw new Error("no state yet");
  return msg.room;
};
const faceUp = (view: RoomView, seat: number) =>
  view.game?.players[seat].grid.filter((s) => s !== "down" && s !== null).length ?? 0;

describe("RoomDO storage writes", () => {
  it("SEC-3: 100 repeated hellos write nothing and reach no other socket", async () => {
    const t = await harness();
    const [a, b] = await t.seat(2);
    const rows = t.rows();
    const [toA, toB] = [a.sent.length, b.sent.length];
    for (let i = 0; i < 100; i++) {
      vi.setSystemTime(Date.now() + 50);
      await t.send(a, { t: "hello", token: token(0) });
    }
    expect(t.rows()).toBe(rows);
    expect(b.sent.length).toBe(toB);
    expect(a.sent.length).toBe(toA + 100); // the sender still gets its own view
  });

  it("SEC-3: a reconnecting phone's hello still tells the others it is back", async () => {
    const t = await harness();
    const [a, b] = await t.seat(2);
    await t.close(b);
    expect(lastView(a).seats[1].connected).toBe(false);
    const back = await t.connect();
    await t.send(back, { t: "hello", token: token(1) });
    expect(lastView(a).seats[1].connected).toBe(true);
  });

  it("SEC-3: a repeated hello writes nothing right after the object wakes from hibernation", async () => {
    const t = await harness();
    const [a] = await t.seat(2);
    await t.advance(30_000);
    t.wake();
    const rows = t.rows();
    await t.send(a, { t: "hello", token: token(0) });
    expect(t.rows()).toBe(rows);
  });

  it("SEC-3: rejected and malformed messages write nothing and reach no other socket", async () => {
    const t = await harness();
    const [a, b] = await t.seat(2);
    const rows = t.rows();
    const toB = b.sent.length;
    const rejected: (ClientMsg | string)[] = [
      "not json",
      '{"t":"nope"}',
      { t: "join", name: "Again" },
      { t: "kick", seat: 1 },
      { t: "rematch" },
      { t: "act", action: { type: "draw", seat: 0, source: "deck" } },
    ];
    for (const msg of rejected) await t.send(a, msg);
    expect(t.rows()).toBe(rows);
    expect(b.sent.length).toBe(toB);
    expect(a.sent.slice(-rejected.length).every((m) => m.t === "error")).toBe(true);
  });

  it("SEC-3: a spectator's socket closing writes nothing", async () => {
    const t = await harness();
    await t.seat(2);
    const watcher = await t.connect();
    await t.send(watcher, { t: "hello", token: token(9) });
    const rows = t.rows();
    await t.close(watcher);
    expect(t.rows()).toBe(rows);
  });

  it("SEC-3: a 4-player game writes each move once and sets an alarm only to move it earlier", async () => {
    const t = await harness();
    const conns = await t.seat(4);
    await t.send(conns[0], { t: "start" });
    const puts = t.storage.puts;
    let moves = 0;
    for (let game = t.game(); game && game.phase !== "gameOver"; game = t.game()) {
      await t.advance(2_000, conns);
      const legal = legalActions(game);
      const action = legal[game.phase === "place" ? legal.length - 1 : 0] as Action;
      const seat = "seat" in action ? action.seat : 0;
      await t.send(conns[seat], { t: "act", action });
      moves++;
      expect(t.storage.puts).toBe(puts + moves);
      expect(t.onTime()).toBe(true);
    }
    expect(t.storage.needless).toBe(0);
    expect(t.storage.alarmSets).toBeLessThan(moves / 4);
  });
});

describe("RoomDO alarms", () => {
  it("SEC-3: the stall guard still moves for an absent seat exactly 60 s into its wait", async () => {
    const t = await harness();
    const [a, b] = await t.seat(2);
    await t.send(a, { t: "start" });
    await t.close(b); // b's phone dies during the opening flip
    t.wake(); // and the object hibernates while the table waits
    await t.advance(STALL_MS - 1, [a]);
    expect(faceUp(lastView(a), 1)).toBe(0);
    await t.advance(1, [a]);
    expect(faceUp(lastView(a), 1)).toBe(2);
  });

  it("SEC-3: an empty room still expires 10 min after its last message", async () => {
    const t = await harness();
    const visitor = await t.connect();
    await t.advance(60_000);
    await t.send(visitor, { t: "hello", token: token(9) }); // last message: never joins
    await t.advance(60_000);
    await t.close(visitor);
    await t.advance(EMPTY_IDLE_MS - 60_000 - 1);
    expect(t.exists()).toBe(true);
    await t.advance(1);
    expect(t.exists()).toBe(false);
  });

  it("SEC-3: a lobby with forgotten tabs still expires 24 h after its last message", async () => {
    const t = await harness();
    const conns = await t.seat(2);
    await t.advance(60 * 60_000, conns);
    await t.send(conns[0], { t: "hello", token: token(0) }); // last message, one hour in
    await t.advance(IDLE_MS - 1, conns);
    expect(t.exists()).toBe(true);
    await t.advance(1, conns);
    expect(t.exists()).toBe(false);
    expect(conns[1].sent.at(-1)).toEqual({ t: "missing" });
  });
});

/** Moves the clock to the start of a minute, so a test's messages share one limiter window. */
const nextMinute = () => vi.setSystemTime(Math.ceil((Date.now() + 1) / 60_000) * 60_000);
/** 10 messages a second: fast, but under the per-socket flood limit (120 per 10 s). */
const soon = () => vi.setSystemTime(Date.now() + 100);

describe("RoomDO per-IP message budget", () => {
  it("SEC-10: a join/leave loop is closed at its IP's budget, and the message past it writes nothing", async () => {
    const t = await harness();
    nextMinute();
    const bot = await t.connect();
    await t.send(bot, { t: "hello", token: token(0) });
    for (let i = 1; i < IP_MESSAGES_PER_MINUTE; i++) {
      soon();
      await t.send(bot, i % 2 ? { t: "join", name: "Bot" } : { t: "leave" });
    }
    expect(bot.closed).toBeNull();
    const rows = t.rows();
    soon();
    await t.send(bot, { t: "leave" });
    expect(bot.closed).toBe(1008);
    expect(t.rows()).toBe(rows);
  });

  it("SEC-10: the budget is shared by all of an IP's sockets, in every room; another IP has its own", async () => {
    const limiter = messageLimiter();
    const [a, b] = [await harness({ MESSAGES: limiter }), await harness({ MESSAGES: limiter })];
    nextMinute();
    const [inA, inB] = [await a.connect(), await b.connect()];
    for (let i = 0; i < IP_MESSAGES_PER_MINUTE; i++) {
      soon();
      if (i % 2) await b.send(inB, { t: "hello", token: token(1) });
      else await a.send(inA, { t: "hello", token: token(0) });
    }
    const neighbour = await a.connect("198.51.100.1");
    await a.send(neighbour, { t: "hello", token: token(2) });
    await b.send(inB, { t: "hello", token: token(1) });
    expect(inB.closed).toBe(1008);
    expect(neighbour.closed).toBeNull();
  });

  it("SEC-10: budget use survives hibernation", async () => {
    const t = await harness();
    nextMinute();
    const ws = await t.connect();
    for (let i = 0; i < IP_MESSAGES_PER_MINUTE; i++) {
      soon();
      await t.send(ws, { t: "hello", token: token(0) });
    }
    t.wake(); // a fresh instance knows the socket's IP only from its attachment
    await t.send(ws, { t: "hello", token: token(0) });
    expect(ws.closed).toBe(1008);
  });

  it("SEC-10: 8 friends behind one IP play two fast games, with reconnects and a rematch, and never trip it", async () => {
    const t = await harness();
    /** One tap a second, every turn, on every phone: faster than any real table plays. */
    const TAP = 1_000;
    const phones: FakeSocket[] = [];
    const everyone: FakeSocket[] = [];
    const connect = async (seat: number) => {
      const ws = await t.connect();
      everyone.push(ws);
      await t.send(ws, { t: "hello", token: token(seat) });
      return ws;
    };
    for (let seat = 0; seat < 8; seat++) {
      phones.push(await connect(seat));
      await t.advance(TAP, phones);
      await t.send(phones[seat], { t: "join", name: `P${seat}` });
      await t.advance(TAP, phones);
    }
    const act = (seat: number, action: Action) => t.send(phones[seat], { t: "act", action });
    for (let games = 0; games < 2; games++) {
      await t.send(phones[0], { t: "start" });
      await t.advance(TAP, phones);
      for (let game = t.game(); game && game.phase !== "gameOver"; game = t.game()) {
        const legal = legalActions(game);
        if (game.phase === "flip") {
          // Everyone flips at once.
          for (let seat = 0; seat < 8; seat++) {
            const flip = legal.find((a) => a.type === "flip" && a.seat === seat);
            if (flip) await act(seat, flip);
          }
        } else if (game.phase === "roundOver") {
          // Every phone locked during the summary: all 8 reconnect at once, then the host deals.
          for (let seat = 0; seat < 8; seat++) {
            await t.close(phones[seat]);
            phones[seat] = await connect(seat);
          }
          await t.advance(TAP, phones);
          await act(0, { type: "nextRound" });
        } else {
          await act(game.current, legal[game.phase === "place" ? legal.length - 1 : 0] as Action);
        }
        await t.advance(TAP, phones);
      }
      await t.send(phones[0], { t: "rematch" });
      await t.advance(TAP, phones);
    }
    expect(everyone.filter((ws) => ws.closed !== null)).toEqual([]);
    // The busiest sliding minute is 74, or 81 when a round ends, 8 phones reconnect and 16 cards
    // flip in it (the deal is random); the budget keeps at least a third more on top.
    const peak = Math.max(
      ...t.log.map((at, i) => t.log.slice(i).filter((m) => m < at + 60_000).length),
    );
    expect(peak).toBeLessThanOrEqual(0.75 * IP_MESSAGES_PER_MINUTE);
  });
});

describe("RoomDO event order", () => {
  it("SEC-10: a socket's messages are handled in order even when the limiter answers out of order", async () => {
    let calls = 0;
    const slowFirst = {
      limit: async () => {
        if (calls++ === 0) await new Promise((done) => setTimeout(done, 20));
        return { success: true };
      },
    };
    const t = await harness({ MESSAGES: slowFirst });
    const ws = await t.connect();
    // A phone sends hello on open and may tap Join before the hello is answered.
    await Promise.all([
      t.send(ws, { t: "hello", token: token(0) }),
      t.send(ws, { t: "join", name: "Ana" }),
    ]);
    expect(ws.sent.filter((m) => m.t === "error")).toEqual([]);
    expect(lastView(ws).you).toBe(0);
  });
});
