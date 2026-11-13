import { HttpError } from '@haunted-lab/common';
import { classifyRef } from './refs.ts';
import { findScenario, type ScenarioName } from './scenarios.ts';
import { SERVICES, type Actor, type DeployRecord, type ServiceName, type ServiceState } from './types.ts';
import type { Runner } from './runner.ts';

export interface LabState {
  activeScenario: ScenarioName | null;
  services: ServiceState[];
}

export interface LabDeps {
  runners: Readonly<Record<ServiceName, Runner>>;
  /** Branch -> commit sha (undefined when the branch does not exist). */
  resolveRef(ref: string): Promise<string | undefined>;
  /** Make the commit runnable for a service; returns the service dir. */
  prepare(service: ServiceName, sha: string): Promise<string>;
  record(r: Omit<DeployRecord, 'id'>): Promise<DeployRecord>;
  /** Remove the previous worktree of a service once its child is stopped (service dir from `prepare`). */
  retire?(service: ServiceName, oldDir: string): Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
}

export const refReserved = (): HttpError =>
  new HttpError(403, 'ref_reserved', 'exorcist/* fix-branch deploys are not enabled yet');

/** Serializes every change so two calls never change the same service at once. */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#tail.then(fn, fn);
    this.#tail = p.catch(() => undefined);
    return p;
  }
}

/** Chaos controller core: which ref each service runs. Refs come only from the allow-list and the scenario table. */
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

  /** Deploy `ref` to `service` if it is not already running that exact commit. */
  async #deploy(service: ServiceName, ref: string, actor: Actor, force: boolean): Promise<DeployRecord | undefined> {
    const cls = classifyRef(ref);
    if (cls === 'reserved') throw refReserved();
    if (cls !== 'allowed') throw new HttpError(400, 'ref_denied', 'ref is not allow-listed');
    const sha = await this.#deps.resolveRef(ref);
    if (!sha) throw new HttpError(500, 'deploy_failed', `ref ${ref} does not exist in the lab repo`);
    const runner = this.#deps.runners[service];
    const current = runner.deployment;
    if (!force && current && current.ref === ref && current.sha === sha) return undefined;
    let dir: string;
    try {
      dir = await this.#deps.prepare(service, sha);
    } catch (err) {
      this.#deps.log?.(`deploy of ${service} failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      throw new HttpError(500, 'deploy_failed', 'deploy failed');
    }
    await runner.deploy({ ref, sha, dir });
    // The old child is stopped now; keep only the active worktree per service.
    if (current && current.dir !== dir && this.#deps.retire) {
      await this.#deps.retire(service, current.dir).catch((err: unknown) => {
        this.#deps.log?.(`could not remove old worktree of ${service}: ${err instanceof Error ? err.message : 'unknown error'}`);
      });
    }
    const now = (this.#deps.now?.() ?? new Date()).toISOString();
    return this.#deps.record({ service, ref, sha, time: now, actor });
  }

  /** Deploy a ref chosen in code (not from a request). Used by boot and, later, fix branches. */
  deployRef(service: ServiceName, ref: string, actor: Actor): Promise<DeployRecord | undefined> {
    return this.#mutex.run(() => this.#deploy(service, ref, actor, false));
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
      await Promise.all(SERVICES.map((s) => this.#deps.runners[s].stop()));
    });
  }
}
