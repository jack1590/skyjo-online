import { describe, expect, it } from "vitest";
import { newDeck } from "./game";
import { chachaBlock, randomBelow, seedRng, shuffle } from "./rng";

const hex = (words: number[]) => words.map((w) => w.toString(16).padStart(8, "0")).join(" ");

describe("ChaCha20 block (RFC 8439)", () => {
  it("matches the block function test vector of section 2.3.2", () => {
    // Key bytes 00..1f, nonce 00 00 00 09 00 00 00 4a 00 00 00 00, counter 1: little-endian words.
    const key = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (0x03020100 + 0x04040404 * i) >>> 0);
    expect(hex(chachaBlock(key, 1, [0x09000000, 0x4a000000, 0]))).toBe(
      "e4e7f110 15593bd1 1fdd0f50 c47120a3 c7f4d1c7 0368c033 9aaa2204 4e6cd4c3 " +
        "466482d2 09aa9f07 05d7c214 a2028bd9 d19c12b5 b94e16de e883d0cb 4e3c50a2",
    );
  });

  it("matches test vector 1 of appendix A.1 (all-zero key and nonce, counter 0)", () => {
    // Keystream bytes 76 b8 e0 ad a0 f1 3d 90 40 5d 6a e5 53 86 bd 28 …
    expect(hex(chachaBlock([0, 0, 0, 0, 0, 0, 0, 0], 0).slice(0, 4))).toBe(
      "ade0b876 903df1a0 e56a5d40 28bd8653",
    );
  });
});

describe("seedRng", () => {
  it("keys the generator with up to 256 bits, padding a short seed with zeros", () => {
    expect(seedRng([1, 2])).toEqual({ key: [1, 2, 0, 0, 0, 0, 0, 0], used: 0 });
    expect(seedRng([1, 2, 3, 4, 5, 6, 7, 8, 9]).key).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("is plain JSON, so a saved game replays exactly", () => {
    const [, rng] = shuffle(newDeck(), seedRng([5]));
    const [a] = shuffle(newDeck(), rng);
    const [b] = shuffle(newDeck(), JSON.parse(JSON.stringify(rng)));
    expect(a).toEqual(b);
  });
});

describe("randomBelow", () => {
  it("reads the stream word by word: one call per word equals the block", () => {
    let rng = seedRng([0]);
    const words: number[] = [];
    for (let i = 0; i < 20; i++) {
      let v: number;
      [v, rng] = randomBelow(2 ** 32, rng);
      words.push(v);
    }
    const zeros = [0, 0, 0, 0, 0, 0, 0, 0];
    expect(words).toEqual([...chachaBlock(zeros, 0), ...chachaBlock(zeros, 1).slice(0, 4)]);
    expect(rng.used).toBe(20);
  });

  it("rejects the words that would bias the result instead of folding them in", () => {
    // n just over 2^31: every word at or above n is thrown away, about half of them.
    const n = 2 ** 31 + 1;
    let rng = seedRng([7]);
    for (let i = 0; i < 200; i++) {
      let v: number;
      [v, rng] = randomBelow(n, rng);
      expect(v).toBeLessThan(n);
    }
    expect(rng.used).toBeGreaterThan(300);
    expect(rng.used).toBeLessThan(500);
  });
});

describe("shuffle", () => {
  it("keeps every item, leaves its input alone, and is deterministic for a seed", () => {
    const items = Array.from({ length: 150 }, (_, i) => i);
    const [a, next] = shuffle(items, seedRng([42]));
    expect(items[149]).toBe(149);
    expect([...a].sort((x, y) => x - y)).toEqual(items);
    expect(a).not.toEqual(items);
    expect(shuffle(items, seedRng([42]))[0]).toEqual(a);
    expect(shuffle(items, seedRng([43]))[0]).not.toEqual(a);
    expect(shuffle(items, next)[0]).not.toEqual(a);
  });

  it("R1/R2: over 20,000 deals every card value is as likely at every deck position", () => {
    const deck = newDeck();
    const share = [5, 10, 15, ...Array<number>(12).fill(10)].map((n) => n / 150);
    const deals = 20_000;
    const seen = new Float64Array(150 * 15);
    let rng = seedRng([2024]);
    for (let n = 0; n < deals; n++) {
      let dealt: number[];
      [dealt, rng] = shuffle(deck, rng);
      for (let i = 0; i < 150; i++) seen[i * 15 + (dealt[i] as number) + 2]++;
    }
    let chi2 = 0;
    for (let i = 0; i < seen.length; i++) {
      const expected = deals * (share[i % 15] as number);
      chi2 += ((seen[i] as number) - expected) ** 2 / expected;
    }
    // 149 × 14 = 2086 degrees of freedom, sd √(2 × 2086) ≈ 65: within 4 sd of the mean.
    expect(Math.abs(chi2 - 2086)).toBeLessThan(4 * 65);
  });

  it("gives all 24 orders of 4 cards equally often", () => {
    const counts = new Map<string, number>();
    const runs = 24_000;
    let rng = seedRng([9]);
    for (let n = 0; n < runs; n++) {
      let order: number[];
      [order, rng] = shuffle([0, 1, 2, 3], rng);
      counts.set(order.join(), (counts.get(order.join()) ?? 0) + 1);
    }
    expect(counts.size).toBe(24);
    let chi2 = 0;
    for (const n of counts.values()) chi2 += (n - 1000) ** 2 / 1000;
    // 23 degrees of freedom: 99.9% of fair shuffles score under 49.7.
    expect(chi2).toBeLessThan(49.7);
  });
});
