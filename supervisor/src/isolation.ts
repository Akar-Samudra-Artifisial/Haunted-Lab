// Isolation of fix children. Merged fixes are human-reviewed but AI-written: untrusted code.
// - env: a whitelist only, never a supervisor variable;
// - Node permission model: fs read limited to the worktree and the shared dependencies, nothing
//   else (no fs write, child process, worker, addon, WASI, FFI, inspector). `--allow-net` is all
//   or nothing: it does NOT limit destinations, so network is not a boundary here;
// - optional FIX_RUN_AS_USER: a separate OS user (EC2). Node calls its permission model a seat
//   belt, not a security boundary; on EC2 the boundary is that uid plus an owner-match firewall
//   that allows only loopback for it and blocks IMDS (set up by Haunted Ops `deploy-demo`).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { ConfigError } from '@haunted-lab/common';
import { labMarker } from './pids.ts';
import { dialHost, type ServicePorts, type SpawnPlan } from './runner.ts';
import type { ServiceName } from './types.ts';

export const FIX_PATH = '/usr/bin:/bin';

const PORT_NAME: Record<ServiceName, string> = { gate: 'GATE_PORT', orders: 'ORDERS_PORT', payments: 'PAYMENTS_PORT', ledger: 'LEDGER_PORT' };
const DOWNSTREAM: Record<ServiceName, { name: string; service: ServiceName } | undefined> = {
  gate: { name: 'ORDERS_URL', service: 'orders' },
  orders: { name: 'PAYMENTS_URL', service: 'payments' },
  payments: { name: 'LEDGER_URL', service: 'ledger' },
  ledger: undefined,
};

/** The whole env of a fix child, built from ports only. Nothing is inherited. */
export function fixChildEnv(service: ServiceName, ports: ServicePorts, bindHost: string): Record<string, string> {
  const env: Record<string, string> = {
    [PORT_NAME[service]]: String(ports[service]),
    SERVICE_BIND_HOST: bindHost,
    NODE_ENV: 'production',
    PATH: FIX_PATH,
  };
  const down = DOWNSTREAM[service];
  if (down) env[down.name] = `http://${dialHost(bindHost)}:${ports[down.service]}`;
  return env;
}

/**
 * Node argv for a fix child. fs read: the worktree, and three paths of the SOURCE checkout (not of
 * the fix's tree): `node_modules` (pnpm store), `services/<service>/node_modules` (the workspace
 * symlinks the worktree's `node_modules` link points at) and `packages/lab-common` (where
 * `@haunted-lab/common` resolves). A fix only changes files in its own worktree: the chain rule
 * allows `services/<service>/` only, and refuses manifests and any path with a `node_modules`
 * segment. `--allow-net` lets the child listen and call its downstream, but it does not restrict
 * which hosts it can reach; on EC2 the firewall rule for the fix uid does that.
 */
export function fixChildArgs(worktree: string, source: string, service: ServiceName): string[] {
  return [
    '--permission',
    `--allow-fs-read=${worktree}`,
    `--allow-fs-read=${join(source, 'node_modules')}`,
    `--allow-fs-read=${join(source, 'services', service, 'node_modules')}`,
    `--allow-fs-read=${join(source, 'packages', 'lab-common')}`,
    '--allow-net',
    '--disable-warning=ExperimentalWarning',
    join('src', 'main.ts'),
    labMarker(service),
  ];
}

export interface FixUser {
  name: string;
  uid: number;
  gid: number;
}

export function fixSpawnPlan(opts: {
  service: ServiceName;
  worktree: string;
  source: string;
  ports: ServicePorts;
  bindHost: string;
  user?: FixUser;
}): SpawnPlan {
  const plan: SpawnPlan = { args: fixChildArgs(opts.worktree, opts.source, opts.service), env: fixChildEnv(opts.service, opts.ports, opts.bindHost) };
  if (opts.user) {
    plan.uid = opts.user.uid;
    plan.gid = opts.user.gid;
  }
  return plan;
}

export const FIX_USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

const invalidUser = () => new ConfigError([], ['FIX_RUN_AS_USER']);

export type IdRunner = (args: string[]) => Promise<string>;

/** `id <args>` through execFile (argument array, timeout). */
export const runId: IdRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('id', args, { timeout: 5000, env: { PATH: FIX_PATH } }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
  });

/**
 * Resolve `FIX_RUN_AS_USER` to uid and gid. Refuses a bad name, an unknown user, root and the
 * supervisor's own uid. Errors name the variable only.
 */
export async function resolveFixUser(name: string, id: IdRunner = runId, ownUid: number = process.getuid?.() ?? -1): Promise<FixUser> {
  if (!FIX_USER_NAME.test(name)) throw invalidUser();
  let uidText: string;
  let gidText: string;
  try {
    uidText = await id(['-u', '--', name]);
    gidText = await id(['-g', '--', name]);
  } catch {
    throw invalidUser();
  }
  if (!/^\d{1,10}$/.test(uidText) || !/^\d{1,10}$/.test(gidText)) throw invalidUser();
  const uid = Number(uidText);
  const gid = Number(gidText);
  if (uid === 0 || gid === 0 || uid === ownUid) throw invalidUser();
  return { name, uid, gid };
}

export interface ProbeDeps {
  spawn?: typeof spawn;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  timeoutMs?: number;
}

export type ProbeResult = { ok: true } | { ok: false; reason: 'spawn' | 'cap_kill' };

/**
 * Startup probe for FIX_RUN_AS_USER: start a tiny idle child as that user, SIGTERM it and confirm
 * it exits. `spawn` fails without CAP_SETUID/CAP_SETGID; the signal fails (EPERM) or the child
 * stays without CAP_KILL. The child is SIGKILLed best effort on failure.
 */
export function probeFixUser(user: FixUser, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const timeoutMs = deps.timeoutMs ?? 5000;
  const kill = deps.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = (deps.spawn ?? spawn)(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        uid: user.uid,
        gid: user.gid,
        env: { PATH: FIX_PATH },
        stdio: 'ignore',
      });
    } catch {
      resolve({ ok: false, reason: 'spawn' });
      return;
    }
    let settled = false;
    const done = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) kill(child.pid, 'SIGKILL');
      } catch {
        // best effort
      }
      done({ ok: false, reason: 'cap_kill' });
    }, timeoutMs);
    child.once('error', () => done({ ok: false, reason: 'spawn' }));
    child.once('spawn', () => {
      try {
        kill(child.pid as number, 'SIGTERM');
      } catch {
        done({ ok: false, reason: 'cap_kill' });
      }
    });
    child.once('exit', (_code, signal) => done(signal === 'SIGTERM' ? { ok: true } : { ok: false, reason: 'spawn' }));
  });
}

/** Startup error for a failed probe; names variables and capabilities only. */
export function probeError(result: Exclude<ProbeResult, { ok: true }>): ConfigError {
  return new ConfigError(
    [],
    ['FIX_RUN_AS_USER'],
    result.reason === 'cap_kill'
      ? 'the supervisor cannot signal FIX_RUN_AS_USER processes (needs CAP_KILL)'
      : 'the supervisor cannot start processes as FIX_RUN_AS_USER (needs CAP_SETUID and CAP_SETGID)',
  );
}

export const NO_FIX_USER_NOTICE = "fix code runs as the supervisor's user (FIX_RUN_AS_USER not set; development only)";
export const NO_ISOLATION_NOTICE = 'fix deploys disabled: NODE_ENV=production needs FIX_RUN_AS_USER (deploy-fix answers 503 isolation_unavailable)';
