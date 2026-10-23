/** Generator state: four int32s, plain JSON so it lives inside GameState and games replay exactly. */
export type Rng = [number, number, number, number];

/**
 * sfc32. The 128-bit state means the seed can't be brute-forced from the cards everyone sees.
 * ponytail: not a CSPRNG; swap in ChaCha20 if state recovery from visible cards ever matters.
 */
export function nextRandom(rng: Rng): [value: number, next: Rng] {
  const [a, b, c, d] = rng;
  const t = (((a + b) | 0) + d) | 0;
  const rotated = (c << 21) | (c >>> 11);
  return [
    (t >>> 0) / 4294967296,
    [b ^ (b >>> 9), (c + (c << 3)) | 0, (rotated + t) | 0, (d + 1) | 0],
  ];
}

/** Mixes a raw seed so that low-entropy seeds (tests) still start from a well-spread state. */
export function seedRng(seed: Rng): Rng {
  let rng = seed.map((n) => n | 0) as Rng;
  for (let i = 0; i < 15; i++) [, rng] = nextRandom(rng);
  return rng;
}

/** Fisher–Yates shuffle. Returns the shuffled copy and the advanced generator state. */
export function shuffle<T>(items: readonly T[], rng: Rng): [T[], Rng] {
  const out = [...items];
  let r = rng;
  for (let i = out.length - 1; i > 0; i--) {
    let v: number;
    [v, r] = nextRandom(r);
    const j = Math.floor(v * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return [out, r];
}
