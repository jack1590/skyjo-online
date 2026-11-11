/** A raw seed: up to 8 int32s (256 bits), from `crypto.getRandomValues` in real games. */
export type Seed = readonly number[];

/**
 * Generator state: a 256-bit ChaCha20 key and how many 32-bit words of its keystream were used.
 * Plain JSON, so it lives inside GameState and games replay exactly. The cards everyone sees are
 * keystream output, which doesn't give away the key: nobody can work out the rest of the deck.
 */
export type Rng = { key: number[]; used: number };

const rotl = (v: number, n: number) => (v << n) | (v >>> (32 - n));

/** The ChaCha20 block function (RFC 8439, section 2.3): 16 keystream words for one counter. */
export function chachaBlock(
  key: readonly number[],
  counter: number,
  nonce: readonly number[] = [0, 0, 0],
): number[] {
  const start = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574, ...key, counter, ...nonce];
  const x = new Uint32Array(start);
  const quarter = (a: number, b: number, c: number, d: number) => {
    x[a] = (x[a] as number) + (x[b] as number);
    x[d] = rotl((x[d] as number) ^ (x[a] as number), 16);
    x[c] = (x[c] as number) + (x[d] as number);
    x[b] = rotl((x[b] as number) ^ (x[c] as number), 12);
    x[a] = (x[a] as number) + (x[b] as number);
    x[d] = rotl((x[d] as number) ^ (x[a] as number), 8);
    x[c] = (x[c] as number) + (x[d] as number);
    x[b] = rotl((x[b] as number) ^ (x[c] as number), 7);
  };
  for (let round = 0; round < 10; round++) {
    quarter(0, 4, 8, 12);
    quarter(1, 5, 9, 13);
    quarter(2, 6, 10, 14);
    quarter(3, 7, 11, 15);
    quarter(0, 5, 10, 15);
    quarter(1, 6, 11, 12);
    quarter(2, 7, 8, 13);
    quarter(3, 4, 9, 14);
  }
  return Array.from(x, (v, i) => (v + (start[i] as number)) >>> 0);
}

/**
 * Starts a generator from a seed. Also takes the four ints that were the whole state before
 * 2.6.4 (sfc32), so a game saved by an older version carries on.
 */
export function seedRng(seed: Seed): Rng {
  return { key: Array.from({ length: 8 }, (_, i) => (seed[i] ?? 0) | 0), used: 0 };
}

/** Reads `rng`'s keystream from where it stopped, working out each block once. */
function reader(rng: Rng) {
  let used = rng.used;
  let block: number[] = [];
  return {
    /** A uniform integer in `[0, n)`, for `n` up to 2^32. */
    below(n: number): number {
      // Words at or above the largest multiple of n would make low results likelier: skip them.
      const limit = 2 ** 32 - (2 ** 32 % n);
      for (;;) {
        // ponytail: the block counter wraps after 2^36 words; a game uses a few thousand.
        if (used % 16 === 0 || block.length === 0)
          block = chachaBlock(rng.key, Math.floor(used / 16));
        const word = block[used++ % 16] as number;
        if (word < limit) return word % n;
      }
    },
    rng: (): Rng => ({ key: rng.key, used }),
  };
}

/** A uniform integer in `[0, n)` and the advanced generator state. */
export function randomBelow(n: number, rng: Rng): [value: number, next: Rng] {
  const r = reader(rng);
  return [r.below(n), r.rng()];
}

/** Fisher–Yates shuffle. Returns the shuffled copy and the advanced generator state. */
export function shuffle<T>(items: readonly T[], rng: Rng): [T[], Rng] {
  const out = [...items];
  const r = reader(rng);
  for (let i = out.length - 1; i > 0; i--) {
    const j = r.below(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return [out, r.rng()];
}
