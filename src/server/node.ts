// Self-host adapter: Node + ws on one port, serving the built app and the same rooms as the
// Cloudflare Worker. ponytail: rooms live in memory, so a restart ends every game; add a JSON
// snapshot on commit if self-hosting ever needs to survive restarts.
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
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
  RoomError,
  randomCode,
  STALE_MS,
} from "./room";

const PORT = Number(process.env.PORT ?? 8787);
/** Loopback only by default: reaching it from other devices must be a deliberate choice (HOST=0.0.0.0). */
const HOST = process.env.HOST ?? "127.0.0.1";
/** Memory cap: each room holds state and a timer for up to 24 h. */
const MAX_ROOMS = 1000;
const ROOT = resolve(process.env.STATIC_DIR ?? "dist/client");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

interface LiveRoom {
  room: Room;
  sockets: Map<WebSocket, Conn>;
  timer?: NodeJS.Timeout;
}
const rooms = new Map<string, LiveRoom>();

const send = (ws: WebSocket, msg: ServerMsg) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

/** Sends every socket its own view and schedules the next stall/idle check (the DO alarm's job). */
function commit(code: string) {
  const live = rooms.get(code);
  if (!live) return;
  const conns = [...live.sockets.values()];
  for (const [ws, conn] of live.sockets) {
    send(ws, { t: "state", room: live.room.view(conn, conns), ack: conn.ack });
  }
  clearTimeout(live.timer);
  live.timer = setTimeout(() => alarm(code), live.room.nextAlarm(conns) - Date.now());
}

function alarm(code: string) {
  const live = rooms.get(code);
  if (!live) return;
  if (live.room.isIdle([...live.sockets.values()])) {
    for (const ws of live.sockets.keys()) {
      send(ws, { t: "missing" });
      ws.close(CLOSE_UNKNOWN_ROOM, "Room expired");
    }
    rooms.delete(code);
    return;
  }
  // Phones that vanished without closing would otherwise get every broadcast until TCP gives up.
  for (const [ws, conn] of live.sockets) {
    if (Date.now() - conn.seenAt > 2 * STALE_MS) ws.terminate();
  }
  live.room.tick([...live.sockets.values()]);
  commit(code);
}

/** Path without query; never throws (`new URL("//", base)` does). */
const pathOf = (url: string | undefined) => (url ?? "/").split("?")[0] ?? "/";

async function isFile(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end("Server error");
  });
});

async function handle(req: IncomingMessage, res: ServerResponse) {
  const pathname = pathOf(req.url);
  if (pathname === "/api/rooms" && req.method === "POST") {
    if (rooms.size >= MAX_ROOMS) {
      res.writeHead(503).end("Too many rooms, try again later");
      return;
    }
    let code = randomCode();
    while (rooms.has(code)) code = randomCode();
    rooms.set(code, { room: new Room(newRoom(code, Date.now()), deps), sockets: new Map() });
    commit(code);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code }));
    return;
  }
  if (pathname.startsWith("/api/")) {
    res.writeHead(404).end("Not found");
    return;
  }
  // Static files; anything else (e.g. /r/CODE) gets the app shell. Paths can't escape ROOT.
  let path = join(ROOT, "index.html");
  try {
    const candidate = resolve(join(ROOT, decodeURIComponent(pathname)));
    if (candidate.startsWith(ROOT + sep) && (await isFile(candidate))) path = candidate;
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  const body = await readFile(path); // rejects (→ 500) if the app wasn't built
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
  res.end(body);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy()); // e.g. a reset mid-handshake
  const code = pathOf(req.url).match(/^\/api\/rooms\/([A-Z0-9]+)\/ws$/)?.[1];
  if (!code || !isRoomCode(code)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, code));
});

function onConnection(ws: WebSocket, code: string) {
  const live = rooms.get(code);
  if (!live) {
    // A failed upgrade looks like a network error to browsers, so say "no such room" in-band.
    send(ws, { t: "missing" });
    ws.close(CLOSE_UNKNOWN_ROOM, "Unknown room");
    return;
  }
  const conn = newConn(Date.now());
  live.sockets.set(ws, conn);
  // Oversized or malformed frames emit 'error'; without a listener that kills the process.
  // ws closes the socket itself afterwards.
  ws.on("error", () => {});
  ws.on("message", (data) => {
    const raw = data.toString();
    conn.seenAt = Date.now();
    if (raw === PING) {
      ws.send(PONG);
      return;
    }
    if (!allowMessage(conn, Date.now())) {
      ws.close(1008, "Too many messages");
      return;
    }
    const conns = [...live.sockets.values()];
    try {
      const msg = parseClientMsg(raw);
      if (!msg) throw new RoomError("bad-message");
      live.room.receive(conn, msg, conns);
      live.room.tick(conns);
      commit(code);
    } catch (e) {
      if (e instanceof RoomError) {
        send(ws, { t: "error", code: e.code, ack: conn.ack });
      } else {
        console.error(e);
        ws.close(1011, "Server error");
      }
    }
  });
  ws.on("close", () => {
    live.sockets.delete(ws);
    live.room.closed(conn);
    commit(code);
  });
}

server.listen(PORT, HOST, () => console.log(`Skyjo Online on http://${HOST}:${PORT}`));
