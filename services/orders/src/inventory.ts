const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const WAREHOUSES = ['north', 'south', 'east', 'west', 'harbor', 'hill', 'mill', 'yard'];

/** Ask a warehouse how fresh its stock count is before reserving. */
async function checkFreshness(_sku: string, _warehouse: string): Promise<void> {
  await sleep(200);
}

/** Simulated stock reservation. Synthetic: no real inventory. */
export async function reserveStock(sku: string): Promise<void> {
  for (const warehouse of WAREHOUSES) {
    await checkFreshness(sku, warehouse);
  }
  await sleep(20);
}
