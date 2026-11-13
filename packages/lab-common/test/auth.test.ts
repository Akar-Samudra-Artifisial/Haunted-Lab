import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bearerMatches } from '../src/index.ts';

describe('bearerMatches', () => {
  it('handles missing headers and empty secrets', () => {
    expect(bearerMatches(undefined, 'secret-secret-123')).toBe(false);
    expect(bearerMatches('Bearer ', '')).toBe(false);
    expect(bearerMatches('Bearer secret-secret-123', 'secret-secret-123')).toBe(true);
    expect(bearerMatches('bearer secret-secret-123', 'secret-secret-123')).toBe(false);
  });

  // Feature: haunted-lab, Property 3
  it('is true iff the header is `Bearer ` + the exact secret', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), fc.string({ maxLength: 60 }), (secret, header) => {
        expect(bearerMatches(`Bearer ${secret}`, secret)).toBe(true);
        expect(bearerMatches(header, secret)).toBe(header === `Bearer ${secret}`);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: haunted-lab, Property 3
  it('never accepts a different token (two-token separation)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 16, maxLength: 40 }), fc.string({ minLength: 16, maxLength: 40 }), (chaos, read) => {
        fc.pre(chaos !== read);
        expect(bearerMatches(`Bearer ${chaos}`, read)).toBe(false);
        expect(bearerMatches(`Bearer ${read}`, chaos)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
