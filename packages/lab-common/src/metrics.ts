import { Counter, Histogram, Registry } from 'prom-client';

export const DURATION_BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
export const INITIAL_CODES: readonly string[] = ['200', '500'];

export interface LabMetrics {
  registry: Registry;
  observe(route: string, code: number, seconds: number): void;
  /** Create `http_requests_total{route,code}` at 0 for codes 200 and 500 of each route. */
  init(routes: readonly string[]): void;
  render(): Promise<string>;
  contentType: string;
}

/** Only the two lab metrics. `up` comes from the Prometheus scrape, never from a service. */
export function createMetrics(): LabMetrics {
  const registry = new Registry();
  const requests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests handled',
    labelNames: ['route', 'code'],
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['route'],
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });
  return {
    registry,
    observe(route, code, seconds) {
      requests.inc({ route, code: String(code) });
      duration.observe({ route }, seconds);
    },
    init(routes) {
      for (const route of routes) for (const code of INITIAL_CODES) requests.inc({ route, code }, 0);
    },
    render: () => registry.metrics(),
    contentType: registry.contentType,
  };
}

/** Paths that never count in http_requests_total. */
export function isInfraPath(pathname: string): boolean {
  return pathname === '/metrics' || pathname === '/healthz' || pathname === '/debug' || pathname.startsWith('/debug/');
}

export interface RouteDef {
  method: string;
  path: string;
}

function matchTemplate(template: string, pathname: string): Record<string, string> | null {
  const t = template.split('/');
  const p = pathname.split('/');
  if (t.length !== p.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < t.length; i++) {
    const seg = t[i] as string;
    const val = p[i] as string;
    if (seg.startsWith('{') && seg.endsWith('}')) {
      if (val === '') return null;
      params[seg.slice(1, -1)] = decodeURIComponent(val);
    } else if (seg !== val) return null;
  }
  return params;
}

export interface RouteMatch<R extends RouteDef> {
  route?: R;
  params: Record<string, string>;
  /** Template of the path that matched, even if the method did not. */
  template: string | undefined;
  allowed: string[];
}

export function matchRoute<R extends RouteDef>(routes: readonly R[], method: string, pathname: string): RouteMatch<R> {
  let template: string | undefined;
  let params: Record<string, string> = {};
  const allowed: string[] = [];
  let found: R | undefined;
  for (const r of routes) {
    let m: Record<string, string> | null;
    try {
      m = matchTemplate(r.path, pathname);
    } catch {
      m = null; // bad percent-encoding
    }
    if (!m) continue;
    template = r.path;
    allowed.push(r.method);
    if (r.method === method && !found) {
      found = r;
      params = m;
    }
  }
  return found ? { route: found, params, template, allowed } : { params: {}, template, allowed };
}

/** The `route` label: a registered template or `unmatched`. Never a raw path. */
export function routeLabel<R extends RouteDef>(routes: readonly R[], method: string, pathname: string): string {
  return matchRoute(routes, method, pathname).template ?? 'unmatched';
}
