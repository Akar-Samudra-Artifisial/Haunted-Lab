import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createErrorRing, createLogRing, Ring } from '../src/index.ts';

describe('Ring', () => {
  it('uses the spec capacities', () => {
    expect(createErrorRing().capacity).toBe(200);
    expect(createLogRing().capacity).toBe(500);
  });

  it('rejects a bad capacity', () => {
    expect(() => new Ring(0)).toThrow(RangeError);
  });

  // Feature: haunted-lab, Property 1
  it('stays bounded and ordered for any push sequence', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.integer(), { maxLength: 200 }),
        fc.integer({ min: 0, max: 80 }),
        (capacity, pushes, limit) => {
          const ring = new Ring<number>(capacity);
          for (const p of pushes) ring.push(p);
          const expected = pushes.slice(-capacity);
          expect(ring.size).toBe(expected.length);
          expect(ring.size).toBeLessThanOrEqual(capacity);
          expect(ring.latest()).toEqual(expected);
          expect(ring.latest(limit)).toEqual(expected.slice(Math.max(0, expected.length - limit)));
        },
      ),
      { numRuns: 200 },
    );
  });
});
