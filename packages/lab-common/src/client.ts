import { Agent, request } from 'node:http';
import { HttpError } from './errors.ts';

// Built on node:http rather than fetch: on macOS, undici adds ~300 ms when it reuses an
// idle keep-alive socket, which would hide the planted latency signal under noise.
const agent = new Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 1000 });

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** Minimal HTTP client (http: only). Rejects with the underlying error on network failure or timeout. */
export function httpRequest(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'http:') {
      reject(new Error('only http: URLs are supported'));
      return;
    }
    const headers: Record<string, string | number> = { ...opts.headers };
    if (opts.body !== undefined) headers['content-length'] = Buffer.byteLength(opts.body);
    const req = request(
      { hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: opts.method ?? 'GET', headers, agent },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    const timeoutMs = opts.timeoutMs ?? 3000;
    const timer = setTimeout(() => {
      const e = new Error('request timed out');
      e.name = 'TimeoutError';
      req.destroy(e);
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end(opts.body);
  });
}

export interface CallOptions {
  requestId: string;
  timeoutMs?: number;
}

/** POST JSON to a downstream service. Any failure, non-2xx or timeout becomes a 502 HttpError. */
export async function callJson(url: string, body: unknown, opts: CallOptions): Promise<unknown> {
  const target = new URL(url).pathname;
  let res: HttpResponse;
  try {
    res = await httpRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': opts.requestId },
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs ?? 3000,
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new HttpError(502, 'bad_gateway', `downstream ${target} ${timedOut ? 'timed out' : 'unreachable'}`);
  }
  if (res.status < 200 || res.status > 299) {
    throw new HttpError(502, 'bad_gateway', `downstream ${target} answered ${res.status}`);
  }
  try {
    return JSON.parse(res.text) as unknown;
  } catch {
    throw new HttpError(502, 'bad_gateway', `downstream ${target} sent invalid JSON`);
  }
}
