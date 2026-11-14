import { HttpError } from '@haunted-lab/common';
import { classifyRef } from './refs.ts';
import { findScenario, type ScenarioName } from './scenarios.ts';
import { SERVICES, type Actor, type DeployRecord, type ServiceName, type ServiceState } from './types.ts';
import { StopTimeoutError, type Deployment, type Runner } from './runner.ts';

export interface LabState {
  activeScenario: ScenarioName | null;
  services: ServiceState[];
}

export interface LabDeps {
  runners: Readonly<Record<ServiceName, Runner>>;
  /** Named branch -> commit sha (undefined when the branch does not exist). */
  resolveRef(ref: string): Promise<string | undefined>;
  /** Make the commit runnable for a service; returns the service dir. */
  prepare(service: ServiceName, sha: string): Promise<string>;
  record(r: Omit<DeployRecord, 'id'>): Promise<DeployRecord>;
  /** Handle the previous deployment of a service once its child is stopped. */
  retire?(service: ServiceName, old: Deployment): Promise<void>;
  /** Runs after every deploy (worktree cleanup). Errors are logged, never thrown. */
  afterDeploy?(): Promise<void>;
  /** Latest Deploy Record for this service, ref and sha (idempotent fix deploys). */
  findDeploy?(service: ServiceName, ref: string, sha: string): DeployRecord | undefined;
  now?: () => Date;
  log?: (line: string) => void;
}

/** Serializes every change so two calls never change the same service at once. */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#tail.then(fn, fn);
    this.#tail = p.catch(() => undefined);
    return p;
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : 'unknown error');

/** Chaos controller core: which ref each service runs. Named refs come from the allow-list; fixes only through deployFix. */
export class Lab {
  #deps: LabDeps;
  #active: ScenarioName | null = null;
  #mutex = new Mutex();

  constructor(deps: LabDeps) {
    this.#deps = deps;
  }

  get activeScenario(): ScenarioName | null {
    return this.#active;
  }

  /** Start `d` on `service`, retire the previous deployment and record it. */
  async #start(service: ServiceName, d: Deployment, actor: Actor): Promise<DeployRecord> {
    const runner = this.#deps.runners[service];
    const current = runner.deployment;
    try {
      await runner.deploy(d);
    } catch (err) {
      if (err instanceof StopTimeoutError) throw new HttpError(500, 'stop_timeout', 'the previous child did not stop');
      throw err;
    }
    if (current && current.dir !== d.dir && this.#deps.retire) {
      await this.#deps.retire(service, current).catch((err: unknown) => this.#deps.log?.(`could not retire old worktree of ${service}: ${message(err)}`));
    }
    const record = await this.#deps.record({ service, ref: d.ref, sha: d.sha, time: (this.#deps.now?.() ?? new Date()).toISOString(), actor });
    await this.#deps.afterDeploy?.().catch((err: unknown) => this.#deps.log?.(`worktree cleanup failed: ${message(err)}`));
    return record;
  }

  /** Deploy a named ref to `service` if it is not already running that exact commit. */
  async #deploy(service: ServiceName, ref: string, actor: Actor, force: boolean): Promise<DeployRecord | undefined> {
    // Only named refs here: apply, reset and boot can never run an incident ref.
    if (classifyRef(ref) !== 'named') throw new HttpError(400, 'ref_denied', 'ref is not allow-listed');
    const sha = await this.#deps.resolveRef(ref);
    if (!sha) throw new HttpError(500, 'deploy_failed', `ref ${ref} does not exist in the lab repo`);
    const current = this.#deps.runners[service].deployment;
    if (!force && current && current.ref === ref && current.sha === sha) return undefined;
    let dir: string;
    try {
      dir = await this.#deps.prepare(service, sha);
    } catch (err) {
      this.#deps.log?.(`deploy of ${service} failed: ${message(err)}`);
      throw new HttpError(500, 'deploy_failed', 'deploy failed');
    }
    return this.#start(service, { ref, sha, dir }, actor);
  }

  /** Deploy a named ref chosen in code (not from a request). */
  deployRef(service: ServiceName, ref: string, actor: Actor): Promise<DeployRecord | undefined> {
    return this.#mutex.run(() => this.#deploy(service, ref, actor, false));
  }

  /**
   * Deploy an accepted fix under the same mutex as apply and reset. `currentHead` re-reads the
   * incident ref so a ref that moved after the check is refused (409 `not_head`). The same ref at
   * the same sha already running answers with its existing Deploy Record.
   */
  deployFix(
    service: ServiceName,
    ref: string,
    sha: string,
    currentHead: () => Promise<string | undefined>,
  ): Promise<{ record: DeployRecord; deployed: boolean }> {
    return this.#mutex.run(async () => {
      if (classifyRef(ref) !== 'fix') throw new HttpError(400, 'bad_request', 'not an incident ref');
      let head: string | undefined;
      try {
        head = await currentHead();
      } catch {
        throw new HttpError(503, 'deploy_failed', 'could not read the incident ref');
      }
      if (head !== sha) throw new HttpError(409, 'not_head', 'sha is not the head of the ref');
      const current = this.#deps.runners[service].deployment;
      if (current && current.ref === ref && current.sha === sha) {
        const existing = this.#deps.findDeploy?.(service, ref, sha);
        if (existing) return { record: existing, deployed: false };
      }
      let dir: string;
      try {
        dir = await this.#deps.prepare(service, sha);
      } catch (err) {
        this.#deps.log?.(`fix deploy of ${service} failed: ${message(err)}`);
        throw new HttpError(503, 'deploy_failed', 'deploy failed');
      }
      try {
        const record = await this.#start(service, { ref, sha, dir, fix: true }, 'exorcist');
        return { record, deployed: true };
      } catch (err) {
        this.#deps.log?.(`fix deploy of ${service} failed: ${message(err)}`);
        throw new HttpError(503, 'deploy_failed', 'deploy failed');
      }
    });
  }

  /** Boot: `main` for every service, recorded with actor `supervisor`. */
  boot(): Promise<DeployRecord[]> {
    return this.#mutex.run(async () => {
      const out: DeployRecord[] = [];
      // Downstream first so the chain is up when traffic starts.
      for (const s of [...SERVICES].reverse()) {
        const r = await this.#deploy(s, 'main', 'supervisor', true);
        if (r) out.push(r);
      }
      this.#active = null;
      return out;
    });
  }

  apply(name: string): Promise<{ scenario: ScenarioName; deploys: DeployRecord[]; state: LabState }> {
    const scenario = findScenario(name);
    if (!scenario) return Promise.reject(new HttpError(404, 'unknown_scenario', 'unknown scenario'));
    return this.#mutex.run(async () => {
      const deploys: DeployRecord[] = [];
      for (const s of [...SERVICES].reverse()) {
        const ref = s === scenario.service ? scenario.ref : 'main';
        const r = await this.#deploy(s, ref, 'chaos', false);
        if (r) deploys.push(r);
      }
      this.#active = scenario.name;
      return { scenario: scenario.name, deploys, state: this.state() };
    });
  }

  reset(): Promise<{ deploys: DeployRecord[]; state: LabState }> {
    return this.#mutex.run(async () => {
      const deploys: DeployRecord[] = [];
      for (const s of [...SERVICES].reverse()) {
        const r = await this.#deploy(s, 'main', 'chaos', false);
        if (r) deploys.push(r);
      }
      this.#active = null;
      return { deploys, state: this.state() };
    });
  }

  state(): LabState {
    return { activeScenario: this.#active, services: SERVICES.map((s) => this.#deps.runners[s].state()) };
  }

  stopAll(): Promise<void> {
    return this.#mutex.run(async () => {
      // A child that cannot be stopped (stop_timeout) must not keep the others running.
      const results = await Promise.allSettled(SERVICES.map((s) => this.#deps.runners[s].stop()));
      for (const r of results) if (r.status === 'rejected') this.#deps.log?.(`stop failed: ${message(r.reason)}`);
    });
  }
}
