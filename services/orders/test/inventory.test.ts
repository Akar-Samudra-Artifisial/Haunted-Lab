import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { patchedServiceCopy } from '../../../scripts/scenario-copy.mjs';
import { loadConfig } from '../src/config.ts';
import { reserveStock } from '../src/inventory.ts';

/** Virtual milliseconds until `p` settles, advancing fake timers in 10 ms steps. */
async function virtualDuration(start: () => Promise<void>, limitMs = 10_000): Promise<number> {
  let done = false;
  const p = start().then(() => {
    done = true;
  });
  let elapsed = 0;
  while (!done && elapsed < limitMs) {
    await vi.advanceTimersByTimeAsync(10);
    elapsed += 10;
  }
  await p;
  return elapsed;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('orders inventory', () => {
  it('main: reserving stock takes one short simulated call (fake clock)', async () => {
    vi.useFakeTimers();
    const ms = await virtualDuration(() => reserveStock('sku-1'));
    expect(ms).toBe(20);
  });

  it('needs ORDERS_PORT and PAYMENTS_URL', () => {
    expect(() => loadConfig({})).toThrow('missing required env: ORDERS_PORT, PAYMENTS_URL');
    expect(loadConfig({ ORDERS_PORT: '4002', PAYMENTS_URL: 'http://127.0.0.1:4003' })).toEqual({
      port: 4002,
      host: '127.0.0.1',
      paymentsUrl: 'http://127.0.0.1:4003',
    });
  });
});

describe('scenario fog, applied in-process', () => {
  it('adds more than 1 s of sequential latency and no errors (fake clock)', async () => {
    const copy = await patchedServiceCopy(resolve(import.meta.dirname, '..'), 'fog');
    try {
      const mod = (await import(`${copy.src}/inventory.ts`)) as { reserveStock: typeof reserveStock };
      vi.useFakeTimers();
      const ms = await virtualDuration(() => mod.reserveStock('sku-1'));
      expect(ms).toBeGreaterThan(1000);
      expect(ms).toBe(8 * 200 + 20);
    } finally {
      vi.useRealTimers();
      await copy.cleanup();
    }
  });
});
