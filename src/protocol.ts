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
/** Closing code (policy violation) for a socket over the per-socket or per-IP message limit. */
export const CLOSE_TOO_MANY = 1008;
/** Closing code for a socket turned away from a room at its socket cap (SEC-2), after a "full" message. */
export const CLOSE_ROOM_FULL = 4029;

/** Keep-alive frames. Cloudflare answers them without waking the room; other adapters must too. */
export const PING = "ping";
export const PONG = "pong";

/** The turn clock (M8): each turn, and the opening flip, gets 30 s before the server plays for it. */
export const TURN_MS = 30_000;

export type ClientMsg = (
  | { t: "hello"; token: string }
  | { t: "join"; name: string }
  | { t: "leave" }
  | { t: "kick"; seat: number }
  | { t: "start" }
  | { t: "act"; action: Action }
  | { t: "rematch" }
  /** Ticks or unticks Auto-play for the sender's own seat. */
  | { t: "auto"; on: boolean }
  /** In the lobby, whoever may lead switches "Play until one is left" (R16) on or off. */
  | { t: "knockout"; on: boolean }
) & {
  /** Client counter; the server echoes the highest one handled as `ack`. */
  seq?: number;
};

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
  /** Auto-play is on: the server plays this seat's turns. */
  auto: boolean;
}

/**
 * A seat the table waits on, and ms until the server moves for it: when its clock runs out
 * ("timer", or "offline" when its phone is gone), or its next auto-play step ("auto").
 */
export interface Wait {
  seat: number;
  inMs: number;
  reason: "timer" | "offline" | "auto";
}

export interface RoomView {
  code: string;
  seats: SeatView[];
  host: number;
  /** Your seat, or null when watching. */
  you: number | null;
  /** Whether you may start, advance rounds, and rematch (the host, or anyone if the host is away). */
  lead: boolean;
  /**
   * Every waited-on seat whose clock runs (several in the opening flip); empty when none does.
   * Not `wait`, which tabs loaded before 2.1.0 read as a single offline seat.
   */
  clocks: Wait[];
  /** The lobby's "Play until one is left" option (R16), which the next start deals with. */
  knockout: boolean;
  game: GameView | null;
}

export type ServerMsg =
  | { t: "state"; room: RoomView; ack: number }
  | { t: "error"; code: ErrorCode; ack: number }
  | { t: "missing" }
  | { t: "full" };

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
  const body = parseBody(msg);
  if (!body) return null;
  return Number.isSafeInteger(msg.seq) && (msg.seq as number) >= 0
    ? { ...body, seq: msg.seq as number }
    : body;
}

function parseBody(msg: Record<string, unknown>): ClientMsg | null {
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
    case "kick":
      return Number.isInteger(msg.seat) ? { t: "kick", seat: msg.seat as number } : null;
    case "auto":
    case "knockout":
      return typeof msg.on === "boolean" ? { t: msg.t, on: msg.on } : null;
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
