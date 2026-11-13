import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMS, findRefund, refundTerms } from '../src/refunds.ts';
import { seededIds } from './seeded.ts';

describe('refunds', () => {
  it('has no record for about 30% of order ids and falls back to default terms', () => {
    const ids = seededIds(5000, 42);
    let missing = 0;
    for (const id of ids) {
      if (findRefund(id) === undefined) {
        missing++;
        expect(refundTerms(id)).toEqual(DEFAULT_TERMS);
      } else {
        expect(refundTerms(id)).toEqual(findRefund(id));
      }
    }
    expect(missing / ids.length).toBeGreaterThan(0.27);
    expect(missing / ids.length).toBeLessThan(0.33);
  });

  it('is deterministic for a given seed', () => {
    expect(seededIds(5, 7)).toEqual(seededIds(5, 7));
    expect(seededIds(5, 7)).not.toEqual(seededIds(5, 8));
  });
});
