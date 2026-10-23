// Cloudflare adapter: one Durable Object per room, hibernatable WebSockets, state in DO storage.
import { DurableObject } from "cloudflare:workers";
import type { Rng } from "../engine/rng";
import {
  CLOSE_UNKNOWN_ROOM,
  CODE_ALPHABET,
  CODE_LENGTH,
  isRoomCode,
  parseClientMsg,
  type ServerMsg,
} from "../protocol";
import { type Conn, newRoom, Room, type RoomData, RoomError } from "./room";

const deps = {
  now: () => Date.now(),
  seed: () => Array.from(crypto.getRandomValues(new Int32Array(4))) as Rng,
};

/** 32-letter alphabet, so `byte % 32` is unbiased. */
const randomCode = () =>
  [...crypto.getRandomValues(new Uint8Array(CODE_LENGTH))]
    .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
    .join("");

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
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async create(code: string): Promise<boolean> {
    if (await this.load()) return false;
    this.room = new Room(newRoom(code, Date.now()), deps);
    await this.commit(new Map());
    return true;
  }

  async fetch(): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    if (await this.load()) {
      server.serializeAttachment({ token: null, seenAt: Date.now() } satisfies Conn);
    } else {
      // A failed upgrade looks like a network error to browsers, so say "no such room" in-band.
      server.close(CLOSE_UNKNOWN_ROOM, "Unknown room");
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const room = await this.load();
    const live = this.live();
    const conn = live.get(ws);
    if (!room || !conn) return;
    try {
      const msg = parseClientMsg(raw);
      if (!msg) throw new RoomError("bad-message");
      room.receive(conn, msg, [...live.values()]);
    } catch (e) {
      if (!(e instanceof RoomError)) throw e;
      ws.serializeAttachment(conn);
      send(ws, { t: "error", code: e.code });
      return;
    }
    ws.serializeAttachment(conn);
    await this.commit(live);
  }

  async webSocketClose(ws: WebSocket) {
    const room = await this.load();
    const live = this.live();
    const conn = live.get(ws);
    live.delete(ws);
    if (!room || !conn) return;
    room.closed(conn);
    await this.commit(live);
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    const room = await this.load();
    if (!room) return;
    const live = this.live();
    if (room.isIdle([...live.values()])) {
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    room.tick([...live.values()]);
    await this.commit(live);
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

  /** Persists, sends every socket its own view, and schedules the next stall or idle check. */
  private async commit(live: Map<WebSocket, Conn>) {
    const room = this.room;
    if (!room) return;
    const conns = [...live.values()];
    await this.ctx.storage.put("room", room.data);
    for (const [ws, conn] of live) send(ws, { t: "state", room: room.view(conn, conns) });
    await this.ctx.storage.setAlarm(room.nextAlarm(conns));
  }
}
