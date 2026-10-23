// Platform-agnostic room: seats, permissions, stall guard. Adapters (worker.ts, node.ts) own the
// sockets and storage; this file owns the rules about who may do what.
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
import { type ClientMsg, type ErrorCode, NAME_MAX, type RoomView } from "../protocol";

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
  game: GameState | null;
  /** Last change (ms); idle rooms get deleted. */
  updatedAt: number;
}

/** One open socket. `token` comes from its hello; `seenAt` is its last message or ping (ms). */
export interface Conn {
  token: string | null;
  seenAt: number;
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
/** A seat the table waits on gets a default move after being gone this long. */
export const STALL_MS = 60_000;
export const IDLE_MS = 24 * 60 * 60_000;

export const newRoom = (code: string, now: number): RoomData => ({
  code,
  seats: [],
  host: 0,
  game: null,
  updatedAt: now,
});

/** Strips control/format characters (zero-width, bidi overrides), trims, caps length. */
const cleanName = (name: string) => name.replace(/\p{C}/gu, "").trim().slice(0, NAME_MAX).trim();

export class Room {
  constructor(
    readonly data: RoomData,
    private readonly deps: Deps,
  ) {}

  seatOf(conn: Conn): number | null {
    const seat = this.data.seats.findIndex((s) => s.token === conn.token);
    return seat === -1 ? null : seat;
  }

  /** Applies one client message. Throws RoomError, which the adapter sends to that socket only. */
  receive(conn: Conn, msg: ClientMsg, live: Conn[]): void {
    const now = this.deps.now();
    conn.seenAt = now;
    if (msg.t === "hello") {
      conn.token = msg.token;
    }
    if (conn.token === null) throw new RoomError("bad-message");
    const seat = this.seatOf(conn);
    if (seat !== null) this.data.seats[seat].seenAt = now;
    this.data.updatedAt = now;

    const { seats, game } = this.data;
    switch (msg.t) {
      case "hello":
        return;
      case "join": {
        // Between games only: seat order must match the running game's players.
        if (seat !== null || (game !== null && game.phase !== "gameOver")) {
          throw new RoomError("not-allowed");
        }
        if (seats.length >= MAX_PLAYERS) throw new RoomError("room-full");
        const name = cleanName(msg.name);
        if (!name) throw new RoomError("bad-name");
        if (seats.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
          throw new RoomError("name-taken");
        }
        seats.push({ token: conn.token, name, seenAt: now });
        return;
      }
      case "leave":
        if (seat === null || game !== null) throw new RoomError("not-allowed");
        seats.splice(seat, 1);
        // The next seat inherits the host role.
        if (seat < this.data.host) this.data.host--;
        else if (this.data.host >= seats.length) this.data.host = 0;
        return;
      case "start":
        if (game !== null || seats.length < MIN_PLAYERS || !this.canLead(seat, live)) {
          throw new RoomError("not-allowed");
        }
        this.deal();
        return;
      case "rematch":
        if (game?.phase !== "gameOver" || !this.canLead(seat, live)) {
          throw new RoomError("not-allowed");
        }
        this.deal();
        return;
      case "act":
        if (game === null || seat === null) throw new RoomError("not-allowed");
        if (msg.action.type === "nextRound") {
          if (!this.canLead(seat, live)) throw new RoomError("not-allowed");
          // Fresh entropy per round, so reconstructing one round's RNG can't predict the next deal.
          this.play({ ...game, rng: this.deps.seed() }, msg.action);
        } else {
          this.play(game, { ...msg.action, seat });
        }
        return;
    }
  }

  /** A socket closed: its seat was alive until now. */
  closed(conn: Conn): void {
    const seat = this.seatOf(conn);
    if (seat !== null) this.data.seats[seat].seenAt = this.deps.now();
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
    // Bounded: each pass plays a move, and a round has finitely many.
    for (let pass = 0; pass < 1000; pass++) {
      const seat = this.awaited().find((s) => now - this.lastSeen(s, live) >= STALL_MS);
      if (seat === undefined || !this.data.game) break;
      this.play(this.data.game, autoMove(this.data.game, seat));
      changed = true;
    }
    if (changed) this.data.updatedAt = now;
    return changed;
  }

  /** When tick() next needs to run (ms). */
  nextAlarm(live: Conn[]): number {
    const stalls = this.awaited().map((s) => this.lastSeen(s, live) + STALL_MS);
    return Math.min(this.data.updatedAt + IDLE_MS, ...stalls);
  }

  isIdle(live: Conn[]): boolean {
    return live.length === 0 && this.deps.now() - this.data.updatedAt >= IDLE_MS;
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

  private lastSeen(seat: number, live: Conn[]): number {
    const s = this.data.seats[seat];
    return Math.max(s.seenAt, ...live.filter((c) => c.token === s.token).map((c) => c.seenAt));
  }

  /** Seats the table is waiting on right now. */
  private awaited(): number[] {
    const g = this.data.game;
    if (g?.phase === "flip") {
      return g.players.flatMap((p, i) => (p.grid.filter((s) => s?.up).length < 2 ? [i] : []));
    }
    return g?.phase === "draw" || g?.phase === "place" ? [g.current] : [];
  }

  private deal(): void {
    this.data.game = createGame(
      this.data.seats.map((s) => s.name),
      this.deps.seed(),
    );
  }

  private play(state: GameState, action: Action): void {
    try {
      this.data.game = apply(state, action);
    } catch (e) {
      if (e instanceof RuleError) throw new RoomError("illegal-move");
      throw e;
    }
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
