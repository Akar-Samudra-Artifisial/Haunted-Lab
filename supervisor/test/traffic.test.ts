import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_IN_FLIGHT, nextInterval, syntheticOrder, TrafficGenerator } from '../src/traffic.ts';

describe('nextInterval', () => {
  // Feature: haunted-lab, Property 12
  it('stays within 60% to 140% of the base and averages to the base', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), (rps, r) => {
        const base = 1000 / rps;
        const v = nextInterval(rps, r);
        expect(v).toBeGreaterThanOrEqual(base * 0.6 - 1e-9);
        expect(v).toBeLessThanOrEqual(base * 1.4 + 1e-9);
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (rps) => {
        let sum = 0;
        const n = 4000;
        for (let i = 0; i < n; i++) sum += nextInterval(rps, Math.random());
        expect(Math.abs(sum / n - 1000 / rps)).toBeLessThan((1000 / rps) * 0.05);
      }),
      { numRuns: 20 },
    );
  });
});

describe('TrafficGenerator', () => {
  // Feature: haunted-lab, Property 16
  it('never exceeds 50 in flight and skips instead of queueing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.oneof(fc.constant('tick' as const), fc.constant('settle' as const)), { maxLength: 300 }), async (steps) => {
        const pending: (() => void)[] = [];
        const gen = new TrafficGenerator({
          gateUrl: 'http://127.0.0.1:1',
          rps: 5,
          send: () => new Promise<void>((resolve, reject) => pending.push(Math.random() < 0.5 ? resolve : () => reject(new Error('x')))),
        });
        let ticks = 0;
        for (const step of steps) {
          if (step === 'tick') {
            const before = gen.inFlight;
            ticks++;
            gen.tick();
            if (before >= MAX_IN_FLIGHT) expect(gen.inFlight).toBe(before);
          } else {
            pending.shift()?.();
            await new Promise((r) => setImmediate(r));
          }
          expect(gen.inFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT);
        }
        expect(gen.sent + gen.skipped).toBe(ticks);
        expect(pending.length).toBeLessThanOrEqual(MAX_IN_FLIGHT);
      }),
      { numRuns: 100 },
    );
  });

  it('keeps running when gate is down and sends only synthetic checkout bodies', async () => {
    const gen = new TrafficGenerator({ gateUrl: 'http://127.0.0.1:1', rps: 50 });
    for (let i = 0; i < 5; i++) gen.tick();
    await new Promise((r) => setTimeout(r, 200));
    expect(gen.failed).toBe(5);
    expect(gen.inFlight).toBe(0);
    const o = syntheticOrder(3);
    expect(o.orderId).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(o.qty).toBeGreaterThanOrEqual(1);
    expect(o.qty).toBeLessThanOrEqual(9);
  });

  it('does nothing at 0 rps', () => {
    const gen = new TrafficGenerator({ gateUrl: 'http://127.0.0.1:1', rps: 0 });
    gen.start();
    gen.stop();
    expect(gen.sent).toBe(0);
  });
});
