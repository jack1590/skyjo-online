// Cloudflare adapter: one Durable Object per room, hibernatable WebSockets, state in DO storage.
import { DurableObject } from "cloudflare:workers";
import {
  CLOSE_TOO_MANY,
  CLOSE_UNKNOWN_ROOM,
  isRoomCode,
  PING,
  PONG,
  parseClientMsg,
  type ServerMsg,
} from "../protocol";
import {
  allowMessage,
  type Change,
  type Conn,
  systemDeps as deps,
  ipKey,
  newConn,
  newRoom,
  peerKey,
  Room,
  type RoomData,
  RoomError,
  randomCode,
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

const tooMany = (what: string) =>
  new Response(`Too many ${what}, try again in a minute`, {
    status: 429,
    headers: { "Retry-After": "60" },
  });

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
        if (await env.ROOMS.get(env.ROOMS.idFromName(code)).create(code)) {
          return Response.json({ code });
        }
      }
      return new Response("Try again", { status: 503 });
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

  create(code: string): Promise<boolean> {
    return this.serial(async () => {
      if (await this.load()) return false;
      this.room = new Room(newRoom(code, Date.now()), deps);
      await this.commit(new Map(), "data");
      return true;
    });
  }

  fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      if (await this.load()) {
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
    const ip = (ws.deserializeAttachment() as Conn | null)?.ip;
    if (ip && !(await this.env.MESSAGES.limit({ key: ip })).success) {
      ws.close(CLOSE_TOO_MANY, "Too many messages");
      return;
    }
    const room = await this.load();
    const live = this.live();
    const conn = live.get(ws);
    if (!room || !conn) return;
    if (!allowMessage(conn, Date.now())) {
      ws.close(CLOSE_TOO_MANY, "Too many messages");
      return;
    }
    let change: Change;
    try {
      const msg = parseClientMsg(raw);
      if (!msg) throw new RoomError("bad-message");
      change = room.receive(conn, msg, [...live.values()]);
    } catch (e) {
      if (!(e instanceof RoomError)) throw e;
      ws.serializeAttachment(conn);
      send(ws, { t: "error", code: e.code, ack: conn.ack });
      return;
    }
    ws.serializeAttachment(conn);
    // A returning player may unblock a stall that was waiting for someone to be present.
    if (room.tick([...live.values()])) change = "data";
    await this.commit(live, change, ws);
  }

  webSocketClose(ws: WebSocket) {
    return this.serial(async () => {
      const room = await this.load();
      const live = this.live();
      const conn = live.get(ws);
      live.delete(ws);
      if (!room || !conn) return;
      await this.commit(live, room.closed(conn) ? "data" : "none");
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
        for (const ws of live.keys()) {
          send(ws, { t: "missing" });
          ws.close(CLOSE_UNKNOWN_ROOM, "Room expired");
        }
        await this.ctx.storage.deleteAll();
        this.room = null;
        return;
      }
      // Re-broadcast even without a move: presence and who may lead can change with time alone.
      await this.commit(live, room.tick([...live.values()]) ? "data" : "view");
    });
  }

  private async load(): Promise<Room | null> {
    if (this.room === undefined) {
      const data = await this.ctx.storage.get<RoomData>("room");
      this.room = data ? new Room(data, deps) : null;
      this.alarmAt = await this.ctx.storage.getAlarm();
    }
    return this.room;
  }

  /** Open sockets as the room sees them, counting runtime-answered pings as signs of life. */
  private live(): Map<WebSocket, Conn> {
    const live = new Map<WebSocket, Conn>();
    for (const ws of this.ctx.getWebSockets()) {
      const conn = ws.deserializeAttachment() as Conn | null;
      if (!conn) continue;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      live.set(ws, { ...conn, seenAt: Math.max(conn.seenAt, pinged) });
    }
    return live;
  }

  /**
   * Persists and broadcasts only what changed (to `from` alone for "none"), and makes sure an
   * alarm comes by the room's next check. Each put and each setAlarm is a row written.
   */
  private async commit(live: Map<WebSocket, Conn>, change: Change, from?: WebSocket) {
    const room = this.room;
    if (!room) return;
    const conns = [...live.values()];
    if (change === "data") await this.ctx.storage.put("room", room.data);
    for (const [ws, conn] of live) {
      if (change === "none" && ws !== from) continue;
      send(ws, { t: "state", room: room.view(conn, conns), ack: conn.ack });
    }
    // An alarm that comes early just re-checks and re-arms, so only an earlier time needs a write.
    const next = room.nextAlarm(conns);
    if (this.alarmAt === null || next < this.alarmAt) {
      this.alarmAt = next;
      await this.ctx.storage.setAlarm(next);
    }
  }
}
