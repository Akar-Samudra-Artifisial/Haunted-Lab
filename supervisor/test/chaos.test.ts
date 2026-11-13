import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Lab } from '../src/chaos.ts';
import { SCENARIOS, type ScenarioName } from '../src/scenarios.ts';
import { SERVICES, type DeployRecord } from '../src/types.ts';
import { fakeRunners } from './helpers.ts';

const SHAS: Record<string, string> = {
  main: '1'.repeat(40),
  'scenario/error-spike': '2'.repeat(40),
  'scenario/fog': '3'.repeat(40),
  'scenario/dark-room': '4'.repeat(40),
};

function makeLab() {
  const runners = fakeRunners();
  const records: DeployRecord[] = [];
  let id = 101;
  const lab = new Lab({
    runners,
    resolveRef: async (ref) => SHAS[ref],
    prepare: async (service, sha) => `/wt/${service}@${sha}/services/${service}`,
    record: async (r) => {
      const full = { id: `d-${id++}`, ...r };
      records.push(full);
      return full;
    },
  });
  return { lab, runners, records };
}

const opArb = fc.oneof(fc.constantFrom<ScenarioName>('error-spike', 'fog', 'dark-room').map((s) => ({ kind: 'apply' as const, s })), fc.constant({ kind: 'reset' as const }));

describe('Lab apply/reset', () => {
  // Feature: haunted-lab, Property 14
  it('converges: apply puts only the target on its branch, reset puts all on main; only changes are recorded', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 12 }), async (ops) => {
        const { lab, runners, records } = makeLab();
        await lab.boot();
        expect(records.map((r) => r.actor)).toEqual(['supervisor', 'supervisor', 'supervisor', 'supervisor']);
        for (const op of ops) {
          const before = Object.fromEntries(SERVICES.map((s) => [s, runners[s].deployment?.ref]));
          const n = records.length;
          if (op.kind === 'apply') {
            const res = await lab.apply(op.s);
            const sc = SCENARIOS[op.s];
            for (const s of SERVICES) expect(runners[s].deployment?.ref).toBe(s === sc.service ? sc.ref : 'main');
            expect(res.state.activeScenario).toBe(op.s);
          } else {
            const res = await lab.reset();
            for (const s of SERVICES) expect(runners[s].deployment?.ref).toBe('main');
            expect(res.state.activeScenario).toBeNull();
          }
          const changed = SERVICES.filter((s) => before[s] !== runners[s].deployment?.ref);
          const added = records.slice(n);
          expect(added.map((r) => r.service).sort()).toEqual([...changed].sort());
          for (const r of added) {
            expect(r.actor).toBe('chaos');
            expect(r.sha).toBe(SHAS[r.ref]);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('rejects unknown scenarios with 404 and serializes concurrent calls', async () => {
    const { lab, runners } = makeLab();
    await lab.boot();
    await expect(lab.apply('../../main')).rejects.toMatchObject({ status: 404, code: 'unknown_scenario' });
    await expect(lab.apply('constructor')).rejects.toMatchObject({ status: 404 });
    await Promise.all([lab.apply('fog'), lab.reset(), lab.apply('dark-room')]);
    expect(runners.ledger.deployment?.ref).toBe('scenario/dark-room');
    expect(runners.orders.deployment?.ref).toBe('main');
    expect(lab.state().activeScenario).toBe('dark-room');
  });

  it('fails a deploy with deploy_failed when the branch is missing and keeps the old child', async () => {
    const runners = fakeRunners();
    const lab = new Lab({
      runners,
      resolveRef: async (ref) => (ref === 'main' ? SHAS.main : undefined),
      prepare: async () => '/x',
      record: async (r) => ({ id: 'd-1', ...r }),
    });
    await lab.boot();
    await expect(lab.apply('fog')).rejects.toMatchObject({ status: 500, code: 'deploy_failed' });
    expect(runners.orders.deployment?.ref).toBe('main');
  });
});
