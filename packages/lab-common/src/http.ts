import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { badRequest, firstFrame, HttpError } from './errors.ts';
import { createErrorRing, createLogRing, type ErrorEntry, type LogEntry, type Ring } from './ring.ts';
import { isInfraPath, matchRoute, type LabMetrics } from './metrics.ts';

export const MAX_BODY_BYTES = 8192;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Reuse a well-formed incoming id, otherwise make a fresh one. */
export function sanitizeRequestId(value: unknown): string {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v === 'string' && REQUEST_ID.test(v)) return v;
  return `r-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

/**
 * Read a JSON body of at most `limit` bytes. Stops reading as soon as the limit is crossed
 * (413) and never buffers more than the limit plus one chunk.
 */
export async function readJsonBody(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<unknown> {
  const raw = await readRawBody(req, limit);
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw badRequest('body is not valid JSON');
  }
}

/** Read the raw body with the same limit (used where the body is ignored but still bounded). */
export function readRawBody(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.['content-length'] ?? '0');
    const tooLarge = () => new HttpError(413, 'payload_too_large', `body larger than ${limit} bytes`, { connection: 'close' });
    if (Number.isFinite(declared) && declared > limit) {
      reject(tooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > limit) {
        cleanup();
        req.pause();
        reject(tooLarge());
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = () => {
      cleanup();
      reject(badRequest('request body could not be read'));
    };
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export interface Ctx {
  method: string;
  pathname: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  requestId: string;
  log(line: string): void;
  readJson(): Promise<unknown>;
  /** Read and drop the body (still limited to the body cap). */
  discardBody(): Promise<void>;
}

export interface HandlerResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Pre-rendered text body (for /metrics). */
  text?: string;
  contentType?: string;
}

export interface Route {
  method: string;
  path: string;
  handler(ctx: Ctx): Promise<HandlerResult> | HandlerResult;
}

export interface ServerOptions {
  name: string;
  routes: Route[];
  maxBodyBytes?: number;
  metrics?: LabMetrics;
  errors?: Ring<ErrorEntry>;
  logs?: Ring<LogEntry>;
  /** Serve /healthz, /metrics, /debug/errors, /debug/logs. Default true. */
  infra?: boolean;
  /** Where log lines go besides the ring. Default stdout. */
  sink?: (line: string) => void;
  /** Extra top-level fields for error bodies on a path (e.g. `untrusted: true` on /lab). */
  errorExtras?: (pathname: string) => Record<string, unknown> | undefined;
}

export interface LabServer {
  server: Server;
  errors: Ring<ErrorEntry>;
  logs: Ring<LogEntry>;
  log(line: string): void;
  recordError(err: unknown, requestId: string): void;
}

export function parseLimit(raw: string | null, def: number, max: number): number {
  if (raw === null) return def;
  if (!/^\d{1,6}$/.test(raw)) throw badRequest('limit must be an integer');
  const n = Number(raw);
  if (n < 1 || n > max) throw badRequest(`limit must be between 1 and ${max}`);
  return n;
}

export function createLabServer(opts: ServerOptions): LabServer {
  const errors = opts.errors ?? createErrorRing();
  const logs = opts.logs ?? createLogRing();
  const limit = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const sink = opts.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const log = (line: string) => {
    const time = new Date().toISOString();
    logs.push({ time, line });
    sink(`${time} ${opts.name} ${line}`);
  };
  const recordError = (err: unknown, requestId: string) => {
    errors.push({
      time: new Date().toISOString(),
      message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      frame: firstFrame(err),
      requestId,
    });
  };

  const routes: Route[] = [...opts.routes];
  // Every app route starts with codes 200 and 500 at 0, so a healthy error ratio is 0, not empty.
  opts.metrics?.init([...new Set(opts.routes.map((r) => r.path).filter((p) => !isInfraPath(p)))]);
  if (opts.infra !== false) {
    routes.push(
      { method: 'GET', path: '/healthz', handler: () => ({ status: 200, body: { ok: true } }) },
      {
        method: 'GET',
        path: '/metrics',
        handler: async () => {
          if (!opts.metrics) throw new HttpError(404, 'not_found', 'no metrics');
          return { status: 200, text: await opts.metrics.render(), contentType: opts.metrics.contentType };
        },
      },
      {
        method: 'GET',
        path: '/debug/errors',
        handler: (ctx) => ({ status: 200, body: { items: errors.latest(parseLimit(ctx.query.get('limit'), 50, errors.capacity)) } }),
      },
      {
        method: 'GET',
        path: '/debug/logs',
        handler: (ctx) => ({ status: 200, body: { items: logs.latest(parseLimit(ctx.query.get('limit'), 100, logs.capacity)) } }),
      },
    );
  }

  const send = (res: ServerResponse, result: HandlerResult, requestId: string) => {
    const payload = result.text ?? (result.body === undefined ? '' : JSON.stringify(result.body));
    res.writeHead(result.status, {
      'content-type': result.contentType ?? 'application/json',
      'content-length': Buffer.byteLength(payload),
      'x-request-id': requestId,
      'cache-control': 'no-store',
      ...result.headers,
    });
    res.end(payload);
  };

  const server = createHttpServer((req, res) => {
    const started = process.hrtime.bigint();
    const requestId = sanitizeRequestId(req.headers['x-request-id']);
    const method = req.method ?? 'GET';
    let pathname = '/';
    let query = new URLSearchParams();
    try {
      const u = new URL(req.url ?? '/', 'http://lab.invalid');
      pathname = u.pathname;
      query = u.searchParams;
    } catch {
      // keep defaults
    }
    const match = matchRoute(routes, method, pathname);
    const label = match.template ?? 'unmatched';

    const finish = (result: HandlerResult) => {
      send(res, result, requestId);
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      if (opts.metrics && !isInfraPath(pathname)) opts.metrics.observe(label, result.status, seconds);
      if (!isInfraPath(pathname)) {
        log(`req ${method} ${label} ${result.status} ${Math.round(seconds * 1000)}ms rid=${requestId}`);
      }
      if (result.status === 413) res.once('finish', () => req.destroy());
    };

    const ctx: Ctx = {
      method,
      pathname,
      query,
      params: match.params,
      headers: req.headers,
      requestId,
      log,
      readJson: () => readJsonBody(req, limit),
      discardBody: () => readRawBody(req, limit).then(() => undefined),
    };

    void (async () => {
      try {
        if (!match.route) {
          if (match.template !== undefined) {
            throw new HttpError(405, 'method_not_allowed', 'method not allowed', { allow: [...new Set(match.allowed)].join(', ') });
          }
          throw new HttpError(404, 'not_found', 'no such route');
        }
        finish(await match.route.handler(ctx));
      } catch (err) {
        if (err instanceof HttpError) {
          if (err.status >= 500) recordError(err, requestId);
          finish({
            status: err.status,
            body: { ...opts.errorExtras?.(pathname), error: { code: err.code, message: err.message } },
            headers: err.headers,
          });
        } else {
          recordError(err, requestId);
          finish({ status: 500, body: { ...opts.errorExtras?.(pathname), error: { code: 'internal_error', message: 'internal error' } } });
        }
      }
    })();
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return { server, errors, logs, log, recordError };
}

export function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
