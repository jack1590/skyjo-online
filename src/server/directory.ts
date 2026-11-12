// The public-room list (M24): the lobbies strangers may join. Platform-agnostic: the adapters own
// where it lives (a Durable Object's storage in worker.ts, memory in node.ts). Rooms decide whether
// they belong here (`Room.listing`); this only keeps what they say.
import type { PublicRoom } from "../protocol";
import { IDLE_MS } from "./room";

/** Home shows this many rooms, the ones that changed last. */
export const LIST_MAX = 20;
/**
 * Rooms held at most; the oldest makes room. A Durable Object reads them all when it wakes, at
 * most every 10 s: under 1.8 million rows read a day, of the free plan's 5 million.
 */
export const ROOMS_MAX = 200;
/**
 * A room not heard from for this long is forgotten: its "unlist" was lost, or it was evicted and
 * came back. A listed room says so again at half this (`Room.relist`).
 */
export const LISTED_MS = IDLE_MS;

/**
 * Each Worker isolate reuses the list this long: Home polls it, and a read is a Durable Object
 * request. Here, not in worker.ts: a Worker's entry module may export only its handlers.
 */
export const LIST_CACHE_MS = 10_000;

/** Rooms one address (`ipKey`) may have on the list: a script can't fill Home with its own. */
export const OWNER_MAX = 2;

/** `owner`: the address of the host who listed it; null = a local run, which isn't limited. */
export type Listed = PublicRoom & { at: number; owner: string | null };

export class Directory {
  constructor(readonly rooms = new Map<string, Listed>()) {}

  /**
   * Lists, updates or (null) unlists a room. `gone`: the codes it dropped, for a store to delete.
   * `ok` false: refused and nothing kept, since `owner` has OWNER_MAX rooms listed already. A room
   * on the list stays its first owner's, whoever tells of a change.
   */
  set(
    code: string,
    room: PublicRoom | null,
    now: number,
    owner: string | null = null,
  ): { gone: string[]; ok: boolean } {
    const gone: string[] = [];
    const drop = (c: string) => this.rooms.delete(c) && gone.push(c);
    for (const [c, r] of this.rooms) if (now - r.at >= LISTED_MS) drop(c);
    if (!room) drop(code);
    else {
      const was = this.rooms.get(code);
      const owned = [...this.rooms.values()].filter((r) => r.owner === owner).length;
      if (!was && owner !== null && owned >= OWNER_MAX) return { gone, ok: false };
      if (!was && this.rooms.size >= ROOMS_MAX) {
        drop([...this.rooms].reduce((a, b) => (b[1].at < a[1].at ? b : a))[0]);
      }
      this.rooms.set(code, { ...room, at: now, owner: was ? was.owner : owner });
    }
    return { gone, ok: true };
  }

  list(now: number): PublicRoom[] {
    return [...this.rooms.values()]
      .filter((r) => now - r.at < LISTED_MS)
      .sort((a, b) => b.at - a.at)
      .slice(0, LIST_MAX)
      .map(({ code, host, players, knockout }) => ({ code, host, players, knockout }));
  }
}
