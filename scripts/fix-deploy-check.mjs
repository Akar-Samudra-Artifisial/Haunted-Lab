#!/usr/bin/env node
// Fix-deploy check (used by the Haunted Ops G-MVP gate): deploy a real merged fix and prove that
// it ends its scenario. Given REF (incident/<cuid>) and SHA (the merged head):
//   1. fetch only that ref from the origin into a temp bare repo and find the pinned scenario head
//      the fix sits on (scripts/scenario-shas.json);
//   2. start a supervisor on this checkout with a temp data dir (its own mirror, worktrees and
//      deploy log), throwaway tokens it never prints, no background traffic;
//   3. apply that scenario and check it is broken; POST /chaos/deploy-fix; check the signal is
//      healthy again; reset; print a table; exit 0 (pass) or 1 (fail).
// It never pushes, never touches this checkout's refs or worktrees, and stops everything it started.
//
// Usage: REF=incident/<cuid> SHA=<40 hex> node scripts/fix-deploy-check.mjs
//   LAB_ORIGIN_URL overrides the origin (default: the public GitHub repo); it is validated with the
//   supervisor's own validator before anything is fetched.
//        CANARY=1 node scripts/fix-deploy-check.mjs
//   Isolation canary, local only: deploys a fix from a temp origin whose code tries forbidden
//   things at boot; passes only if each is denied (signalling the parent is a WARN in dev mode).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_ORIGIN_URL as DEFAULT_ORIGIN, parseOriginUrl } from '../supervisor/src/origin.ts';
import { CANARY_FILE, CANARY_PREFIX, canarySource, evaluateCanary, withCanaryImport } from './canary.mjs';
import { git, labRepoChoice, SCENARIO_PATCHES } from './lab-git.mjs';

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INCIDENT_REF = /^incident\/c[a-z0-9]{24}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const PORTS = { supervisor: 4100, gate: 4001, orders: 4002, payments: 4003, ledger: 4004 };

const log = (line) => process.stdout.write(`[fix-check] ${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portFree = (port) =>
  new Promise((r) => {
    const s = createServer();
    s.once('error', () => r(false));
    s.listen(port, '127.0.0.1', () => s.close(() => r(true)));
  });

async function http(method, url, { token, body, timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

async function waitHealthy(port, seconds) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

/** Counters of one route from a service's /metrics. */
async function routeStats(port, route) {
  const text = (await http('GET', `http://127.0.0.1:${port}/metrics`)).text;
  const esc = route.replaceAll('/', '\\/');
  let total = 0;
  let errors = 0;
  for (const m of text.matchAll(new RegExp(`^http_requests_total\\{route="${esc}",code="(\\d+)"\\} (\\d+)$`, 'gm'))) {
    total += Number(m[2]);
    if (m[1].startsWith('5')) errors += Number(m[2]);
  }
  const buckets = new Map();
  for (const m of text.matchAll(new RegExp(`^http_request_duration_seconds_bucket\\{le="([^"]+)",route="${esc}"\\} (\\d+)$`, 'gm'))) buckets.set(m[1], Number(m[2]));
  return { total, errors, buckets };
}

/** Send `n` synthetic requests to one service route, then measure from /metrics deltas. */
async function measure(port, route, makeBody, n) {
  const before = await routeStats(port, route);
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', body: JSON.stringify(makeBody(i)), signal: AbortSignal.timeout(15_000) })
        .then((r) => r.arrayBuffer())
        .catch(() => undefined),
    ),
  );
  const after = await routeStats(port, route);
  const total = after.total - before.total;
  const ratio = (after.errors - before.errors) / Math.max(1, total);
  const le = (b) => (after.buckets.get(b) ?? 0) - (before.buckets.get(b) ?? 0);
  const share = (b) => le(b) / Math.max(1, total);
  // p95 upper bound from the histogram: the smallest bucket holding 95 % of the requests.
  const bounds = [...after.buckets.keys()].filter((b) => b !== '+Inf').map(Number).sort((a, b) => a - b);
  const p95 = bounds.find((b) => share(String(b)) >= 0.95) ?? Number.POSITIVE_INFINITY;
  return { total, ratio, p95 };
}

const orderBody = (i) => ({ orderId: `o-chk-${i}-${randomBytes(3).toString('hex')}`, sku: 'lantern', qty: 1, amountCents: 500 });
const chargeBody = (i) => ({ orderId: `o-chk-${i}-${randomBytes(3).toString('hex')}`, amountCents: 500 });

const SIGNALS = {
  'error-spike': {
    service: 'payments',
    name: 'payments 5xx ratio',
    probe: async () => (await measure(PORTS.payments, '/payments/charge', chargeBody, 200)).ratio,
    broken: (v) => v > 0.2,
    healthy: (v) => v < 0.01,
  },
  fog: {
    service: 'orders',
    name: 'orders p95 (s, histogram bound)',
    probe: async () => (await measure(PORTS.orders, '/orders', orderBody, 20)).p95,
    broken: (v) => v > 1,
    healthy: (v) => v <= 0.25,
  },
  'dark-room': {
    service: 'ledger',
    name: 'ledger healthz (1 = up)',
    probe: async () => ((await waitHealthy(PORTS.ledger, 8)) ? 1 : 0),
    broken: (v) => v === 0,
    healthy: (v) => v === 1,
  },
};

/** Start a supervisor on this checkout with its own temp data dir; registers its stop in `cleanup`. */
async function startLab(tmp, origin, allowFile, cleanup, extraEnv = {}) {
  const chaosToken = randomBytes(24).toString('hex');
  const readToken = randomBytes(24).toString('hex');
  const out = [];
  const sup = spawn(process.execPath, [join(CHECKOUT, 'supervisor', 'src', 'main.ts')], {
    cwd: CHECKOUT,
    env: {
      PATH: process.env.PATH,
      CHAOS_TOKEN: chaosToken,
      LAB_READ_TOKEN: readToken,
      SUPERVISOR_PORT: String(PORTS.supervisor),
      GATE_PORT: String(PORTS.gate),
      ORDERS_PORT: String(PORTS.orders),
      PAYMENTS_PORT: String(PORTS.payments),
      LEDGER_PORT: String(PORTS.ledger),
      TRAFFIC_RPS: '0',
      LAB_REPO_DIR: CHECKOUT,
      LAB_DATA_DIR: join(tmp, 'data'),
      LAB_WORKTREES_DIR: join(tmp, 'worktrees'),
      LAB_ECHO_CHILD_OUTPUT: '0',
      LAB_ORIGIN_URL: origin,
      ...(allowFile ? { LAB_ALLOW_FILE_ORIGIN: '1' } : {}),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  sup.stdout.on('data', (c) => out.push(String(c)));
  sup.stderr.on('data', (c) => out.push(String(c)));
  const closed = new Promise((r) => sup.once('close', r));
  cleanup.push(async () => {
    if (sup.exitCode === null && sup.signalCode === null) {
      sup.kill('SIGTERM');
      await Promise.race([closed, sleep(10_000).then(() => sup.kill('SIGKILL'))]);
    }
  });
  const base = `http://127.0.0.1:${PORTS.supervisor}`;
  const t0 = Date.now();
  while (!(await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false))) {
    if (sup.exitCode !== null || Date.now() - t0 > 60_000) throw new Error(`supervisor did not start:\n${out.join('').slice(-2000)}`);
    await sleep(250);
  }
  if (!(await waitHealthy(PORTS.gate, 30))) throw new Error('services did not come up');
  return { base, chaosToken, readToken, output: () => out.join('') };
}

/** Fix mode: the real merged fix REF/SHA ends its scenario. */
async function fixMode(ref, sha, origin, allowFile, record, tmp, cleanup, rows) {
  // 1. Which pinned scenario head does the fix sit on? Fetch only that ref into a temp bare repo.
  const probe = join(tmp, 'probe.git');
  const env = { GIT_ALLOW_PROTOCOL: allowFile ? 'https:file' : 'https' };
  await git(tmp, ['init', '--bare', '-q', '--', probe]);
  await git(probe, ['fetch', '-q', '--no-tags', '--no-recurse-submodules', '--end-of-options', CHECKOUT, ...SCENARIO_PATCHES.map((s) => `+refs/heads/${s.branch}:refs/heads/${s.branch}`)]);
  await git(probe, ['fetch', '-q', '--no-tags', '--no-recurse-submodules', '--end-of-options', origin, `+refs/heads/${ref}:refs/heads/${ref}`], { env });
  const head = await git(probe, ['rev-parse', '--verify', `refs/heads/${ref}^{commit}`]);
  if (head !== sha) throw new Error(`SHA is not the head of ${ref}`);
  const firstParents = (await git(probe, ['rev-list', '--first-parent', '--max-count=21', sha])).split('\n');
  const scenario = SCENARIO_PATCHES.find((s) => firstParents.includes(record.shas[s.name]));
  if (!scenario) throw new Error('the fix does not sit on a pinned scenario head');
  const signal = SIGNALS[scenario.name];
  log(`fix ${sha.slice(0, 12)} on ${ref} sits on scenario ${scenario.name} (${signal.service})`);

  // 2. Supervisor with its own data dir, on this checkout.
  const { base, chaosToken, readToken } = await startLab(tmp, origin, allowFile, cleanup);

  // 3. Broken, fixed, reset.
  const applied = await http('POST', `${base}/chaos/scenarios/${scenario.name}/apply`, { token: chaosToken });
  if (applied.status !== 200) throw new Error(`apply answered ${applied.status}`);
  if (scenario.name !== 'dark-room') await waitHealthy(PORTS[signal.service], 20);
  else await sleep(3000);
  const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(3));
  const brokenValue = await signal.probe();
  rows.push(['scenario applied', signal.name, fmt(brokenValue), signal.broken(brokenValue) ? 'broken (expected)' : 'NOT BROKEN']);

  const t1 = Date.now();
  const res = await http('POST', `${base}/chaos/deploy-fix`, { token: chaosToken, body: { service: signal.service, ref, sha }, timeoutMs: 120_000 });
  const deploySecs = ((Date.now() - t1) / 1000).toFixed(1);
  rows.push(['deploy-fix', `HTTP ${res.status}`, res.json?.deployId ?? res.json?.error?.code ?? '', `${deploySecs} s`]);
  if (res.status !== 200) throw new Error(`deploy-fix answered ${res.status} ${res.json?.error?.code ?? ''}`);
  await waitHealthy(PORTS[signal.service], 30);
  const fixedValue = await signal.probe();
  const fixed = signal.healthy(fixedValue);
  rows.push(['fix deployed', signal.name, fmt(fixedValue), fixed ? 'healthy' : 'STILL BROKEN']);

  const deploys = await http('GET', `${base}/lab/deploys`, { token: readToken });
  const last = deploys.json?.items?.at(-1);
  const recorded = last?.actor === 'exorcist' && last?.ref === ref && last?.sha === sha;
  rows.push(['deploy record', 'actor exorcist, ref, sha', recorded ? (last?.id ?? '') : 'missing', recorded ? 'ok' : 'MISSING']);

  const allMain = await resetToMain(base, chaosToken, rows);
  return signal.broken(brokenValue) && fixed && recorded && allMain;
}

async function resetToMain(base, chaosToken, rows) {
  const reset = await http('POST', `${base}/chaos/reset`, { token: chaosToken });
  const state = await http('GET', `${base}/chaos/state`, { token: chaosToken });
  const allMain = reset.status === 200 && state.json?.services?.every((s) => s.ref === 'main');
  rows.push(['reset', 'all services on main', String(allMain), allMain ? 'ok' : 'FAILED']);
  return allMain;
}

/**
 * Canary mode (CANARY=1): in a temp local origin, a fix on `main` adds a payments module that tries
 * at boot what hostile fix code would try, and logs the results. Never touches GitHub.
 */
async function canaryMode(tmp, cleanup, rows) {
  const origin = join(tmp, 'canary-origin.git');
  await git(tmp, ['clone', '--bare', '-q', '--', CHECKOUT, origin]);
  const empty = join(tmp, 'empty-work-tree');
  await mkdir(empty);
  const main = await git(origin, ['rev-parse', '--verify', 'refs/heads/main^{commit}']);
  const env = { GIT_INDEX_FILE: join(tmp, 'canary-index'), GIT_WORK_TREE: empty };
  await git(origin, ['read-tree', main], { env });
  const add = async (path, content) => {
    const blob = await git(origin, ['hash-object', '-w', '--no-filters', '--stdin'], { input: content });
    await git(origin, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
  };
  await add(CANARY_FILE, canarySource(join(CHECKOUT, '.env')));
  await add('services/payments/src/main.ts', withCanaryImport(await git(origin, ['show', `${main}:services/payments/src/main.ts`], { raw: true })));
  const tree = await git(origin, ['write-tree'], { env });
  const when = '@1767225600 +0000';
  const sha = await git(origin, ['commit-tree', '--no-gpg-sign', tree, '-p', main, '-m', 'isolation canary'], {
    env: { GIT_AUTHOR_NAME: 'Canary', GIT_AUTHOR_EMAIL: 'canary@example.invalid', GIT_COMMITTER_NAME: 'Canary', GIT_COMMITTER_EMAIL: 'canary@example.invalid', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
  const ref = `incident/c${'0'.repeat(18)}canary`;
  await git(origin, ['update-ref', `refs/heads/${ref}`, sha]);
  const dev = process.env.FIX_RUN_AS_USER === undefined;
  const { base, chaosToken, readToken } = await startLab(tmp, pathToFileURL(origin).href, true, cleanup, dev ? {} : { FIX_RUN_AS_USER: process.env.FIX_RUN_AS_USER });
  const res = await http('POST', `${base}/chaos/deploy-fix`, { token: chaosToken, body: { service: 'payments', ref, sha }, timeoutMs: 120_000 });
  rows.push(['canary deploy-fix', `HTTP ${res.status}`, res.json?.deployId ?? res.json?.error?.code ?? '', res.status === 200 ? 'ok' : 'FAILED']);
  if (res.status !== 200) throw new Error(`deploy-fix answered ${res.status} ${res.json?.error?.code ?? ''}`);
  let results;
  const end = Date.now() + 30_000;
  while (!results && Date.now() < end) {
    const logs = await http('GET', `${base}/lab/logs?service=payments&limit=500`, { token: readToken });
    const line = logs.json?.items?.map((i) => i.line).find((l) => l.startsWith(CANARY_PREFIX));
    if (line) results = JSON.parse(line.slice(CANARY_PREFIX.length));
    else await sleep(250);
  }
  if (!results) throw new Error('the canary did not report');
  const verdict = evaluateCanary(results, { dev });
  for (const [name, value, result] of verdict.rows) {
    rows.push([`canary ${name}`, 'attempt at boot', value, result]);
    if (result.startsWith('WARN')) log(`WARN ${name}: ${result}`);
  }
  const allMain = await resetToMain(base, chaosToken, rows);
  return verdict.ok && allMain;
}

async function main() {
  const canary = process.env.CANARY === '1';
  const ref = process.env.REF ?? '';
  const sha = process.env.SHA ?? '';
  if (!canary && (!INCIDENT_REF.test(ref) || !FULL_SHA.test(sha))) {
    process.stderr.write('usage: REF=incident/<cuid> SHA=<40 hex> node scripts/fix-deploy-check.mjs   (or CANARY=1)\n');
    return 2;
  }
  const allowFile = process.env.LAB_ALLOW_FILE_ORIGIN === '1';
  let origin;
  try {
    // Same validator as the supervisor, before anything is fetched.
    origin = parseOriginUrl(process.env.LAB_ORIGIN_URL ?? DEFAULT_ORIGIN, allowFile);
  } catch (err) {
    process.stderr.write(`[fix-check] ${err instanceof Error ? err.message : 'invalid env: LAB_ORIGIN_URL'}\n`);
    return 2;
  }
  const cleanup = [];
  /** @type {boolean} */
  let ok;
  const rows = [];
  try {
    const choice = await labRepoChoice(CHECKOUT);
    if (choice.mode !== 'branches') throw new Error(`this checkout is not pinned: ${choice.reason}`);
    const record = JSON.parse(await readFile(join(CHECKOUT, 'scripts', 'scenario-shas.json'), 'utf8'));
    for (const p of Object.values(PORTS)) if (!(await portFree(p))) throw new Error(`port ${p} on 127.0.0.1 is in use`);
    const tmp = await mkdtemp(join(tmpdir(), 'lab-fixcheck-'));
    cleanup.push(() => rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    ok = canary ? await canaryMode(tmp, cleanup, rows) : await fixMode(ref, sha, origin, allowFile, record, tmp, cleanup, rows);
  } catch (err) {
    log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    ok = false;
  } finally {
    for (const f of cleanup.reverse()) await Promise.resolve(f()).catch(() => undefined);
  }
  if (rows.length > 0) {
    const header = ['step', 'signal', 'value', 'result'];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
    const line = (cells) => `| ${cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ')} |`;
    process.stdout.write(`\n${line(header)}\n|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|\n${rows.map(line).join('\n')}\n\n`);
  }
  log(ok ? `${canary ? 'CANARY' : 'FIX DEPLOY'} CHECK PASSED` : `${canary ? 'CANARY' : 'FIX DEPLOY'} CHECK FAILED`);
  return ok ? 0 : 1;
}

process.exit(await main());
