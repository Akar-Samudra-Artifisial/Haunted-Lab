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

describe('Lab.deployFix', () => {
  const REF = 'incident/c000000000000000000000001';
  const FIX = 'f'.repeat(40);

  function fixLab() {
    const runners = fakeRunners();
    const records: DeployRecord[] = [];
    const retired: { ref: string; fix: boolean }[] = [];
    let afterDeploys = 0;
    const lab = new Lab({
      runners,
      resolveRef: async (ref) => SHAS[ref],
      prepare: async (service, sha) => `/wt/${service}@${sha}/services/${service}`,
      record: async (r) => {
        const full = { id: `d-${200 + records.length}`, ...r };
        records.push(full);
        return full;
      },
      retire: async (_s, old) => {
        retired.push({ ref: old.ref, fix: old.fix === true });
      },
      afterDeploy: async () => {
        afterDeploys++;
      },
      findDeploy: (service, ref, sha) => [...records].reverse().find((r) => r.service === service && r.ref === ref && r.sha === sha),
    });
    return { lab, runners, records, retired, afterDeploys: () => afterDeploys };
  }

  it('deploys as exorcist with the fix flag, then apply and reset replace it', async () => {
    const { lab, runners, records, retired, afterDeploys } = fixLab();
    await lab.boot();
    await lab.apply('error-spike');
    const out = await lab.deployFix('payments', REF, FIX, async () => FIX);
    expect(out.deployed).toBe(true);
    expect(out.record).toMatchObject({ service: 'payments', ref: REF, sha: FIX, actor: 'exorcist' });
    expect(runners.payments.deployment).toMatchObject({ ref: REF, sha: FIX, fix: true });
    expect(runners.orders.deployment?.ref).toBe('main');
    expect(retired.at(-1)).toEqual({ ref: 'scenario/error-spike', fix: false });
    // Same ref at the same sha: existing record, no restart.
    const again = await lab.deployFix('payments', REF, FIX, async () => FIX);
    expect(again).toEqual({ record: out.record, deployed: false });
    expect(runners.payments.deploys).toHaveLength(3);
    await lab.reset();
    expect(runners.payments.deployment?.ref).toBe('main');
    expect(retired.at(-1)).toEqual({ ref: REF, fix: true });
    expect(records.filter((r) => r.actor === 'exorcist')).toHaveLength(1);
    expect(afterDeploys()).toBe(records.length);
  });

  it('refuses a head that moved before the mutex (409 not_head) and non-incident refs', async () => {
    const { lab, runners } = fixLab();
    await lab.boot();
    await expect(lab.deployFix('payments', REF, FIX, async () => 'e'.repeat(40))).rejects.toMatchObject({ status: 409, code: 'not_head' });
    await expect(lab.deployFix('payments', 'main', FIX, async () => FIX)).rejects.toMatchObject({ status: 400 });
    expect(runners.payments.deployment?.ref).toBe('main');
  });

  it('a failed prepare is 503 deploy_failed and keeps the previous child', async () => {
    const runners = fakeRunners();
    const lab = new Lab({
      runners,
      resolveRef: async (ref) => SHAS[ref],
      prepare: async (service, sha) => {
        if (sha === FIX) throw new Error('worktree add failed');
        return `/wt/${service}@${sha}/services/${service}`;
      },
      record: async (r) => ({ id: 'd-1', ...r }),
    });
    await lab.boot();
    await expect(lab.deployFix('payments', REF, FIX, async () => FIX)).rejects.toMatchObject({ status: 503, code: 'deploy_failed' });
    expect(runners.payments.deployment?.ref).toBe('main');
  });

  it('serializes with apply and reset', async () => {
    const { lab, runners } = fixLab();
    await lab.boot();
    await Promise.all([lab.apply('error-spike'), lab.deployFix('payments', REF, FIX, async () => FIX), lab.reset()]);
    expect(runners.payments.deployment?.ref).toBe('main');
  });
});
