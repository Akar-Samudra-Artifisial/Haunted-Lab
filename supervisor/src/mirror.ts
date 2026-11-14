// The bare mirror `data/repo.git`: the only repo the supervisor deploys from, diffs from and
// fetches into. Seeded from the source checkout (`main`, `scenario/*`) at every start; fetches
// only the one requested `incident/*` ref from the public origin. The source checkout is never
// fetched into and never changed.
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from '@haunted-lab/common';
import { INCIDENT_REF } from './fix-contract.ts';
import { git, GitError, gitOk, isAncestor, revParseBranch } from './git.ts';
import { ALLOW_LIST } from './refs.ts';
import { SCENARIOS } from './scenarios.ts';

export const FETCH_TIMEOUT_MS = 30_000;
export const GC_TIMEOUT_MS = 60_000;
export const MAX_INCIDENT_REFS = 50;
/** Requests that may wait for the fetch lock (besides the running one); more get 503 `busy`. */
export const MAX_FETCH_WAITING = 4;
/** Incident refs fetched this recently are never pruned (a request may be between fetch and deploy). */
export const PRUNE_PROTECT_MS = 10 * 60 * 1000;
export const INCIDENT_REFSPEC = '+refs/heads/incident/*:refs/heads/incident/*';

export interface PlantRecord {
  base: string;
  shas: Record<string, string>;
}

export interface MirrorOptions {
  dataDir: string;
  /** Source checkout: seeds `main` and `scenario/*`, holds `scripts/scenario-shas.json`. */
  source: string;
  originUrl: string;
  allowFileOrigin: boolean;
  log?: (line: string) => void;
  /** Tests only: a smaller incident ref limit. */
  maxIncidentRefs?: number;
  now?: () => number;
}

/** One lock for fetches: a second request waits for the first fetch to finish; at most `maxWaiting` wait. */
export class BoundedLock {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  readonly maxWaiting: number;
  constructor(maxWaiting: number) {
    this.maxWaiting = maxWaiting;
  }
  /** Requests running or waiting. */
  get pending(): number {
    return this.#pending;
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    // One may run; `maxWaiting` may wait behind it.
    if (this.#pending > this.maxWaiting) return Promise.reject(new HttpError(503, 'busy', 'too many fix deploys waiting'));
    this.#pending++;
    const task = async () => {
      try {
        return await fn();
      } finally {
        this.#pending--;
      }
    };
    const p = this.#tail.then(task, task);
    this.#tail = p.catch(() => undefined);
    return p;
  }
}

/**
 * Which incident refs to delete: keep the `keep` newest by fetch time (ties by name), every
 * protected one, and every one fetched within `recentMs` of `now` (a request may sit between its
 * fetch and its deploy; pruning its ref would turn a 200/409 into a false 404).
 */
export function planIncidentPrune(
  fetchedAt: Readonly<Record<string, string>>,
  present: readonly string[],
  keep = MAX_INCIDENT_REFS,
  protect: ReadonlySet<string> = new Set(),
  now = Date.now(),
  recentMs = PRUNE_PROTECT_MS,
): string[] {
  const recent = (r: string) => {
    const t = Date.parse(fetchedAt[r] ?? '');
    return Number.isFinite(t) && now - t < recentMs;
  };
  const refs = [...new Set(present)].filter((r) => INCIDENT_REF.test(r));
  const order = [...refs].sort((a, b) => {
    const ta = fetchedAt[a] ?? '';
    const tb = fetchedAt[b] ?? '';
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const kept = new Set(order.slice(0, keep));
  return order.filter((r) => !kept.has(r) && !protect.has(r) && !recent(r));
}

/** Same rule as `verifyPlantRecord` in scripts/lab-git.mjs, with our timed git runner. */
export async function verifyRecordIn(repo: string, record: PlantRecord): Promise<string[]> {
  const problems: string[] = [];
  const main = await revParseBranch(repo, 'main');
  if (!main || !(await isAncestor(repo, record.base, main))) problems.push('record.base is not an ancestor of main');
  for (const s of Object.values(SCENARIOS)) {
    const sha = await revParseBranch(repo, s.ref);
    if (!sha || sha !== record.shas[s.name]) {
      problems.push(`${s.ref} does not match the record`);
      continue;
    }
    const parents = (await gitOk(repo, ['rev-list', '--parents', '-n', '1', sha])).split(' ').slice(1);
    if (parents.length !== 1 || parents[0] !== record.base) problems.push(`${s.ref} is not one commit on record.base`);
  }
  return problems;
}

export class Mirror {
  readonly path: string;
  readonly #opts: MirrorOptions;
  readonly #lock = new BoundedLock(MAX_FETCH_WAITING);
  readonly #fetchedFile: string;
  #warnedUnpinned = false;

  constructor(opts: MirrorOptions) {
    this.#opts = opts;
    this.path = join(opts.dataDir, 'repo.git');
    this.#fetchedFile = join(opts.dataDir, 'incident-refs.json');
  }

  get #protocols(): string {
    return this.#opts.allowFileOrigin ? 'https:file' : 'https';
  }

  /** Create (if missing) and refresh the mirror. Throws on any failure: never fall back to the source. */
  async ensure(): Promise<void> {
    await mkdir(this.#opts.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.#opts.dataDir, 0o700);
    if (!existsSync(join(this.path, 'HEAD'))) {
      await gitOk(this.#opts.dataDir, ['init', '--bare', '-q', '--', this.path]);
      await gitOk(this.path, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    }
    // origin: the configured public URL, fetching only incident/* refs.
    await gitOk(this.path, ['config', 'remote.origin.url', this.#opts.originUrl]);
    await gitOk(this.path, ['config', '--replace-all', 'remote.origin.fetch', INCIDENT_REFSPEC]);
    await gitOk(this.path, ['config', 'remote.origin.tagOpt', '--no-tags']);
    // Seed the named refs from the source checkout (a local path: file protocol allowed for this call only).
    const named = ALLOW_LIST.map((r) => `+refs/heads/${r}:refs/heads/${r}`);
    await gitOk(this.path, ['fetch', '-q', '--no-tags', '--no-recurse-submodules', '--end-of-options', this.#opts.source, ...named]);
    // Only main, scenario/* and incident/<cuid> may exist locally.
    const refs = (await gitOk(this.path, ['for-each-ref', '--format=%(refname)'])).split('\n').filter(Boolean);
    for (const ref of refs) {
      const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '';
      if (ALLOW_LIST.includes(name) || INCIDENT_REF.test(name)) continue;
      await gitOk(this.path, ['update-ref', '-d', '--', ref]);
    }
  }

  /**
   * Fetch exactly `refs/heads/<ref>` from origin. 404 `unknown_ref` if origin lacks it, 503
   * `origin_unreachable` on any network error or timeout.
   */
  fetchIncident(ref: string, protect: ReadonlySet<string> = new Set()): Promise<void> {
    if (!INCIDENT_REF.test(ref)) return Promise.reject(new HttpError(400, 'bad_request', 'not an incident ref'));
    return this.#lock.run(async () => {
      const env = { GIT_ALLOW_PROTOCOL: this.#protocols };
      const unreachable = () => new HttpError(503, 'origin_unreachable', 'origin unreachable');
      let probe;
      try {
        probe = await git(this.path, ['ls-remote', '--exit-code', '--heads', '--end-of-options', 'origin', `refs/heads/${ref}`], { env, timeoutMs: FETCH_TIMEOUT_MS });
      } catch {
        throw unreachable();
      }
      if (probe.code === 2) throw new HttpError(404, 'unknown_ref', 'the ref does not exist on origin');
      if (probe.code !== 0) throw unreachable();
      let fetched;
      try {
        fetched = await git(
          this.path,
          ['fetch', '-q', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--end-of-options', 'origin', `+refs/heads/${ref}:refs/heads/${ref}`],
          { env, timeoutMs: FETCH_TIMEOUT_MS },
        );
      } catch {
        throw unreachable();
      }
      if (fetched.code !== 0) throw unreachable();
      await this.#recordFetch(ref, protect);
    });
  }

  async #recordFetch(ref: string, protect: ReadonlySet<string>): Promise<void> {
    let times: Record<string, string> = {};
    try {
      const raw = JSON.parse(await readFile(this.#fetchedFile, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) if (INCIDENT_REF.test(k) && typeof v === 'string') times[k] = v;
      }
    } catch {
      times = {};
    }
    const now = this.#opts.now?.() ?? Date.now();
    times[ref] = new Date(now).toISOString();
    const present = await this.incidentRefs();
    const pruned = planIncidentPrune(times, present, this.#opts.maxIncidentRefs ?? MAX_INCIDENT_REFS, new Set([...protect, ref]), now);
    for (const old of pruned) {
      await git(this.path, ['update-ref', '-d', '--', `refs/heads/${old}`]);
      delete times[old];
    }
    if (pruned.length > 0) {
      // Drop the objects only the pruned refs held, so the mirror's disk use stays bounded.
      const gc = await git(this.path, ['gc', '--prune=now', '--quiet'], { timeoutMs: GC_TIMEOUT_MS }).catch(() => undefined);
      if (!gc || gc.code !== 0) this.#opts.log?.('git gc on the mirror failed (ignored)');
    }
    for (const k of Object.keys(times)) if (!present.includes(k)) delete times[k];
    const tmp = `${this.#fetchedFile}.tmp`;
    await writeFile(tmp, `${JSON.stringify(times)}\n`, { mode: 0o600 });
    await rename(tmp, this.#fetchedFile);
  }

  refHead(ref: string): Promise<string | undefined> {
    return revParseBranch(this.path, ref);
  }

  async incidentRefs(): Promise<string[]> {
    const out = await gitOk(this.path, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/incident/']);
    return out.split('\n').filter((r) => INCIDENT_REF.test(r));
  }

  /** Heads of the local incident refs (for the diff route). */
  async incidentTips(): Promise<string[]> {
    const out = await gitOk(this.path, ['for-each-ref', '--format=%(objectname)', 'refs/heads/incident/']);
    return out.split('\n').filter((s) => /^[0-9a-f]{40}$/.test(s));
  }

  /**
   * Allowed bases for a fix. With `scripts/scenario-shas.json` in the source: the recorded scenario
   * SHAs plus the mirror's `main`, only if the record verifies (else 503 `lab_not_pinned`).
   * Without it (snapshot repos): the four named heads as found, logged once as not pinned.
   */
  async allowedHeads(): Promise<{ heads: string[]; pinned: boolean }> {
    const recordFile = join(this.#opts.source, 'scripts', 'scenario-shas.json');
    if (existsSync(recordFile)) {
      let record: PlantRecord;
      try {
        record = JSON.parse(readFileSync(recordFile, 'utf8')) as PlantRecord;
      } catch {
        throw new HttpError(503, 'lab_not_pinned', 'scenario-shas.json is unreadable');
      }
      let problems: string[];
      try {
        problems = await verifyRecordIn(this.path, record);
      } catch (err) {
        if (err instanceof GitError) problems = ['git failed'];
        else throw err;
      }
      if (problems.length > 0) throw new HttpError(503, 'lab_not_pinned', 'scenario branches do not match scenario-shas.json');
      const main = (await revParseBranch(this.path, 'main')) as string;
      return { heads: [main, ...Object.values(SCENARIOS).map((s) => record.shas[s.name] as string)], pinned: true };
    }
    if (!this.#warnedUnpinned) {
      this.#warnedUnpinned = true;
      this.#opts.log?.('allowed heads not pinned (no scenario-shas.json)');
    }
    const heads: string[] = [];
    for (const r of ALLOW_LIST) {
      const sha = await revParseBranch(this.path, r);
      if (sha) heads.push(sha);
    }
    return { heads, pinned: false };
  }
}
