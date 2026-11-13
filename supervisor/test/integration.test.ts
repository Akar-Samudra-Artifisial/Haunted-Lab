import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpRequest } from '@haunted-lab/common';
import { buildSnapshotRepo, plantScenarios } from '../../scripts/lab-git.mjs';
import { freePorts } from './helpers.ts';

// Starts the real supervisor (node supervisor/src/main.ts) against a temporary lab repo with the
// planted branches, TRAFFIC_RPS=0, and drives /chaos and /lab over loopback.

const CHECKOUT = resolve(import.meta.dirname, '..', '..');
const CHAOS = 'chaos-token-integration-0001';
const READ = 'read-token-integration-00001';

let dir = '';
let child: ChildProcess | undefined;
let base = '';
let ports: number[] = [];
let shas: Record<string, string> = {};
let mainSha = '';
let output = '';

interface Json {
  status: number;
  body: Record<string, unknown> & { error?: { code: string } };
  headers: Record<string, string | string[] | undefined>;
}

async function call(method: string, path: string, token?: string, body?: string): Promise<Json> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await httpRequest(`${base}${path}`, { method, headers, body, timeoutMs: 15_000 });
  let parsed: Json['body'] = {};
  try {
    parsed = JSON.parse(res.text) as Json['body'];
  } catch {
    // non-JSON
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

const state = async () => (await call('GET', '/chaos/state', CHAOS)).body as { activeScenario: string | null; services: { service: string; ref: string; sha: string; status: string; restarts: number }[] };

async function waitFor<T>(fn: () => Promise<T | undefined>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out; supervisor output:\n${output.slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const servicePost = (port: number, path: string, body: unknown) =>
  httpRequest(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(body), timeoutMs: 10_000 });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lab-int-'));
  const repo = join(dir, 'repo');
  mainSha = await buildSnapshotRepo(CHECKOUT, repo);
  shas = (await plantScenarios(repo)).shas;
  ports = await freePorts(5);
  base = `http://127.0.0.1:${ports[0]}`;
  startProcess(repo);
  const gate = ports[1] as number;
  await waitFor(async () => ((await call('GET', '/healthz')).status === 200 ? true : undefined), 20_000);
  await waitFor(async () => ((await httpRequest(`http://127.0.0.1:${gate}/healthz`)).status === 200 ? true : undefined), 10_000);
}, 60_000);

function startProcess(repo: string) {
  const [sup, gate, orders, payments, ledger] = ports as [number, number, number, number, number];
  child = spawn(process.execPath, [join(CHECKOUT, 'supervisor', 'src', 'main.ts')], {
    env: {
      PATH: process.env.PATH,
      CHAOS_TOKEN: CHAOS,
      LAB_READ_TOKEN: READ,
      SUPERVISOR_PORT: String(sup),
      GATE_PORT: String(gate),
      ORDERS_PORT: String(orders),
      PAYMENTS_PORT: String(payments),
      LEDGER_PORT: String(ledger),
      TRAFFIC_RPS: '0',
      LAB_REPO_DIR: repo,
      LAB_DATA_DIR: join(dir, 'data'),
      LAB_WORKTREES_DIR: join(dir, 'worktrees'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
}

afterAll(async () => {
  if (child && child.exitCode === null) {
    const closed = new Promise((r) => child?.once('close', r));
    child.kill('SIGTERM');
    await closed;
  }
  await rm(dir, { recursive: true, force: true });
}, 30_000);

describe('supervisor (real processes)', () => {
  it('boots main for every service and records four supervisor deploys', async () => {
    const s = await state();
    expect(s.activeScenario).toBeNull();
    expect(s.services.map((x) => [x.service, x.ref, x.sha, x.status])).toEqual(
      ['gate', 'orders', 'payments', 'ledger'].map((n) => [n, 'main', mainSha, 'running']),
    );
    const deploys = (await call('GET', '/lab/deploys', READ)).body.items as { id: string; actor: string }[];
    expect(deploys.map((d) => d.id)).toEqual(['d-101', 'd-102', 'd-103', 'd-104']);
    expect(deploys.every((d) => d.actor === 'supervisor')).toBe(true);
    const [, gate] = ports as [number, number];
    const ok = await servicePost(gate, '/checkout', { orderId: 'o-1', sku: 'chalk', qty: 1, amountCents: 500 });
    expect(ok.status).toBe(200);
  });

  it('enforces auth per prefix, methods, routes and the body limit', async () => {
    expect((await call('GET', '/chaos/state')).status).toBe(401);
    expect((await call('GET', '/chaos/state', READ)).status).toBe(401);
    expect((await call('GET', '/lab/deploys', CHAOS)).status).toBe(401);
    expect((await call('GET', '/lab/deploys', `${READ}x`)).status).toBe(401);
    const unauth = await httpRequest(`${base}/lab/errors`);
    expect(unauth.headers['www-authenticate']).toBe('Bearer');
    expect(unauth.text).not.toContain(READ);
    expect(unauth.text).not.toContain(CHAOS);
    expect((await call('DELETE', '/chaos/reset', CHAOS)).status).toBe(405);
    expect((await call('GET', '/chaos/scenarios/fog/apply', CHAOS)).status).toBe(405);
    expect((await call('POST', '/lab/deploys', READ)).status).toBe(405);
    expect((await call('GET', '/chaos/nothing', CHAOS)).status).toBe(404);
    const big = await call('POST', '/chaos/reset', CHAOS, 'x'.repeat(9000));
    expect(big.status).toBe(413);
    const unknown = await call('POST', '/chaos/scenarios/haunted/apply', CHAOS);
    expect(unknown).toMatchObject({ status: 404, body: { error: { code: 'unknown_scenario' } } });
    const bad = await call('GET', '/lab/errors?limit=999', READ);
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'bad_request' } } });
    expect((await call('GET', '/lab/logs?service=vault', READ)).status).toBe(400);
  });

  it('ignores refs and paths in the request body', async () => {
    const res = await call('POST', '/chaos/reset', CHAOS, JSON.stringify({ ref: 'exorcist/fix-1', path: '/etc', service: 'gate' }));
    expect(res.status).toBe(200);
    expect((await state()).services.every((s) => s.ref === 'main')).toBe(true);
  });

  it('error-spike: payments on its branch, ~30% of charges fail with the culprit frame', async () => {
    const res = await call('POST', '/chaos/scenarios/error-spike/apply', CHAOS, '{"ref":"main"}');
    expect(res.status).toBe(200);
    expect((res.body.deploys as { service: string; sha: string; actor: string }[]).map((d) => [d.service, d.sha, d.actor])).toEqual([
      ['payments', shas['error-spike'], 'chaos'],
    ]);
    const payments = ports[3] as number;
    await waitFor(async () => ((await httpRequest(`http://127.0.0.1:${payments}/healthz`)).status === 200 ? true : undefined), 10_000);
    let failed = 0;
    const n = 200;
    const results = await Promise.all(Array.from({ length: n }, (_, i) => servicePost(payments, '/payments/charge', { orderId: `o-${i}-${Math.floor(Math.random() * 1e6)}`, amountCents: 100 })));
    for (const r of results) if (r.status === 500) failed++;
    expect(failed / n).toBeGreaterThan(0.18);
    expect(failed / n).toBeLessThan(0.42);
    const errors = (await call('GET', '/lab/errors?service=payments&limit=5', READ)).body.items as { message: string; frame: string; source: string }[];
    expect(errors).toHaveLength(5);
    expect(errors[0]).toMatchObject({ source: 'service', message: "Cannot read properties of undefined (reading 'windowDays')" });
    expect(errors[0]?.frame).toMatch(/^at refundTerms \(services\/payments\/src\/refunds\.ts:\d+:\d+\)$/);
  }, 30_000);

  it('fog: orders p95 over 1.5 s with no errors', async () => {
    const res = await call('POST', '/chaos/scenarios/fog/apply', CHAOS);
    expect((res.body.deploys as { service: string }[]).map((d) => d.service).sort()).toEqual(['orders', 'payments']);
    const orders = ports[2] as number;
    await waitFor(async () => ((await httpRequest(`http://127.0.0.1:${orders}/healthz`)).status === 200 ? true : undefined), 10_000);
    const times: number[] = [];
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const t0 = performance.now();
        const r = await servicePost(orders, '/orders', { orderId: `o-fog-${i}`, sku: 'rope', qty: 1, amountCents: 100 });
        times.push((performance.now() - t0) / 1000);
        return r;
      }),
    );
    // Payments is back on main, so the refund failure must not leak in.
    expect(results.filter((r) => r.status !== 200)).toHaveLength(0);
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]).toBeGreaterThan(1.5);
  }, 30_000);

  it('dark-room: ledger crash-loops with backoff and the exit reason is visible', async () => {
    const res = await call('POST', '/chaos/scenarios/dark-room/apply', CHAOS);
    expect(res.status).toBe(200);
    const s = await waitFor(async () => {
      const st = await state();
      const ledger = st.services.find((x) => x.service === 'ledger');
      return ledger && ledger.restarts >= 2 && ledger.status === 'backoff' ? st : undefined;
    }, 10_000);
    expect(s.activeScenario).toBe('dark-room');
    expect(s.services.find((x) => x.service === 'ledger')?.sha).toBe(shas['dark-room']);
    expect(s.services.find((x) => x.service === 'orders')?.ref).toBe('main');
    const errs = (await call('GET', '/lab/errors?service=ledger', READ)).body.items as { message: string; source: string }[];
    expect(errs.at(-1)).toMatchObject({ source: 'supervisor', message: 'ledger exited with code 1: missing required env: LEDGER_LISTEN_PORT' });
    const logs = (await call('GET', '/lab/logs?service=ledger&limit=3', READ)).body.items as { stream: string; line: string }[];
    expect(logs.some((l) => l.stream === 'stderr' && l.line.includes('LEDGER_LISTEN_PORT'))).toBe(true);
    const ledger = ports[4] as number;
    await expect(httpRequest(`http://127.0.0.1:${ledger}/healthz`, { timeoutMs: 500 })).rejects.toThrow();
  }, 30_000);

  it('reset: all services back on main and healthy', async () => {
    const res = await call('POST', '/chaos/reset', CHAOS);
    expect((res.body.deploys as { service: string; ref: string }[]).map((d) => [d.service, d.ref])).toEqual([['ledger', 'main']]);
    const ledger = ports[4] as number;
    await waitFor(async () => ((await httpRequest(`http://127.0.0.1:${ledger}/healthz`)).status === 200 ? true : undefined), 10_000);
    const s = await state();
    expect(s.activeScenario).toBeNull();
    expect(s.services.every((x) => x.ref === 'main' && x.sha === mainSha)).toBe(true);
    const gate = ports[1] as number;
    expect((await servicePost(gate, '/checkout', { orderId: 'o-after', sku: 'bell', qty: 2, amountCents: 300 })).status).toBe(200);
  }, 30_000);

  it('keeps only the active worktree per service after redeploys', async () => {
    const names = (await readdir(join(dir, 'worktrees'))).sort();
    expect(names).toEqual(['gate', 'ledger', 'orders', 'payments'].map((n) => `${n}@${mainSha}`));
  });

  it('marks every /lab response untrusted, errors included, and not /chaos', async () => {
    for (const path of ['/lab/errors', '/lab/logs', '/lab/deploys', `/lab/commits/${shas.fog}/diff`]) {
      expect((await call('GET', path, READ)).body.untrusted).toBe(true);
    }
    expect((await call('GET', '/lab/errors')).body).toMatchObject({ untrusted: true, error: { code: 'unauthorized' } });
    expect((await call('GET', '/lab/commits/deadbeef00/diff', READ)).body).toMatchObject({ untrusted: true, error: { code: 'unknown_commit' } });
    expect((await call('GET', '/chaos/state', CHAOS)).body.untrusted).toBeUndefined();
  });

  it('serves culprit diffs by sha prefix and refuses others', async () => {
    for (const [name, sha] of Object.entries(shas)) {
      const res = await call('GET', `/lab/commits/${sha.slice(0, 12)}/diff`, READ);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ sha, author: 'Haunted Lab Bot', truncated: false });
      expect(String(res.body.diff)).toContain(`services/${{ 'error-spike': 'payments', fog: 'orders', 'dark-room': 'ledger' }[name]}/`);
    }
    expect((await call('GET', `/lab/commits/${mainSha}/diff`, READ)).status).toBe(200);
    expect((await call('GET', '/lab/commits/deadbeefdeadbeef/diff', READ)).body.error?.code).toBe('unknown_commit');
    expect((await call('GET', '/lab/commits/main/diff', READ)).status).toBe(404);
    expect((await call('GET', '/lab/commits/HEAD~1/diff', READ)).status).toBe(404);
    const deploys = (await call('GET', '/lab/deploys', READ)).body.items as { id: string }[];
    const ids = deploys.map((d) => Number(d.id.slice(2)));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    const since = (await call('GET', `/lab/deploys?since=${encodeURIComponent(new Date().toISOString())}`, READ)).body.items as unknown[];
    expect(since).toHaveLength(0);
  });

  it('never returns token values', async () => {
    for (const path of ['/lab/errors', '/lab/logs?limit=500', '/lab/deploys']) {
      const raw = await httpRequest(`${base}${path}`, { headers: { authorization: `Bearer ${READ}` } });
      expect(raw.headers['content-type']).toBe('application/json');
      expect(raw.text).not.toContain(READ);
      expect(raw.text).not.toContain(CHAOS);
    }
    expect(output).not.toContain(READ);
    expect(output).not.toContain(CHAOS);
  });

  it('after a supervisor SIGKILL, the next supervisor stops the orphaned children before binding', async () => {
    const recorded = JSON.parse(await readFile(join(dir, 'data', 'pids.json'), 'utf8')) as Record<string, number>;
    expect(Object.keys(recorded).sort()).toEqual(['gate', 'ledger', 'orders', 'payments']);
    const closed = new Promise((r) => child?.once('close', r));
    child?.kill('SIGKILL');
    await closed;
    // Children are in their own process groups: they outlive the SIGKILLed supervisor.
    const gate = ports[1] as number;
    expect((await httpRequest(`http://127.0.0.1:${gate}/healthz`)).status).toBe(200);
    output = '';
    startProcess(join(dir, 'repo'));
    await waitFor(async () => ((await call('GET', '/healthz')).status === 200 ? true : undefined), 20_000);
    const line = /stopped stale children: ([a-z, ]+)/.exec(output)?.[1] ?? '';
    expect(line.split(', ').sort()).toEqual(['gate', 'ledger', 'orders', 'payments']);
    for (const pid of Object.values(recorded)) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
    const s = await state();
    expect(s.services.every((x) => x.status === 'running' && x.ref === 'main')).toBe(true);
    const deploys = (await call('GET', '/lab/deploys', READ)).body.items as { id: string; actor: string }[];
    expect(deploys.slice(-4).every((d) => d.actor === 'supervisor')).toBe(true);
    expect((await readdir(join(dir, 'worktrees'))).length).toBe(4);
  }, 40_000);

  it('stops every child on SIGTERM and exits 0', async () => {
    const pids = (await state()).services.length;
    expect(pids).toBe(4);
    const closed = new Promise<number | null>((r) => child?.once('close', (code) => r(code)));
    child?.kill('SIGTERM');
    expect(await closed).toBe(0);
    for (const p of ports.slice(1)) {
      await expect(httpRequest(`http://127.0.0.1:${p}/healthz`, { timeoutMs: 500 })).rejects.toThrow();
    }
  }, 20_000);
});
