// Cloudflare adapter: one Durable Object per room, hibernatable WebSockets, state in DO storage.
import { DurableObject } from "cloudflare:workers";
import {
  CLOSE_UNKNOWN_ROOM,
  isRoomCode,
  PING,
  PONG,
  parseClientMsg,
  type ServerMsg,
} from "../protocol";
import {
  allowMessage,
  type Conn,
  systemDeps as deps,
  newConn,
  newRoom,
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (!(await env.ROOM_CREATION.limit({ key: ip })).success) {
        return new Response("Too many rooms, try again in a minute", { status: 429 });
      }
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The runtime answers pings without waking the object; their timestamps mark sockets alive.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async create(code: string): Promise<boolean> {
    if (await this.load()) return false;
    this.room = new Room(newRoom(code, Date.now()), deps);
    await this.commit(new Map(), true);
    return true;
  }

  async fetch(): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    if (await this.load()) {
      server.serializeAttachment(newConn(Date.now()));
    } else {
      // A failed upgrade looks like a network error to browsers, so say "no such room" in-band.
      send(server, { t: "missing" });
      server.close(CLOSE_UNKNOWN_ROOM, "Unknown room");
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const room = await this.load();
    const live = this.live();
    const conn = live.get(ws);
    if (!room || !conn) return;
    if (!allowMessage(conn, Date.now())) {
      ws.close(1008, "Too many messages");
      return;
    }
    let changed: boolean;
    try {
      const msg = parseClientMsg(raw);
      if (!msg) throw new RoomError("bad-message");
      changed = room.receive(conn, msg, [...live.values()]);
    } catch (e) {
      if (!(e instanceof RoomError)) throw e;
      ws.serializeAttachment(conn);
      send(ws, { t: "error", code: e.code, ack: conn.ack });
      return;
    }
    ws.serializeAttachment(conn);
    // A returning player may unblock a stall that was waiting for someone to be present.
    changed = room.tick([...live.values()]) || changed;
    await this.commit(live, changed);
  }

  async webSocketClose(ws: WebSocket) {
    const room = await this.load();
    const live = this.live();
    const conn = live.get(ws);
    live.delete(ws);
    if (!room || !conn) return;
    room.closed(conn);
    await this.commit(live, true);
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    const room = await this.load();
    if (!room) return;
    const live = this.live();
    if (room.isIdle()) {
      for (const ws of live.keys()) {
        send(ws, { t: "missing" });
        ws.close(CLOSE_UNKNOWN_ROOM, "Room expired");
      }
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    // Re-broadcast even without a move: presence and who may lead can change with time alone.
    await this.commit(live, room.tick([...live.values()]));
  }

  private async load(): Promise<Room | null> {
    if (this.room === undefined) {
      const data = await this.ctx.storage.get<RoomData>("room");
      this.room = data ? new Room(data, deps) : null;
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

  /** Persists if needed, sends every socket its own view, and schedules the next check. */
  private async commit(live: Map<WebSocket, Conn>, persist: boolean) {
    const room = this.room;
    if (!room) return;
    const conns = [...live.values()];
    if (persist) await this.ctx.storage.put("room", room.data);
    for (const [ws, conn] of live) {
      send(ws, { t: "state", room: room.view(conn, conns), ack: conn.ack });
    }
    await this.ctx.storage.setAlarm(room.nextAlarm(conns));
  }
}
