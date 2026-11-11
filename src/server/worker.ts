// Cloudflare adapter: one Durable Object per room, hibernatable WebSockets, state in DO storage.
import { DurableObject } from "cloudflare:workers";
import {
  CLOSE_ROOM_FULL,
  CLOSE_TOO_MANY,
  CLOSE_UNKNOWN_ROOM,
  isRoomCode,
  PING,
  PONG,
  type PublicRoom,
  parseClientMsg,
  type ServerMsg,
} from "../protocol";
import { Directory, LIST_CACHE_MS, type Listed } from "./directory";
import {
  allowMessage,
  type Change,
  type Conn,
  dead,
  systemDeps as deps,
  ipKey,
  newConn,
  newRoom,
  peerKey,
  Room,
  type RoomData,
  RoomError,
  randomCode,
  silent,
} from "./room";

const send = (ws: WebSocket, msg: ServerMsg) => {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket already closing; its close handler cleans up.
  }
};

/**
 * Who a request counts against: its IPv4 address or IPv6 /64. null = a local run (dev, E2E): a
 * loopback client at http://localhost, which isn't limited. Cloudflare only routes our own
 * hostname here and sets the real client address, so it needs both to be faked.
 */
const clientKey = (request: Request) => {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const local = new URL(request.url).hostname === "localhost" && peerKey(ip, undefined) === null;
  return local ? null : ipKey(ip);
};

/**
 * Spends `units` of an IP's MESSAGES budget, the one budget for every row it makes us write (SEC-11):
 * - a message, 1, and 1 more if it moves the room's alarm earlier (a row), as does a close;
 * - each alarm run, 2 (a row and a Durable Object request) to every IP with a live socket in the
 *   room: a lobby whose sockets only ping re-checks presence every ≤ 45 s, and each auto-play step
 *   (M8) is an alarm run that also saves the room (2 rows, a request);
 * - a new room, 3: two rows now, one when it expires;
 * - telling the public list about a room (M24), 2: a row there and a Durable Object request (and
 *   the room's own row, when the event didn't save it already), to whoever's message or close
 *   changed the listing, or at an alarm to every IP in the room;
 * - reading the public list from its object, 2: a request.
 * So one IP writes about a row per unit at most, however it splits them.
 */
async function spend(env: Env, key: string, units: number): Promise<boolean> {
  for (let i = 0; i < units; i++) if (!(await env.MESSAGES.limit({ key })).success) return false;
  return true;
}

/** A socket's attachment. `shut`: we closed it, so it is ignored until it's gone. */
type Attachment = Conn & { shut?: true };

/**
 * Closes a socket, by default one over its IP's limit; it may be closing already. Marked first, so
 * it stops counting as live (or holding the room open) even if its client never answers the close.
 */
function shut(ws: WebSocket, conn: Conn, code = CLOSE_TOO_MANY, reason = "Too many messages") {
  ws.serializeAttachment({ ...conn, shut: true } satisfies Attachment);
  try {
    ws.close(code, reason);
  } catch {
    // Its close event cleans up.
  }
}

const tooMany = (what: string) =>
  new Response(`Too many ${what}, try again in a minute`, {
    status: 429,
    headers: { "Retry-After": "60" },
  });

/** The one DirectoryDO. */
const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName("public"));

/** This isolate's last read of the public list (M24), reused for LIST_CACHE_MS. */
let listed = { at: Number.NEGATIVE_INFINITY, rooms: [] as PublicRoom[] };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Only /api/* reaches the Worker (run_worker_first). A 429 costs this Worker request and no
    // Durable Object request; it still counts toward the Worker quota, which only a WAF rule saves.
    const key = clientKey(request);
    if (key && !(await env.API_REQUESTS.limit({ key })).success) return tooMany("requests");
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      if (key && !(await env.ROOM_CREATION.limit({ key })).success) return tooMany("rooms");
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = randomCode();
        const made = await env.ROOMS.get(env.ROOMS.idFromName(code)).create(code, key);
        if (made === "limited") return tooMany("rooms");
        if (made === "created") return Response.json({ code });
      }
      return new Response("Try again", { status: 503 });
    }
    if (url.pathname === "/api/public" && request.method === "GET") {
      // A local run always reads afresh, so its tests see a change at once.
      if (!key || Date.now() - listed.at >= LIST_CACHE_MS) {
        if (key && !(await spend(env, key, 2))) return tooMany("requests");
        listed = { at: Date.now(), rooms: await directory(env).list() };
      }
      return Response.json(listed.rooms);
    }
    const code = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/ws$/)?.[1];
    if (code && isRoomCode(code) && request.headers.get("Upgrade") === "websocket") {
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export class RoomDO extends DurableObject<Env> {
  /** undefined = not loaded yet; null = no such room. */
  private room: Room | null | undefined;
  /** The scheduled alarm, as last read or set; null = none. */
  private alarmAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The runtime answers pings without waking the object; their timestamps mark sockets alive.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /**
   * Runs events one at a time, in arrival order. Awaiting the MESSAGES binding, unlike storage, lets
   * the next event in; without this a socket's first move could overtake its hello, or its close
   * overtake its last message.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const done = this.queue.then(run);
    this.queue = done.catch(() => {});
    return done;
  }

  /**
   * Makes the room unless the code is taken. Its creator's IP pays 3 here rather than in the Worker:
   * ratelimit counts are per Cloudflare location, and this is where the room's other charges count.
   */
  create(code: string, ip: string | null): Promise<"created" | "taken" | "limited"> {
    return this.serial(async () => {
      if (await this.load()) return "taken";
      if (ip && !(await spend(this.env, ip, 3))) return "limited";
      this.room = new Room(newRoom(code, Date.now()), deps);
      await this.commit(new Map(), "data");
      return "created";
    });
  }

  fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      if (await this.load()) {
        this.live(); // a new socket's arrival closes the silent ones (SEC-6)
        // The attachment keeps the client's key through hibernation.
        server.serializeAttachment(newConn(Date.now(), clientKey(request)));
      } else {
        // A failed upgrade looks like a network error to browsers, so say "no such room" in-band.
        send(server, { t: "missing" });
        server.close(CLOSE_UNKNOWN_ROOM, "Unknown room");
      }
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    return this.serial(() => this.handle(ws, raw));
  }

  private async handle(ws: WebSocket, raw: string | ArrayBuffer) {
    // Per IP across every socket and room (SEC-10). Pings are answered by the runtime, never here.
    const attached = ws.deserializeAttachment() as Conn | null;
    if (attached?.ip && !(await spend(this.env, attached.ip, 1))) {
      shut(ws, attached);
      return;
    }
    const room = await this.load();
    const live = this.live();
    const conn = live.get(ws);
    if (!room || !conn) return;
    if (!allowMessage(conn, Date.now())) {
      shut(ws, conn);
      return;
    }
    const msg = parseClientMsg(raw);
    if (msg?.t === "hello" && conn.token === null) {
      // SEC-2: turned away, or another socket makes room: a dead one just reconnects if it wakes;
      // the others are told in-band, as close codes can get lost.
      const out = room.admit(conn, msg.token, [...live.values()]);
      for (const [other, c] of live) {
        if (c !== out) continue;
        if (dead(c, Date.now())) shut(other, c, 1001, "Gone quiet");
        else {
          send(other, { t: "full" });
          shut(other, c, CLOSE_ROOM_FULL, "Room full");
        }
        live.delete(other);
      }
      if (out === conn) return;
    }
    let change: Change;
    try {
      if (!msg) throw new RoomError("bad-message");
      change = room.receive(conn, msg, [...live.values()]);
    } catch (e) {
      if (!(e instanceof RoomError)) throw e;
      ws.serializeAttachment(conn);
      send(ws, { t: "error", code: e.code, ack: conn.ack });
      return;
    }
    ws.serializeAttachment(conn);
    // Ticking auto-play on may make a step due now, and a returning player may restart auto-play.
    if (room.tick([...live.values()])) change = "data";
    const { moved, told } = await this.commit(live, change, ws);
    const units = (moved ? 1 : 0) + (told ? 2 : 0);
    if (units && conn.ip && !(await spend(this.env, conn.ip, units))) shut(ws, conn);
  }

  webSocketClose(ws: WebSocket) {
    return this.serial(async () => {
      const room = await this.load();
      const live = this.live();
      const conn = live.get(ws) ?? (ws.deserializeAttachment() as Conn | null); // a shut socket
      live.delete(ws);
      if (!room || !conn) return;
      // The seat's last sign of life is kept in memory only: a close writes no row unless it moves
      // the alarm earlier, and then its IP pays for it.
      // The last seated player out also takes the room off the public list (M24), and pays.
      const { moved, told } = await this.commit(live, room.closed(conn) ? "view" : "none");
      // The last socket out also pays for an alarm it leaves armed before the room's expiry: that
      // run (a row and a request) finds no IP in the room to charge (SEC-13).
      const early = live.size === 0 && this.alarmAt !== null && this.alarmAt < room.nextAlarm([]);
      const units = (moved ? 1 : 0) + (early ? 2 : 0) + (told ? 2 : 0);
      if (units && conn.ip) await spend(this.env, conn.ip, units);
    });
  }

  webSocketError(ws: WebSocket) {
    return this.webSocketClose(ws);
  }

  alarm() {
    return this.serial(async () => {
      const room = await this.load();
      this.alarmAt = null; // this one just fired
      if (!room) return;
      const live = this.live();
      if (room.isIdle([...live.values()])) {
        // Still on the public list (a tab that only pinged for a day): taken off it (M24).
        if (room.data.listed && (await this.tell(room.data.code, null))) await this.charge(live);
        for (const ws of live.keys()) {
          send(ws, { t: "missing" });
          ws.close(CLOSE_UNKNOWN_ROOM, "Room expired");
        }
        await this.ctx.storage.deleteAll();
        this.room = null;
        return;
      }
      // Every check, and every auto-play step (M8), costs a row and a request, so the IPs holding
      // the room open pay for it (SEC-11). A step also saves the room: 2 rows for the 2 units.
      await this.charge(live);
      // Re-broadcast even without a move: presence and who may lead can change with time alone.
      const { told } = await this.commit(live, room.tick([...live.values()]) ? "data" : "view");
      // The last connected seat went stale, so the room left the public list (M24): 2 more each.
      if (told) await this.charge(live);
    });
  }

  /**
   * Charges 2 to every IP with a live socket in the room, and closes the sockets of one past its
   * budget. Their close events take the room off the public list if they were its last seats.
   */
  private async charge(live: Map<WebSocket, Conn>) {
    for (const ip of new Set([...live.values()].map((conn) => conn.ip))) {
      if (!ip || (await spend(this.env, ip, 2))) continue;
      for (const [ws, conn] of live) {
        if (conn.ip !== ip) continue;
        this.room?.closed(conn); // its seat keeps the ping-fresh time, so it shows offline only when stale
        shut(ws, conn);
        live.delete(ws);
      }
    }
  }

  /**
   * Tells the public list (M24): a row there and a Durable Object request. False when it can't be
   * reached: the room tries again at its next event, and the list forgets an expired room in 24 h.
   */
  private async tell(code: string, room: PublicRoom | null) {
    try {
      await directory(this.env).set(code, room);
      return true;
    } catch {
      return false;
    }
  }

  private async load(): Promise<Room | null> {
    if (this.room === undefined) {
      const data = await this.ctx.storage.get<RoomData>("room");
      this.room = data ? new Room(data, deps) : null;
      this.alarmAt = await this.ctx.storage.getAlarm();
    }
    return this.room;
  }

  /**
   * Open sockets as the room sees them, counting runtime-answered pings as signs of life. Closes any
   * that never said hello in time (SEC-6), so each event sweeps them at no extra cost.
   */
  private live(): Map<WebSocket, Conn> {
    const live = new Map<WebSocket, Conn>();
    for (const ws of this.ctx.getWebSockets()) {
      const conn = ws.deserializeAttachment() as Attachment | null;
      if (!conn || conn.shut) continue;
      if (silent(conn, Date.now())) {
        shut(ws, conn, 1000, "No hello");
        continue;
      }
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      live.set(ws, { ...conn, seenAt: Math.max(conn.seenAt, pinged) });
    }
    return live;
  }

  /**
   * Persists and broadcasts only what changed (to `from` alone for "none"), and makes sure an
   * alarm comes by the room's next check. Each put and each setAlarm is a row written. Returns
   * whether it moved the alarm earlier, and whether it told the public list (M24), which saves the
   * room too: what the list knows must survive hibernation.
   */
  private async commit(live: Map<WebSocket, Conn>, change: Change, from?: WebSocket) {
    const room = this.room;
    if (!room) return { moved: false, told: false };
    const conns = [...live.values()];
    const listing = room.relist(conns);
    const told = listing !== undefined && (await this.tell(room.data.code, listing));
    if (told) room.told(listing);
    if (change === "data" || told) await this.ctx.storage.put("room", room.data);
    for (const [ws, conn] of live) {
      // A socket that hasn't said hello gets nothing until it does (SEC-6).
      if (conn.token === null || (change === "none" && ws !== from)) continue;
      send(ws, { t: "state", room: room.view(conn, conns), ack: conn.ack });
    }
    // An alarm that comes early just re-checks and re-arms, so only an earlier time needs a write.
    const next = room.nextAlarm(conns);
    if (this.alarmAt !== null && next >= this.alarmAt) return { moved: false, told };
    this.alarmAt = next;
    await this.ctx.storage.setAlarm(next);
    return { moved: true, told };
  }
}

/** Home's public list (M24): one object, one row per listed room, read once when it wakes. */
export class DirectoryDO extends DurableObject<Env> {
  private directory: Directory | undefined;

  private async load() {
    this.directory ??= new Directory(await this.ctx.storage.list<Listed>());
    return this.directory;
  }

  /** Lists, updates or (null) unlists a room: one row, or none when there was nothing to unlist. */
  async set(code: string, room: PublicRoom | null): Promise<void> {
    const rooms = await this.load();
    for (const gone of rooms.set(code, room, Date.now())) await this.ctx.storage.delete(gone);
    const entry = room && rooms.rooms.get(code);
    if (entry) await this.ctx.storage.put(code, entry);
  }

  async list(): Promise<PublicRoom[]> {
    return (await this.load()).list(Date.now());
  }
}
