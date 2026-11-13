import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from '@haunted-lab/common';
import { revParseBranch } from '../src/git.ts';
import { ALLOW_LIST } from '../src/refs.ts';
import { capList, capText, DIFF_CAP_BYTES, LIST_CAP_BYTES, parseLabQuery, reachableCommit, repoRelative } from '../src/observability.ts';
import { git } from '../../scripts/lab-git.mjs';

const runGit = git as (repo: string, args: string[], opts?: { env?: Record<string, string>; input?: string }) => Promise<string>;

describe('parseLabQuery', () => {
  const valueArb = fc.oneof(
    fc.constantFrom('gate', 'orders', 'payments', 'ledger', 'Gate', '', '1', '500', '501', '0', '-1', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00.123+02:00', '2026-13-40T00:00:00Z', 'yesterday', '1e2'),
    fc.string({ maxLength: 30 }),
  );
  const paramsArb = fc.array(fc.tuple(fc.constantFrom('service', 'since', 'limit', 'other'), valueArb), { maxLength: 4 });

  // Feature: haunted-lab, Property 7
  it('returns a valid query or a bad_request error, and never throws anything else', () => {
    fc.assert(
      fc.property(paramsArb, (pairs) => {
        const q = new URLSearchParams(pairs);
        try {
          const out = parseLabQuery(q);
          expect(out.limit).toBeGreaterThanOrEqual(1);
          expect(out.limit).toBeLessThanOrEqual(500);
          if (!q.has('limit')) expect(out.limit).toBe(100);
          if (out.service) expect(['gate', 'orders', 'payments', 'ledger']).toContain(out.service);
          if (out.since) expect(Number.isNaN(out.since.getTime())).toBe(false);
          expect(q.has('other')).toBe(false);
        } catch (e) {
          expect(e).toBeInstanceOf(HttpError);
          expect((e as HttpError).status).toBe(400);
          expect((e as HttpError).code).toBe('bad_request');
        }
      }),
      { numRuns: 1000 },
    );
    expect(parseLabQuery(new URLSearchParams('service=orders')).limit).toBe(100);
  });
});

describe('caps', () => {
  // Feature: haunted-lab, Property 8
  it('lists fit in 256 KiB, keep the newest items in order, and flag truncation exactly', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ time: fc.string({ maxLength: 5 }), line: fc.string({ maxLength: 3000 }) }), { maxLength: 300 }), (items) => {
        const out = capList(items);
        expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(LIST_CAP_BYTES);
        expect(out.items).toEqual(items.slice(items.length - out.items.length));
        expect(out.truncated).toBe(out.items.length < items.length);
        if (!out.truncated) expect(out.items.length).toBe(items.length);
      }),
      { numRuns: 100 },
    );
    const big = Array.from({ length: 200 }, (_, i) => ({ i, line: 'x'.repeat(2000) }));
    const out = capList(big);
    expect(out.truncated).toBe(true);
    expect(out.items.at(-1)?.i).toBe(199);
  });

  // Feature: haunted-lab, Property 8
  it('diffs are a prefix of at most 64 KiB on a character boundary', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 30_000 }), fc.integer({ min: 1, max: 4 }), (s, rep) => {
        const text = s.repeat(rep);
        const buf = Buffer.from(text, 'utf8');
        const out = capText(buf);
        expect(out.bytes).toBeLessThanOrEqual(DIFF_CAP_BYTES);
        expect(Buffer.byteLength(out.text)).toBe(out.bytes);
        expect(text.startsWith(out.text)).toBe(true);
        expect(out.truncated).toBe(buf.length > DIFF_CAP_BYTES);
        expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('rewrites local worktree paths to repo paths', () => {
    expect(repoRelative('at refundTerms (file:///private/tmp/x/wt/payments@abc/services/payments/src/refunds.ts:31:31)')).toBe(
      'at refundTerms (services/payments/src/refunds.ts:31:31)',
    );
  });
});

describe('reachableCommit', () => {
  let repo = '';
  const commits: Record<string, string> = {};
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };

  async function commit(name: string, parents: string[]) {
    const tree = await runGit(repo, ['mktree'], { input: '' });
    const args = ['commit-tree', '--no-gpg-sign', tree, ...parents.flatMap((p) => ['-p', p]), '-m', name];
    commits[name] = await runGit(repo, args, { env: { ...env, GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z' } });
    return commits[name];
  }

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'reach-'));
    await runGit(repo, ['init', '-q', '-b', 'main']);
    const root = await commit('root', []);
    const m1 = await commit('m1', [root]);
    await runGit(repo, ['update-ref', 'refs/heads/main', m1]);
    await runGit(repo, ['update-ref', 'refs/heads/scenario/fog', await commit('fog', [m1])]);
    await runGit(repo, ['update-ref', 'refs/heads/scenario/error-spike', await commit('spike', [m1])]);
    await runGit(repo, ['update-ref', 'refs/heads/secret', await commit('secret', [m1])]);
    await runGit(repo, ['update-ref', 'refs/heads/exorcist/fix-1', await commit('fix', [m1])]);
    await commit('dangling', [root]);
  }, 30_000);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Feature: haunted-lab, Property 9
  it('serves a commit iff it is a 7-40 hex name reachable from an allow-listed ref', async () => {
    const reachable = new Set(['root', 'm1', 'fog', 'spike'].map((n) => commits[n]));
    const deps = { repo, resolveRef: (ref: string) => (ALLOW_LIST.includes(ref) ? revParseBranch(repo, ref) : Promise.resolve(undefined)) };
    const nameArb = fc.oneof(
      fc.constantFrom(...Object.values(commits)).chain((sha) => fc.integer({ min: 4, max: 40 }).map((n) => sha.slice(0, n))),
      fc.constantFrom(...Object.values(commits)).map((s) => s.toUpperCase()),
      fc.stringMatching(/^[0-9a-f]{7,40}$/),
      fc.constantFrom('main', 'HEAD', 'main~1', 'secret', `${commits.m1}^`, '--all', '../x'),
      fc.string({ maxLength: 45 }),
    );
    await fc.assert(
      fc.asyncProperty(nameArb, async (name) => {
        const got = await reachableCommit(deps, name);
        const full = Object.values(commits).find((c) => /^[0-9a-fA-F]{7,40}$/.test(name) && c.startsWith(name.toLowerCase()));
        const expected = full && reachable.has(full) ? full : undefined;
        expect(got).toBe(expected);
      }),
      { numRuns: 120 },
    );
  }, 60_000);
});
