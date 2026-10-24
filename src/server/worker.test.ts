import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Action, legalActions } from "../engine/game";
import type { ClientMsg, RoomView, ServerMsg } from "../protocol";
import {
  type Conn,
  EMPTY_IDLE_MS,
  IDLE_MS,
  IP_MESSAGES_PER_MINUTE,
  type Room,
  STALE_MS,
  STALL_MS,
} from "./room";
import worker, { RoomDO } from "./worker";

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
/** Node's Response refuses status 101, so the Worker and the object get this one. */
class FakeResponse {
  constructor(
    readonly body: string | null = null,
    readonly init: { status?: number } = {},
  ) {}
  get status() {
    return this.init.status ?? 200;
  }
  static json(value: unknown) {
    return new FakeResponse(JSON.stringify(value));
  }
}
vi.stubGlobal("Response", FakeResponse);
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
});

const PING_MS = 20_000;
const token = (i: number) => `token-${i}-abcdef`;
/** One home router: every phone in these tests shares it unless a test says otherwise. */
const HOME = "203.0.113.7";

/** A ratelimit binding: fixed one-minute windows on the wall clock, like Cloudflare's and miniflare's. */
function limiter(max: number) {
  const counts = new Map<string, number>();
  /** Every check, as [key, when]: each one is a unit of that key's budget. */
  const calls: [string, number][] = [];
  return {
    calls,
    limit: async ({ key }: { key: string }) => {
      calls.push([key, Date.now()]);
      const window = `${key}@${Math.floor(Date.now() / 60_000)}`;
      const n = (counts.get(window) ?? 0) + 1;
      counts.set(window, n);
      return { success: n <= max };
    },
  };
}
const messageLimiter = () => limiter(IP_MESSAGES_PER_MINUTE);

/** The most of `key`'s checks that fall in any 60 s, sliding. */
const peakMinute = (calls: [string, number][], key: string) => {
  const at = calls.filter(([k]) => k === key).map(([, when]) => when);
  return Math.max(0, ...at.map((t, i) => at.slice(i).filter((m) => m < t + 60_000).length));
};

/**
 * A RoomDO on a fake runtime that counts rows written (each `put`, `setAlarm` and `deleteAll`) and
 * Durable Object requests, runs alarms when the clock passes them, and answers pings without waking
 * the object. `created: false` leaves creating the room to the Worker.
 */
async function harness(
  env: object = { MESSAGES: messageLimiter() },
  code = "ABCDE",
  created = true,
) {
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
    deletes: 0,
    deleteAll: async () => {
      storage.deletes++;
      data.clear();
    },
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
  /** The object's in-memory room and sockets, private to it. */
  const inside = () => durable as unknown as { room: Room | null; live(): Map<unknown, Conn> };

  const t = {
    storage,
    sockets,
    rows: () => storage.puts + storage.alarmSets + storage.deletes,
    /** Durable Object requests billed: each create, upgrade and alarm run, 1/20 per message or close. */
    requests: 0,
    create: (ip: string | null = null) => {
      t.requests++;
      return durable.create(code, ip);
    },
    fetch: (request: Request) => {
      t.requests++;
      return durable.fetch(request);
    },
    /** Runs the scheduled alarm now. */
    alarm: () => {
      t.requests++;
      storage.alarm = null;
      return durable.alarm();
    },
    ping: (ws: FakeSocket, at = Date.now()) => pings.set(ws, at),
    exists: () => data.has("room"),
    /** The object is evicted (hibernation) and a fresh instance handles the next event. */
    wake: () => {
      durable = new RoomDO(ctx as never, env as never);
    },
    log,
    connect: async (ip = HOME) => {
      const url = `https://skyjo-online.example.workers.dev/api/rooms/${code}/ws`;
      await t.fetch(new Request(url, { headers: { "cf-connecting-ip": ip } }));
      return sockets[sockets.length - 1];
    },
    send: (ws: FakeSocket, msg: ClientMsg | string) => {
      log.push(Date.now());
      t.requests += 1 / 20;
      return durable.webSocketMessage(
        ws as never,
        typeof msg === "string" ? msg : JSON.stringify(msg),
      );
    },
    /** The socket's close event (the client left, or answered a close the object sent). */
    close: async (ws: FakeSocket) => {
      t.requests += 1 / 20;
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
        ping();
        await t.alarm();
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
  if (created) await t.create();
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

  it("SEC-10, SEC-11: 8 friends behind one IP play two fast games, with reconnects and a rematch, and never trip it", async () => {
    const env = { MESSAGES: messageLimiter() };
    const t = await harness(env);
    const everyone = await eightFriends(t, { slow: false });
    expect(everyone.filter((ws) => ws.closed !== null)).toEqual([]);
    // The busiest sliding minute of the IP's budget, messages and presence checks together, is 78–80,
    // or 85–87 when a round ends, 8 phones reconnect and 16 cards flip in it (the deal is random).
    expect(peakMinute(env.MESSAGES.calls, HOME)).toBeLessThanOrEqual(0.75 * IP_MESSAGES_PER_MINUTE);
  });

  it("SEC-11: 8 friends with long waits in the lobby and at the summary, and slow turns, never trip it and still see who's offline", async () => {
    const env = { MESSAGES: messageLimiter() };
    const t = await harness(env);
    const everyone = await eightFriends(t, { slow: true });
    expect(everyone.filter((ws) => ws.closed !== null)).toEqual([]);
    expect(peakMinute(env.MESSAGES.calls, HOME)).toBeLessThanOrEqual(0.75 * IP_MESSAGES_PER_MINUTE);
  });
});

/**
 * 8 phones on one IP (HOME) join, play two games and a rematch, all 8 reconnecting at every round
 * end. They tap once a second, every turn, which is faster than any real table plays. `slow` adds a
 * 5-minute lobby wait (during which one phone silently drops and must show offline), a 3-minute
 * chat over each summary, and 50 s of thinking on every 5th draw. Returns every socket used.
 */
async function eightFriends(t: Awaited<ReturnType<typeof harness>>, { slow }: { slow: boolean }) {
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
  if (slow) {
    // One phone loses its connection without closing; the others still see it go offline.
    await t.advance(2 * STALE_MS, phones.slice(0, 7));
    expect(lastView(phones[0]).seats[7].connected).toBe(false);
    await t.send(phones[7], { t: "hello", token: token(7) });
    await t.advance(5 * 60_000, phones);
  }
  const act = (seat: number, action: Action) => t.send(phones[seat], { t: "act", action });
  for (let games = 0; games < 2; games++) {
    await t.send(phones[0], { t: "start" });
    await t.advance(TAP, phones);
    for (let turn = 0, game = t.game(); game && game.phase !== "gameOver"; game = t.game()) {
      const legal = legalActions(game);
      if (game.phase === "flip") {
        // Everyone flips at once.
        for (let seat = 0; seat < 8; seat++) {
          const flip = legal.find((a) => a.type === "flip" && a.seat === seat);
          if (flip) await act(seat, flip);
        }
      } else if (game.phase === "roundOver") {
        if (slow) await t.advance(3 * 60_000, phones);
        // Every phone locked during the summary: all 8 reconnect at once, then the host deals.
        for (let seat = 0; seat < 8; seat++) {
          await t.close(phones[seat]);
          phones[seat] = await connect(seat);
        }
        await t.advance(TAP, phones);
        await act(0, { type: "nextRound" });
      } else {
        // Under the 60 s stall guard.
        if (slow && game.phase === "draw" && ++turn % 5 === 0) await t.advance(50_000, phones);
        await act(game.current, legal[game.phase === "place" ? legal.length - 1 : 0] as Action);
      }
      await t.advance(TAP, phones);
    }
    await t.send(phones[0], { t: "rematch" });
    await t.advance(TAP, phones);
  }
  return everyone;
}

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

describe("RoomDO alarm charges (SEC-11)", () => {
  const AWAY = "198.51.100.1";

  it("SEC-11: each alarm run charges 2 to every IP with a live socket in the room", async () => {
    const env = { MESSAGES: messageLimiter() };
    const t = await harness(env);
    const home = await t.seat(2);
    const guest = await t.connect(AWAY);
    await t.send(guest, { t: "hello", token: token(9) });
    const charged = (ip: string) => env.MESSAGES.calls.filter(([k]) => k === ip).length;
    const [atHome, away, requests] = [charged(HOME), charged(AWAY), t.requests];
    await t.advance(10 * 60_000, [...home, guest]); // a lobby re-checks who may lead every ≤ 45 s
    const runs = Math.round(t.requests - requests);
    expect(runs).toBeGreaterThan(10);
    expect(charged(HOME) - atHome).toBe(2 * runs);
    expect(charged(AWAY) - away).toBe(2 * runs);
  });

  it("SEC-11: past its budget, an IP's sockets in the room are closed, and their closes write nothing", async () => {
    const env = { MESSAGES: messageLimiter() };
    const t = await harness(env);
    nextMinute();
    const home = await t.seat(2);
    const guest = await t.connect(AWAY);
    await t.send(guest, { t: "hello", token: token(9) });
    // HOME has 1 unit left this minute; the next presence check costs 2.
    while (env.MESSAGES.calls.filter(([k]) => k === HOME).length < IP_MESSAGES_PER_MINUTE - 1) {
      await env.MESSAGES.limit({ key: HOME });
    }
    await t.advance(STALE_MS, [...home, guest]);
    expect(home.map((ws) => ws.closed)).toEqual([1008, 1008]);
    expect(guest.closed).toBeNull();
    expect(lastView(guest).seats.map((s) => s.connected)).toEqual([false, false]);
    const rows = t.rows();
    for (const ws of home) await t.close(ws);
    expect(t.rows()).toBe(rows);
  });

  it("SEC-11: a new room spends 3 of its creator's budget in the room, and isn't made without them", async () => {
    const env = { MESSAGES: messageLimiter() };
    const broke = await harness(env, "BCDEF", false);
    for (let i = 0; i < IP_MESSAGES_PER_MINUTE - 2; i++) await env.MESSAGES.limit({ key: HOME });
    expect(await broke.create(HOME)).toBe("limited");
    expect(broke.exists()).toBe(false);
    const made = await harness(env, "CDEFG", false);
    expect(await made.create(AWAY)).toBe("created");
    expect(env.MESSAGES.calls.filter(([k]) => k === AWAY).length).toBe(3);
  });

  it("SEC-11: a hello that brings the presence check forward pays for it, and a close writes nothing", async () => {
    const env = { MESSAGES: messageLimiter() };
    const t = await harness(env);
    const [host, guest] = await t.seat(2);
    await t.close(host);
    await t.close(guest);
    await t.advance(60_000); // nobody's there: the room's next check is a day away
    const charged = () => env.MESSAGES.calls.filter(([k]) => k === HOME).length;
    const [rows, units] = [t.rows(), charged()];
    const back = await t.connect();
    await t.send(back, { t: "hello", token: token(0) }); // the host is back: a check in ≤ 45 s
    expect(t.rows()).toBe(rows + 1);
    expect(charged()).toBe(units + 2);
    await t.close(back);
    expect(t.rows()).toBe(rows + 1);
  });

  it("SEC-11: one IP at every limit, holding 2-seat lobbies open and spending the rest of its budget, needs over 12 h to use up rows or DO requests", async () => {
    // Before this fix rows ran out in 1.8–1.9 h holding, 10.2 h spamming first and 7.5 h hitting and
    // running. Now every way needs at least 14.0 h for the rows and 18.2 h for the DO requests.
    const ways = ["hold only", "hold, then spam", "spam, then hold", "hit and run"] as const;
    for (const how of ways) {
      const day = await holdRooms(24, how);
      expect(day.hoursToRows).toBeGreaterThanOrEqual(12);
      expect(day.hoursToRequests).toBeGreaterThanOrEqual(12);
    }
  });
});

/**
 * SEC-11's attacker: one IP at every production limit (wrangler.jsonc, checked in room.test.ts),
 * through the real Worker and RoomDO on the fake runtime. At the start of each minute's limit
 * window it re-opens the host socket of every lobby the server closed, and creates rooms and seats
 * 2 sockets in each; its sockets stay open and ping. Except when holding only, it keeps an upgrade
 * for a join/leave loop (a row a message) that spends the rest of its budget, last or first. "hit
 * and run" closes each socket right after its hello or join, before the room's presence check.
 * Stops at a day's quota or after `hours`; says how long one IP needs to use up the 100,000 rows
 * and the 100,000 DO requests a day.
 */
async function holdRooms(
  hours: number,
  how: "hold only" | "hold, then spam" | "spam, then hold" | "hit and run",
) {
  const BOT = "192.0.2.66";
  const QUOTA = 100_000;
  type Harness = Awaited<ReturnType<typeof harness>>;
  const rooms = new Map<string, Harness>();
  const env = {
    API_REQUESTS: limiter(30),
    ROOM_CREATION: limiter(10),
    MESSAGES: messageLimiter(),
    ROOMS: {
      idFromName: (code: string) => code,
      get: (code: string) => ({
        create: async (_: string, ip: string | null) => (await room(code)).create(ip),
        fetch: async (request: Request) => (await room(code)).fetch(request),
      }),
    },
  };
  const room = async (code: string) => {
    const known = rooms.get(code);
    if (known) return known;
    const made = await harness(env, code, false);
    rooms.set(code, made);
    return made;
  };
  const api = (path: string, init: RequestInit = {}) =>
    worker.fetch(
      new Request(`https://skyjo-online.example.workers.dev${path}`, {
        ...init,
        headers: { "cf-connecting-ip": BOT, ...init.headers },
      }) as never,
      env as never,
    ) as unknown as Promise<FakeResponse>;
  const open = async (code: string) => {
    const res = await api(`/api/rooms/${code}/ws`, { headers: { Upgrade: "websocket" } });
    return res.status === 101 ? (rooms.get(code)?.sockets.at(-1) ?? null) : null;
  };
  /** Rooms whose next alarm falls inside the simulation: the held ones. */
  const soon = new Set<Harness>();
  /** The runtime delivers the close event of each socket the object closed. */
  const settle = async (h: Harness) => {
    for (const ws of h.sockets.filter((s) => s.closed !== null)) await h.close(ws);
    if (h.storage.alarm !== null && h.storage.alarm < end) soon.add(h);
    else soon.delete(h);
  };
  /** The bot closes its own socket. */
  const leave = async (h: Harness, ws: FakeSocket) => {
    await h.close(ws);
    await settle(h);
    return null;
  };
  const tell = async (h: Harness, ws: FakeSocket, msg: ClientMsg) => {
    await h.send(ws, msg);
    await settle(h);
    return ws.closed === null;
  };
  const held: { code: string; host: FakeSocket | null }[] = [];
  let spam: FakeSocket | null = null;
  const start = Math.ceil(Date.now() / 60_000) * 60_000;
  const end = start + hours * 3_600_000;
  const used = () => {
    let rows = 0;
    let requests = 0;
    for (const h of rooms.values()) {
      rows += h.rows();
      requests += h.requests;
    }
    return { rows, requests };
  };
  /** A socket in the first room for the join/leave loop, opened before anything else uses the upgrades. */
  const ready = async () => {
    if (!held.length || spam?.closed === null) return;
    spam = await open(held[0].code);
    const h = rooms.get(held[0].code) as Harness;
    if (spam && !(await tell(h, spam, { t: "hello", token: "spammer-token" }))) spam = null;
  };
  /** The rest of the budget: the join/leave loop, a row a message. */
  const spend = async () => {
    if (!held.length) return;
    const h = rooms.get(held[0].code) as Harness;
    while (spam?.closed === null) {
      await tell(h, spam, lastView(spam).you === null ? { t: "join", name: "x" } : { t: "leave" });
    }
  };
  let minute = 0;
  for (; minute < hours * 60; minute++) {
    vi.setSystemTime(start + minute * 60_000);
    if (how !== "hold only") await ready();
    if (how === "spam, then hold") await spend();
    for (const r of held) {
      if (r.host?.closed === null) continue;
      const ws = await open(r.code);
      const h = rooms.get(r.code) as Harness;
      r.host = ws && (await tell(h, ws, { t: "hello", token: `${r.code}-host` })) ? ws : null;
      if (!r.host) break;
      if (how === "hit and run") r.host = await leave(h, r.host);
    }
    for (let res = await api("/api/rooms", { method: "POST" }); res.status === 200; ) {
      const { code } = JSON.parse(res.body ?? "{}") as { code: string };
      const h = rooms.get(code) as Harness;
      const r = { code, host: null as FakeSocket | null };
      held.push(r);
      for (const who of ["host", "guest"]) {
        const ws = await open(code);
        if (!ws || !(await tell(h, ws, { t: "hello", token: `${code}-${who}` }))) break;
        if (!(await tell(h, ws, { t: "join", name: who }))) break;
        if (who === "host") r.host = ws;
        if (how === "hit and run") r.host = await leave(h, ws);
      }
      res = await api("/api/rooms", { method: "POST" });
    }
    if (how !== "spam, then hold") await spend();
    const until = start + (minute + 1) * 60_000;
    for (;;) {
      let next: Harness | null = null;
      for (const h of soon) {
        const at = h.storage.alarm as number;
        if (at < until && (!next || at < (next.storage.alarm as number))) next = h;
      }
      if (!next) break;
      vi.setSystemTime(next.storage.alarm as number);
      // The bot's sockets ping every 20 s.
      for (const ws of next.sockets) next.ping(ws, Date.now() - (Date.now() % PING_MS));
      await next.alarm();
      await settle(next);
    }
    const { rows, requests } = used();
    if (rows >= QUOTA || requests >= QUOTA) break;
  }
  const { rows, requests } = used();
  const simulated = (minute + 1) / 60;
  return {
    hoursToRows: (simulated * QUOTA) / rows,
    hoursToRequests: (simulated * QUOTA) / requests,
  };
}
