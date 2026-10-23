// Wire protocol between browser and room server. Shared by src/client and src/server.
import type { Action } from "./engine/game";
import type { GameView } from "./engine/view";

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
export const CODE_LENGTH = 5;
export const isRoomCode = (code: string) =>
  code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));

export const NAME_MAX = 16;

/** Closing code for a room that doesn't exist. Close codes can get lost, so a "missing" message precedes it. */
export const CLOSE_UNKNOWN_ROOM = 4004;

export type ClientMsg =
  | { t: "hello"; token: string }
  | { t: "join"; name: string }
  | { t: "leave" }
  | { t: "start" }
  | { t: "act"; action: Action }
  | { t: "rematch" };

export type ErrorCode =
  | "bad-message"
  | "not-allowed"
  | "room-full"
  | "bad-name"
  | "name-taken"
  | "illegal-move";

export interface SeatView {
  name: string;
  connected: boolean;
}

export interface RoomView {
  code: string;
  seats: SeatView[];
  host: number;
  /** Your seat, or null when watching. */
  you: number | null;
  /** Whether you may start, advance rounds, and rematch (the host, or anyone if the host is away). */
  lead: boolean;
  game: GameView | null;
}

export type ServerMsg =
  | { t: "state"; room: RoomView }
  | { t: "error"; code: ErrorCode }
  | { t: "missing" };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parses an untrusted frame into a ClientMsg, or null. Only shape is checked here; the room
 * checks permissions and the engine checks legality. `seat` is never read from the client.
 */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== "string" || raw.length > 1000) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(msg)) return null;
  switch (msg.t) {
    case "hello":
      return typeof msg.token === "string" && /^[\w-]{8,64}$/.test(msg.token)
        ? { t: "hello", token: msg.token }
        : null;
    case "join":
      return typeof msg.name === "string" ? { t: "join", name: msg.name } : null;
    case "leave":
    case "start":
    case "rematch":
      return { t: msg.t };
    case "act": {
      const a = msg.action;
      if (!isObject(a)) return null;
      // Only copy known fields; the room overwrites `seat` with the sender's own seat.
      switch (a.type) {
        case "flip":
        case "swap":
        case "discardAndFlip":
          return typeof a.pos === "number"
            ? { t: "act", action: { type: a.type, seat: -1, pos: a.pos } }
            : null;
        case "draw":
          return a.source === "deck" || a.source === "discard"
            ? { t: "act", action: { type: "draw", seat: -1, source: a.source } }
            : null;
        case "nextRound":
          return { t: "act", action: { type: "nextRound" } };
        default:
          return null;
      }
    }
    default:
      return null;
  }
}
