import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { closeServer, listen } from '@haunted-lab/common';
import { Lab } from './chaos.ts';
import type { SupervisorConfig } from './config.ts';
import { DeployLog } from './deploys.ts';
import { createFixDeployer } from './fix-deploy.ts';
import { revParseBranch } from './git.ts';
import { fixSpawnPlan, NO_FIX_USER_NOTICE, NO_ISOLATION_NOTICE, probeError, probeFixUser, resolveFixUser, type FixUser } from './isolation.ts';
import { Mirror } from './mirror.ts';
import { killStale, PidFile } from './pids.ts';
import { classifyRef } from './refs.ts';
import { childEnv, dialHost, ServiceRunner } from './runner.ts';
import { createSupervisorServer } from './server.ts';
import { TrafficGenerator } from './traffic.ts';
import { SERVICES, type ServiceName } from './types.ts';
import {
  ensureWorktree,
  listWorktrees,
  planWorktreeCleanup,
  removeSourceWorktrees,
  removeWorktree,
  touchWorktree,
  worktreeOf,
  type WorktreeOptions,
} from './worktrees.ts';

/** The supervisor binds loopback only. The Haunted Ops api is its only client. */
export const SUPERVISOR_HOST = '127.0.0.1';

export interface RunningSupervisor {
  port: number;
  lab: Lab;
  traffic: TrafficGenerator;
  close(): Promise<void>;
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export async function startSupervisor(config: SupervisorConfig, out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<RunningSupervisor> {
  const say = (l: string) => out(`[supervisor] ${l}`);

  // 0. Fix user (EC2): resolve and probe before anything runs; on the Mac say plainly what fix code gets.
  let fixUser: FixUser | undefined;
  if (config.fixUser !== undefined) {
    fixUser = await resolveFixUser(config.fixUser);
    const probe = await probeFixUser(fixUser);
    if (!probe.ok) throw probeError(probe);
    say(`fix code runs as a separate user (uid ${fixUser.uid})`);
  } else if (config.production) {
    say(NO_ISOLATION_NOTICE);
  } else {
    say(NO_FIX_USER_NOTICE);
  }

  // 1. Children a previous supervisor left behind (e.g. it was SIGKILLed) hold our ports: stop them first.
  const mirror = new Mirror({ dataDir: config.dataDir, source: config.repo, originUrl: config.originUrl, allowFileOrigin: config.allowFileOrigin, log: say });
  await mirror.ensure(); // creates data/ (0700) and the bare mirror, seeds main and scenario/*
  const pidsFile = join(config.dataDir, 'pids.json');
  const stale = await killStale(pidsFile, { log: say });
  if (stale.length > 0) say(`stopped stale children: ${stale.join(', ')}`);

  // 2. Worktrees: registered to the mirror. Drop any still registered to the source checkout.
  const wt: WorktreeOptions = { repo: mirror.path, root: config.worktreesDir, depsDir: config.depsDir };
  const migrated = await removeSourceWorktrees(config.repo, config.worktreesDir);
  if (migrated.length > 0) say(`removed ${migrated.length} worktree(s) registered to the source checkout`);

  const deployLog = await DeployLog.open(join(config.dataDir, 'deploys.jsonl'));
  const pids = new PidFile(pidsFile);
  const echo = config.echo ? out : undefined;
  const depsReal = real(config.depsDir);
  const runners = Object.fromEntries(
    SERVICES.map((s) => [
      s,
      new ServiceRunner({
        service: s,
        env: childEnv(s, config.ports, config.bindHost),
        echo,
        onSpawn: (pid) => void pids.set(s, pid).catch(() => say('could not write pids.json')),
        onExit: (pid) => void pids.clear(s, pid).catch(() => say('could not write pids.json')),
        log: say,
        fixPlan: (d) =>
          fixSpawnPlan({
            service: s,
            worktree: real(worktreeOf(d.dir)),
            source: depsReal,
            ports: config.ports,
            bindHost: config.bindHost,
            ...(fixUser ? { user: fixUser } : {}),
          }),
      }),
    ]),
  ) as Record<ServiceName, ServiceRunner>;

  const activeNames = () =>
    new Set(
      SERVICES.map((s) => runners[s].deployment)
        .filter((d) => d !== undefined)
        .map((d) => worktreeOf(d.dir).slice(worktreeOf(d.dir).lastIndexOf('/') + 1)),
    );
  const cleanup = async () => {
    const heads = await mirror.allowedHeads().then(
      (h) => h.heads,
      () => [] as string[],
    );
    const plan = planWorktreeCleanup({ entries: await listWorktrees(config.worktreesDir), active: activeNames(), allowedHeads: heads, now: Date.now() });
    for (const name of plan) await removeWorktree(wt, join(config.worktreesDir, name));
    return plan;
  };
  const removed = await cleanup();
  if (removed.length > 0) say(`removed ${removed.length} stale worktree(s)`);

  // Only named branch names are resolved for boot, apply and reset.
  const resolveRef = (ref: string) => (classifyRef(ref) === 'named' ? revParseBranch(mirror.path, ref) : Promise.resolve(undefined));
  const lab = new Lab({
    runners,
    resolveRef,
    prepare: (service, sha) => ensureWorktree(wt, service, sha),
    // Named worktrees go right away; a fix worktree stays for an hour (reuse, inspection).
    retire: (_service, old) => (old.fix ? touchWorktree(config.worktreesDir, worktreeOf(old.dir)) : removeWorktree(wt, worktreeOf(old.dir))),
    afterDeploy: async () => {
      await cleanup();
    },
    findDeploy: (service, ref, sha) => [...deployLog.records()].reverse().find((r) => r.service === service && r.ref === ref && r.sha === sha),
    record: (r) => deployLog.append(r),
    log: say,
  });
  const deployFix = createFixDeployer({
    mirror,
    lab,
    // Outside development a fix never runs without its own OS user.
    isolationAvailable: !config.production || fixUser !== undefined,
    activeIncidentRefs: () => new Set(SERVICES.map((s) => runners[s].deployment?.ref ?? '').filter((r) => classifyRef(r) === 'fix')),
    log: say,
  });
  const host = dialHost(config.bindHost);
  const server = createSupervisorServer({
    lab,
    deployFix,
    tokens: { chaos: config.chaosToken, read: config.readToken },
    sink: out,
    observability: {
      repo: mirror.path,
      serviceBase: (s) => `http://${host}:${config.ports[s]}`,
      exits: (s) => runners[s].exits(),
      logs: (s) => runners[s].logs(),
      deploys: () => deployLog.records(),
      resolveRef,
      incidentTips: () => mirror.incidentTips(),
    },
  });
  const traffic = new TrafficGenerator({ gateUrl: `http://${host}:${config.ports.gate}`, rps: config.trafficRps });
  let port: number;
  try {
    await lab.boot();
    port = await listen(server.server, config.port, SUPERVISOR_HOST);
  } catch (err) {
    // Never leave started children behind (they run in their own process groups).
    await lab.stopAll();
    await pids.idle();
    throw err;
  }
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
      await pids.idle();
    },
  };
}
