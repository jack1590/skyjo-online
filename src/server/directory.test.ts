import { describe, expect, it } from "vitest";
import type { PublicRoom } from "../protocol";
import { Directory, LIST_MAX, LISTED_MS, OWNER_MAX, ROOMS_MAX } from "./directory";

const room = (code: string, players = 1): PublicRoom => ({
  code,
  host: `host of ${code}`,
  players,
  knockout: false,
});

describe("Directory (M24)", () => {
  it("M24: lists rooms newest first, updates one in place, and unlists it", () => {
    const d = new Directory();
    d.set("AAAAA", room("AAAAA"), 1_000);
    d.set("BBBBB", room("BBBBB"), 2_000);
    expect(d.list(3_000).map((r) => r.code)).toEqual(["BBBBB", "AAAAA"]);
    d.set("AAAAA", room("AAAAA", 3), 4_000);
    expect(d.list(5_000)).toEqual([room("AAAAA", 3), room("BBBBB")]);
    expect(d.set("BBBBB", null, 6_000).gone).toEqual(["BBBBB"]);
    expect(d.set("BBBBB", null, 6_000).gone).toEqual([]); // already gone: nothing to delete
    expect(d.list(7_000)).toEqual([room("AAAAA", 3)]);
  });

  it(`M24: shows ${LIST_MAX} rooms at most and holds ${ROOMS_MAX}: the oldest makes room`, () => {
    const d = new Directory();
    const code = (i: number) => `R${String(i).padStart(4, "0")}`;
    for (let i = 0; i < ROOMS_MAX; i++) expect(d.set(code(i), room(code(i)), i).gone).toEqual([]);
    expect(d.list(ROOMS_MAX)).toHaveLength(LIST_MAX);
    expect(d.list(ROOMS_MAX)[0].code).toBe(code(ROOMS_MAX - 1));
    expect(d.set(code(5), room(code(5), 2), 1_000).gone).toEqual([]); // an update evicts nobody
    expect(d.set("NEWER", room("NEWER"), 1_001).gone).toEqual([code(0)]);
    expect(d.rooms.size).toBe(ROOMS_MAX);
  });

  it("M24: forgets a room 24 h after it was last told, and says which rows to delete", () => {
    const d = new Directory();
    d.set("AAAAA", room("AAAAA"), 0);
    d.set("BBBBB", room("BBBBB"), 1_000);
    expect(d.list(LISTED_MS - 1)).toHaveLength(2);
    expect(d.list(LISTED_MS).map((r) => r.code)).toEqual(["BBBBB"]);
    expect(d.set("CCCCC", room("CCCCC"), LISTED_MS).gone).toEqual(["AAAAA"]);
    expect([...d.rooms.keys()]).toEqual(["BBBBB", "CCCCC"]);
  });

  it(`M24: an address lists ${OWNER_MAX} rooms at most: the next is refused and writes nothing; updates, another address and a local run (no address) aren't; unlisting frees a place; the list never shows the address`, () => {
    const d = new Directory();
    const HOME = "203.0.113.7";
    expect(d.set("AAAAA", room("AAAAA"), 1, HOME).ok).toBe(true);
    expect(d.set("BBBBB", room("BBBBB"), 2, HOME).ok).toBe(true);
    expect(d.set("CCCCC", room("CCCCC"), 3, HOME)).toEqual({ gone: [], ok: false });
    expect(d.rooms.has("CCCCC")).toBe(false);
    expect(d.set("AAAAA", room("AAAAA", 2), 4, HOME).ok).toBe(true); // an update
    // Whoever listed it keeps it: a guest's address telling of a change doesn't take it over.
    expect(d.set("AAAAA", room("AAAAA", 3), 5, "198.51.100.1").ok).toBe(true);
    expect(d.set("CCCCC", room("CCCCC"), 6, HOME).ok).toBe(false);
    expect(d.set("DDDDD", room("DDDDD"), 7, "198.51.100.1").ok).toBe(true);
    for (const code of ["L1111", "L2222", "L3333"]) {
      expect(d.set(code, room(code), 8, null).ok).toBe(true);
    }
    d.set("BBBBB", null, 9, null);
    expect(d.set("CCCCC", room("CCCCC"), 10, HOME).ok).toBe(true);
    expect(JSON.stringify(d.list(11))).not.toContain(HOME);
    expect(Object.keys(d.list(11)[0]).sort()).toEqual(["code", "host", "knockout", "players"]);
  });
});
