import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Lab } from '../src/chaos.ts';
import { ALLOW_LIST, classifyRef } from '../src/refs.ts';
import { fakeRunners } from './helpers.ts';

const refArb = fc.oneof(
  fc.constantFrom(...ALLOW_LIST, 'exorcist/fix-1', 'exorcist/a/b', 'exorcist/', 'exorcist/../main', 'Main', 'main ', 'scenario/other', 'refs/heads/main', '../etc', '-rf'),
  fc.string({ maxLength: 40 }),
  fc.string({ maxLength: 20 }).map((s) => `exorcist/${s}`),
  fc.string({ maxLength: 20 }).map((s) => `scenario/${s}`),
);

describe('classifyRef', () => {
  // Feature: haunted-lab, Property 4
  it('allows exactly the allow-list, reserves exorcist/*, denies the rest', () => {
    fc.assert(
      fc.property(refArb, (ref) => {
        const cls = classifyRef(ref);
        if (ALLOW_LIST.includes(ref)) expect(cls).toBe('allowed');
        else if (cls === 'reserved') expect(ref.startsWith('exorcist/')).toBe(true);
        else expect(cls).toBe('denied');
        if (!ref.startsWith('exorcist/')) expect(cls).not.toBe('reserved');
      }),
      { numRuns: 500 },
    );
    expect(classifyRef('exorcist/fix-1')).toBe('reserved');
    expect(classifyRef('exorcist/../main')).toBe('denied');
    expect(classifyRef(42)).toBe('denied');
  });

  // Feature: haunted-lab, Property 4
  it('refuses reserved and denied refs without resolving them in git', async () => {
    await fc.assert(
      fc.asyncProperty(refArb, async (ref) => {
        fc.pre(!ALLOW_LIST.includes(ref));
        let gitCalls = 0;
        const lab = new Lab({
          runners: fakeRunners(),
          resolveRef: async () => {
            gitCalls++;
            return 'a'.repeat(40);
          },
          prepare: async () => '/x',
          record: async (r) => ({ id: 'd-1', ...r }),
        });
        const err = (await lab.deployRef('gate', ref, 'exorcist').catch((e: unknown) => e)) as { status: number; code: string };
        expect(gitCalls).toBe(0);
        if (classifyRef(ref) === 'reserved') expect(err).toMatchObject({ status: 403, code: 'ref_reserved' });
        else expect(err.status).toBe(400);
      }),
      { numRuns: 200 },
    );
  });
});
