import { appendFile, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { DeployLog, readDeployFile, readDeployTail } from '../src/deploys.ts';
import { revParseBranch } from '../src/git.ts';
import { reachableCommit } from '../src/observability.ts';
import { ALLOW_LIST } from '../src/refs.ts';
import { SERVICES, type DeployRecord } from '../src/types.ts';
import { ensureWorktree, FIX_WORKTREE_MAX_IDLE_MS, planWorktreeCleanup, removeSourceWorktrees } from '../src/worktrees.ts';
import { labRepoChoice } from '../../scripts/lab-git.mjs';
import { CHECKOUT, cuidRef, makeFixture, REFUNDS, runGit } from './fix-origin.ts';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
const exists = (p: string) => lstat(p).then(() => true, () => false);

describe('worktree cleanup plan', () => {
  // Feature: fix-deploy, Property 7
  it('removes inactive named worktrees, inactive fix worktrees idle > 1 h, and nothing else', () => {
    const heads = ['1'.repeat(40), '2'.repeat(40)];
    const sha = fc.oneof(fc.constantFrom(...heads), fc.stringMatching(/^[0-9a-f]{40}$/));
    const entryArb = fc.oneof(
      fc.record({ service: fc.constantFrom(...SERVICES), sha, age: fc.integer({ min: 0, max: 3 * FIX_WORKTREE_MAX_IDLE_MS }) }).map((e) => ({ name: `${e.service}@${e.sha}`, age: e.age })),
      fc.record({ name: fc.constantFrom('..', 'notes', 'gate@abc', '../payments@' + '1'.repeat(40)), age: fc.nat() }),
    );
    fc.assert(
      fc.property(fc.uniqueArray(entryArb, { selector: (e) => e.name, maxLength: 12 }), fc.array(fc.nat(11), { maxLength: 4 }), (entries, activeIdx) => {
        const now = 10 * FIX_WORKTREE_MAX_IDLE_MS;
        const active = new Set(activeIdx.map((i) => entries[i]?.name).filter((n): n is string => n !== undefined));
        const plan = planWorktreeCleanup({ entries: entries.map((e) => ({ name: e.name, mtimeMs: now - e.age })), active, allowedHeads: heads, now });
        for (const e of entries) {
          const valid = /^(gate|orders|payments|ledger)@[0-9a-f]{40}$/.test(e.name);
          const fix = valid && !heads.includes(e.name.split('@')[1] as string);
          const expected = valid && !active.has(e.name) && (!fix || e.age > FIX_WORKTREE_MAX_IDLE_MS);
          expect(plan.includes(e.name), e.name).toBe(expected);
        }
        expect(plan.every((n) => !n.includes('/'))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('removes lab worktrees still registered to the source checkout and prunes it', async () => {
    const fx = await makeFixture();
    dirs.push(fx.dir);
    const root = join(fx.dir, 'worktrees');
    await ensureWorktree({ repo: fx.source, root, depsDir: CHECKOUT }, 'gate', fx.heads.main);
    await mkdir(join(root, 'notes'), { recursive: true });
    expect((await runGit(fx.source, ['worktree', 'list'])).split('\n')).toHaveLength(2);
    expect(await removeSourceWorktrees(fx.source, root)).toEqual([`gate@${fx.heads.main}`]);
    expect((await runGit(fx.source, ['worktree', 'list'])).split('\n')).toHaveLength(1);
    expect(await exists(join(root, `gate@${fx.heads.main}`))).toBe(false);
    expect(await exists(join(root, 'notes'))).toBe(true);
  }, 30_000);
});

describe('deploy log tail', () => {
  const rec = (i: number): DeployRecord => ({ id: `d-${101 + i}`, service: SERVICES[i % 4] as DeployRecord['service'], ref: 'main', sha: `${i % 10}`.repeat(40), time: '2026-11-13T00:00:00.000Z', actor: 'chaos' });

  // Feature: fix-deploy, Property 10
  it('opening from the tail matches a full read for any content and chunk size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tail-'));
    dirs.push(dir);
    let n = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof({ weight: 5, arbitrary: fc.constant('rec' as const) }, fc.constantFrom('junk', '{"id":"d-x"}', '', '{"half":')), { maxLength: 60 }),
        fc.boolean(),
        fc.integer({ min: 16, max: 600 }),
        fc.integer({ min: 1, max: 30 }),
        async (lines, partialLast, chunk, tail) => {
          const file = join(dir, `log-${n++}.jsonl`);
          let i = 0;
          const text = lines.map((l) => (l === 'rec' ? JSON.stringify(rec(i++)) : l)).join('\n') + (lines.length ? '\n' : '');
          await writeFile(file, text + (partialLast ? '{"id":"d-9' : ''));
          const full = await readDeployFile(file);
          const { records } = await readDeployTail(file, tail, chunk, 1024 * 1024);
          expect(records).toEqual(full.slice(Math.max(0, full.length - tail)));
          const log = await DeployLog.open(file, tail);
          const next = await log.append({ service: 'gate', ref: 'main', sha: 'a'.repeat(40), time: '2026-11-14T00:00:00.000Z', actor: 'chaos' });
          expect(next.id).toBe(`d-${101 + full.length}`);
        },
      ),
      { numRuns: 120 },
    );
  });

  it('reads only the end of a large file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tail-big-'));
    dirs.push(dir);
    const file = join(dir, 'deploys.jsonl');
    const body = Array.from({ length: 20_000 }, (_, i) => JSON.stringify(rec(i))).join('\n') + '\n';
    await writeFile(file, body);
    await appendFile(file, 'garbage\n');
    const { records, bytesRead } = await readDeployTail(file, 10);
    expect(records.at(-1)?.id).toBe('d-20100');
    expect(bytesRead).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(body)).toBeGreaterThan(2 * 1024 * 1024);
    const { id: _id, ...next } = rec(0);
    expect((await (await DeployLog.open(file)).append(next)).id).toBe('d-20101');
  });
});

describe('diff reachability with incident refs', () => {
  // Feature: fix-deploy, Property 8
  it('serves a commit iff it is reachable from a named head or a fetched incident ref', async () => {
    const fx = await makeFixture();
    dirs.push(fx.dir);
    const good = await fx.commit([fx.heads['error-spike']], { [REFUNDS]: await fx.mainFile(REFUNDS) }, 'fix');
    const unrelated = await fx.commit([fx.heads.fog], { 'services/orders/src/x.ts': '1\n' }, 'not fetched');
    await fx.setRef(cuidRef(1), good);
    const all = [...Object.values(fx.heads), good, unrelated];
    const reachable = new Set([...Object.values(fx.heads), good, (await runGit(fx.origin, ['rev-list', '--all'])).split('\n')].flat());
    reachable.delete(unrelated);
    const repo = fx.origin;
    const deps = {
      repo,
      resolveRef: (ref: string) => (ALLOW_LIST.includes(ref) ? revParseBranch(repo, ref) : Promise.resolve(undefined)),
      incidentTips: async () => [good],
    };
    const nameArb = fc.oneof(
      fc.constantFrom(...all).chain((s) => fc.integer({ min: 7, max: 40 }).map((n) => s.slice(0, n))),
      fc.stringMatching(/^[0-9a-f]{7,40}$/),
      fc.constantFrom('main', 'HEAD', `${good}^`, '--all'),
    );
    await fc.assert(
      fc.asyncProperty(nameArb, async (name) => {
        const got = await reachableCommit(deps, name);
        const full = all.find((c) => /^[0-9a-f]{7,40}$/.test(name) && c.startsWith(name));
        expect(got).toBe(full && reachable.has(full) ? full : undefined);
      }),
      { numRuns: 60 },
    );
    expect(await reachableCommit({ ...deps, incidentTips: async () => [] }, good)).toBeUndefined();
  }, 120_000);
});

describe('gate repo choice', () => {
  it('this checkout uses its real scenario branches when scenario-shas.json verifies', async () => {
    const choice = await labRepoChoice(resolve(CHECKOUT));
    if (await exists(join(CHECKOUT, 'scripts', 'scenario-shas.json'))) expect(choice).toEqual({ mode: 'branches', reason: 'scenario branches match scripts/scenario-shas.json' });
    const fx = await makeFixture();
    dirs.push(fx.dir);
    expect((await labRepoChoice(fx.source)).mode).toBe('snapshot');
  }, 30_000);
});
