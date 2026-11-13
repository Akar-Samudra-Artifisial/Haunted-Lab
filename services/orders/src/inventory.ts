const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Simulated stock reservation. Synthetic: no real inventory. */
export async function reserveStock(_sku: string): Promise<void> {
  await sleep(20);
}
