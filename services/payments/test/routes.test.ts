import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeServer, createLabServer, httpRequest, listen, type LabServer } from '@haunted-lab/common';
import { patchedServiceCopy } from '../../../scripts/scenario-copy.mjs';
import { createPayments } from '../src/app.ts';
import { seededIds } from './seeded.ts';

const quiet = () => undefined;
const servers: LabServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => closeServer(s.server)));
});

/** Fake ledger: records calls, answers 201 (or `status`). */
async function fakeLedger(status = 201) {
  const calls: unknown[] = [];
  const lab = createLabServer({
    name: 'fake-ledger',
    sink: quiet,
    infra: false,
    routes: [
      {
        method: 'POST',
        path: '/ledger/entries',
        handler: async (ctx) => {
          calls.push(await ctx.readJson());
          return { status, body: { entryId: `le-${calls.length}` } };
        },
      },
    ],
  });
  const port = await listen(lab.server, 0, '127.0.0.1');
  servers.push(lab);
  return { url: `http://127.0.0.1:${port}`, calls };
}

async function startPayments(create: typeof createPayments, ledgerUrl: string) {
  const lab = create({ ledgerUrl, sink: quiet });
  const port = await listen(lab.server, 0, '127.0.0.1');
  servers.push(lab);
  return `http://127.0.0.1:${port}`;
}

const charge = (base: string, body: unknown) =>
  httpRequest(`${base}/payments/charge`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('payments routes', () => {
  it('captures a charge and writes one ledger entry', async () => {
    const ledger = await fakeLedger();
    const base = await startPayments(createPayments, ledger.url);
    const res = await charge(base, { orderId: 'o-1', amountCents: 250 });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ paymentId: 'pay-1', ledgerEntryId: 'le-1', status: 'captured' });
    expect(ledger.calls).toEqual([{ orderId: 'o-1', paymentId: 'pay-1', amountCents: 250 }]);
  });

  it('validates the body and maps a ledger failure to 502', async () => {
    const ledger = await fakeLedger(500);
    const base = await startPayments(createPayments, ledger.url);
    expect((await charge(base, { orderId: 'o-1' })).status).toBe(400);
    expect((await charge(base, { orderId: 'o 1', amountCents: 1 })).status).toBe(400);
    expect((await charge(base, '[1]')).status).toBe(400);
    expect((await charge(base, { orderId: 'o-2', amountCents: 5 })).status).toBe(502);
  });

  it('main: no errors over seeded order ids', async () => {
    const ledger = await fakeLedger();
    const base = await startPayments(createPayments, ledger.url);
    const results = await Promise.all(seededIds(200, 1).map((orderId) => charge(base, { orderId, amountCents: 100 })));
    expect(results.filter((r) => r.status !== 200)).toHaveLength(0);
  });
});

describe('scenario error-spike, applied in-process', () => {
  it('about 30% of seeded charges fail with the missing-guard TypeError', async () => {
    const copy = await patchedServiceCopy(resolve(import.meta.dirname, '..'), 'error-spike');
    try {
      const mod = (await import(`${copy.src}/app.ts`)) as { createPayments: typeof createPayments };
      const ledger = await fakeLedger();
      const lab = mod.createPayments({ ledgerUrl: ledger.url, sink: quiet });
      const port = await listen(lab.server, 0, '127.0.0.1');
      servers.push(lab);
      const n = 400;
      const results = await Promise.all(seededIds(n, 1).map((orderId) => charge(`http://127.0.0.1:${port}`, { orderId, amountCents: 100 })));
      const ratio = results.filter((r) => r.status === 500).length / n;
      expect(ratio).toBeGreaterThan(0.25);
      expect(ratio).toBeLessThan(0.35);
      expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
      const err = lab.errors.latest(1)[0];
      expect(err?.message).toBe("Cannot read properties of undefined (reading 'windowDays')");
      expect(err?.frame).toContain('refundTerms');
    } finally {
      await copy.cleanup();
    }
  });
});
