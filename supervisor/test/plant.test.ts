import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSnapshotRepo, git, plantScenarios, SCENARIO_PATCHES, SNAPSHOT_DATE, verifyPlantRecord } from '../../scripts/lab-git.mjs';

const run = promisify(execFile);
const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const runGit = git as (repo: string, args: string[], opts?: { env?: Record<string, string> }) => Promise<string>;
const runGitEnv = (repo: string, args: string[], date: string) =>
  runGit(repo, args, {
    env: { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });

/**
 * Expected SHAs for the runtime snapshot of this checkout. They change only when a runtime file
 * (services/<svc>/src, services/<svc>/package.json, packages/lab-common/src or package.json) changes.
 * When that happens on purpose, update these values together with the change.
 */
export const EXPECTED = {
  main: '377121f304ff4fd51f1a7edc7ac6b99651e97f12',
  shas: {
    'error-spike': '2b89664deaf7e2e393ff71de3c6c40c2bc2de5f4',
    fog: '83e12fd39c6e4c4ad1eaa6506a769cd55ed1bb16',
    'dark-room': '182227f4f99444ab2fc306be4cde07a4c21157b9',
  },
};

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function snapshot() {
  const dir = await mkdtemp(join(tmpdir(), 'plant-'));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  const main = await buildSnapshotRepo(CHECKOUT, repo);
  return { repo, main };
}

describe('plant-scenarios', () => {
  it('plants the three culprit commits with the exact expected SHAs', async () => {
    const { repo, main } = await snapshot();
    expect(main).toBe(EXPECTED.main);
    const planted = await plantScenarios(repo);
    expect(planted.base).toBe(EXPECTED.main);
    expect(planted.shas).toEqual(EXPECTED.shas);
  }, 30_000);

  // Feature: haunted-lab, Property 11
  it('is deterministic and idempotent: any number of runs, one commit each on main, same SHAs', async () => {
    const { repo } = await snapshot();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (runs) => {
        for (let i = 0; i < runs; i++) {
          const r = await plantScenarios(repo);
          expect(r.shas).toEqual(EXPECTED.shas);
        }
        for (const s of SCENARIO_PATCHES) {
          const sha = await runGit(repo, ['rev-parse', `refs/heads/${s.branch}`]);
          expect(sha).toBe(EXPECTED.shas[s.name as keyof typeof EXPECTED.shas]);
          expect(await runGit(repo, ['rev-list', '--count', `main..${s.branch}`])).toBe('1');
          expect(await runGit(repo, ['rev-parse', `${s.branch}^`])).toBe(EXPECTED.main);
        }
        expect(await runGit(repo, ['rev-parse', 'refs/heads/main'])).toBe(EXPECTED.main);
      }),
      { numRuns: 5 },
    );
    // A second, independent snapshot (another "machine") gives the same SHAs.
    const other = await snapshot();
    expect((await plantScenarios(other.repo)).shas).toEqual(EXPECTED.shas);
  }, 60_000);

  it('each culprit commit has its title, the fixed identity, and touches only its service', async () => {
    const { repo } = await snapshot();
    await plantScenarios(repo);
    const baseTime = Date.parse(SNAPSHOT_DATE);
    for (const s of SCENARIO_PATCHES) {
      // Dates are deterministic and after the base: base committer date + 1, 2, 3 hours.
      const when = new Date(baseTime + s.offsetHours * 3_600_000).toISOString().replace('.000Z', 'Z');
      expect(await runGit(repo, ['log', '-1', '--format=%s|%an|%ae|%aI|%cn|%cI', s.branch])).toBe(
        `${s.message}|Haunted Lab Bot|lab@example.invalid|${when}|Haunted Lab Bot|${when}`,
      );
      const parentTime = Number(await runGit(repo, ['log', '-1', '--format=%ct', `${s.branch}^`]));
      expect(Number(await runGit(repo, ['log', '-1', '--format=%ct', s.branch]))).toBe(parentTime + s.offsetHours * 3600);
      const files = (await runGit(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', s.branch])).split('\n');
      expect(files).toEqual([s.file]);
      expect(s.file.startsWith(`services/${s.service}/`)).toBe(true);
    }
    expect(await runGit(repo, ['show', '--format=', 'scenario/error-spike'])).toContain('-  if (!refund) {');
    expect(await runGit(repo, ['show', '--format=', 'scenario/dark-room'])).toContain('+      LEDGER_LISTEN_PORT');
    expect(await runGit(repo, ['show', '--format=', 'scenario/fog'])).toContain('+    await checkFreshness(sku, warehouse);');
  }, 30_000);

  it('the CLI plants into --repo and prints the SHAs', async () => {
    const { repo } = await snapshot();
    const { stdout } = await run(process.execPath, [join(CHECKOUT, 'scripts', 'plant-scenarios.mjs'), '--repo', repo]);
    expect(JSON.parse(stdout)).toMatchObject({ base: EXPECTED.main, shas: EXPECTED.shas });
    const again = await run(process.execPath, [join(CHECKOUT, 'scripts', 'plant-scenarios.mjs'), '--repo', repo]);
    expect(JSON.parse(again.stdout).changed).toEqual([]);
  }, 30_000);

  it('planted dates follow the real base, not a fixed calendar date', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plant-late-'));
    dirs.push(dir);
    const repo = join(dir, 'repo');
    await buildSnapshotRepo(CHECKOUT, repo);
    // A newer main (as after a real commit): planted commits must still be newer than it.
    const tree = await runGit(repo, ['rev-parse', 'main^{tree}']);
    const late = await runGitEnv(repo, ['commit-tree', '--no-gpg-sign', tree, '-p', 'main', '-m', 'later'], '2027-03-04T05:06:07+00:00');
    await runGit(repo, ['update-ref', 'refs/heads/main', late]);
    await plantScenarios(repo);
    for (const s of SCENARIO_PATCHES) {
      expect(await runGit(repo, ['log', '-1', '--format=%cI', s.branch])).toBe(
        new Date(Date.parse('2027-03-04T05:06:07Z') + s.offsetHours * 3_600_000).toISOString().replace('.000Z', 'Z'),
      );
    }
  }, 30_000);

  it('verifyPlantRecord accepts a main that moved on (e.g. committing the record) and rejects a stale record', async () => {
    const { repo } = await snapshot();
    const planted = await plantScenarios(repo);
    const record = { base: planted.base, shas: planted.shas };
    expect(await verifyPlantRecord(repo, record)).toEqual([]);
    const tree = await runGit(repo, ['rev-parse', 'main^{tree}']);
    const next = await runGitEnv(repo, ['commit-tree', '--no-gpg-sign', tree, '-p', 'main', '-m', 'add scenario-shas.json'], '2026-11-01T05:00:00+00:00');
    await runGit(repo, ['update-ref', 'refs/heads/main', next]);
    expect(await verifyPlantRecord(repo, record)).toEqual([]);
    expect(await verifyPlantRecord(repo, { ...record, shas: { ...record.shas, fog: 'f'.repeat(40) } })).toHaveLength(1);
    expect(await verifyPlantRecord(repo, { ...record, base: next })).not.toEqual([]);
    // A main that no longer contains the base (rewritten history) is rejected.
    const orphan = await runGitEnv(repo, ['commit-tree', '--no-gpg-sign', tree, '-m', 'rewritten'], '2026-11-01T06:00:00+00:00');
    await runGit(repo, ['update-ref', 'refs/heads/main', orphan]);
    expect((await verifyPlantRecord(repo, record))[0]).toContain('not an ancestor of main');
  }, 30_000);

  it('fails clearly when main lacks the services', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plant-empty-'));
    dirs.push(dir);
    await runGit(dir, ['init', '-q', '-b', 'main']);
    await runGit(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'empty']);
    await expect(plantScenarios(dir)).rejects.toThrow('commit the services before planting');
  });

  // Real-repo guard: once the services are on `main` and planted, scenario-shas.json must match.
  const recordFile = join(CHECKOUT, 'scripts', 'scenario-shas.json');
  // Skipped (visibly) until the services are committed to main and planted here.
  it.skipIf(!existsSync(recordFile))('this repo: scenario branches match scripts/scenario-shas.json', async () => {
    const record = JSON.parse(readFileSync(recordFile, 'utf8')) as { base: string; shas: Record<string, string> };
    // Not `main === base`: committing scenario-shas.json itself moves main.
    expect(await verifyPlantRecord(CHECKOUT, record)).toEqual([]);
  });
});
