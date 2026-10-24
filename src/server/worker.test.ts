import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Action, legalActions } from "../engine/game";
import type { ClientMsg, RoomView, ServerMsg } from "../protocol";
import { type Conn, EMPTY_IDLE_MS, IDLE_MS, type Room, STALL_MS } from "./room";
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
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {}
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

/**
 * A RoomDO on a fake runtime that counts rows written (each `put` and each `setAlarm`), runs
 * alarms when the clock passes them, and answers pings without waking the object.
 */
async function harness() {
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
  let durable = new RoomDO(ctx as never, {} as never);
  await durable.create("ABCDE");
  /** The object's in-memory room and sockets, private to it. */
  const inside = () => durable as unknown as { room: Room | null; live(): Map<unknown, Conn> };

  const t = {
    storage,
    rows: () => storage.puts + storage.alarmSets,
    exists: () => data.has("room"),
    /** The object is evicted (hibernation) and a fresh instance handles the next event. */
    wake: () => {
      durable = new RoomDO(ctx as never, {} as never);
    },
    connect: async () => {
      await durable.fetch();
      return sockets[sockets.length - 1];
    },
    send: (ws: FakeSocket, msg: ClientMsg | string) =>
      durable.webSocketMessage(ws as never, typeof msg === "string" ? msg : JSON.stringify(msg)),
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
