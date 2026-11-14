import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpRequest } from '@haunted-lab/common';
import { CHECKOUT, cuidRef, makeFixture, REFUNDS, runGit, type Fixture } from './fix-origin.ts';
import { freePorts } from './helpers.ts';

// Real supervisor process, local bare origin (never GitHub): error-spike -> push an incident fix to
// the origin -> POST /chaos/deploy-fix -> the payments error ratio from /metrics is back to normal.

const CHAOS = 'chaos-token-fix-integration1';
const READ = 'read-token-fix-integration12';

let fx: Fixture;
let child: ChildProcess | undefined;
let base = '';
let ports: number[] = [];
let output = '';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function waitFor<T>(fn: () => Promise<T | undefined>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out; supervisor output:\n${output.slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Seeded order ids, same shape as the traffic generator's (mulberry32). */
function seededIds(n: number, seed: number): string[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: n }, (_, i) => `o-${i}-${Math.floor(rand() * 1_000_000)}`);
}

/** `http_requests_total{route="/payments/charge"}` by code, from payments' /metrics. */
async function chargeCounts(): Promise<{ total: number; errors: number }> {
  const text = (await httpRequest(`http://127.0.0.1:${ports[3]}/metrics`)).text;
  let total = 0;
  let errors = 0;
  for (const m of text.matchAll(/^http_requests_total\{route="\/payments\/charge",code="(\d+)"\} (\d+)$/gm)) {
    total += Number(m[2]);
    if ((m[1] ?? '').startsWith('5')) errors += Number(m[2]);
  }
  return { total, errors };
}

async function errorRatio(seed: number): Promise<number> {
  const before = await chargeCounts();
  const ids = seededIds(200, seed);
  await Promise.all(ids.map((orderId) => httpRequest(`http://127.0.0.1:${ports[3]}/payments/charge`, { method: 'POST', body: JSON.stringify({ orderId, amountCents: 100 }), timeoutMs: 10_000 })));
  const after = await chargeCounts();
  return (after.errors - before.errors) / Math.max(1, after.total - before.total);
}

const healthy = (port: number) => waitFor(async () => ((await httpRequest(`http://127.0.0.1:${port}/healthz`)).status === 200 ? true : undefined), 20_000);

beforeAll(async () => {
  fx = await makeFixture();
  ports = await freePorts(5);
  base = `http://127.0.0.1:${ports[0]}`;
  child = spawn(process.execPath, [join(CHECKOUT, 'supervisor', 'src', 'main.ts')], {
    env: {
      PATH: process.env.PATH,
      CHAOS_TOKEN: CHAOS,
      LAB_READ_TOKEN: READ,
      SUPERVISOR_PORT: String(ports[0]),
      GATE_PORT: String(ports[1]),
      ORDERS_PORT: String(ports[2]),
      PAYMENTS_PORT: String(ports[3]),
      LEDGER_PORT: String(ports[4]),
      TRAFFIC_RPS: '0',
      LAB_REPO_DIR: fx.source,
      LAB_DATA_DIR: join(fx.dir, 'data'),
      LAB_WORKTREES_DIR: join(fx.dir, 'worktrees'),
      LAB_ORIGIN_URL: fx.originUrl,
      LAB_ALLOW_FILE_ORIGIN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
  await waitFor(async () => ((await httpRequest(`${base}/healthz`)).status === 200 ? true : undefined), 30_000);
  await healthy(ports[1] as number);
}, 90_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const closed = new Promise((r) => child?.once('close', r));
    child.kill('SIGTERM');
    await closed;
  }
  await fx?.cleanup();
}, 30_000);

describe('deploy-fix end to end', () => {
  it('an incident fix deployed through deploy-fix brings the payments error ratio back', async () => {
    const applied = await httpRequest(`${base}/chaos/scenarios/error-spike/apply`, { method: 'POST', headers: auth(CHAOS) });
    expect(applied.status).toBe(200);
    await healthy(ports[3] as number);
    const broken = await errorRatio(7);
    expect(broken).toBeGreaterThan(0.2);

    // "Push" the merged fix to the origin: restore the guard on top of the scenario head.
    const fixSha = await fx.commit([fx.heads['error-spike']], { [REFUNDS]: await fx.mainFile(REFUNDS) }, 'restore refund guard');
    const ref = cuidRef(42);
    await fx.setRef(ref, fixSha);

    const res = await httpRequest(`${base}/chaos/deploy-fix`, {
      method: 'POST',
      headers: { ...auth(CHAOS), 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'payments', ref, sha: fixSha }),
      timeoutMs: 60_000,
    });
    expect(res.status, res.text).toBe(200);
    const body = JSON.parse(res.text) as { deployId: string; service: string; sha: string };
    expect(body).toMatchObject({ service: 'payments', sha: fixSha });
    await healthy(ports[3] as number);

    const fixed = await errorRatio(7);
    expect(fixed).toBeLessThan(0.01);

    const deploys = JSON.parse((await httpRequest(`${base}/lab/deploys`, { headers: auth(READ) })).text) as { items: { id: string; actor: string; ref: string; sha: string }[] };
    expect(deploys.items.at(-1)).toMatchObject({ id: body.deployId, actor: 'exorcist', ref, sha: fixSha });
    const diff = await httpRequest(`${base}/lab/commits/${fixSha}/diff`, { headers: auth(READ) });
    expect(diff.status).toBe(200);
    expect(output).toContain('FIX_RUN_AS_USER not set; development only');
    expect(output).not.toContain(CHAOS);
  }, 120_000);

  it('reset returns every service to main; no worktree is registered in the source', async () => {
    const res = await httpRequest(`${base}/chaos/reset`, { method: 'POST', headers: auth(CHAOS) });
    expect(res.status).toBe(200);
    const st = JSON.parse((await httpRequest(`${base}/chaos/state`, { headers: auth(CHAOS) })).text) as { activeScenario: string | null; services: { ref: string; sha: string }[] };
    expect(st.activeScenario).toBeNull();
    expect(st.services.every((s) => s.ref === 'main' && s.sha === fx.heads.main)).toBe(true);
    await healthy(ports[3] as number);
    expect(await errorRatio(9)).toBeLessThan(0.01);
    expect((await runGit(fx.source, ['worktree', 'list'])).split('\n')).toHaveLength(1);
  }, 60_000);
});
