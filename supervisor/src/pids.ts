import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isServiceName, type ServiceName } from './types.ts';

/** Extra argv marker on every service child, so a stale pid can be told apart from a reused one. */
export const labMarker = (service: ServiceName): string => `--lab-service=${service}`;

export type PidMap = Partial<Record<ServiceName, number>>;

/** `data/pids.json`: the live child pid of each service (each child leads its own process group). */
export class PidFile {
  readonly file: string;
  #pids: PidMap = {};
  #queue: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  set(service: ServiceName, pid: number): Promise<void> {
    this.#pids[service] = pid;
    return this.#flush();
  }

  clear(service: ServiceName, pid: number): Promise<void> {
    if (this.#pids[service] === pid) delete this.#pids[service];
    return this.#flush();
  }

  /** Atomic write (tmp + rename), serialized. */
  #flush(): Promise<void> {
    const snapshot = JSON.stringify(this.#pids);
    const run = async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, `${snapshot}\n`, 'utf8');
      await rename(tmp, this.file);
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined);
    return p;
  }
}

export async function readPidFile(file: string): Promise<PidMap> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const out: PidMap = {};
    for (const [k, v] of Object.entries(raw)) {
      if (isServiceName(k) && typeof v === 'number' && Number.isInteger(v) && v > 1) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Command line of a pid via `ps` (argument array, no shell), or undefined if it is gone. */
export function commandOf(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5000 }, (err, stdout) => {
      const out = String(stdout).trim();
      resolve(err || out === '' ? undefined : out);
    });
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Signal a whole process group, falling back to the pid itself. */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export interface KillStaleOptions {
  commandOf?: (pid: number) => Promise<string | undefined>;
  graceMs?: number;
}

/**
 * Before binding ports: stop children a previous supervisor left behind (e.g. after SIGKILL).
 * A pid is only signalled if its command line still is that lab service (`src/main.ts` plus the
 * `--lab-service=<name>` marker); a pid reused by another program is left alone.
 * Returns the services whose stale child was stopped.
 */
export async function killStale(file: string, opts: KillStaleOptions = {}): Promise<ServiceName[]> {
  const pids = await readPidFile(file);
  const lookup = opts.commandOf ?? commandOf;
  const killed: ServiceName[] = [];
  for (const [service, pid] of Object.entries(pids) as [ServiceName, number][]) {
    const cmd = await lookup(pid);
    if (!cmd || !cmd.includes('src/main.ts') || !cmd.split(/\s+/).includes(labMarker(service))) continue;
    killGroup(pid, 'SIGTERM');
    const end = Date.now() + (opts.graceMs ?? 5000);
    while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    if (alive(pid)) killGroup(pid, 'SIGKILL');
    killed.push(service);
  }
  await writeFile(file, '{}\n', 'utf8').catch(() => undefined);
  return killed;
}
