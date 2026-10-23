/** mulberry32. The generator state is a plain int carried inside GameState, so games replay exactly. */
export function nextRandom(rng: number): [value: number, next: number] {
  const next = (rng + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), next | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

/** Fisher–Yates shuffle. Returns the shuffled copy and the advanced generator state. */
export function shuffle<T>(items: readonly T[], rng: number): [T[], number] {
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
