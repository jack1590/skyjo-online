import { describe, expect, it } from "vitest";
import type { PublicRoom } from "../protocol";
import { Directory, LIST_MAX, LISTED_MS, ROOMS_MAX } from "./directory";

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
    expect(d.set("BBBBB", null, 6_000)).toEqual(["BBBBB"]);
    expect(d.set("BBBBB", null, 6_000)).toEqual([]); // already gone: nothing to delete
    expect(d.list(7_000)).toEqual([room("AAAAA", 3)]);
  });

  it(`M24: shows ${LIST_MAX} rooms at most and holds ${ROOMS_MAX}: the oldest makes room`, () => {
    const d = new Directory();
    const code = (i: number) => `R${String(i).padStart(4, "0")}`;
    for (let i = 0; i < ROOMS_MAX; i++) expect(d.set(code(i), room(code(i)), i)).toEqual([]);
    expect(d.list(ROOMS_MAX)).toHaveLength(LIST_MAX);
    expect(d.list(ROOMS_MAX)[0].code).toBe(code(ROOMS_MAX - 1));
    expect(d.set(code(5), room(code(5), 2), 1_000)).toEqual([]); // an update evicts nobody
    expect(d.set("NEWER", room("NEWER"), 1_001)).toEqual([code(0)]);
    expect(d.rooms.size).toBe(ROOMS_MAX);
  });

  it("M24: forgets a room 24 h after it was last told, and says which rows to delete", () => {
    const d = new Directory();
    d.set("AAAAA", room("AAAAA"), 0);
    d.set("BBBBB", room("BBBBB"), 1_000);
    expect(d.list(LISTED_MS - 1)).toHaveLength(2);
    expect(d.list(LISTED_MS).map((r) => r.code)).toEqual(["BBBBB"]);
    expect(d.set("CCCCC", room("CCCCC"), LISTED_MS)).toEqual(["AAAAA"]);
    expect([...d.rooms.keys()]).toEqual(["BBBBB", "CCCCC"]);
  });
});
