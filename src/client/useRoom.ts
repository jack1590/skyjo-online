import { useCallback, useEffect, useRef, useState } from "react";
import {
  CLOSE_ROOM_FULL,
  CLOSE_TOO_MANY,
  CLOSE_UNKNOWN_ROOM,
  type ClientMsg,
  type ErrorCode,
  isRoomCode,
  PING,
  PONG,
  type ReactionKind,
  type RoomView,
  type ServerMsg,
  type TossItem,
} from "../protocol";

/** "missing" and "full" (too many sockets in the room, SEC-2) are final: no retry. */
export type Status = "connecting" | "open" | "reconnecting" | "missing" | "full";

const PING_MS = 20_000;
/** No message (not even a pong) for this long means the socket is dead even if it looks open. */
const SILENT_MS = 2 * PING_MS + 5_000;
/** A sent message unanswered this long means the socket is dead: reconnect. */
const ACK_MS = 5_000;
/** An answer this late already says "Reconnecting…" (UX-5). */
const LATE_MS = 1_500;

/** Per-room secret that lets this browser reclaim its seat after a reload or a dropped connection. */
function tokenFor(code: string): string {
  const key = `skyjo:token:${code}`;
  try {
    const saved = localStorage.getItem(key);
    if (saved) return saved;
    const token = crypto.randomUUID();
    localStorage.setItem(key, token);
    return token;
  } catch {
    // ponytail: without storage (private mode) a reload means a new identity; add a URL token if that bites.
    return crypto.randomUUID();
  }
}

export function useRoom(code: string) {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<ErrorCode | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const reconnect = useRef(() => {});
  const seq = useRef(0);
  /** The one message awaiting the server's ack; further taps are dropped until it lands. */
  const awaiting = useRef<number | null>(null);
  /** The same, as state (a tapped card stays lifted until its ack, UX-3), and whether it's late. */
  const [waiting, setWaiting] = useState<number | null>(null);
  const [late, setLate] = useState(false);
  /** The wait is over: answered, or the socket that would answer is gone. */
  const answered = useCallback(() => {
    awaiting.current = null;
    setWaiting(null);
    setLate(false);
  }, []);

  useEffect(() => {
    if (!isRoomCode(code)) {
      setStatus("missing");
      return;
    }
    const token = tokenFor(code);
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${scheme}://${window.location.host}/api/rooms/${code}/ws`;
    let attempt = 0;
    let lastHeard = Date.now();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const stop = (why: "missing" | "full") => {
      stopped = true;
      answered(); // a pending tap's ack timeout must not reconnect
      setStatus(why);
    };

    const connect = () => {
      clearTimeout(retry);
      socket.current?.close();
      const ws = new WebSocket(url);
      socket.current = ws;
      lastHeard = Date.now();
      /** This socket's last view showed this phone offline. */
      let away = false;
      ws.onopen = () => {
        attempt = 0;
        setStatus("open");
        ws.send(JSON.stringify({ t: "hello", token } satisfies ClientMsg));
      };
      ws.onmessage = (e) => {
        if (socket.current !== ws) return;
        lastHeard = Date.now();
        if (e.data === PONG) return;
        const msg = JSON.parse(e.data) as ServerMsg;
        if ("ack" in msg && awaiting.current !== null && msg.ack >= awaiting.current) answered();
        if (msg.t === "state") {
          setRoom(msg.room);
          // Shown offline on a visible page: the room missed our pings (a network stall the socket
          // survived), and pings alone never reach it. A hello does, once per stretch shown offline,
          // so everyone sees us back at once and any clock we stopped restarts (M8, SEC-9). Hidden
          // pages wait for `wake`: a throttled tab would otherwise keep a forgotten room busy.
          const me = msg.room.you === null ? undefined : msg.room.seats[msg.room.you];
          const shown = me?.connected === false && document.visibilityState === "visible";
          if (shown && !away) ws.send(JSON.stringify({ t: "hello", token } satisfies ClientMsg));
          away = shown;
        } else if (msg.t === "missing" || msg.t === "full") stop(msg.t);
        else setError(msg.code);
      };
      ws.onclose = (e) => {
        if (socket.current !== ws || stopped) return;
        answered();
        if (e.code === CLOSE_UNKNOWN_ROOM || e.code === CLOSE_ROOM_FULL) {
          stop(e.code === CLOSE_ROOM_FULL ? "full" : "missing");
          return;
        }
        setStatus("reconnecting");
        // Over a message limit, each reconnect would open, say hello and be closed again: retry
        // every 20 s until the limit's minute rolls over.
        const wait = e.code === CLOSE_TOO_MANY ? 20_000 : Math.min(500 * 2 ** attempt++, 8_000);
        retry = setTimeout(connect, wait);
      };
    };

    // Phones freeze sockets in the background without closing them, so a silent socket is replaced.
    const check = () => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) {
        if (Date.now() - lastHeard > SILENT_MS) connect();
        else ws.send(PING);
      }
    };
    const wake = () => {
      if (stopped || document.visibilityState !== "visible") return;
      const ws = socket.current;
      if (ws?.readyState === WebSocket.CLOSED || ws?.readyState === WebSocket.CLOSING) connect();
      else if (ws?.readyState === WebSocket.OPEN && Date.now() - lastHeard <= SILENT_MS) {
        // Back from the background: a hello, unlike a ping, reaches the room, which then shows
        // this phone online and restarts any clock that stopped while it was gone (M8).
        ws.send(JSON.stringify({ t: "hello", token } satisfies ClientMsg));
      } else check();
    };

    reconnect.current = () => {
      setStatus("reconnecting");
      connect();
    };
    connect();
    const ping = setInterval(check, PING_MS);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(ping);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      socket.current?.close();
    };
  }, [code, answered]);

  /**
   * Sends one message at a time: taps before the server acks the last one are dropped (double
   * taps). Returns its seq, or null when it wasn't sent.
   */
  const send = useCallback(
    (msg: ClientMsg) => {
      const ws = socket.current;
      if (ws?.readyState !== WebSocket.OPEN || awaiting.current !== null) return null;
      const n = ++seq.current;
      awaiting.current = n;
      setWaiting(n);
      ws.send(JSON.stringify({ ...msg, seq: n }));
      setTimeout(() => awaiting.current === n && setLate(true), LATE_MS);
      setTimeout(() => {
        if (awaiting.current !== n) return;
        answered();
        reconnect.current(); // no answer: the socket is half-open
      }, ACK_MS);
      return n;
    },
    [answered],
  );

  /** Sends a throw (M21) without a seq: nothing waits on its answer, so it never holds up a move. */
  const toss = useCallback((to: number, item: TossItem) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: "toss", to, item } satisfies ClientMsg));
    }
  }, []);

  /** Sends a reaction (M23), like a throw: without a seq. */
  const react = useCallback((kind: ReactionKind, to?: number) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: "react", kind, to } satisfies ClientMsg));
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { room, status, error, clearError, send, toss, react, waiting, late };
}
