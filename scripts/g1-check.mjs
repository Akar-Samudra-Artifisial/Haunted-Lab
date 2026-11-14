#!/usr/bin/env node
// Gate G1: start the supervisor and Prometheus, apply each scenario, assert within 30 s that its
// PromQL signal moves, reset, assert recovery within 30 s, print a table, exit 0 (pass) or 1 (fail).
// Everything it starts is stopped on exit. Tokens are generated per run and never printed.
//
// Usage: node scripts/g1-check.mjs
//   Uses this checkout's real scenario branches when scripts/scenario-shas.json verifies against
//   them; otherwise builds a deterministic snapshot lab repo in a temp dir and prints why.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshotRepo, git, labRepoChoice, plantScenarios } from './lab-git.mjs';

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = join(CHECKOUT, 'deploy', 'compose.yaml');
const COMPOSE_LINUX_FILE = join(CHECKOUT, 'deploy', 'compose.linux.yaml');
const PROJECT = 'haunted-lab-g1';
const PROM = 'http://127.0.0.1:9090';
const SUPERVISOR_PORT = 4100;
const SERVICE_PORTS = { gate: 4001, orders: 4002, payments: 4003, ledger: 4004 };
const WINDOW = '15s';
const DETECT_S = 30;
const RECOVER_S = 30;

const errorRatio = (svc) =>
  `(sum(rate(http_requests_total{service="${svc}",code=~"5.."}[${WINDOW}])) or vector(0)) / sum(rate(http_requests_total{service="${svc}"}[${WINDOW}]))`;
const p95 = (svc, route) =>
  `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{service="${svc}",route="${route}"}[${WINDOW}])))`;

const CHECKS = [
  { scenario: 'error-spike', signal: 'payments 5xx ratio', query: errorRatio('payments'), bad: (v) => v > 0.2, good: (v) => v < 0.05, threshold: '> 0.2' },
  { scenario: 'fog', signal: 'orders p95 (s)', query: p95('orders', '/orders'), bad: (v) => v > 1, good: (v) => v < 0.25, threshold: '> 1' },
  { scenario: 'dark-room', signal: 'ledger up', query: 'up{service="ledger"}', bad: (v) => v === 0, good: (v) => v === 1, threshold: '== 0' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => process.stdout.write(`[g1] ${line}\n`);

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    execFile(cmd, args, { cwd: CHECKOUT, timeout: opts.timeout ?? 120_000, maxBuffer: 8 * 1024 * 1024, env: opts.env ?? process.env }, (err, stdout, stderr) =>
      resolvePromise({ ok: !err, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** First working compose command: `docker compose`, `docker-compose`, `podman compose`. */
async function findCompose() {
  for (const [cmd, pre] of [['docker', ['compose']], ['docker-compose', []], ['podman', ['compose']]]) {
    if ((await run(cmd, [...pre, 'version'], { timeout: 20_000 })).ok) return { cmd, pre };
  }
  return undefined;
}

const portFree = (port) =>
  new Promise((r) => {
    const s = createServer();
    s.once('error', () => r(false));
    s.listen(port, '127.0.0.1', () => s.close(() => r(true)));
  });

async function promQuery(query) {
  const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(3000) });
  const body = await res.json();
  if (body.status !== 'success') throw new Error('query failed');
  const v = body.data.result[0]?.value?.[1];
  const n = v === undefined ? Number.NaN : Number(v);
  return n;
}

async function poll(query, pred, seconds) {
  const t0 = Date.now();
  let last = Number.NaN;
  while ((Date.now() - t0) / 1000 <= seconds) {
    last = await promQuery(query).catch(() => Number.NaN);
    if (!Number.isNaN(last) && pred(last)) return { ok: true, value: last, secs: (Date.now() - t0) / 1000 };
    await sleep(1000);
  }
  return { ok: false, value: last, secs: (Date.now() - t0) / 1000 };
}

/** Use this checkout's real scenario branches when scenario-shas.json verifies; else a snapshot repo. */
async function chooseRepo(tmp) {
  const choice = await labRepoChoice(CHECKOUT);
  if (choice.mode === 'branches') return { repo: CHECKOUT, kind: `this checkout (${choice.reason})` };
  const repo = join(tmp, 'repo');
  await buildSnapshotRepo(CHECKOUT, repo);
  await plantScenarios(repo);
  return { repo, kind: `snapshot (${choice.reason})` };
}

const fmt = (v) => (Number.isNaN(v) ? 'n/a' : Number.isInteger(v) ? String(v) : v.toFixed(3));

async function main() {
  const cleanup = [];
  let failed = false;
  const onSignal = () => {
    log('interrupted, cleaning up');
    failed = true;
    void Promise.allSettled(cleanup.reverse().map((f) => f())).then(() => process.exit(1));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    for (const p of [SUPERVISOR_PORT, ...Object.values(SERVICE_PORTS), 9090]) {
      if (!(await portFree(p))) throw new Error(`port ${p} on 127.0.0.1 is in use; stop whatever runs there first`);
    }
    const compose = await findCompose();
    if (!compose) throw new Error('no compose command found (docker compose, docker-compose or podman compose)');
    // Linux: host-network override, so the services can stay on 127.0.0.1 (see compose.linux.yaml).
    const files = process.platform === 'linux' ? [COMPOSE_FILE, COMPOSE_LINUX_FILE] : [COMPOSE_FILE];
    const composeArgs = [...compose.pre, '-p', PROJECT, ...files.flatMap((f) => ['-f', f])];
    log(`compose: ${[compose.cmd, ...compose.pre].join(' ')}`);

    const tmp = await mkdtemp(join(tmpdir(), 'lab-g1-'));
    cleanup.push(async () => {
      await rm(tmp, { recursive: true, force: true });
      // Worktrees of this run lived in tmp; drop their metadata (only entries whose dirs are gone).
      await git(CHECKOUT, ['worktree', 'prune']).catch(() => undefined);
    });
    const { repo, kind } = await chooseRepo(tmp);
    log(`lab repo: ${kind}`);

    const chaosToken = randomBytes(24).toString('hex');
    const readToken = randomBytes(24).toString('hex');
    const supOut = [];
    const sup = spawn(process.execPath, [join(CHECKOUT, 'supervisor', 'src', 'main.ts')], {
      cwd: CHECKOUT,
      env: {
        PATH: process.env.PATH,
        CHAOS_TOKEN: chaosToken,
        LAB_READ_TOKEN: readToken,
        SUPERVISOR_PORT: String(SUPERVISOR_PORT),
        GATE_PORT: String(SERVICE_PORTS.gate),
        ORDERS_PORT: String(SERVICE_PORTS.orders),
        PAYMENTS_PORT: String(SERVICE_PORTS.payments),
        LEDGER_PORT: String(SERVICE_PORTS.ledger),
        TRAFFIC_RPS: '5',
        LAB_REPO_DIR: repo,
        LAB_DATA_DIR: join(tmp, 'data'),
        LAB_WORKTREES_DIR: join(tmp, 'worktrees'),
        LAB_ECHO_CHILD_OUTPUT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    sup.stdout.on('data', (c) => supOut.push(String(c)));
    sup.stderr.on('data', (c) => supOut.push(String(c)));
    const supClosed = new Promise((r) => sup.once('close', r));
    cleanup.push(async () => {
      if (sup.exitCode === null && sup.signalCode === null) {
        sup.kill('SIGTERM');
        await Promise.race([supClosed, sleep(10_000).then(() => sup.kill('SIGKILL'))]);
      }
    });

    const chaos = async (path) => {
      const res = await fetch(`http://127.0.0.1:${SUPERVISOR_PORT}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${chaosToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status !== 200) throw new Error(`${path} answered ${res.status}`);
      return res.json();
    };

    const t0 = Date.now();
    for (;;) {
      const ok = await fetch(`http://127.0.0.1:${SUPERVISOR_PORT}/healthz`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
      if (ok) break;
      if (sup.exitCode !== null || Date.now() - t0 > 30_000) throw new Error(`supervisor did not start:\n${supOut.join('').slice(-2000)}`);
      await sleep(250);
    }
    log('supervisor up');

    log('pulling and starting Prometheus');
    const pull = await run(compose.cmd, [...composeArgs, 'pull', '-q'], { timeout: 600_000 });
    if (!pull.ok) throw new Error(`compose pull failed: ${pull.stderr.trim().split('\n').at(-1) ?? ''}`);
    cleanup.push(async () => {
      await run(compose.cmd, [...composeArgs, 'down', '-v', '--remove-orphans'], { timeout: 120_000 });
    });
    const up = await run(compose.cmd, [...composeArgs, 'up', '-d'], { timeout: 180_000 });
    if (!up.ok) throw new Error(`compose up failed: ${up.stderr.trim().split('\n').at(-1) ?? ''}`);

    const targets = await poll('count(up{job="lab"} == 1)', (v) => v === 4, 90);
    if (!targets.ok) throw new Error(`Prometheus does not see 4 targets up (saw ${fmt(targets.value)})`);
    log(`4 targets up after ${targets.secs.toFixed(1)} s`);
    const warm = await poll(`sum(rate(http_requests_total{service="gate"}[${WINDOW}]))`, (v) => v > 1, 60);
    if (!warm.ok) throw new Error('no traffic visible in Prometheus');
    for (const c of CHECKS) {
      const h = await poll(c.query, c.good, 60);
      if (!h.ok) throw new Error(`baseline not healthy for ${c.signal}: ${fmt(h.value)}`);
    }
    log('baseline healthy; running scenarios');

    const rows = [];
    for (const c of CHECKS) {
      await chaos(`/chaos/scenarios/${c.scenario}/apply`);
      const detect = await poll(c.query, c.bad, DETECT_S);
      await chaos('/chaos/reset');
      const recover = await poll(c.query, c.good, RECOVER_S);
      const pass = detect.ok && recover.ok;
      if (!pass) failed = true;
      rows.push({ c, detect, recover, pass });
      log(`${c.scenario}: ${pass ? 'PASS' : 'FAIL'}`);
      if (!recover.ok) break; // later scenarios need a healthy start
    }

    const header = ['scenario', 'signal', 'threshold', 'observed', 'detect_s', 'recovered', 'recover_s', 'result'];
    const lines = rows.map(({ c, detect, recover, pass }) => [
      c.scenario,
      c.signal,
      c.threshold,
      fmt(detect.value),
      detect.ok ? detect.secs.toFixed(1) : `>${DETECT_S}`,
      fmt(recover.value),
      recover.ok ? recover.secs.toFixed(1) : `>${RECOVER_S}`,
      pass ? 'PASS' : 'FAIL',
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
    const row = (cells) => `| ${cells.map((x, i) => x.padEnd(widths[i])).join(' | ')} |`;
    process.stdout.write(`\n${row(header)}\n|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|\n${lines.map(row).join('\n')}\n\n`);
    if (rows.length < CHECKS.length) failed = true;
  } catch (err) {
    failed = true;
    log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    for (const f of cleanup.reverse()) await Promise.resolve(f()).catch(() => undefined);
  }
  log(failed ? 'G1 FAILED' : 'G1 PASSED');
  process.exit(failed ? 1 : 0);
}

await main();
