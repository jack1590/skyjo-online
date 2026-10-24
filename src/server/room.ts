// Platform-agnostic room: seats, permissions, stall guard, scheduling. Adapters (worker.ts,
// node.ts) own sockets and storage; this file owns who may do what, and when.
import {
  type Action,
  apply,
  createGame,
  type GameState,
  legalActions,
  MAX_PLAYERS,
  MIN_PLAYERS,
  RuleError,
} from "../engine/game";
import type { Rng } from "../engine/rng";
import { toView } from "../engine/view";
import {
  type ClientMsg,
  CODE_ALPHABET,
  CODE_LENGTH,
  type ErrorCode,
  NAME_MAX,
  type RoomView,
} from "../protocol";

export interface Seat {
  /** Secret held by the seat's browser; never sent to anyone. */
  token: string;
  name: string;
  /** Last sign of life from this seat (ms). */
  seenAt: number;
}

export interface RoomData {
  code: string;
  seats: Seat[];
  host: number;
  /** null = lobby. */
  game: GameState | null;
  /** Last client message (ms). Pings don't count, so a forgotten tab doesn't keep a room forever. */
  updatedAt: number;
  /** When the table started waiting on whoever it waits on now (ms): the stall guard counts from here. */
  waitSince: number;
}

/** One open socket, persisted in its attachment. */
export interface Conn {
  /** From its hello. */
  token: string | null;
  /** Last message or ping (ms). */
  seenAt: number;
  /** Highest client `seq` handled, echoed back so the client knows its move landed. */
  ack: number;
  windowStart: number;
  windowCount: number;
}

export interface Deps {
  now: () => number;
  /** Fresh CSPRNG entropy for each deal. */
  seed: () => Rng;
}

export class RoomError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

/** A socket silent this long counts as gone; phones drop sockets without closing them. */
export const STALE_MS = 45_000;
/** A seat the table waits on gets a default move after being gone this long into its wait. */
export const STALL_MS = 60_000;
/** No client message for this long and the room is deleted. */
export const IDLE_MS = 24 * 60 * 60_000;
/** A room nobody ever joined goes much sooner (abandoned "Create a room" taps, creation bursts). */
export const EMPTY_IDLE_MS = 10 * 60_000;
/** Per-socket flood limit: far above any human pace (a test bot taps ~7/s), far below a script loop. */
const WINDOW_MS = 10_000;
const WINDOW_MAX = 120;

/** Real clock and CSPRNG; both runtimes (Workers, Node 22) have a global `crypto`. */
export const systemDeps: Deps = {
  now: () => Date.now(),
  seed: () => Array.from(crypto.getRandomValues(new Int32Array(4))) as Rng,
};

/** 32-letter alphabet, so `byte % 32` is unbiased. */
export const randomCode = () =>
  [...crypto.getRandomValues(new Uint8Array(CODE_LENGTH))]
    .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
    .join("");

export const newRoom = (code: string, now: number): RoomData => ({
  code,
  seats: [],
  host: 0,
  game: null,
  updatedAt: now,
  waitSince: now,
});

export const newConn = (now: number): Conn => ({
  token: null,
  seenAt: now,
  ack: 0,
  windowStart: now,
  windowCount: 0,
});

/** Counts one message against the socket's budget; false = the adapter should close it (1008). */
export function allowMessage(conn: Conn, now: number): boolean {
  if (now - conn.windowStart >= WINDOW_MS) {
    conn.windowStart = now;
    conn.windowCount = 0;
  }
  return ++conn.windowCount <= WINDOW_MAX;
}

/** Strips control/format characters (zero-width, bidi overrides), trims, caps length in code points (never splits an emoji). */
const cleanName = (name: string) =>
  [...name.replace(/\p{C}/gu, "").trim()].slice(0, NAME_MAX).join("").trim();

export class Room {
  constructor(
    readonly data: RoomData,
    private readonly deps: Deps,
  ) {}

  seatOf(conn: Conn): number | null {
    const seat = this.data.seats.findIndex((s) => s.token === conn.token);
    return seat === -1 ? null : seat;
  }

  /**
   * Applies one client message and records its `seq` as acknowledged, even when it fails.
   * Returns whether state worth persisting changed. Throws RoomError for that socket only.
   */
  receive(conn: Conn, msg: ClientMsg, live: Conn[]): boolean {
    const now = this.deps.now();
    conn.seenAt = now;
    if (msg.seq !== undefined) conn.ack = Math.max(conn.ack, msg.seq);
    if (msg.t === "hello") conn.token = msg.token;
    if (conn.token === null) throw new RoomError("bad-message");
    const seat = this.seatOf(conn);
    if (seat !== null) this.data.seats[seat].seenAt = now;
    this.data.updatedAt = now;

    const { seats, game } = this.data;
    const lobby = game === null;
    switch (msg.t) {
      case "hello":
        return false;
      case "join": {
        if (seat !== null || !lobby) throw new RoomError("not-allowed");
        if (seats.length >= MAX_PLAYERS) throw new RoomError("room-full");
        const name = cleanName(msg.name);
        if (!name) throw new RoomError("bad-name");
        if (seats.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
          throw new RoomError("name-taken");
        }
        seats.push({ token: conn.token, name, seenAt: now });
        return true;
      }
      case "leave":
        if (seat === null || !lobby) throw new RoomError("not-allowed");
        this.removeSeat(seat);
        return true;
      case "kick":
        // Clears ghost seats (someone who closed the tab without leaving); online players stay.
        if (!lobby || !this.canLead(seat, live) || msg.seat === seat) {
          throw new RoomError("not-allowed");
        }
        if (!seats[msg.seat] || this.connected(msg.seat, live)) throw new RoomError("not-allowed");
        this.removeSeat(msg.seat);
        return true;
      case "start":
        if (!lobby || seats.length < MIN_PLAYERS || !this.canLead(seat, live)) {
          throw new RoomError("not-allowed");
        }
        this.data.game = createGame(
          seats.map((s) => s.name),
          this.deps.seed(),
        );
        this.data.waitSince = now;
        return true;
      case "rematch":
        // Back to the lobby with the same seats, where people can join, leave, or be removed.
        if (game?.phase !== "gameOver" || !this.canLead(seat, live)) {
          throw new RoomError("not-allowed");
        }
        this.data.game = null;
        return true;
      case "act":
        if (game === null || seat === null) throw new RoomError("not-allowed");
        if (msg.action.type === "nextRound") {
          if (!this.canLead(seat, live)) throw new RoomError("not-allowed");
          // Fresh entropy per round, so reconstructing one round's RNG can't predict the next deal.
          this.play({ ...game, rng: this.deps.seed() }, msg.action);
        } else {
          this.play(game, { ...msg.action, seat });
        }
        return true;
    }
  }

  /** A socket closed: its seat was last alive when that socket was. */
  closed(conn: Conn): void {
    const seat = this.seatOf(conn);
    if (seat !== null) {
      const s = this.data.seats[seat];
      s.seenAt = Math.max(s.seenAt, conn.seenAt);
    }
  }

  view(conn: Conn, live: Conn[]): RoomView {
    const you = this.seatOf(conn);
    return {
      code: this.data.code,
      seats: this.data.seats.map((s, i) => ({ name: s.name, connected: this.connected(i, live) })),
      host: this.data.host,
      you,
      lead: this.canLead(you, live),
      game: this.data.game && toView(this.data.game),
    };
  }

  /** Stall guard: plays default moves for seats gone too long. Returns whether anything changed. */
  tick(live: Conn[]): boolean {
    const now = this.deps.now();
    let changed = false;
    // Bounded: each pass finishes one stalled seat's turn, and a round has finitely many.
    for (let pass = 0; pass < 1000; pass++) {
      const seat = this.awaited().find(
        (s) => this.canStall(s, live) && now >= this.deadline(s, live),
      );
      if (seat === undefined) break;
      // Finish that seat's whole turn (both initial flips, or draw then discard-and-flip).
      while (this.data.game && this.awaited().includes(seat)) {
        this.play(this.data.game, autoMove(this.data.game, seat));
      }
      changed = true;
    }
    return changed;
  }

  /** When the adapter should call tick() and re-broadcast next (ms). Always in the future. */
  nextAlarm(live: Conn[]): number {
    const now = this.deps.now();
    const due = [this.data.updatedAt + this.idleAfter()];
    for (const s of this.awaited()) if (this.canStall(s, live)) due.push(this.deadline(s, live));
    // If the host goes quiet while the table needs a lead, others must learn they may step in.
    if (this.needsLead() && this.connected(this.data.host, live)) {
      due.push(this.lastSeen(this.data.host, live) + STALE_MS);
    }
    const future = due.filter((t) => t > now);
    return future.length ? Math.min(...future) : now + STALE_MS;
  }

  isIdle(): boolean {
    return this.deps.now() - this.data.updatedAt >= this.idleAfter();
  }

  private idleAfter(): number {
    return this.data.seats.length === 0 ? EMPTY_IDLE_MS : IDLE_MS;
  }

  private connected(seat: number, live: Conn[]): boolean {
    const now = this.deps.now();
    const token = this.data.seats[seat]?.token;
    return live.some((c) => c.token === token && now - c.seenAt < STALE_MS);
  }

  /** The host leads; if the host is away anyone seated may, so one dropped phone can't freeze the table. */
  private canLead(seat: number | null, live: Conn[]): boolean {
    return seat !== null && (seat === this.data.host || !this.connected(this.data.host, live));
  }

  private needsLead(): boolean {
    const phase = this.data.game?.phase;
    return this.data.game === null
      ? this.data.seats.length >= MIN_PLAYERS
      : phase === "roundOver" || phase === "gameOver";
  }

  private lastSeen(seat: number, live: Conn[]): number {
    const s = this.data.seats[seat];
    return Math.max(s.seenAt, ...live.filter((c) => c.token === s.token).map((c) => c.seenAt));
  }

  /** A seat gets a full STALL_MS of absence counted from when its wait began, not from when it went quiet. */
  private deadline(seat: number, live: Conn[]): number {
    return Math.max(this.lastSeen(seat, live), this.data.waitSince) + STALL_MS;
  }

  /** Only stall for someone when somebody else is there to wait; an empty table doesn't play itself. */
  private canStall(seat: number, live: Conn[]): boolean {
    return this.data.seats.some((_, i) => i !== seat && this.connected(i, live));
  }

  /** Seats the table is waiting on right now. */
  private awaited(): number[] {
    const g = this.data.game;
    if (g?.phase === "flip") {
      return g.players.flatMap((p, i) => (p.grid.filter((s) => s?.up).length < 2 ? [i] : []));
    }
    return g?.phase === "draw" || g?.phase === "place" ? [g.current] : [];
  }

  private removeSeat(seat: number): void {
    this.data.seats.splice(seat, 1);
    // The next seat inherits the host role.
    if (seat < this.data.host) this.data.host--;
    else if (this.data.host >= this.data.seats.length) this.data.host = 0;
  }

  private play(state: GameState, action: Action): void {
    try {
      this.data.game = apply(state, action);
    } catch (e) {
      if (e instanceof RuleError) throw new RoomError("illegal-move");
      throw e;
    }
    this.data.waitSince = this.deps.now();
  }
}

/** The stall guard's move: draw from the deck, discard it, flip the first face-down card. */
export function autoMove(g: GameState, seat: number): Action {
  const legal = legalActions(g).filter((a) => "seat" in a && a.seat === seat);
  const faceDown = (pos: number) => g.players[seat].grid[pos]?.up === false;
  return (
    legal.find((a) => a.type === "discardAndFlip") ??
    legal.find((a) => a.type === "flip") ??
    legal.find((a) => a.type === "draw" && a.source === "deck") ??
    legal.find((a) => a.type === "swap" && faceDown(a.pos)) ??
    (legal[0] as Action)
  );
}
