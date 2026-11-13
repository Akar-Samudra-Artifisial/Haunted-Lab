import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeServer, httpRequest, listen, type LabServer } from '@haunted-lab/common';
import { patchedServiceCopy } from '../../../scripts/scenario-copy.mjs';
import { createLedger } from '../src/app.ts';

const quiet = () => undefined;
const servers: LabServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => closeServer(s.server)));
});

async function startLedger() {
  const lab = createLedger({ sink: quiet });
  const port = await listen(lab.server, 0, '127.0.0.1');
  servers.push(lab);
  return `http://127.0.0.1:${port}`;
}

const entry = (base: string, body: unknown) =>
  httpRequest(`${base}/ledger/entries`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('ledger routes', () => {
  it('appends entries with increasing ids (201)', async () => {
    const base = await startLedger();
    const a = await entry(base, { orderId: 'o-1', paymentId: 'pay-1', amountCents: 10 });
    const b = await entry(base, { orderId: 'o-2', paymentId: 'pay-2', amountCents: 20 });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([JSON.parse(a.text), JSON.parse(b.text)]).toEqual([{ entryId: 'le-1' }, { entryId: 'le-2' }]);
  });

  it('rejects invalid entries with 400 and other methods with 405', async () => {
    const base = await startLedger();
    expect((await entry(base, { orderId: 'o-1', paymentId: 'pay-1', amountCents: 0 })).status).toBe(400);
    expect((await entry(base, { orderId: 'o-1', amountCents: 5 })).status).toBe(400);
    expect((await entry(base, 'null')).status).toBe(400);
    expect((await httpRequest(`${base}/ledger/entries`)).status).toBe(405);
  });
});

function run(main: string, env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [main], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stderr });
    });
  });
}

describe('scenario dark-room, applied in-process', () => {
  it('ledger exits at start with the missing env message, given only LEDGER_PORT', async () => {
    const copy = await patchedServiceCopy(resolve(import.meta.dirname, '..'), 'dark-room');
    try {
      const res = await run(`${copy.src}/main.ts`, { LEDGER_PORT: '4999' });
      expect(res.code).toBe(1);
      expect(res.stderr.trim()).toBe('missing required env: LEDGER_LISTEN_PORT');
      const mod = (await import(`${copy.src}/config.ts`)) as { loadConfig: (env: Record<string, string>) => unknown };
      expect(() => mod.loadConfig({ LEDGER_PORT: '4999' })).toThrow('missing required env: LEDGER_LISTEN_PORT');
    } finally {
      await copy.cleanup();
    }
  }, 20_000);
});
