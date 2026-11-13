import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError } from '@haunted-lab/common';
import { loadSupervisorConfig } from '../src/config.ts';
import { BACKOFF_CAP_MS, BACKOFF_START_MS, CHILD_ENV_NAMES, childEnv, nextDelay, ServiceRunner } from '../src/runner.ts';
import { SERVICES } from '../src/types.ts';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function fakeService(code: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'runner-'));
  dirs.push(dir);
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'main.ts'), code);
  return dir;
}

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('nextDelay', () => {
  // Feature: haunted-lab, Property 6
  it('starts at 500 ms, never decreases, is capped at 30 s', () => {
    expect(nextDelay(1)).toBe(BACKOFF_START_MS);
    expect(nextDelay(0)).toBe(BACKOFF_START_MS);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (n) => {
        const d = nextDelay(n);
        expect(d).toBeGreaterThanOrEqual(BACKOFF_START_MS);
        expect(d).toBeLessThanOrEqual(BACKOFF_CAP_MS);
        expect(nextDelay(n + 1)).toBeGreaterThanOrEqual(d);
      }),
      { numRuns: 500 },
    );
    expect(nextDelay(7)).toBe(BACKOFF_CAP_MS);
  });

  // Feature: haunted-lab, Property 6
  it('restarts a crashing child with growing delays and resets after a stable run', async () => {
    const dir = await fakeService(`
      const fs = await import('node:fs');
      const marker = new URL('../marker', import.meta.url);
      const n = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;
      fs.writeFileSync(marker, String(n + 1));
      process.stderr.write('boom ' + n + '\\n');
      if (n < 3) process.exit(1);
      setInterval(() => {}, 1000);
    `);
    const delays: number[] = [];
    const runner = new ServiceRunner({
      service: 'ledger',
      env: {},
      stableAfterMs: 3000, // well above child start-up time under parallel load
      delay: (n) => {
        delays.push(nextDelay(n));
        return 10 * n; // keep the test fast; the schedule itself is checked above
      },
    });
    await runner.deploy({ ref: 'main', sha: 'a'.repeat(40), dir });
    await waitFor(() => runner.state().restarts === 3 && runner.state().status === 'running');
    expect(delays).toEqual([500, 1000, 2000]);
    expect(runner.exits().map((e) => e.message)).toEqual([
      'ledger exited with code 1: boom 0',
      'ledger exited with code 1: boom 1',
      'ledger exited with code 1: boom 2',
    ]);
    await waitFor(() => runner.failures === 0, 8000);
    expect(runner.logs().some((l) => l.stream === 'stderr' && l.line === 'boom 3')).toBe(true);
    await runner.stop();
    expect(runner.state().status).toBe('stopped');
  });

  it('stops with SIGTERM and keeps output across restarts', async () => {
    const dir = await fakeService(`console.log('up'); setInterval(() => {}, 1000);`);
    const runner = new ServiceRunner({ service: 'gate', env: {} });
    await runner.deploy({ ref: 'main', sha: 'a'.repeat(40), dir });
    await waitFor(() => runner.logs().length === 1);
    await runner.deploy({ ref: 'main', sha: 'b'.repeat(40), dir });
    await waitFor(() => runner.logs().length === 2);
    expect(runner.state()).toMatchObject({ sha: 'b'.repeat(40), status: 'running', restarts: 0 });
    await runner.stop();
  });
});

describe('child env and config', () => {
  // Feature: haunted-lab, Property 13
  it('gives each child only its fixed env names, never a token', () => {
    fc.assert(
      fc.property(
        fc.record({ gate: fc.integer({ min: 1, max: 65535 }), orders: fc.integer({ min: 1, max: 65535 }), payments: fc.integer({ min: 1, max: 65535 }), ledger: fc.integer({ min: 1, max: 65535 }) }),
        fc.constantFrom('127.0.0.1', '0.0.0.0', '10.0.0.5'),
        fc.constantFrom(...SERVICES),
        (ports, host, service) => {
          const env = childEnv(service, ports, host);
          expect(Object.keys(env).sort()).toEqual([...CHILD_ENV_NAMES[service]].sort());
          expect(JSON.stringify(env)).not.toMatch(/TOKEN/);
        },
      ),
    );
  });

  // Feature: haunted-lab, Property 13
  it('never echoes env values in config errors', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 15 }), fc.string({ minLength: 1, maxLength: 40 }), (shortToken, other) => {
        const chaos = `§${shortToken}`.slice(0, 15);
        try {
          loadSupervisorConfig({ CHAOS_TOKEN: chaos, LAB_READ_TOKEN: `¶${other}`.padEnd(16, 'x'), TRAFFIC_RPS: '7a' });
          expect.unreachable();
        } catch (e) {
          expect(e).toBeInstanceOf(ConfigError);
          expect((e as Error).message).not.toContain(chaos);
          expect((e as Error).message).not.toContain(`¶${other}`);
          expect((e as Error).message).toMatch(/TRAFFIC_RPS/);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('requires both tokens of at least 16 characters', () => {
    expect(() => loadSupervisorConfig({})).toThrow('missing required env: CHAOS_TOKEN, LAB_READ_TOKEN');
    expect(() => loadSupervisorConfig({ CHAOS_TOKEN: 'short', LAB_READ_TOKEN: 'x'.repeat(16) })).toThrow('invalid env: CHAOS_TOKEN');
    // The .env.example placeholders are refused, in any case.
    expect(() => loadSupervisorConfig({ CHAOS_TOKEN: 'change-me-chaos-token', LAB_READ_TOKEN: 'r'.repeat(16) })).toThrow('invalid env: CHAOS_TOKEN');
    expect(() => loadSupervisorConfig({ CHAOS_TOKEN: 'c'.repeat(16), LAB_READ_TOKEN: 'Change-Me-read-token-x' })).toThrow('invalid env: LAB_READ_TOKEN');
    // One token must not open both prefixes; the error names variables, never the value.
    const same = 's3cret-shared-token-value';
    try {
      loadSupervisorConfig({ CHAOS_TOKEN: same, LAB_READ_TOKEN: same });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toBe('CHAOS_TOKEN and LAB_READ_TOKEN must be different');
      expect((e as Error).message).not.toContain(same);
    }
    const ok = loadSupervisorConfig({ CHAOS_TOKEN: 'c'.repeat(16), LAB_READ_TOKEN: 'r'.repeat(16) });
    expect(ok).toMatchObject({ port: 4100, trafficRps: 5, bindHost: '127.0.0.1', ports: { gate: 4001, orders: 4002, payments: 4003, ledger: 4004 } });
  });
});
