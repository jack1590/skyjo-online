import { useCallback, useEffect, useRef, useState } from "react";
import {
  CLOSE_UNKNOWN_ROOM,
  type ClientMsg,
  type ErrorCode,
  isRoomCode,
  PING,
  PONG,
  type RoomView,
  type ServerMsg,
} from "../protocol";

export type Status = "connecting" | "open" | "reconnecting" | "missing";

const PING_MS = 20_000;
/** No message (not even a pong) for this long means the socket is dead even if it looks open. */
const SILENT_MS = 2 * PING_MS + 5_000;
/** A sent message unanswered this long means the socket is dead: reconnect. */
const ACK_MS = 5_000;

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
    const stop = () => {
      stopped = true;
      setStatus("missing");
    };

    const connect = () => {
      clearTimeout(retry);
      socket.current?.close();
      const ws = new WebSocket(url);
      socket.current = ws;
      lastHeard = Date.now();
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
        if (msg.t !== "missing" && awaiting.current !== null && msg.ack >= awaiting.current) {
          awaiting.current = null;
        }
        if (msg.t === "state") setRoom(msg.room);
        else if (msg.t === "missing") stop();
        else setError(msg.code);
      };
      ws.onclose = (e) => {
        if (socket.current !== ws || stopped) return;
        awaiting.current = null;
        if (e.code === CLOSE_UNKNOWN_ROOM) {
          stop();
          return;
        }
        setStatus("reconnecting");
        retry = setTimeout(connect, Math.min(500 * 2 ** attempt++, 8_000));
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
      if (document.visibilityState !== "visible") return;
      const state = socket.current?.readyState;
      if (state === WebSocket.CLOSED || state === WebSocket.CLOSING) connect();
      else check();
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
  }, [code]);

  /** Sends one message at a time: taps before the server acks the last one are dropped (double taps). */
  const send = useCallback((msg: ClientMsg) => {
    const ws = socket.current;
    if (ws?.readyState !== WebSocket.OPEN || awaiting.current !== null) return;
    const n = ++seq.current;
    awaiting.current = n;
    ws.send(JSON.stringify({ ...msg, seq: n }));
    setTimeout(() => {
      if (awaiting.current !== n) return;
      awaiting.current = null;
      reconnect.current(); // no answer: the socket is half-open
    }, ACK_MS);
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { room, status, error, clearError, send };
}
