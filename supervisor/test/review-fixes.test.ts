// Regression tests for fix-deploy task 11 (review fixes).
import { execFile, type spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { httpRequest, listen, closeServer } from '@haunted-lab/common';
import { Lab } from '../src/chaos.ts';
import { loadSupervisorConfig } from '../src/config.ts';
import { createFixDeployer } from '../src/fix-deploy.ts';
import { git, GIT_ENV, worktreeAdd } from '../src/git.ts';
import { probeError, probeFixUser } from '../src/isolation.ts';
import { BoundedLock, Mirror, planIncidentPrune } from '../src/mirror.ts';
import { killGroup, killStale, labMarker } from '../src/pids.ts';
import { ServiceRunner, StopTimeoutError } from '../src/runner.ts';
import { createSupervisorServer } from '../src/server.ts';
import { CHECKOUT, cuidRef, makeFixture, REFUNDS, runGit, type Fixture } from './fix-origin.ts';
import { fakeRunners } from './helpers.ts';

const run = promisify(execFile);
const dirs: string[] = [];
const fixtures: Fixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.map((f) => f.cleanup()));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const eperm = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });

/** A child that never exits on its own (it only "closes" when `exit()` is called). */
function fakeChild(pid = 4242) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => true,
    exit(signal: string) {
      child.signalCode = signal;
      child.emit('close', null, signal);
    },
  });
  return child;
}

describe('item 1: stopping a child we may not signal', () => {
  it('killGroup reports EPERM instead of swallowing it', () => {
    expect(killGroup(1, 'SIGTERM', () => {
      throw eperm();
    })).toBe('eperm');
    expect(killGroup(1, 'SIGTERM', () => {
      throw Object.assign(new Error('x'), { code: 'ESRCH' });
    })).toBe('gone');
    expect(killGroup(1, 'SIGTERM', () => undefined)).toBe('sent');
  });

  it('stop() logs EPERM once, still escalates to SIGKILL, then rejects stop_timeout; the Lab mutex is released', async () => {
    const lines: string[] = [];
    const signals: string[] = [];
    const children: ReturnType<typeof fakeChild>[] = [];
    const runner = new ServiceRunner({
      service: 'payments',
      env: {},
      log: (l) => lines.push(l),
      spawn: (() => {
        const c = fakeChild(5000 + children.length);
        children.push(c);
        setImmediate(() => c.emit('spawn'));
        return c;
      }) as unknown as typeof spawn,
      kill: (_pid, sig) => {
        signals.push(String(sig));
        throw eperm();
      },
      stopGraceMs: 30,
      stopHardMs: 60,
    });
    await runner.deploy({ ref: 'main', sha: 'a'.repeat(40), dir: '/x' });
    const t0 = Date.now();
    await expect(runner.stop()).rejects.toBeInstanceOf(StopTimeoutError);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(signals).toContain('SIGTERM');
    expect(signals).toContain('SIGKILL');
    expect(lines.filter((l) => l.includes('EPERM'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('stop_timeout'))).toBe(true);

    // In a Lab: apply fails with stop_timeout instead of hanging, and the next call still runs.
    const others = fakeRunners();
    const lab = new Lab({
      runners: { ...others, payments: runner },
      resolveRef: async (ref) => ({ main: '1'.repeat(40), 'scenario/error-spike': '2'.repeat(40) })[ref],
      prepare: async (service, sha) => `/wt/${service}@${sha}/services/${service}`,
      record: async (r) => ({ id: 'd-1', ...r }),
    });
    await runner.deploy({ ref: 'main', sha: '1'.repeat(40), dir: '/wt/payments@x/services/payments' }).catch(() => undefined);
    await expect(lab.apply('error-spike')).rejects.toMatchObject({ code: 'stop_timeout' });
    const second = await Promise.race([lab.reset().then(() => 'done', () => 'rejected'), new Promise((r) => setTimeout(() => r('hung'), 3000))]);
    expect(second).not.toBe('hung');
  });

  it('killStale logs EPERM for a stale child it may not signal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stale-'));
    dirs.push(dir);
    const file = join(dir, 'pids.json');
    await writeFile(file, JSON.stringify({ gate: process.pid }));
    const lines: string[] = [];
    await killStale(file, {
      commandOf: async () => `node src/main.ts ${labMarker('gate')}`,
      kill: (_p, sig) => {
        if (sig === 0) return;
        throw eperm();
      },
      graceMs: 50,
      log: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.includes('EPERM'))).toBe(true);
  });

  it('the FIX_RUN_AS_USER probe checks that the user can be signalled (CAP_KILL)', async () => {
    const user = { name: 'labfix', uid: 1500, gid: 1500 };
    const spawnOk = (() => {
      const c = fakeChild();
      setImmediate(() => c.emit('spawn'));
      return c;
    }) as unknown as typeof spawn;
    // The signal works: the child exits on SIGTERM.
    let child: ReturnType<typeof fakeChild> | undefined;
    const spawnTrack = ((...args: unknown[]) => {
      child = (spawnOk as unknown as (...a: unknown[]) => ReturnType<typeof fakeChild>)(...args);
      return child;
    }) as unknown as typeof spawn;
    await expect(probeFixUser(user, { spawn: spawnTrack, kill: () => child?.emit('exit', null, 'SIGTERM') })).resolves.toEqual({ ok: true });
    // EPERM on the signal: no CAP_KILL.
    const noKill = await probeFixUser(user, { spawn: spawnOk, kill: () => { throw eperm(); }, timeoutMs: 200 });
    expect(noKill).toEqual({ ok: false, reason: 'cap_kill' });
    // The signal is "sent" but the child never exits: also refused.
    expect(await probeFixUser(user, { spawn: spawnOk, kill: () => undefined, timeoutMs: 100 })).toEqual({ ok: false, reason: 'cap_kill' });
    // Spawning as the user fails: no CAP_SETUID / CAP_SETGID.
    expect(await probeFixUser(user, { spawn: (() => { throw eperm(); }) as unknown as typeof spawn })).toEqual({ ok: false, reason: 'spawn' });
    expect(probeError({ ok: false, reason: 'cap_kill' }).message).toContain('CAP_KILL');
    expect(probeError({ ok: false, reason: 'cap_kill' }).message).toContain('FIX_RUN_AS_USER');
    expect(probeError({ ok: false, reason: 'spawn' }).message).toContain('CAP_SETUID');
  });
});

/** A bare supervisor server whose only real part is the deploy-fix route. */
async function routeServer(deployFix: ReturnType<typeof createFixDeployer>) {
  const lab = new Lab({ runners: fakeRunners(), resolveRef: async () => undefined, prepare: async () => '/x', record: async (r) => ({ id: 'd-1', ...r }) });
  const server = createSupervisorServer({
    lab,
    deployFix,
    tokens: { chaos: 'c'.repeat(20), read: 'r'.repeat(20) },
    sink: () => undefined,
    observability: { repo: '/nowhere', serviceBase: () => 'http://127.0.0.1:1', exits: () => [], logs: () => [], deploys: () => [], resolveRef: async () => undefined },
  });
  const port = await listen(server.server, 0, '127.0.0.1');
  return {
    post: async (body: unknown) => {
      const res = await httpRequest(`http://127.0.0.1:${port}/chaos/deploy-fix`, { method: 'POST', headers: { authorization: `Bearer ${'c'.repeat(20)}` }, body: JSON.stringify(body), timeoutMs: 30_000 });
      return { status: res.status, body: JSON.parse(res.text) as { error?: { code: string } } };
    },
    close: () => closeServer(server.server),
  };
}

const BODY = { service: 'payments', ref: cuidRef(1), sha: 'a'.repeat(40) };

describe('item 2: no fix deploys without a separate user outside development', () => {
  it('NODE_ENV=production without FIX_RUN_AS_USER: 503 isolation_unavailable and nothing is fetched', async () => {
    const base = { CHAOS_TOKEN: 'c'.repeat(16), LAB_READ_TOKEN: 'r'.repeat(16) };
    expect(loadSupervisorConfig({ ...base, NODE_ENV: 'production' }).production).toBe(true);
    expect(loadSupervisorConfig(base).production).toBe(false);
    let fetched = 0;
    const mirror = { path: '/x', fetchIncident: async () => void fetched++, refHead: async () => undefined, allowedHeads: async () => ({ heads: [], pinned: false }) };
    const deployFix = createFixDeployer({ mirror, lab: { deployFix: async () => Promise.reject(new Error('no')) }, isolationAvailable: false });
    const srv = await routeServer(deployFix);
    try {
      expect(await srv.post(BODY)).toMatchObject({ status: 503, body: { error: { code: 'isolation_unavailable' } } });
      expect(fetched).toBe(0);
    } finally {
      await srv.close();
    }
  });
});

describe('item 4: fetch queue bound', () => {
  it('one runs, four wait, the sixth gets 503 busy', async () => {
    const lock = new BoundedLock(4);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const running = Array.from({ length: 5 }, () => lock.run(() => gate));
    await expect(lock.run(async () => undefined)).rejects.toMatchObject({ status: 503, code: 'busy' });
    release();
    await Promise.all(running);
    await expect(lock.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('items 4 and 5: prune protection and gc', () => {
  it('a ref fetched in the last 10 minutes is never pruned', () => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    const times = { [cuidRef(1)]: '2026-11-14T11:55:00.000Z', [cuidRef(2)]: '2026-11-14T11:59:00.000Z', [cuidRef(3)]: '2026-11-14T10:00:00.000Z' };
    expect(planIncidentPrune(times, Object.keys(times), 1, new Set(), now)).toEqual([cuidRef(3)]);
    expect(planIncidentPrune(times, Object.keys(times), 1, new Set(), now, 0)).toEqual([cuidRef(1), cuidRef(3)]);
  });

  it('a prune during a request still gives that request its 409/200, never a false 404; old refs are pruned and gc-ed', async () => {
    const fx = await makeFixture();
    fixtures.push(fx);
    const good = await fx.mainFile(REFUNDS);
    const a = await fx.commit([fx.heads['error-spike']], { [REFUNDS]: good }, 'fix a');
    const b = await fx.commit([fx.heads['error-spike']], { [REFUNDS]: `${good}\n// b\n` }, 'fix b');
    const c = await fx.commit([fx.heads['error-spike']], { [REFUNDS]: `${good}\n// c\n` }, 'fix c');
    await fx.setRef(cuidRef(1), a);
    await fx.setRef(cuidRef(2), b);
    await fx.setRef(cuidRef(3), c);
    let clock = Date.parse('2026-11-14T12:00:00Z');
    const mirror = new Mirror({ dataDir: join(fx.dir, 'data'), source: fx.source, originUrl: fx.originUrl, allowFileOrigin: true, maxIncidentRefs: 1, now: () => clock });
    await mirror.ensure();
    // Request A: fetched; before its deploy, request B's fetch runs the prune.
    let lateHead: string | undefined;
    const lab = {
      deployFix: async (_s: string, _r: string, sha: string, currentHead: () => Promise<string | undefined>) => {
        clock += 1000; // B is newer than A, so the limit of 1 would drop A
        await mirror.fetchIncident(cuidRef(2)); // another request in between: prune runs here
        lateHead = await currentHead();
        if (lateHead !== sha) throw Object.assign(new Error('moved'), {});
        return { record: { id: 'd-500', service: 'payments' as const, ref: cuidRef(1), sha, time: '', actor: 'exorcist' as const }, deployed: true };
      },
    };
    const deploy = createFixDeployer({ mirror, lab: lab as never });
    await expect(deploy({ service: 'payments', ref: cuidRef(1), sha: a })).resolves.toMatchObject({ deployId: 'd-500' });
    expect(lateHead).toBe(a);
    // Much later, a new fetch prunes the old refs (limit 1) and gc drops their objects.
    clock += 60 * 60 * 1000;
    await mirror.fetchIncident(cuidRef(3));
    expect(await mirror.incidentRefs()).toEqual([cuidRef(3)]);
    const objectGone = await git(mirror.path, ['cat-file', '-e', `${a}^{commit}`]);
    expect(objectGone.code).not.toBe(0);
    expect((await git(mirror.path, ['cat-file', '-e', `${c}^{commit}`])).code).toBe(0);
  }, 60_000);
});

describe('item 7: git hardening', () => {
  it('runs without hooks, without replace objects, with fsck on fetch', async () => {
    expect(GIT_ENV).toMatchObject({ GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
    const fx = await makeFixture();
    fixtures.push(fx);
    // A post-checkout hook in the (bare) repo must not run for a supervisor worktree add.
    const marker = join(fx.dir, 'hook-ran');
    await mkdir(join(fx.origin, 'hooks'), { recursive: true });
    await writeFile(join(fx.origin, 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    await chmod(join(fx.origin, 'hooks', 'post-checkout'), 0o755);
    await runGit(fx.origin, ['config', 'core.hooksPath', join(fx.origin, 'hooks')]);
    await worktreeAdd(fx.origin, join(fx.dir, 'wt-hook'), fx.heads.main);
    expect(existsSync(marker)).toBe(false);
    // A replace ref must not swap what the supervisor reads.
    await runGit(fx.origin, ['replace', fx.heads.fog, fx.heads['dark-room']]);
    const subject = await git(fx.origin, ['log', '-1', '--format=%s', fx.heads.fog]);
    expect(subject.stdout.trim()).toBe('add inventory freshness check');
    // fsck settings are passed on every call.
    const cfg = await git(fx.origin, ['config', '--get', 'transfer.fsckObjects']);
    expect(cfg.stdout.trim()).toBe('true');
    expect((await git(fx.origin, ['config', '--get', 'core.hooksPath'])).stdout.trim()).toBe('/dev/null');
  }, 30_000);
});

describe('item 8: fix-deploy-check validates LAB_ORIGIN_URL before any fetch', () => {
  it('refuses a non-https origin with exit 2 and names the variable only', async () => {
    const script = join(CHECKOUT, 'scripts', 'fix-deploy-check.mjs');
    for (const url of ['http://example.com/lab.git', 'https://user:pw@example.com/lab.git', 'file:///tmp/x.git']) {
      const res = await run(process.execPath, [script], { env: { PATH: process.env.PATH, REF: cuidRef(1), SHA: 'a'.repeat(40), LAB_ORIGIN_URL: url } }).then(
        () => ({ code: 0, stderr: '' }),
        (e: { code: number; stderr: string }) => e,
      );
      expect(res.code, url).toBe(2);
      expect(res.stderr).toContain('invalid env: LAB_ORIGIN_URL');
      expect(res.stderr).not.toContain(url);
    }
  }, 30_000);
});

describe('item 9: route-level 503 when the mirror is unavailable', () => {
  it('a mirror that was never created answers 503, not 500', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nomirror-'));
    dirs.push(dir);
    const mirror = new Mirror({ dataDir: join(dir, 'missing'), source: dir, originUrl: 'https://example.invalid/lab.git', allowFileOrigin: false });
    const deployFix = createFixDeployer({ mirror, lab: { deployFix: async () => Promise.reject(new Error('unreachable')) } });
    const srv = await routeServer(deployFix);
    try {
      const res = await srv.post(BODY);
      expect(res.status).toBe(503);
      expect(['origin_unreachable', 'deploy_failed']).toContain(res.body.error?.code);
    } finally {
      await srv.close();
    }
  });
});
