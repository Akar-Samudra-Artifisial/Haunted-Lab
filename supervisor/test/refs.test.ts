import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Lab } from '../src/chaos.ts';
import { ALLOW_LIST, classifyRef } from '../src/refs.ts';
import { fakeRunners } from './helpers.ts';

const INCIDENT = /^incident\/c[a-z0-9]{24}$/;

const refArb = fc.oneof(
  fc.constantFrom(
    ...ALLOW_LIST,
    'exorcist/fix-1',
    'exorcist/c000000000000000000000001',
    'incident/c000000000000000000000001',
    'incident/C000000000000000000000001',
    'incident/c00000000000000000000000',
    'incident/c0000000000000000000000012',
    'incident/../main',
    'Main',
    'main ',
    'scenario/other',
    'refs/heads/main',
    '../etc',
    '-rf',
  ),
  fc.string({ maxLength: 40 }),
  fc.string({ maxLength: 20 }).map((s) => `exorcist/${s}`),
  fc.stringMatching(/^c[a-z0-9]{24}$/).map((s) => `incident/${s}`),
  fc.string({ maxLength: 26 }).map((s) => `incident/${s}`),
  fc.string({ maxLength: 20 }).map((s) => `scenario/${s}`),
);

describe('classifyRef', () => {
  // Feature: fix-deploy, Property 3
  it('returns named for main and the scenarios, fix for incident/<cuid>, denied for the rest', () => {
    fc.assert(
      fc.property(refArb, (ref) => {
        const cls = classifyRef(ref);
        if (ALLOW_LIST.includes(ref)) expect(cls).toBe('named');
        else if (INCIDENT.test(ref)) expect(cls).toBe('fix');
        else expect(cls).toBe('denied');
      }),
      { numRuns: 500 },
    );
    expect(classifyRef('exorcist/c000000000000000000000001')).toBe('denied');
    expect(classifyRef(42)).toBe('denied');
  });

  // Feature: fix-deploy, Property 3
  it('boot, apply, reset and deployRef never pass a fix or denied ref to git or a runner', async () => {
    await fc.assert(
      fc.asyncProperty(refArb, async (ref) => {
        fc.pre(!ALLOW_LIST.includes(ref));
        let gitCalls = 0;
        const runners = fakeRunners();
        const lab = new Lab({
          runners,
          resolveRef: async () => {
            gitCalls++;
            return 'a'.repeat(40);
          },
          prepare: async () => '/x',
          record: async (r) => ({ id: 'd-1', ...r }),
        });
        const err = (await lab.deployRef('gate', ref, 'exorcist').catch((e: unknown) => e)) as { status: number; code: string };
        expect(gitCalls).toBe(0);
        expect(err).toMatchObject({ status: 400, code: 'ref_denied' });
        expect(runners.gate.deploys).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });
});
