import { afterEach, describe, expect, it } from 'vitest';
import { closeServer, createLabServer, httpRequest, listen, type LabServer } from '@haunted-lab/common';
import { createOrders } from '../src/app.ts';

const quiet = () => undefined;
const servers: LabServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => closeServer(s.server)));
});

async function fakePayments(status = 200) {
  const calls: { body: unknown; requestId: string | undefined }[] = [];
  const lab = createLabServer({
    name: 'fake-payments',
    sink: quiet,
    infra: false,
    routes: [
      {
        method: 'POST',
        path: '/payments/charge',
        handler: async (ctx) => {
          calls.push({ body: await ctx.readJson(), requestId: ctx.requestId });
          return { status, body: { paymentId: 'pay-9', ledgerEntryId: 'le-9', status: 'captured' } };
        },
      },
    ],
  });
  const port = await listen(lab.server, 0, '127.0.0.1');
  servers.push(lab);
  return { url: `http://127.0.0.1:${port}`, calls };
}

async function startOrders(paymentsUrl: string) {
  const lab = createOrders({ paymentsUrl, sink: quiet });
  const port = await listen(lab.server, 0, '127.0.0.1');
  servers.push(lab);
  return { base: `http://127.0.0.1:${port}`, lab };
}

const order = { orderId: 'o-7', sku: 'lantern', qty: 2, amountCents: 1200 };
const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  httpRequest(`${base}/orders`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('orders routes', () => {
  it('reserves stock, charges payments with the order amount and passes the request id', async () => {
    const payments = await fakePayments();
    const { base } = await startOrders(payments.url);
    const res = await post(base, order, { 'x-request-id': 'rid_orders_1' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ orderId: 'o-7', paymentId: 'pay-9', ledgerEntryId: 'le-9', reserved: true });
    expect(payments.calls).toEqual([{ body: { orderId: 'o-7', amountCents: 1200 }, requestId: 'rid_orders_1' }]);
  });

  it('answers 400 for bad orders without calling payments, 502 when payments fails', async () => {
    const payments = await fakePayments(500);
    const { base, lab } = await startOrders(payments.url);
    expect((await post(base, { ...order, qty: 0 })).status).toBe(400);
    expect((await post(base, { ...order, sku: '' })).status).toBe(400);
    expect(payments.calls).toHaveLength(0);
    expect((await post(base, order)).status).toBe(502);
    expect(lab.errors.latest(1)[0]?.message).toContain('/payments/charge answered 500');
  });
});
