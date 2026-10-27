import { describe, expect, it } from "vitest";
import { TOSS_ITEMS } from "../protocol";
import { FADE, flight, WIND } from "./Toss";

const at = (transform: unknown) => String(transform);

describe("flight", () => {
  it("M22: winds up at the thrower, flies to the target, and hits early enough for its mark to show", () => {
    for (const item of TOSS_ITEMS) {
      for (const [dx, dy] of [
        [0, 0],
        [300, -300],
        [-300, 300],
        [120, 40],
      ]) {
        const { frames, ghost, land, hit } = flight(item, dx, dy);
        expect(at(frames[0].transform)).toBe(`translate(${dx}px, ${dy}px) scale(0)`);
        expect(at(frames.at(-1)?.transform)).toBe("translate(0px, 0px) scale(1)");
        const offsets = frames.map((f) => f.offset as number);
        expect(offsets[0]).toBe(0);
        expect(offsets.at(-1)).toBe(1);
        for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
        expect(land).toBeGreaterThan(WIND);
        expect(hit).toBeGreaterThanOrEqual(land);
        expect(hit + 600).toBeLessThanOrEqual(FADE);
        // The trail is unseen during the wind-up and on arrival.
        const trail = ghost(0.4);
        expect(trail.slice(0, 3).every((f) => f.opacity === 0)).toBe(true);
        expect(trail.at(-1)?.opacity).toBe(0);
        expect(trail[10].opacity).toBe(0.4);
      }
    }
  });

  it("M22: heavy items dive in: halfway through the flight they have covered less than half the way", () => {
    const x = (item: "bomb" | "slipper", i: number) =>
      Number(/translate\((-?[\d.]+)px/.exec(at(flight(item, 200, 0).frames[i].transform))?.[1]);
    // Frame 12 is half the flight (the pop is frame 2, then 20 steps).
    expect(x("bomb", 12)).toBeGreaterThan(100);
    expect(x("slipper", 12)).toBe(100);
  });
});
