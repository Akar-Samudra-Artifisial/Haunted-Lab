import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { killStale, labMarker, PidFile, readPidFile } from '../src/pids.ts';
import { ServiceRunner } from '../src/runner.ts';

const dirs: string[] = [];
const spawned: number[] = [];
afterAll(async () => {
  for (const pid of spawned) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A detached process whose command line looks like a lab service child. */
function fakeChild(marker: string): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'src/main.ts', marker], { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid as number;
  spawned.push(pid);
  return pid;
}

describe('pids.json', () => {
  it('PidFile records the live pid per service and clears it on exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pids-'));
    dirs.push(dir);
    const file = join(dir, 'data', 'pids.json');
    const pids = new PidFile(file);
    await pids.set('gate', 1234);
    await pids.set('ledger', 5678);
    await pids.clear('gate', 999); // not the recorded pid: kept
    expect(await readPidFile(file)).toEqual({ gate: 1234, ledger: 5678 });
    await pids.clear('gate', 1234);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ledger: 5678 });
  });

  it('killStale stops a leftover lab child and leaves a reused pid alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pids-'));
    dirs.push(dir);
    const file = join(dir, 'pids.json');
    const stale = fakeChild(labMarker('gate'));
    const unrelated = fakeChild(labMarker('orders')); // recorded under the wrong service: not ours
    await new Promise((r) => setTimeout(r, 300)); // let ps see the final command lines
    await writeFile(file, JSON.stringify({ gate: stale, payments: unrelated }));
    const killed = await killStale(file, { graceMs: 3000 });
    expect(killed).toEqual(['gate']);
    await waitFor(() => !alive(stale));
    expect(alive(unrelated)).toBe(true);
    expect(await readPidFile(file)).toEqual({});
    process.kill(unrelated, 'SIGKILL');
  }, 15_000);

  it('ignores a missing or malformed pids.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pids-'));
    dirs.push(dir);
    expect(await killStale(join(dir, 'none.json'))).toEqual([]);
    await writeFile(join(dir, 'bad.json'), '{"gate": "1; rm -rf /", "nope": 12}');
    expect(await readPidFile(join(dir, 'bad.json'))).toEqual({});
  });

  it('a runner child leads its own process group: stop() also ends its children', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pgroup-'));
    dirs.push(dir);
    await mkdir(join(dir, 'src'));
    await writeFile(
      join(dir, 'src', 'main.ts'),
      `import { spawn } from 'node:child_process';
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log('grandchild ' + g.pid + ' argv ' + process.argv.slice(2).join(' '));
setInterval(() => {}, 1000);
`,
    );
    const seen: number[] = [];
    const runner = new ServiceRunner({ service: 'orders', env: {}, onSpawn: (pid) => seen.push(pid) });
    await runner.deploy({ ref: 'main', sha: 'a'.repeat(40), dir });
    await waitFor(() => runner.logs().some((l) => l.line.startsWith('grandchild ')));
    const line = runner.logs().find((l) => l.line.startsWith('grandchild '))?.line ?? '';
    expect(line).toContain(`argv ${labMarker('orders')}`);
    const grandchild = Number(line.split(' ')[1]);
    spawned.push(grandchild);
    expect(seen).toHaveLength(1);
    expect(alive(grandchild)).toBe(true);
    await runner.stop();
    await waitFor(() => !alive(grandchild));
  }, 15_000);
});
