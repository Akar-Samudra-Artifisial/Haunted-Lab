/** mulberry32: small seeded PRNG so tests never depend on Math.random. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` synthetic order ids in the same shape as the traffic generator's. */
export function seededIds(n: number, seed: number): string[] {
  const rand = seededRandom(seed);
  return Array.from({ length: n }, (_, i) => `o-${i}-${Math.floor(rand() * 1_000_000)}`);
}
