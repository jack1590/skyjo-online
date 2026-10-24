// Platform-agnostic room: seats, permissions, the turn clock, scheduling. Adapters (worker.ts,
// node.ts) own sockets and storage; this file owns who may do what, and when.
import {
  type Action,
  apply,
  createGame,
  type GameState,
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
  TURN_MS,
  type Wait,
} from "../protocol";

export interface Seat {
  /** Secret held by the seat's browser; never sent to anyone. */
  token: string;
  name: string;
  /** Last sign of life from this seat (ms). */
  seenAt: number;
  /** Auto-play (M8): the server plays this seat's turns until its player unticks it. Unset before 2.1.0. */
  auto?: boolean;
}

export interface RoomData {
  code: string;
  seats: Seat[];
  host: number;
  /** null = lobby. */
  game: GameState | null;
  /** Last client message (ms). Pings don't count, so a forgotten tab doesn't keep a room forever. */
  updatedAt: number;
  /** The last move (ms): a draw's place deadline and auto-play's next step count from here. */
  waitSince: number;
  /** When the turn clock started (ms): the deal, the turn's start, or an untick on your turn. */
  turnSince: number;
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
  /** The client's `ipKey`, which its messages count against; null = a local run, not limited. */
  ip: string | null;
  /** When the socket opened (ms). A deploy closes every socket, so no attachment predates it. */
  openedAt: number;
}

export interface Deps {
  now: () => number;
  /** Fresh CSPRNG entropy for each deal. */
  seed: () => Rng;
}

/**
 * What a handled event changed, so adapters write and broadcast only when needed (each storage
 * write is a row on the free plan's daily quota): "none" = only the sender's own view, "view" =
 * other sockets' views too, "data" = persisted state, which every view also reflects.
 */
export type Change = "none" | "view" | "data";

export class RoomError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

/** A socket silent this long counts as gone; phones drop sockets without closing them. */
export const STALE_MS = 45_000;
/** After a draw you always have this long to place it, even past the turn's 30 s (TURN_MS). */
export const GRACE_MS = 10_000;
/** An auto-play seat moves this long into its turn (or the opening flip), so everyone sees it... */
export const AUTO_FIRST_MS = 1_500;
/** ...and makes each next step this long after the last move: every step is its own broadcast. */
export const AUTO_NEXT_MS = 700;
/** No client message for this long and the room is deleted. */
export const IDLE_MS = 24 * 60 * 60_000;
/** A room nobody ever joined goes much sooner (abandoned "Create a room" taps, creation bursts). */
export const EMPTY_IDLE_MS = 10 * 60_000;
/** Per-socket flood limit: far above any human pace (a test bot taps ~7/s), far below a script loop. */
const WINDOW_MS = 10_000;
const WINDOW_MAX = 120;
/**
 * Per-IP budget (SEC-10, SEC-11), a minute, for one IP or IPv6 /64 across all its sockets and rooms:
 * 1 per message (pings don't count). On the Worker it pays for every row the IP makes us write, as
 * `spend` in worker.ts says. 8 friends on one router tapping once a second, faster than real play,
 * peak at 78–87 (worker.test.ts); at a tap every 2 s, at most 57. The Worker enforces it with its
 * MESSAGES binding, which must match (room.test.ts).
 */
export const IP_MESSAGES_PER_MINUTE = 120;
/**
 * Sockets per room that said hello (SEC-2): 8 players and a dozen spectators. Each one gets every
 * broadcast and can send its own writes, so a room can't take as many as a script opens.
 */
export const MAX_SOCKETS = 20;
/** A socket that hasn't said hello this long after opening is closed (SEC-6); the client says it at once. */
export const HELLO_MS = 10_000;

/** Never said hello, HELLO_MS after opening: it holds no place in the room and is closed. */
export const silent = (conn: Conn, now: number) =>
  conn.token === null && now - conn.openedAt >= HELLO_MS;

/** No message or ping for 2 × STALE_MS (pings come every 20 s): a phone that dropped without closing. */
export const dead = (conn: Conn, now: number) => now - conn.seenAt >= 2 * STALE_MS;

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
  turnSince: now,
});

export const newConn = (now: number, ip: string | null): Conn => ({
  token: null,
  seenAt: now,
  ack: 0,
  windowStart: now,
  windowCount: 0,
  ip,
  openedAt: now,
});

interface Window {
  windowStart: number;
  windowCount: number;
}

/** Counts one message in a fixed window; false = over `max`, and the adapter closes the socket (1008). */
function count(w: Window, now: number, ms: number, max: number): boolean {
  if (now - w.windowStart >= ms) {
    w.windowStart = now;
    w.windowCount = 0;
  }
  return ++w.windowCount <= max;
}

/** The per-socket flood limit. */
export const allowMessage = (conn: Conn, now: number) => count(conn, now, WINDOW_MS, WINDOW_MAX);

/** The per-IP budget, for a server without the Worker's MESSAGES binding (node.ts). */
export function allowIp(windows: Map<string, Window>, key: string, now: number): boolean {
  // ponytail: an O(n) sweep once 10,000 addresses are tracked; a timer if that ever shows up.
  if (windows.size >= 10_000) {
    for (const [k, w] of windows) if (now - w.windowStart >= 60_000) windows.delete(k);
  }
  const w = windows.get(key) ?? { windowStart: now, windowCount: 0 };
  windows.set(key, w);
  return count(w, now, 60_000, IP_MESSAGES_PER_MINUTE);
}

/**
 * The key for a socket a server accepted itself (node.ts). Through a local proxy (the README's
 * cloudflared tunnel) that is the client address Cloudflare forwards; a direct loopback client
 * (dev, E2E) isn't limited, and anyone else is keyed by their own address.
 */
export function peerKey(peer: string, forwarded: string | undefined): string | null {
  if (!/^(127\.|::1$|::ffff:127\.)/.test(peer)) return ipKey(peer);
  return forwarded ? ipKey(forwarded) : null;
}

/**
 * The rate-limit key for a client address: IPv4 as is, IPv6 by its /64, since one home or phone
 * gets a whole /64 and could rotate through it. Anything unparsable is its own key.
 */
export function ipKey(ip: string): string {
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (v4 || !ip.includes(":")) return v4 ?? ip;
  let host: string;
  try {
    host = new URL(`http://[${ip}]`).hostname.slice(1, -1); // canonical: lower case, no leading zeros
  } catch {
    return ip;
  }
  const [head, tail] = host.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return `${[...left, ...zeros, ...right].slice(0, 4).join(":")}::/64`;
}

/** Strips control/format characters (zero-width, bidi overrides), trims, caps length in code points (never splits an emoji). */
const cleanName = (name: string) =>
  [...name.replace(/\p{C}/gu, "").trim()].slice(0, NAME_MAX).join("").trim();

export class Room {
  constructor(
    readonly data: RoomData,
    private readonly deps: Deps,
  ) {
    data.turnSince ??= data.waitSince; // a room saved before 2.1.0
  }

  seatOf(conn: Conn): number | null {
    const seat = this.data.seats.findIndex((s) => s.token === conn.token);
    return seat === -1 ? null : seat;
  }

  /**
   * Applies one client message and records its `seq` as acknowledged, even when it fails.
   * Returns what changed. Throws RoomError for that socket only.
   */
  receive(conn: Conn, msg: ClientMsg, live: Conn[]): Change {
    const stopped = this.awaited().filter((s) => !this.canStall(s, live));
    const change = this.handle(conn, msg, live);
    // A clock that wasn't running, with nobody else there, starts afresh once someone is.
    if (!stopped.some((s) => this.awaited().includes(s) && this.canStall(s, live))) return change;
    this.data.turnSince = this.deps.now();
    return "data";
  }

  private handle(conn: Conn, msg: ClientMsg, live: Conn[]): Change {
    const now = this.deps.now();
    const online = this.online(live);
    conn.seenAt = now;
    if (msg.seq !== undefined) conn.ack = Math.max(conn.ack, msg.seq);
    if (msg.t === "hello") {
      // A socket keeps its first token, so it can't slip past the socket cap as another (SEC-2).
      if (conn.token !== null && conn.token !== msg.token) throw new RoomError("bad-message");
      conn.token = msg.token;
    }
    if (conn.token === null) throw new RoomError("bad-message");
    const seat = this.seatOf(conn);
    if (seat !== null) this.data.seats[seat].seenAt = now;
    this.data.updatedAt = now;

    const { seats, game } = this.data;
    const lobby = game === null;
    switch (msg.t) {
      case "hello":
        // A repeated hello, or a second tab, only refreshes signs of life: nobody else sees it.
        return this.online(live) === online ? "none" : "view";
      case "join": {
        if (seat !== null || !lobby) throw new RoomError("not-allowed");
        if (seats.length >= MAX_PLAYERS) throw new RoomError("room-full");
        const name = cleanName(msg.name);
        if (!name) throw new RoomError("bad-name");
        if (seats.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
          throw new RoomError("name-taken");
        }
        seats.push({ token: conn.token, name, seenAt: now });
        return "data";
      }
      case "leave":
        if (seat === null || !lobby) throw new RoomError("not-allowed");
        this.removeSeat(seat);
        return "data";
      case "kick":
        // Clears ghost seats (someone who closed the tab without leaving); online players stay.
        if (!lobby || !this.canLead(seat, live) || msg.seat === seat) {
          throw new RoomError("not-allowed");
        }
        if (!seats[msg.seat] || this.connected(msg.seat, live)) throw new RoomError("not-allowed");
        this.removeSeat(msg.seat);
        return "data";
      case "start":
        if (!lobby || seats.length < MIN_PLAYERS || !this.canLead(seat, live)) {
          throw new RoomError("not-allowed");
        }
        this.data.game = createGame(
          seats.map((s) => s.name),
          this.deps.seed(),
        );
        this.data.waitSince = now;
        this.data.turnSince = now;
        // Auto-play lasts a game: in the lobby it only let others lead while you were away.
        for (const s of seats) s.auto = false;
        return "data";
      case "auto": {
        if (seat === null) throw new RoomError("not-allowed");
        if ((seats[seat].auto === true) === msg.on) return "none";
        seats[seat].auto = msg.on;
        // Unticking on your turn gives you a fresh clock, once per move: ticking on and off can't
        // hold a turn open.
        const moved = this.data.waitSince >= this.data.turnSince;
        if (!msg.on && moved && this.awaited().includes(seat)) this.data.turnSince = now;
        return "data";
      }
      case "rematch":
        // Back to the lobby with the same seats, where people can join, leave, or be removed.
        if (game?.phase !== "gameOver" || !this.canLead(seat, live)) {
          throw new RoomError("not-allowed");
        }
        this.data.game = null;
        return "data";
      case "act":
        if (game === null || seat === null) throw new RoomError("not-allowed");
        if (msg.action.type === "nextRound") {
          if (!this.canLead(seat, live)) throw new RoomError("not-allowed");
          // Fresh entropy per round, so reconstructing one round's RNG can't predict the next deal.
          this.play({ ...game, rng: this.deps.seed() }, msg.action);
        } else {
          this.play(game, { ...msg.action, seat });
        }
        return "data";
    }
  }

  /**
   * The socket to close so `conn`, saying its first hello as `token`, fits under MAX_SOCKETS
   * (SEC-2), or null. Only sockets that said hello count. In a full room, in this order:
   * - a `dead` socket goes first: phones that drop without closing leave sockets behind;
   * - anyone takes the place of their own least recently seen socket;
   * - otherwise a spectator is turned away (`conn` itself);
   * - a seated player always gets in, in place of the least recently seen spectator, or over the
   *   cap when there's none: one socket at most per seat, since a socket keeps its first token.
   */
  admit(conn: Conn, token: string, live: Conn[]): Conn | null {
    const others = live.filter((c) => c !== conn && c.token !== null);
    if (others.length < MAX_SOCKETS) return null;
    others.sort((a, b) => a.seenAt - b.seenAt);
    if (dead(others[0], this.deps.now())) return others[0];
    const own = others.find((c) => c.token === token);
    if (own) return own;
    if (!this.data.seats.some((s) => s.token === token)) return conn;
    return others.find((c) => this.seatOf(c) === null) ?? null;
  }

  /** A socket closed: its seat was last alive when that socket was. Returns whether it had a seat. */
  closed(conn: Conn): boolean {
    const seat = this.seatOf(conn);
    if (seat === null) return false;
    const s = this.data.seats[seat];
    s.seenAt = Math.max(s.seenAt, conn.seenAt);
    return true;
  }

  view(conn: Conn, live: Conn[]): RoomView {
    const you = this.seatOf(conn);
    return {
      code: this.data.code,
      seats: this.data.seats.map((s, i) => ({
        name: s.name,
        connected: this.connected(i, live),
        auto: s.auto === true,
      })),
      host: this.data.host,
      you,
      lead: this.canLead(you, live),
      clocks: this.clocks(live),
      game: this.data.game && toView(this.data.game),
    };
  }

  /** Every seat the table waits on whose clock runs, and when and why the server moves for it. */
  private clocks(live: Conn[]): Wait[] {
    const now = this.deps.now();
    return this.awaited()
      .filter((seat) => this.canStall(seat, live))
      .map((seat) => ({
        seat,
        inMs: Math.max(0, this.due(seat) - now),
        reason: this.data.seats[seat].auto
          ? "auto"
          : this.connected(seat, live)
            ? "timer"
            : "offline",
      }));
  }

  /**
   * The turn clock: plays one step for each waited-on seat that is due, on auto-play or out of
   * time, which turns auto-play on. One step per seat per call, so everyone sees each one.
   * Returns whether anything changed.
   */
  tick(live: Conn[]): boolean {
    const now = this.deps.now();
    const due = this.awaited().filter((s) => this.canStall(s, live) && now >= this.due(s));
    for (const seat of due) {
      if (!this.data.game) break;
      this.data.seats[seat].auto = true;
      this.play(this.data.game, autoMove(this.data.game, seat));
    }
    return due.length > 0;
  }

  /** When the adapter should call tick() and re-broadcast next (ms). Always in the future. */
  nextAlarm(live: Conn[]): number {
    const now = this.deps.now();
    const due = [this.data.updatedAt + this.idleAfter(live)];
    for (const s of this.awaited()) {
      if (!this.canStall(s, live)) continue;
      due.push(this.due(s));
      // A phone that goes silent: re-broadcast when it turns stale, so the table sees it's offline.
      if (this.connected(s, live)) due.push(this.lastSeen(s, live) + STALE_MS);
    }
    // If the host goes quiet while the table needs a lead, others must learn they may step in.
    if (this.needsLead() && this.connected(this.data.host, live)) {
      due.push(this.lastSeen(this.data.host, live) + STALE_MS);
    }
    // A step that came due after this event's tick() (a timer that fired a millisecond early) is
    // checked again at once, not dropped: dropping it stalled the turn until the next check.
    return Math.max(Math.min(...due), now + 1);
  }

  isIdle(live: Conn[]): boolean {
    return this.deps.now() - this.data.updatedAt >= this.idleAfter(live);
  }

  /** A room with no seats and no open socket was abandoned; one with a waiting creator wasn't. */
  private idleAfter(live: Conn[]): number {
    return this.data.seats.length === 0 && live.length === 0 ? EMPTY_IDLE_MS : IDLE_MS;
  }

  private connected(seat: number, live: Conn[]): boolean {
    const now = this.deps.now();
    const token = this.data.seats[seat]?.token;
    return live.some((c) => c.token === token && now - c.seenAt < STALE_MS);
  }

  /** Who is online, the only part of anyone else's view a hello can change. */
  private online(live: Conn[]): string {
    return this.data.seats.map((_, i) => this.connected(i, live)).join();
  }

  /**
   * The host leads; if the host is away, or on auto-play, anyone seated may, so one dropped phone
   * can't freeze the table.
   */
  private canLead(seat: number | null, live: Conn[]): boolean {
    const { host, seats } = this.data;
    return (
      seat !== null && (seat === host || seats[host]?.auto === true || !this.connected(host, live))
    );
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

  /**
   * When the server moves for a waited-on seat: its next auto-play step, or when its clock runs
   * out, online or not. The clock gives the turn (or the opening flip) TURN_MS, and a draw at
   * least GRACE_MS to place.
   */
  private due(seat: number): number {
    const { turnSince, waitSince, game } = this.data;
    if (this.data.seats[seat].auto) {
      const flipped = game?.players[seat].grid.some((s) => s?.up);
      const first = game?.phase === "draw" || (game?.phase === "flip" && !flipped);
      return first ? turnSince + AUTO_FIRST_MS : waitSince + AUTO_NEXT_MS;
    }
    return Math.max(turnSince + TURN_MS, game?.phase === "place" ? waitSince + GRACE_MS : 0);
  }

  /**
   * The clock and auto-play run for a seat only while someone else is really there: a connected
   * seat not on auto-play. An empty table, or one of auto seats, doesn't play itself (each auto
   * step costs an alarm and a row with no client message to pay for it).
   */
  private canStall(seat: number, live: Conn[]): boolean {
    return this.data.seats.some((s, i) => i !== seat && !s.auto && this.connected(i, live));
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
    let next: GameState;
    try {
      next = apply(state, action);
    } catch (e) {
      if (e instanceof RuleError) throw new RoomError("illegal-move");
      throw e;
    }
    this.data.game = next;
    this.data.waitSince = this.deps.now();
    // The clock keeps running through a draw and through the opening flip; anything else starts a turn.
    if (next.phase !== "place" && !(next.phase === "flip" && state.phase === "flip")) {
      this.data.turnSince = this.data.waitSince;
    }
  }
}

/**
 * The server's move for a seat on auto-play or out of time (M8). In the opening flip it flips the
 * first face-down card in reading order. On a turn it draws from the deck; a drawn card lower than
 * the highest face-up card replaces it. Otherwise it discards the card and flips the first
 * face-down one, unless that is the last and the round isn't ending yet: revealing it would end
 * the round, likely doubled (R12), so it replaces the highest face-up card instead. A card taken from the discard pile can't be
 * thrown away (time ran out after the player took it), so it replaces that face-down card.
 */
export function autoMove(g: GameState, seat: number): Action {
  const grid = g.players[seat].grid;
  const down = grid.flatMap((s, pos) => (s && !s.up ? [pos] : []));
  if (g.phase === "flip") return { type: "flip", seat, pos: down[0] };
  if (g.phase === "draw") return { type: "draw", seat, source: "deck" };
  let high = -1;
  for (const [pos, s] of grid.entries()) {
    if (s?.up && (high === -1 || s.card > (grid[high]?.card ?? 0))) high = pos;
  }
  const highCard = grid[high]?.card ?? 0;
  // On a last turn the round is ending anyway, and R11 reveals that card: flipping it costs nothing.
  const lastCard = down.length === 1 && g.ender === null;
  if (high !== -1 && ((g.drawn as number) < highCard || lastCard)) {
    return { type: "swap", seat, pos: high };
  }
  return { type: g.drawnFrom === "deck" ? "discardAndFlip" : "swap", seat, pos: down[0] };
}
