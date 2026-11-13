import { afterEach, describe, expect, it } from 'vitest';
import { closeServer, httpRequest, listen, type LabServer } from '@haunted-lab/common';
import { createLedger } from '../../ledger/src/app.ts';
import { createPayments } from '../../payments/src/app.ts';
import { createOrders } from '../../orders/src/app.ts';
import { createGate } from '../src/app.ts';

const quiet = () => undefined;

interface Chain {
  gate: string;
  labs: Record<'gate' | 'orders' | 'payments' | 'ledger', LabServer>;
  urls: Record<'gate' | 'orders' | 'payments' | 'ledger', string>;
}

const started: LabServer[] = [];

async function startChain(): Promise<Chain> {
  const ledger = createLedger({ sink: quiet });
  const ledgerPort = await listen(ledger.server, 0, '127.0.0.1');
  const payments = createPayments({ ledgerUrl: `http://127.0.0.1:${ledgerPort}`, sink: quiet });
  const paymentsPort = await listen(payments.server, 0, '127.0.0.1');
  const orders = createOrders({ paymentsUrl: `http://127.0.0.1:${paymentsPort}`, sink: quiet });
  const ordersPort = await listen(orders.server, 0, '127.0.0.1');
  const gate = createGate({ ordersUrl: `http://127.0.0.1:${ordersPort}`, sink: quiet });
  const gatePort = await listen(gate.server, 0, '127.0.0.1');
  started.push(ledger, payments, orders, gate);
  const urls = {
    gate: `http://127.0.0.1:${gatePort}`,
    orders: `http://127.0.0.1:${ordersPort}`,
    payments: `http://127.0.0.1:${paymentsPort}`,
    ledger: `http://127.0.0.1:${ledgerPort}`,
  };
  return { gate: urls.gate, labs: { gate, orders, payments, ledger }, urls };
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((l) => closeServer(l.server)));
});

const order = (id: string) => ({ orderId: id, sku: 'sku-1', qty: 1, amountCents: 1999 });
const post = (url: string, body: unknown, raw = false) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? (body as string) : JSON.stringify(body) });

describe('call chain', () => {
  it('creates an order, a payment and a ledger entry', async () => {
    const chain = await startChain();
    const res = await post(`${chain.gate}/checkout`, order('o-1'), false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orderId: 'o-1', paymentId: 'pay-1', ledgerEntryId: 'le-1', status: 'confirmed' });
  });

  it('answers 400 for invalid bodies without ringing them, 413 for large ones', async () => {
    const chain = await startChain();
    expect((await post(`${chain.gate}/checkout`, '{not json', true)).status).toBe(400);
    expect((await post(`${chain.gate}/checkout`, { orderId: 'o 1' })).status).toBe(400);
    expect((await post(`${chain.gate}/checkout`, { ...order('o-2'), qty: 99 })).status).toBe(400);
    expect((await post(`${chain.gate}/checkout`, 'x'.repeat(9000), true)).status).toBe(413);
    expect(chain.labs.gate.errors.size).toBe(0);
  });

  it('answers 502 and rings the failure when ledger is down, then recovers', async () => {
    const chain = await startChain();
    await closeServer(chain.labs.ledger.server);
    const res = await post(`${chain.gate}/checkout`, order('o-3'));
    expect(res.status).toBe(502);
    const rid = res.headers.get('x-request-id');
    expect(rid).toMatch(/^r-/);
    const gateErrors = (await (await fetch(`${chain.gate}/debug/errors`)).json()) as { items: { message: string; requestId: string }[] };
    expect(gateErrors.items[0]?.requestId).toBe(rid);
    expect(chain.labs.payments.errors.latest()[0]?.requestId).toBe(rid);
    expect(chain.labs.payments.errors.latest()[0]?.message).toContain('/ledger/entries');
  });

  it('serves healthz, metrics, debug rings and rejects non-GET on them', async () => {
    const chain = await startChain();
    await post(`${chain.gate}/checkout`, order('o-4'));
    for (const url of Object.values(chain.urls)) {
      expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ ok: true });
      expect((await fetch(`${url}/debug/logs`, { method: 'POST' })).status).toBe(405);
      expect((await fetch(`${url}/debug/errors`, { method: 'DELETE' })).status).toBe(405);
    }
    const metrics = await (await fetch(`${chain.gate}/metrics`)).text();
    expect(metrics).toContain('http_requests_total{route="/checkout",code="200"} 1');
    const logs = (await (await fetch(`${chain.urls.ledger}/debug/logs`)).json()) as { items: { line: string }[] };
    expect(logs.items.some((i) => i.line.includes('/ledger/entries'))).toBe(true);
  });

  it('propagates one request id down the chain', async () => {
    const chain = await startChain();
    const res = await fetch(`${chain.gate}/checkout`, {
      method: 'POST',
      headers: { 'x-request-id': 'trace_77' },
      body: JSON.stringify(order('o-5')),
    });
    expect(res.headers.get('x-request-id')).toBe('trace_77');
    for (const l of [chain.labs.gate, chain.labs.orders, chain.labs.payments, chain.labs.ledger]) {
      expect(l.logs.latest().some((e) => e.line.includes('rid=trace_77'))).toBe(true);
    }
  });
});

describe('main baseline', () => {
  it('keeps error ratio below 0.01 and p95 below 0.25 s at 5 rps for 10 s', async () => {
    const chain = await startChain();
    const latencies: number[] = [];
    let failures = 0;
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      jobs.push(
        (async () => {
          const t0 = performance.now();
          // node:http client, same as the traffic generator (see lab-common client.ts for why not fetch)
          const res = await httpRequest(`${chain.gate}/checkout`, { method: 'POST', body: JSON.stringify(order(`o-base-${i}`)) });
          latencies.push((performance.now() - t0) / 1000);
          if (res.status >= 500) failures++;
        })(),
      );
      await new Promise((r) => setTimeout(r, 200));
    }
    await Promise.all(jobs);
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
    expect(failures / 50).toBeLessThan(0.01);
    expect(p95).toBeLessThan(0.25);
  }, 30_000);
});
