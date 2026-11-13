import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  callJson,
  closeServer,
  createLabServer,
  createMetrics,
  type HttpError,
  listen,
  MAX_BODY_BYTES,
  readJsonBody,
  routeLabel,
  sanitizeRequestId,
  type LabServer,
  type Route,
} from '../src/index.ts';

const fakeReq = (chunks: Buffer[], headers: Record<string, string> = {}): IncomingMessage =>
  Object.assign(Readable.from(chunks, { objectMode: false }), { headers }) as unknown as IncomingMessage;

const jsonBody = (length: number): Buffer => Buffer.from(`"${'a'.repeat(Math.max(0, length - 2))}"`);

describe('readJsonBody', () => {
  // Feature: haunted-lab, Property 10
  it('accepts at most 8192 bytes and answers 413 above', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 20000 }), fc.integer({ min: 1, max: 4096 }), async (length, chunkSize) => {
        const body = jsonBody(length);
        const chunks: Buffer[] = [];
        for (let i = 0; i < body.length; i += chunkSize) chunks.push(body.subarray(i, i + chunkSize));
        const result = await readJsonBody(fakeReq(chunks)).then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        );
        if (length <= MAX_BODY_BYTES) {
          expect(result.ok).toBe(true);
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) expect((result.e as HttpError).status).toBe(413);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: haunted-lab, Property 10
  it('rejects from content-length without reading anything', async () => {
    let pulled = 0;
    const req = Object.assign(
      new Readable({
        read() {
          pulled++;
          this.push(null);
        },
      }),
      { headers: { 'content-length': '9000' } },
    ) as unknown as IncomingMessage;
    await expect(readJsonBody(req)).rejects.toMatchObject({ status: 413, code: 'payload_too_large' });
    expect(pulled).toBe(0);
  });

  it('answers 400 for malformed JSON', async () => {
    await expect(readJsonBody(fakeReq([Buffer.from('{nope')]))).rejects.toMatchObject({ status: 400 });
  });
});

describe('sanitizeRequestId', () => {
  // Feature: haunted-lab, Property 15
  it('keeps well-formed ids and replaces everything else with a valid one', () => {
    const valid = /^[A-Za-z0-9_-]{1,64}$/;
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 100 }), fc.constant(undefined), fc.array(fc.string())), (input) => {
        const out = sanitizeRequestId(input);
        expect(out).toMatch(valid);
        const first = Array.isArray(input) ? input[0] : input;
        if (typeof first === 'string' && valid.test(first)) expect(out).toBe(first);
        else expect(out).not.toBe(first);
      }),
      { numRuns: 300 },
    );
  });
});

describe('routeLabel', () => {
  const routes: Route[] = [
    { method: 'POST', path: '/checkout', handler: () => ({ status: 200 }) },
    { method: 'GET', path: '/things/{id}/diff', handler: () => ({ status: 200 }) },
  ];
  const templates = new Set(['/checkout', '/things/{id}/diff', 'unmatched']);

  // Feature: haunted-lab, Property 2
  it('is a registered template or `unmatched` for any path', () => {
    fc.assert(
      fc.property(fc.webPath(), fc.constantFrom('GET', 'POST', 'PUT'), (path, method) => {
        expect(templates.has(routeLabel(routes, method, path))).toBe(true);
      }),
      { numRuns: 300 },
    );
    expect(routeLabel(routes, 'GET', '/things/abc123/diff')).toBe('/things/{id}/diff');
    expect(routeLabel(routes, 'GET', '/things/%E0%A4%A/diff')).toBe('unmatched');
  });
});

describe('lab server', () => {
  let lab: LabServer | undefined;
  afterEach(async () => {
    if (lab) await closeServer(lab.server);
    lab = undefined;
  });

  async function start(routes: Route[]) {
    const metrics = createMetrics();
    lab = createLabServer({ name: 'test', routes, metrics, sink: () => undefined });
    const port = await listen(lab.server, 0, '127.0.0.1');
    return { base: `http://127.0.0.1:${port}`, metrics, lab };
  }

  // Feature: haunted-lab, Property 2
  it('counts only real routes in http_requests_total, with template labels', async () => {
    const { base } = await start([
      { method: 'POST', path: '/checkout', handler: async (ctx) => ({ status: 200, body: await ctx.readJson() }) },
    ]);
    // Initialised at 0 before any traffic, so a healthy error ratio is 0 instead of empty.
    const fresh = await (await fetch(`${base}/metrics`)).text();
    expect(fresh).toContain('http_requests_total{route="/checkout",code="200"} 0');
    expect(fresh).toContain('http_requests_total{route="/checkout",code="500"} 0');
    expect(fresh).not.toContain('route="/healthz"');
    await fetch(`${base}/healthz`);
    await fetch(`${base}/debug/errors`);
    await fetch(`${base}/debug/logs`);
    await fetch(`${base}/random/${'x'.repeat(30)}`);
    await fetch(`${base}/checkout`, { method: 'POST', body: '{"a":1}' });
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain('http_requests_total{route="unmatched",code="404"} 1');
    expect(text).toContain('http_requests_total{route="/checkout",code="200"} 1');
    expect(text).not.toContain('healthz');
    expect(text).not.toContain('route="/metrics"');
    expect(text).not.toContain('route="/debug');
    expect(text).not.toMatch(/\nup[ {]/);
    expect(text).toContain('http_request_duration_seconds_bucket{le="0.025",route="/checkout"}');
  });

  it('answers 405 with allow, 413 for big bodies, 400 for bad JSON and rings only 5xx', async () => {
    const { base, lab: l } = await start([
      { method: 'POST', path: '/echo', handler: async (ctx) => ({ status: 200, body: await ctx.readJson() }) },
      {
        method: 'POST',
        path: '/boom',
        handler: () => {
          throw new Error('kaboom');
        },
      },
    ]);
    const wrong = await fetch(`${base}/echo`);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
    expect((await fetch(`${base}/echo`, { method: 'POST', body: 'x'.repeat(9000) })).status).toBe(413);
    expect((await fetch(`${base}/echo`, { method: 'POST', body: '{bad' })).status).toBe(400);
    expect(l.errors.size).toBe(0);
    const boom = await fetch(`${base}/boom`, { method: 'POST', body: '{}', headers: { 'x-request-id': 'req_1' } });
    expect(boom.status).toBe(500);
    expect(boom.headers.get('x-request-id')).toBe('req_1');
    expect(await boom.text()).not.toContain('kaboom');
    const errors = (await (await fetch(`${base}/debug/errors`)).json()) as { items: { message: string; frame: string; requestId: string }[] };
    expect(errors.items).toHaveLength(1);
    expect(errors.items[0]).toMatchObject({ message: 'kaboom', requestId: 'req_1' });
    expect(errors.items[0]?.frame).toContain('at ');
    expect((await fetch(`${base}/debug/errors`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/debug/logs?limit=0`)).status).toBe(400);
    const logs = await (await fetch(`${base}/debug/logs?limit=3`)).json();
    expect((logs as { items: unknown[] }).items.length).toBeLessThanOrEqual(3);
  });

  it('never logs request bodies', async () => {
    const { base, lab: l } = await start([{ method: 'POST', path: '/echo', handler: async (ctx) => ({ status: 200, body: await ctx.readJson() }) }]);
    await fetch(`${base}/echo`, { method: 'POST', body: '{"secret":"hunter2"}' });
    expect(JSON.stringify(l.logs.latest())).not.toContain('hunter2');
  });

  it('callJson maps failures and timeouts to 502', async () => {
    const { base } = await start([
      { method: 'POST', path: '/ok', handler: () => ({ status: 200, body: { fine: true } }) },
      { method: 'POST', path: '/bad', handler: () => ({ status: 500, body: {} }) },
      { method: 'POST', path: '/slow', handler: async () => { await new Promise((r) => setTimeout(r, 300)); return { status: 200, body: {} }; } },
    ]);
    expect(await callJson(`${base}/ok`, {}, { requestId: 'a' })).toEqual({ fine: true });
    await expect(callJson(`${base}/bad`, {}, { requestId: 'a' })).rejects.toMatchObject({ status: 502 });
    await expect(callJson(`${base}/slow`, {}, { requestId: 'a', timeoutMs: 50 })).rejects.toMatchObject({ status: 502 });
    await expect(callJson('http://127.0.0.1:1/x', {}, { requestId: 'a' })).rejects.toMatchObject({ status: 502 });
  });
});
