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
  type Reaction,
  type RoomView,
  TOSS_MS,
  type Toss,
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
  /**
   * Waited-on seats whose clock was stopped at the last event, with nobody there to pay for it
   * (`canStall`). Saved because a phone can come back by pings alone, which no event shows (SEC-9).
   * Unset before 2.1.2.
   */
  stopped?: number[];
  /** "Play until one is left" (R16), set in the lobby and dealt with at every start. Unset before 2.2.0. */
  knockout?: boolean;
}

/** One open socket, persisted in its attachment. */
export interface Conn {
  /** From its hello. */
  token: string | null;
  /** Last message or ping (ms). */
  seenAt: number;
  /**
   * Last message (ms), pings aside; 0 = none yet. A hello writes no row, so the room's quiet and
   * idle clocks read it here, in the attachment, which survives hibernation (SEC-9).
   */
  heardAt: number;
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
/**
 * An auto-play seat moves this long into its turn (or the opening flip), so everyone sees it...
 * At 3.2 s an auto turn (4 budget units, SEC-11) costs about what a human turn does, so a table
 * with seats on auto-play stays under 0.75 of an IP's budget (PO, PR #17; 1.5 s / 0.7 s reached 125).
 */
export const AUTO_FIRST_MS = 2_000;
/** ...and makes each next step this long after the last move: every step is its own broadcast. */
export const AUTO_NEXT_MS = 1_200;
/**
 * No client message for this long and presence is checked only this often (SEC-9): each check is a
 * row and a request, and a forgotten tab only pings. Dots and "may lead" can lag by that much.
 */
export const QUIET_MS = 10 * 60_000;
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
/** Views carry a throw this long (M21): later ones, such as a reconnecting phone's, leave it out. */
export const TOSS_SHOW_MS = 2_000;

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
  heardAt: 0,
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
  /**
   * The latest throw and each seat's last one (M21). In memory only: a throw writes no row, and
   * one lost to hibernation is long over.
   */
  private toss: Toss | null = null;
  private reaction: Reaction | null = null;
  private tossed = new Map<number, number>();

  constructor(
    readonly data: RoomData,
    private readonly deps: Deps,
  ) {
    data.turnSince ??= data.waitSince; // a room saved before 2.1.0
    // A game saved before 2.2.0 (R16).
    if (data.game) data.game.knockout ??= false;
    for (const p of data.game?.players ?? []) p.out ??= null;
    // A game saved before 2.4.0: past the flip, its turn count is lost, and 1 claims no first draw.
    if (data.game) data.game.turn ??= data.game.phase === "flip" ? 0 : 1;
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
    return this.resume(live, stopped) ? "data" : change;
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
    // No message from this seat for STALE_MS: the table may have been shown it offline.
    const quiet = seat !== null && now - this.data.seats[seat].seenAt >= STALE_MS;
    if (seat !== null) this.data.seats[seat].seenAt = now;
    this.data.updatedAt = now;
    conn.heardAt = now;

    const { seats, game } = this.data;
    const lobby = game === null;
    switch (msg.t) {
      case "hello":
        // A repeated hello, or a second tab, only refreshes signs of life: nobody else sees it. A
        // quiet seat's hello is told to everyone (no row): pings that land before it would hide
        // from `online` that the table saw it offline (SEC-9).
        return this.online(live) === online && !quiet ? "none" : "view";
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
          { knockout: this.data.knockout === true },
        );
        this.data.waitSince = now;
        this.data.turnSince = now;
        // Auto-play lasts a game: in the lobby it only let others lead while you were away.
        for (const s of seats) s.auto = false;
        return "data";
      case "knockout":
        // Shared before the deal, so everyone knows the rule, and a stand-in leader keeps it.
        if (!lobby || !this.canLead(seat, live)) throw new RoomError("not-allowed");
        if ((this.data.knockout === true) === msg.on) return "none";
        this.data.knockout = msg.on;
        return "data";
      case "auto": {
        // A player who is out has no turns to play (R16).
        if (seat === null || this.isOut(seat)) throw new RoomError("not-allowed");
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
      case "toss": {
        if (game === null || seat === null || msg.to === seat || !seats[msg.to]) {
          throw new RoomError("not-allowed");
        }
        // Too soon: the client greys the items out meanwhile, so only a script gets here.
        if (now - (this.tossed.get(seat) ?? -TOSS_MS) < TOSS_MS) return "none";
        this.tossed.set(seat, now);
        this.toss = { id: now, from: seat, to: msg.to, item: msg.item };
        return "view";
      }
      case "react": {
        const at = msg.to;
        if (game === null || seat === null || (at !== undefined && (at === seat || !seats[at]))) {
          throw new RoomError("not-allowed");
        }
        // One gag per seat per TOSS_MS, a throw or a reaction.
        if (now - (this.tossed.get(seat) ?? -TOSS_MS) < TOSS_MS) return "none";
        this.tossed.set(seat, now);
        this.reaction = {
          id: now,
          from: seat,
          kind: msg.kind,
          ...(at !== undefined && { to: at }),
        };
        return "view";
      }
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
      knockout: this.data.knockout === true,
      game: this.data.game && toView(this.data.game),
      ...(this.toss && this.deps.now() - this.toss.id < TOSS_SHOW_MS && { toss: this.toss }),
      ...(this.reaction &&
        this.deps.now() - this.reaction.id < TOSS_SHOW_MS && { reaction: this.reaction }),
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
    const resumed = this.resume(live);
    const now = this.deps.now();
    const due = this.awaited().filter((s) => this.canStall(s, live) && now >= this.due(s));
    for (const seat of due) this.data.seats[seat].auto = true;
    // With nobody there playing by hand, nobody else can end the round (BUG-1).
    const mayEnd = this.data.seats.every(
      (s, i) => s.auto || this.isOut(i) || !this.connected(i, live),
    );
    for (const seat of due) {
      if (!this.data.game) break;
      this.play(this.data.game, autoMove(this.data.game, seat, mayEnd));
    }
    // Saves any clock those steps stopped (the next turn's player alone at the table).
    return this.resume(live) || resumed || due.length > 0;
  }

  /** When the adapter should call tick() and re-broadcast next (ms). Always in the future. */
  nextAlarm(live: Conn[]): number {
    const now = this.deps.now();
    const heard = this.heard(live);
    // A presence check (a row and a request) comes when someone would turn stale, for 10 min after
    // the last client message, then every 10 min (SEC-9). Clock and Auto-play steps never wait.
    const check = (at: number) => (at < heard + QUIET_MS ? at : Math.max(at, now + QUIET_MS));
    const due = [heard + this.idleAfter(live)];
    for (const s of this.awaited()) {
      if (!this.canStall(s, live)) continue;
      due.push(this.due(s));
      // A phone that goes silent: re-broadcast when it turns stale, so the table sees it's offline.
      if (this.connected(s, live)) due.push(check(this.lastSeen(s, live) + STALE_MS));
    }
    // If the host goes quiet while the table needs a lead, others must learn they may step in.
    if (this.needsLead() && this.connected(this.data.host, live)) {
      due.push(check(this.lastSeen(this.data.host, live) + STALE_MS));
    }
    // A step that came due after this event's tick() (a timer that fired a millisecond early) is
    // checked again at once, not dropped: dropping it stalled the turn until the next check.
    return Math.max(Math.min(...due), now + 1);
  }

  isIdle(live: Conn[]): boolean {
    return this.deps.now() - this.heard(live) >= this.idleAfter(live);
  }

  /** The last client message (ms), pings aside, any message counting: a hello too (SEC-9). */
  private heard(live: Conn[]): number {
    return Math.max(this.data.updatedAt, ...live.map((c) => c.heardAt));
  }

  /**
   * A seat's clock stops while nobody is there to pay for it (`canStall`) and starts afresh, a
   * full TURN_MS, once someone is. Stopped clocks are saved, since a phone that comes back by pings
   * alone is only seen at the next event, from anyone (M8's ping-only return). `before`: seats
   * stopped just before this event. Returns whether the room changed.
   */
  private resume(live: Conn[], before: number[] = []): boolean {
    // With no socket open nobody can come back by pings, and a new socket's hello brings `before`.
    if (live.length === 0) return false;
    const awaited = this.awaited();
    const stopped = awaited.filter((s) => !this.canStall(s, live));
    const was = [...(this.data.stopped ?? []), ...before];
    const back = was.some((s) => awaited.includes(s) && !stopped.includes(s));
    if (back) this.data.turnSince = this.deps.now();
    if (!back && String(stopped) === String(this.data.stopped ?? [])) return false;
    this.data.stopped = stopped;
    return true;
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
   * The host leads; if the host is away, on auto-play, or out of a knockout game (R16: they may
   * well have stopped watching), anyone seated may, so one dropped phone can't freeze the table.
   */
  private canLead(seat: number | null, live: Conn[]): boolean {
    const { host, seats } = this.data;
    const away = seats[host]?.auto === true || this.isOut(host) || !this.connected(host, live);
    return seat !== null && (seat === host || away);
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
   * The clock and auto-play run for a seat only while a seated player is there to pay for them
   * (each step is an alarm, charged to the IPs in the room, SEC-11): another connected seat, on
   * auto-play or not (BUG-1), or the seat itself when it's on auto-play. Spectators and players
   * who are out (R16) don't count, and a player thinking alone has no clock. Nobody connected,
   * nothing plays.
   */
  private canStall(seat: number, live: Conn[]): boolean {
    return this.data.seats.some(
      (s, i) => this.connected(i, live) && !this.isOut(i) && (i !== seat || s.auto === true),
    );
  }

  /** Seats the table is waiting on right now; never one that is out (R16). */
  private awaited(): number[] {
    const g = this.data.game;
    if (g?.phase === "flip") {
      return g.players.flatMap((p, i) =>
        !this.isOut(i) && p.grid.filter((s) => s?.up).length < 2 ? [i] : [],
      );
    }
    return g?.phase === "draw" || g?.phase === "place" ? [g.current] : [];
  }

  /** Out of the game (R16): no cards, no turns, no clock and no Auto-play; they watch. */
  private isOut(seat: number): boolean {
    return (this.data.game?.players[seat]?.out ?? null) !== null;
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
    // Going out ends a seat's Auto-play: it has no more turns (R16).
    for (const [i, s] of this.data.seats.entries()) if (this.isOut(i)) s.auto = false;
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
 * `mayEnd` (BUG-1): nobody is playing by hand, so that protection would keep the round from ever
 * ending; it is skipped.
 */
export function autoMove(g: GameState, seat: number, mayEnd = false): Action {
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
  const lastCard = down.length === 1 && g.ender === null && !mayEnd;
  if (high !== -1 && ((g.drawn as number) < highCard || lastCard)) {
    return { type: "swap", seat, pos: high };
  }
  return { type: g.drawnFrom === "deck" ? "discardAndFlip" : "swap", seat, pos: down[0] };
}
