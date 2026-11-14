import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { Ring } from '@haunted-lab/common';
import { killGroup, labMarker, type KillFn } from './pids.ts';
import type { ErrorItem, LogItem, RunStatus, ServiceName, ServiceState } from './types.ts';

export const BACKOFF_START_MS = 500;
export const BACKOFF_CAP_MS = 30_000;
export const STABLE_AFTER_MS = 60_000;
export const STOP_GRACE_MS = 5_000;
/** After SIGKILL, give up waiting for the child after this long (e.g. a child of another uid we may not signal). */
export const STOP_HARD_MS = 5_000;
export const OUTPUT_LINES = 500;
export const EXIT_EVENTS = 200;
const MAX_LINE = 2000;

/** Delay before restart number `failures` (1-based). 0 failures means "stable": the start delay. */
export function nextDelay(consecutiveFailures: number): number {
  const n = Math.max(1, Math.floor(consecutiveFailures));
  if (n > 20) return BACKOFF_CAP_MS;
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** (n - 1));
}

export interface ServicePorts {
  gate: number;
  orders: number;
  payments: number;
  ledger: number;
}

/** The ONLY env names a service child gets. No tokens, no inherited env. */
export const CHILD_ENV_NAMES: Readonly<Record<ServiceName, readonly string[]>> = Object.freeze({
  gate: ['GATE_PORT', 'SERVICE_BIND_HOST', 'ORDERS_URL'],
  orders: ['ORDERS_PORT', 'SERVICE_BIND_HOST', 'PAYMENTS_URL'],
  payments: ['PAYMENTS_PORT', 'SERVICE_BIND_HOST', 'LEDGER_URL'],
  ledger: ['LEDGER_PORT', 'SERVICE_BIND_HOST'],
});

/** Address to reach a service bound to `bindHost`. */
export const dialHost = (bindHost: string): string => (bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost);

export function childEnv(service: ServiceName, ports: ServicePorts, bindHost: string): Record<string, string> {
  const host = dialHost(bindHost);
  const all: Record<string, string> = {
    GATE_PORT: String(ports.gate),
    ORDERS_PORT: String(ports.orders),
    PAYMENTS_PORT: String(ports.payments),
    LEDGER_PORT: String(ports.ledger),
    SERVICE_BIND_HOST: bindHost,
    ORDERS_URL: `http://${host}:${ports.orders}`,
    PAYMENTS_URL: `http://${host}:${ports.payments}`,
    LEDGER_URL: `http://${host}:${ports.ledger}`,
  };
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_NAMES[service]) env[name] = all[name] as string;
  return env;
}

export interface Deployment {
  ref: string;
  sha: string;
  /** `<worktree>/services/<service>` */
  dir: string;
  /** An `incident/*` fix: started through the isolated spawn plan. */
  fix?: boolean;
}

/** How to start one child: node argv (after the node binary), env and optional uid/gid. */
export interface SpawnPlan {
  args: string[];
  env: Record<string, string>;
  uid?: number;
  gid?: number;
}

export interface RunnerOptions {
  service: ServiceName;
  env: Record<string, string>;
  /** Echo child output (prefixed) to the supervisor's stdout. */
  echo?: (line: string) => void;
  now?: () => Date;
  /** Run time after which the backoff resets. Default 60 s (tests shorten it). */
  stableAfterMs?: number;
  /** Delay before a restart. Default `nextDelay`. */
  delay?: (consecutiveFailures: number) => number;
  /** Called with the pid of each started / exited child (feeds `data/pids.json`). */
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
  /** Spawn plan for fix deployments (whitelist env, `node --permission`, optional uid/gid). Without it a fix cannot start. */
  fixPlan?: (d: Deployment) => SpawnPlan;
  /** Injected for tests: process spawning and signalling. */
  spawn?: typeof spawn;
  kill?: KillFn;
  stopGraceMs?: number;
  stopHardMs?: number;
  /** Supervisor log (EPERM and stop timeouts). */
  log?: (line: string) => void;
}

/** `stop()` gave up: the child did not exit after SIGTERM, SIGKILL and the hard deadline. */
export class StopTimeoutError extends Error {
  readonly code = 'stop_timeout';
  constructor(service: ServiceName) {
    super(`${service} did not stop after SIGKILL`);
    this.name = 'StopTimeoutError';
  }
}

export interface Runner {
  readonly service: ServiceName;
  readonly deployment: Deployment | undefined;
  deploy(d: Deployment): Promise<void>;
  stop(): Promise<void>;
  state(): ServiceState;
  logs(): LogItem[];
  exits(): ErrorItem[];
}

/** Runs one service as a child process and restarts it with backoff when it exits unexpectedly. */
export class ServiceRunner implements Runner {
  readonly service: ServiceName;
  #opts: RunnerOptions;
  #child: ChildProcess | undefined;
  #deployment: Deployment | undefined;
  #status: RunStatus = 'stopped';
  #since: Date;
  #restarts = 0;
  #failures = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #stableTimer: NodeJS.Timeout | undefined;
  #lastExit: ServiceState['lastExit'];
  #lastStderr = '';
  #output = new Ring<LogItem>(OUTPUT_LINES);
  #exits = new Ring<ErrorItem>(EXIT_EVENTS);
  #generation = 0;

  constructor(opts: RunnerOptions) {
    this.service = opts.service;
    this.#opts = opts;
    this.#since = this.#now();
  }

  #now(): Date {
    return this.#opts.now?.() ?? new Date();
  }

  get deployment(): Deployment | undefined {
    return this.#deployment;
  }

  get failures(): number {
    return this.#failures;
  }

  async deploy(d: Deployment): Promise<void> {
    if (d.fix && !this.#opts.fixPlan) throw new Error('fix deployments need an isolated spawn plan');
    await this.stop();
    this.#deployment = d;
    this.#failures = 0;
    this.#spawn();
  }

  #capture(stream: 'stdout' | 'stderr', chunk: Buffer, carry: { rest: string }) {
    const text = carry.rest + chunk.toString('utf8');
    const lines = text.split('\n');
    carry.rest = (lines.pop() ?? '').slice(0, MAX_LINE);
    for (const raw of lines) this.#line(stream, raw);
  }

  #line(stream: 'stdout' | 'stderr', raw: string) {
    const line = raw.replace(/\r$/, '').slice(0, MAX_LINE);
    if (line === '') return;
    this.#output.push({ time: this.#now().toISOString(), service: this.service, stream, line });
    if (stream === 'stderr') this.#lastStderr = line;
    this.#opts.echo?.(`[${this.service}] ${line}`);
  }

  #spawn() {
    const d = this.#deployment;
    if (!d) return;
    const gen = ++this.#generation;
    this.#status = 'starting';
    this.#since = this.#now();
    this.#lastStderr = '';
    // Own process group (detached) so the whole group can be signalled, and a marker argument so a
    // later supervisor can recognise a stale child from data/pids.json after a SIGKILL.
    let plan: SpawnPlan;
    if (d.fix) {
      if (!this.#opts.fixPlan) throw new Error('fix deployments need an isolated spawn plan');
      plan = this.#opts.fixPlan(d);
    } else {
      plan = { args: [join('src', 'main.ts'), labMarker(this.service)], env: this.#opts.env };
    }
    const child = (this.#opts.spawn ?? spawn)(process.execPath, plan.args, {
      cwd: d.dir,
      env: plan.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
      ...(plan.uid !== undefined ? { uid: plan.uid } : {}),
      ...(plan.gid !== undefined ? { gid: plan.gid } : {}),
    });
    this.#child = child;
    const pid = child.pid;
    if (pid !== undefined) this.#opts.onSpawn?.(pid);
    const out = { rest: '' };
    const err = { rest: '' };
    child.stdout?.on('data', (c: Buffer) => this.#capture('stdout', c, out));
    child.stderr?.on('data', (c: Buffer) => this.#capture('stderr', c, err));
    child.once('spawn', () => {
      if (gen === this.#generation) this.#status = 'running';
    });
    this.#stableTimer = setTimeout(() => {
      if (gen === this.#generation) this.#failures = 0;
    }, this.#opts.stableAfterMs ?? STABLE_AFTER_MS);
    this.#stableTimer.unref();
    child.once('error', () => {
      // spawn failure: handled by the 'close' event that follows
    });
    child.once('close', (code, signal) => {
      if (pid !== undefined) this.#opts.onExit?.(pid);
      if (out.rest) this.#line('stdout', out.rest);
      if (err.rest) this.#line('stderr', err.rest);
      if (gen !== this.#generation) return; // stopped on purpose / replaced
      clearTimeout(this.#stableTimer);
      this.#child = undefined;
      const time = this.#now().toISOString();
      this.#lastExit = { code, signal, time };
      this.#failures++;
      this.#restarts++;
      const why = signal ? `signal ${signal}` : `code ${code}`;
      this.#exits.push({
        time,
        service: this.service,
        message: `${this.service} exited with ${why}${this.#lastStderr ? `: ${this.#lastStderr}` : ''}`.slice(0, 500),
        frame: '',
        requestId: '',
        source: 'supervisor',
      });
      const delay = (this.#opts.delay ?? nextDelay)(this.#failures);
      this.#status = 'backoff';
      this.#since = this.#now();
      this.#opts.echo?.(`[supervisor] ${this.service} exited (${why}), restart in ${delay} ms`);
      this.#restartTimer = setTimeout(() => {
        if (gen === this.#generation) this.#spawn();
      }, delay);
    });
  }

  /**
   * Stop the child: SIGTERM, then SIGKILL after 5 s, then give up after the hard deadline and
   * reject with `StopTimeoutError` (so callers holding the Lab mutex release it instead of hanging).
   * EPERM is logged once per stop and escalation continues. Cancels any pending restart.
   */
  stop(): Promise<void> {
    this.#generation++;
    clearTimeout(this.#restartTimer);
    clearTimeout(this.#stableTimer);
    const child = this.#child;
    this.#child = undefined;
    this.#status = 'stopped';
    this.#since = this.#now();
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const pid = child.pid;
      let warned = false;
      const signal = (sig: NodeJS.Signals) => {
        const r = pid === undefined ? (child.kill(sig) ? 'sent' : 'gone') : killGroup(pid, sig, this.#opts.kill);
        if (r === 'eperm' && !warned) {
          warned = true;
          this.#opts.log?.(`not allowed to signal ${this.service} (pid ${pid}, EPERM); does the supervisor have CAP_KILL?`);
        }
      };
      let hard: NodeJS.Timeout | undefined;
      const kill = setTimeout(() => {
        signal('SIGKILL');
        hard = setTimeout(() => {
          this.#opts.log?.(`${this.service} did not exit after SIGKILL; giving up (stop_timeout)`);
          reject(new StopTimeoutError(this.service));
        }, this.#opts.stopHardMs ?? STOP_HARD_MS);
      }, this.#opts.stopGraceMs ?? STOP_GRACE_MS);
      child.once('close', () => {
        clearTimeout(kill);
        clearTimeout(hard);
        resolve();
      });
      signal('SIGTERM');
    });
  }

  state(): ServiceState {
    const s: ServiceState = {
      service: this.service,
      ref: this.#deployment?.ref ?? '',
      sha: this.#deployment?.sha ?? '',
      status: this.#status,
      restarts: this.#restarts,
      since: this.#since.toISOString(),
    };
    if (this.#lastExit) s.lastExit = this.#lastExit;
    return s;
  }

  logs(): LogItem[] {
    return this.#output.latest();
  }

  exits(): ErrorItem[] {
    return this.#exits.latest();
  }
}
