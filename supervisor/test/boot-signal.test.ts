import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CHECKOUT, makeFixture, type Fixture } from './fix-origin.ts';
import { freePorts } from './helpers.ts';

let fx: Fixture | undefined;
afterAll(async () => {
  await fx?.cleanup();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('supervisor signals', () => {
  it('a SIGTERM during boot stops the children already started instead of orphaning them', async () => {
    fx = await makeFixture();
    const ports = await freePorts(5);
    const dataDir = join(fx.dir, 'data');
    const sup = spawn(process.execPath, [join(CHECKOUT, 'supervisor', 'src', 'main.ts')], {
      env: {
        PATH: process.env.PATH,
        CHAOS_TOKEN: 'chaos-token-boot-signal-01',
        LAB_READ_TOKEN: 'read-token-boot-signal-001',
        SUPERVISOR_PORT: String(ports[0]),
        GATE_PORT: String(ports[1]),
        ORDERS_PORT: String(ports[2]),
        PAYMENTS_PORT: String(ports[3]),
        LEDGER_PORT: String(ports[4]),
        TRAFFIC_RPS: '0',
        LAB_REPO_DIR: fx.source,
        LAB_DATA_DIR: dataDir,
        LAB_WORKTREES_DIR: join(fx.dir, 'worktrees'),
      },
      stdio: 'ignore',
    });
    const closed = new Promise<number | null>((r) => sup.once('close', (code) => r(code)));
    // Wait until the first child is recorded, i.e. boot is under way, then signal.
    let pids: Record<string, number> = {};
    const end = Date.now() + 30_000;
    while (Object.keys(pids).length === 0 && Date.now() < end) {
      pids = await readFile(join(dataDir, 'pids.json'), 'utf8').then((t) => JSON.parse(t) as Record<string, number>, () => ({}));
      if (Object.keys(pids).length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(Object.keys(pids).length).toBeGreaterThan(0);
    sup.kill('SIGTERM');
    expect(await closed).toBe(0);
    const seen = Object.values(pids);
    await new Promise((r) => setTimeout(r, 200));
    for (const pid of seen) expect(alive(pid), `child ${pid}`).toBe(false);
  }, 60_000);
});
