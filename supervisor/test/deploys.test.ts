import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { DeployLog, readDeployFile } from '../src/deploys.ts';
import { SERVICES } from '../src/types.ts';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const recordArb = fc.record({
  service: fc.constantFrom(...SERVICES),
  ref: fc.constantFrom('main', 'scenario/fog', 'scenario/error-spike', 'scenario/dark-room'),
  sha: fc.stringMatching(/^[0-9a-f]{40}$/),
  time: fc.date({ min: new Date('2026-01-01T00:00:00Z'), max: new Date('2027-01-01T00:00:00Z'), noInvalidDate: true }).map((d) => d.toISOString()),
  actor: fc.constantFrom('supervisor' as const, 'chaos' as const),
});

describe('DeployLog', () => {
  // Feature: haunted-lab, Property 5
  it('assigns unique increasing ids from d-101, only grows, and resumes after restart', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(recordArb, { maxLength: 15 }), fc.nat(15), async (records, cut) => {
        const dir = await mkdtemp(join(tmpdir(), 'deploys-'));
        dirs.push(dir);
        const file = join(dir, 'data', 'deploys.jsonl');
        let log = await DeployLog.open(file);
        const written = [];
        let lastSize = 0;
        for (const [i, r] of records.entries()) {
          if (i === cut) log = await DeployLog.open(file); // restart
          written.push(await log.append(r));
          const size = (await stat(file)).size;
          expect(size).toBeGreaterThan(lastSize);
          lastSize = size;
        }
        const ids = written.map((w) => Number(w.id.slice(2)));
        expect(ids).toEqual(records.map((_, i) => 101 + i));
        expect(await readDeployFile(file)).toEqual(written);
        expect((await DeployLog.open(file)).records()).toEqual(written);
        expect(log.records()).toEqual(written.slice(written.length - log.records().length));
        const extra = { service: 'ledger' as const, ref: 'main', sha: 'b'.repeat(40), time: '2026-11-13T00:00:00.000Z', actor: 'chaos' as const };
        const next = await (await DeployLog.open(file)).append(extra);
        expect(next.id).toBe(`d-${101 + records.length}`);
      }),
      { numRuns: 100 },
    );
  });

  it('serializes concurrent appends and skips malformed lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deploys-'));
    dirs.push(dir);
    const file = join(dir, 'deploys.jsonl');
    const log = await DeployLog.open(file);
    const base = { service: 'gate' as const, ref: 'main', sha: 'a'.repeat(40), time: '2026-11-13T00:00:00.000Z', actor: 'chaos' as const };
    const out = await Promise.all(Array.from({ length: 20 }, () => log.append(base)));
    expect(new Set(out.map((o) => o.id)).size).toBe(20);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, 'not json\n');
    const again = await DeployLog.open(file);
    expect(again.records().length).toBe(20);
    expect((await again.append(base)).id).toBe('d-121');
    expect((await readFile(file, 'utf8')).split('\n').filter(Boolean)).toHaveLength(22);
  });

  it('serves reads from a bounded in-memory tail, not by re-reading the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deploys-'));
    dirs.push(dir);
    const file = join(dir, 'deploys.jsonl');
    const log = await DeployLog.open(file, 5);
    const base = { service: 'orders' as const, ref: 'main', sha: 'c'.repeat(40), time: '2026-11-13T00:00:00.000Z', actor: 'chaos' as const };
    for (let i = 0; i < 8; i++) await log.append(base);
    expect(log.records().map((r) => r.id)).toEqual(['d-104', 'd-105', 'd-106', 'd-107', 'd-108']);
    // A line written behind the log's back is not picked up: reads never touch the file.
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, `${JSON.stringify({ ...base, id: 'd-999' })}\n`);
    expect(log.records().at(-1)?.id).toBe('d-108');
    expect((await readDeployFile(file)).length).toBe(9);
  });
});
