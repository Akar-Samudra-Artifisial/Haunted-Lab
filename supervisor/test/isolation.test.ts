import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError } from '@haunted-lab/common';
import { loadSupervisorConfig } from '../src/config.ts';
import { FIX_PATH, fixChildArgs, fixChildEnv, fixSpawnPlan, resolveFixUser } from '../src/isolation.ts';
import { labMarker } from '../src/pids.ts';
import { ServiceRunner } from '../src/runner.ts';
import { SERVICES } from '../src/types.ts';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const portsArb = fc.record({
  gate: fc.integer({ min: 1, max: 65535 }),
  orders: fc.integer({ min: 1, max: 65535 }),
  payments: fc.integer({ min: 1, max: 65535 }),
  ledger: fc.integer({ min: 1, max: 65535 }),
});
const OWN: Record<string, string[]> = {
  gate: ['GATE_PORT', 'ORDERS_URL'],
  orders: ['ORDERS_PORT', 'PAYMENTS_URL'],
  payments: ['PAYMENTS_PORT', 'LEDGER_URL'],
  ledger: ['LEDGER_PORT'],
};

describe('fix child env', () => {
  // Feature: fix-deploy, Property 5
  it('is exactly the whitelist, whatever the supervisor env holds', () => {
    fc.assert(
      fc.property(portsArb, fc.constantFrom('127.0.0.1', '0.0.0.0'), fc.constantFrom(...SERVICES), fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), fc.string({ minLength: 8, maxLength: 30 })), (ports, host, service, supEnv) => {
        const before = { ...process.env };
        Object.assign(process.env, supEnv, { CHAOS_TOKEN: 'chaos-secret-value-123', LAB_READ_TOKEN: 'read-secret-value-1234' });
        try {
          const env = fixChildEnv(service, ports, host);
          expect(Object.keys(env).sort()).toEqual([...OWN[service] as string[], 'NODE_ENV', 'PATH', 'SERVICE_BIND_HOST'].sort());
          expect(env).toMatchObject({ NODE_ENV: 'production', PATH: FIX_PATH, SERVICE_BIND_HOST: host });
          const values = Object.values(env);
          for (const v of [...Object.values(supEnv), 'chaos-secret-value-123', 'read-secret-value-1234']) {
            if (!/^[\d.:/a-z_-]*$/i.test(v) || v.length > 20) expect(values).not.toContain(v);
          }
          expect(JSON.stringify(env)).not.toMatch(/secret-value/);
        } finally {
          for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
          Object.assign(process.env, before);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('fix child argv', () => {
  // Feature: fix-deploy, Property 6
  it('has --permission, exactly the four fs-read paths and --allow-net, and no other --allow flag', () => {
    const seg = fc.stringMatching(/^[A-Za-z0-9_@-][A-Za-z0-9._@-]{0,11}$/);
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 4 }), fc.array(seg, { minLength: 1, maxLength: 4 }), fc.constantFrom(...SERVICES), (w, s, service) => {
        const worktree = `/${w.join('/')}`;
        const source = `/${s.join('/')}`;
        const args = fixChildArgs(worktree, source, service);
        expect(args[0]).toBe('--permission');
        const reads = args.filter((a) => a.startsWith('--allow-fs-read='));
        expect(reads).toEqual([
          `--allow-fs-read=${worktree}`,
          `--allow-fs-read=${source}/node_modules`,
          `--allow-fs-read=${source}/services/${service}/node_modules`,
          `--allow-fs-read=${source}/packages/lab-common`,
        ]);
        const allows = args.filter((a) => a.startsWith('--allow-'));
        expect(allows.filter((a) => !a.startsWith('--allow-fs-read='))).toEqual(['--allow-net']);
        expect(args.slice(-2)).toEqual(['src/main.ts', labMarker(service)]);
      }),
      { numRuns: 300 },
    );
  });

  it('adds uid and gid only when a fix user is given (argument building only on the Mac)', () => {
    const common = { service: 'payments' as const, worktree: '/w', source: '/s', ports: { gate: 1, orders: 2, payments: 3, ledger: 4 }, bindHost: '127.0.0.1' };
    expect(fixSpawnPlan(common)).not.toHaveProperty('uid');
    expect(fixSpawnPlan({ ...common, user: { name: 'labfix', uid: 1500, gid: 1500 } })).toMatchObject({ uid: 1500, gid: 1500 });
  });
});

describe('FIX_RUN_AS_USER', () => {
  const ids = (uid: string, gid: string) => async (args: string[]) => (args[0] === '-u' ? uid : gid);

  it('resolves a valid user and refuses bad names, unknown users, root and the own uid', async () => {
    await expect(resolveFixUser('labfix', ids('1500', '1600'), 501)).resolves.toEqual({ name: 'labfix', uid: 1500, gid: 1600 });
    for (const name of ['root;rm', '-u', 'Lab', '', 'x'.repeat(33), '../x']) {
      await expect(resolveFixUser(name, ids('1500', '1500'), 501)).rejects.toBeInstanceOf(ConfigError);
    }
    await expect(resolveFixUser('labfix', ids('0', '1500'), 501)).rejects.toThrow('invalid env: FIX_RUN_AS_USER');
    await expect(resolveFixUser('labfix', ids('501', '20'), 501)).rejects.toThrow('invalid env: FIX_RUN_AS_USER');
    await expect(resolveFixUser('labfix', async () => Promise.reject(new Error('no such user')), 501)).rejects.toThrow('FIX_RUN_AS_USER');
    let seen: string[] = [];
    await resolveFixUser('labfix', async (a) => {
      seen = a;
      return '1500';
    }, 501);
    expect(seen).toEqual(['-g', '--', 'labfix']);
  });

  it('config validates the name and the origin URL, naming variables only', () => {
    const base = { CHAOS_TOKEN: 'c'.repeat(16), LAB_READ_TOKEN: 'r'.repeat(16) };
    expect(loadSupervisorConfig(base)).not.toHaveProperty('fixUser');
    expect(loadSupervisorConfig({ ...base, FIX_RUN_AS_USER: 'labfix' }).fixUser).toBe('labfix');
    expect(() => loadSupervisorConfig({ ...base, FIX_RUN_AS_USER: 'bad name' })).toThrow('invalid env: FIX_RUN_AS_USER');
    expect(loadSupervisorConfig(base).originUrl).toBe('https://github.com/Akar-Samudra-Artifisial/Haunted-Lab.git');
    expect(() => loadSupervisorConfig({ ...base, LAB_ORIGIN_URL: 'http://example.com/x.git' })).toThrow('invalid env: LAB_ORIGIN_URL');
    expect(() => loadSupervisorConfig({ ...base, LAB_ORIGIN_URL: 'file:///tmp/x.git' })).toThrow('LAB_ORIGIN_URL');
    expect(loadSupervisorConfig({ ...base, LAB_ORIGIN_URL: 'file:///tmp/x.git', LAB_ALLOW_FILE_ORIGIN: '1' }).allowFileOrigin).toBe(true);
  });
});

describe('a real fix child', () => {
  it('cannot see the supervisor tokens in its env, read outside its paths, or spawn', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'fixchild-')));
    dirs.push(root);
    const worktree = join(root, 'payments@x');
    const dir = join(worktree, 'services', 'payments');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(root, 'outside.txt'), 'outside');
    await writeFile(
      join(dir, 'src', 'main.ts'),
      `import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const r: Record<string, unknown> = { env: process.env };
try { readFileSync(${JSON.stringify(join(root, 'outside.txt'))}, 'utf8'); r.read = 'allowed'; } catch (e) { r.read = (e as { code?: string }).code; }
try { readFileSync('/proc/' + process.ppid + '/environ', 'utf8'); r.proc = 'allowed'; } catch (e) { r.proc = (e as { code?: string }).code; }
try { execFileSync('/bin/echo', ['x']); r.spawn = 'allowed'; } catch (e) { r.spawn = (e as { code?: string }).code; }
console.log('RESULT ' + JSON.stringify(r));
setInterval(() => {}, 1000);
`,
    );
    const saved = { c: process.env.CHAOS_TOKEN, r: process.env.LAB_READ_TOKEN };
    process.env.CHAOS_TOKEN = 'chaos-token-must-not-leak-1';
    process.env.LAB_READ_TOKEN = 'read-token-must-not-leak-12';
    const ports = { gate: 1, orders: 2, payments: 3, ledger: 4 };
    const runner = new ServiceRunner({
      service: 'payments',
      env: { CHAOS_TOKEN: process.env.CHAOS_TOKEN }, // the named-child env must not be used for a fix
      fixPlan: () => fixSpawnPlan({ service: 'payments', worktree, source: root, ports, bindHost: '127.0.0.1' }),
    });
    try {
      await runner.deploy({ ref: 'incident/c000000000000000000000001', sha: 'a'.repeat(40), dir, fix: true });
      const end = Date.now() + 10_000;
      while (!runner.logs().some((l) => l.line.startsWith('RESULT ')) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      const line = runner.logs().find((l) => l.line.startsWith('RESULT '))?.line ?? '';
      const result = JSON.parse(line.slice('RESULT '.length)) as { env: Record<string, string>; read: string; proc: string; spawn: string };
      expect(JSON.stringify(result.env)).not.toContain('must-not-leak');
      expect(result.env).not.toHaveProperty('CHAOS_TOKEN');
      expect(result.env).not.toHaveProperty('LAB_READ_TOKEN');
      expect(result.env).toMatchObject({ PAYMENTS_PORT: '3', NODE_ENV: 'production', PATH: FIX_PATH });
      expect(result.read).toBe('ERR_ACCESS_DENIED');
      expect(result.proc).toBe('ERR_ACCESS_DENIED');
      expect(result.spawn).toBe('ERR_ACCESS_DENIED');
    } finally {
      await runner.stop();
      process.env.CHAOS_TOKEN = saved.c;
      process.env.LAB_READ_TOKEN = saved.r;
      if (saved.c === undefined) delete process.env.CHAOS_TOKEN;
      if (saved.r === undefined) delete process.env.LAB_READ_TOKEN;
    }
  }, 20_000);

  it('a runner without a fix plan refuses to start a fix', async () => {
    const runner = new ServiceRunner({ service: 'gate', env: {} });
    await expect(runner.deploy({ ref: 'incident/c000000000000000000000001', sha: 'a'.repeat(40), dir: '/nowhere', fix: true })).rejects.toThrow('isolated spawn plan');
  });
});
