// Self-host adapter: Node + ws on one port, serving the built app and the same rooms as the
// Cloudflare Worker. ponytail: rooms live in memory, so a restart ends every game; add a JSON
// snapshot on commit if self-hosting ever needs to survive restarts.
import { randomBytes, webcrypto } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import type { Rng } from "../engine/rng";
import {
  CLOSE_UNKNOWN_ROOM,
  CODE_ALPHABET,
  CODE_LENGTH,
  isRoomCode,
  PING,
  PONG,
  parseClientMsg,
  type ServerMsg,
} from "../protocol";
import { allowMessage, type Conn, newConn, newRoom, Room, RoomError } from "./room";

const PORT = Number(process.env.PORT ?? 8787);
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

const deps = {
  now: () => Date.now(),
  seed: () => Array.from(webcrypto.getRandomValues(new Int32Array(4))) as Rng,
};

interface LiveRoom {
  room: Room;
  sockets: Map<WebSocket, Conn>;
  timer?: NodeJS.Timeout;
}
const rooms = new Map<string, LiveRoom>();

/** 32-letter alphabet, so `byte % 32` is unbiased. */
const randomCode = () =>
  [...randomBytes(CODE_LENGTH)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");

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
  if (live.room.isIdle()) {
    for (const ws of live.sockets.keys()) {
      send(ws, { t: "missing" });
      ws.close(CLOSE_UNKNOWN_ROOM, "Room expired");
    }
    rooms.delete(code);
    return;
  }
  live.room.tick([...live.sockets.values()]);
  commit(code);
}

async function isFile(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/rooms" && req.method === "POST") {
    let code = randomCode();
    while (rooms.has(code)) code = randomCode();
    rooms.set(code, { room: new Room(newRoom(code, Date.now()), deps), sockets: new Map() });
    commit(code);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code }));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(404).end("Not found");
    return;
  }
  // Static files; anything else (e.g. /r/CODE) gets the app shell. Paths can't escape ROOT.
  let path = join(ROOT, "index.html");
  try {
    const candidate = resolve(join(ROOT, decodeURIComponent(url.pathname)));
    if (candidate.startsWith(ROOT + sep) && (await isFile(candidate))) path = candidate;
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
  res.end(await readFile(path));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const code = path.match(/^\/api\/rooms\/([A-Z0-9]+)\/ws$/)?.[1];
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
    } catch (e) {
      if (e instanceof RoomError) {
        send(ws, { t: "error", code: e.code, ack: conn.ack });
      } else {
        console.error(e);
        ws.close(1011, "Server error");
      }
      return;
    }
    live.room.tick(conns);
    commit(code);
  });
  ws.on("close", () => {
    live.sockets.delete(ws);
    live.room.closed(conn);
    commit(code);
  });
}

server.listen(PORT, () => console.log(`Skyjo Online on http://localhost:${PORT}`));
