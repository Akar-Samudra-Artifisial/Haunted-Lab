import { join } from 'node:path';
import { closeServer, listen } from '@haunted-lab/common';
import { Lab } from './chaos.ts';
import type { SupervisorConfig } from './config.ts';
import { DeployLog } from './deploys.ts';
import { revParseBranch } from './git.ts';
import { killStale, PidFile } from './pids.ts';
import { classifyRef } from './refs.ts';
import { childEnv, dialHost, ServiceRunner } from './runner.ts';
import { createSupervisorServer } from './server.ts';
import { TrafficGenerator } from './traffic.ts';
import { SERVICES, type ServiceName } from './types.ts';
import { cleanWorktrees, ensureWorktree, removeWorktree, worktreeOf, type WorktreeOptions } from './worktrees.ts';

/** The supervisor binds loopback only. The Haunted Ops api is its only client. */
export const SUPERVISOR_HOST = '127.0.0.1';

export interface RunningSupervisor {
  port: number;
  lab: Lab;
  traffic: TrafficGenerator;
  close(): Promise<void>;
}

export async function startSupervisor(config: SupervisorConfig, out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<RunningSupervisor> {
  const say = (l: string) => out(`[supervisor] ${l}`);
  // 1. Children a previous supervisor left behind (e.g. it was SIGKILLed) hold our ports: stop them first.
  const pidsFile = join(config.dataDir, 'pids.json');
  const stale = await killStale(pidsFile);
  if (stale.length > 0) say(`stopped stale children: ${stale.join(', ')}`);
  // 2. No child runs now, so no worktree is active: remove all of ours.
  const wt: WorktreeOptions = { repo: config.repo, root: config.worktreesDir, depsDir: config.depsDir };
  const removed = await cleanWorktrees(wt);
  if (removed.length > 0) say(`removed ${removed.length} stale worktree(s)`);

  const deployLog = await DeployLog.open(join(config.dataDir, 'deploys.jsonl'));
  const pids = new PidFile(pidsFile);
  const echo = config.echo ? out : undefined;
  const runners = Object.fromEntries(
    SERVICES.map((s) => [
      s,
      new ServiceRunner({
        service: s,
        env: childEnv(s, config.ports, config.bindHost),
        echo,
        onSpawn: (pid) => void pids.set(s, pid).catch(() => say('could not write pids.json')),
        onExit: (pid) => void pids.clear(s, pid).catch(() => say('could not write pids.json')),
      }),
    ]),
  ) as Record<ServiceName, ServiceRunner>;
  // Only allow-listed branch names are ever resolved.
  const resolveRef = (ref: string) => (classifyRef(ref) === 'allowed' ? revParseBranch(config.repo, ref) : Promise.resolve(undefined));
  const lab = new Lab({
    runners,
    resolveRef,
    prepare: (service, sha) => ensureWorktree(wt, service, sha),
    retire: (_service, oldDir) => removeWorktree(wt, worktreeOf(oldDir)),
    record: (r) => deployLog.append(r),
    log: say,
  });
  const host = dialHost(config.bindHost);
  const server = createSupervisorServer({
    lab,
    tokens: { chaos: config.chaosToken, read: config.readToken },
    sink: out,
    observability: {
      repo: config.repo,
      serviceBase: (s) => `http://${host}:${config.ports[s]}`,
      exits: (s) => runners[s].exits(),
      logs: (s) => runners[s].logs(),
      deploys: () => deployLog.records(),
      resolveRef,
    },
  });
  const traffic = new TrafficGenerator({ gateUrl: `http://${host}:${config.ports.gate}`, rps: config.trafficRps });
  try {
    await lab.boot();
  } catch (err) {
    await lab.stopAll();
    throw err;
  }
  const port = await listen(server.server, config.port, SUPERVISOR_HOST);
  traffic.start();
  say(`listening on ${SUPERVISOR_HOST}:${port}, traffic ${config.trafficRps} rps`);
  return {
    port,
    lab,
    traffic,
    async close() {
      traffic.stop();
      await closeServer(server.server);
      await lab.stopAll();
    },
  };
}
