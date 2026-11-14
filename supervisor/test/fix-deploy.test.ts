import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpRequest } from '@haunted-lab/common';
import { startSupervisor, type RunningSupervisor } from '../src/app.ts';
import { loadSupervisorConfig } from '../src/config.ts';
import { readChain } from '../src/fix-chain.ts';
import { Mirror, planIncidentPrune } from '../src/mirror.ts';
import { writeFile } from 'node:fs/promises';
import { CANARY_FILE, CANARY_PREFIX, canarySource, evaluateCanary, withCanaryImport } from '../../scripts/canary.mjs';
import { cuidRef, makeFixture, REFUNDS, runGit, type Fixture } from './fix-origin.ts';
import { freePorts } from './helpers.ts';

const CHAOS = 'chaos-token-fixdeploy-00001';
const READ = 'read-token-fixdeploy-000001';

let fx: Fixture;
let sup: RunningSupervisor;
let base = '';
let dataDir = '';
const refs: Record<string, { ref: string; sha: string }> = {};
const lines: string[] = [];
let canaryEnv = '';

async function post(body: unknown, token = CHAOS, raw?: string) {
  const res = await httpRequest(`${base}/chaos/deploy-fix`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
    timeoutMs: 60_000,
  });
  let json: Record<string, unknown> & { error?: { code: string } } = {};
  try {
    json = JSON.parse(res.text) as typeof json;
  } catch {
    // not JSON
  }
  return { status: res.status, body: json };
}

const fix = (name: string, service = 'payments') => ({ service, ref: refs[name]?.ref, sha: refs[name]?.sha });

beforeAll(async () => {
  fx = await makeFixture();
  const D = fx.heads['error-spike'];
  const good = await fx.mainFile(REFUNDS);
  const add = async (name: string, n: number, sha: string) => {
    await fx.setRef(cuidRef(n), sha);
    refs[name] = { ref: cuidRef(n), sha };
  };
  // good fix: restore the guard on the error-spike head
  const g = await fx.commit([D], { [REFUNDS]: good }, 'restore refund guard');
  await add('good', 1, g);
  // merge fix: GitHub merge commit, first parent D, second the fix
  const f2 = await fx.commit([D], { [REFUNDS]: good }, 'restore refund guard (pr head)');
  await add('merge', 2, await fx.commit([D, f2], { [REFUNDS]: good }, 'Merge pull request'));
  // squash fix: one commit with the whole PR (two files of the service)
  await add('squash', 3, await fx.commit([D], { [REFUNDS]: good, 'services/payments/src/notes.ts': 'export const NOTE = 1;\n' }, 'restore refund guard (#3)'));
  // rebase merge: two commits
  const r1 = await fx.commit([D], { 'services/payments/src/notes.ts': 'export const NOTE = 2;\n' }, 'note');
  await add('rebase', 4, await fx.commit([r1], { [REFUNDS]: good }, 'restore guard'));
  // refusals
  await add('otherService', 5, await fx.commit([D], { [REFUNDS]: good, 'services/orders/src/inventory.ts': '// x\n' }, 'touch orders'));
  await add('pkg', 6, await fx.commit([D], { 'services/payments/package.json': '{"name":"x"}\n' }, 'deps'));
  let c = D;
  for (let i = 0; i < 21; i++) c = await fx.commit([c], { 'services/payments/src/notes.ts': `export const N = ${i};\n` }, `step ${i}`);
  await add('long', 7, c);
  await add('binary', 8, await fx.commit([D], { 'services/payments/src/blob.bin': 'a\0b\0c' }, 'binary'));
  await add('symlink', 9, await fx.commit([D], { 'services/payments/src/link.ts': { symlink: '../../../supervisor/src/config.ts' } }, 'symlink'));
  await add('mode', 10, await fx.commit([D], { 'services/payments/src/main.ts': { content: await fx.mainFile('services/payments/src/main.ts'), mode: '100755' } }, 'chmod'));
  await add('big', 11, await fx.commit([D], { 'services/payments/src/big.ts': Array.from({ length: 401 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n' }, 'big'));
  await add('empty', 12, D);
  await add('renameOut', 13, await fx.commit([D], { 'services/payments/src/refunds.ts': null, 'services/ledger/src/refunds.ts': await fx.mainFile(REFUNDS) }, 'move'));
  const root = await runGit(fx.origin, ['commit-tree', '--no-gpg-sign', await runGit(fx.origin, ['rev-parse', `${D}^{tree}`]), '-m', 'orphan'], {
    env: { GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@example.invalid', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@example.invalid', GIT_AUTHOR_DATE: '@1 +0000', GIT_COMMITTER_DATE: '@1 +0000' },
  });
  await add('orphan', 14, root);
  // review fixes (task 11)
  await add('blob', 15, await fx.commit([D], { 'services/payments/src/blob.ts': `export const S = '${'x'.repeat(70 * 1024)}';\n` }, 'big blob'));
  const fifty = `export const S = '${'y'.repeat(50 * 1024)}';\n`;
  await add('total', 16, await fx.commit([D], Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`services/payments/src/part${n}.ts`, fifty])), 'many parts'));
  await add('nodeModules', 17, await fx.commit([D], { 'services/payments/node_modules/evil/index.js': 'module.exports = 1;\n' }, 'vendor'));
  await add('newExec', 18, await fx.commit([D], { 'services/payments/src/run.sh': { content: '#!/bin/sh\n', mode: '100755' } }, 'script'));
  await add('onMain', 19, await fx.commit([fx.heads.main], { 'services/payments/src/notes.ts': 'export const NOTE = 3;\n' }, 'note on main'));
  const touch = await fx.commit([D], { 'services/orders/src/inventory.ts': '// tmp\n' }, 'touch orders');
  const revert = await fx.commit([touch], { 'services/orders/src/inventory.ts': await fx.mainFile('services/orders/src/inventory.ts') }, 'revert orders');
  await add('revertedOther', 20, await fx.commit([revert], { [REFUNDS]: good }, 'fix'));
  // canary: tries forbidden things at boot (the env file is a stand-in, never the real one)
  canaryEnv = join(fx.dir, 'canary.env');
  await writeFile(canaryEnv, 'CHAOS_TOKEN=stand-in-only\n');
  await add('canary', 21, await fx.commit([fx.heads.main], { [CANARY_FILE]: canarySource(canaryEnv), 'services/payments/src/main.ts': withCanaryImport(await fx.mainFile('services/payments/src/main.ts')) }, 'canary'));

  const ports = await freePorts(5);
  dataDir = join(fx.dir, 'data');
  const config = loadSupervisorConfig({
    CHAOS_TOKEN: CHAOS,
    LAB_READ_TOKEN: READ,
    SUPERVISOR_PORT: String(ports[0]),
    GATE_PORT: String(ports[1]),
    ORDERS_PORT: String(ports[2]),
    PAYMENTS_PORT: String(ports[3]),
    LEDGER_PORT: String(ports[4]),
    TRAFFIC_RPS: '0',
    LAB_REPO_DIR: fx.source,
    LAB_DATA_DIR: dataDir,
    LAB_WORKTREES_DIR: join(fx.dir, 'worktrees'),
    LAB_ECHO_CHILD_OUTPUT: '0',
    LAB_ORIGIN_URL: fx.originUrl,
    LAB_ALLOW_FILE_ORIGIN: '1',
  });
  sup = await startSupervisor(config, (l) => lines.push(l));
  base = `http://127.0.0.1:${sup.port}`;
  const res = await httpRequest(`${base}/chaos/scenarios/error-spike/apply`, { method: 'POST', headers: { authorization: `Bearer ${CHAOS}` } });
  expect(res.status).toBe(200);
}, 120_000);

afterAll(async () => {
  await sup?.close();
  await fx?.cleanup();
}, 60_000);

describe('mirror', () => {
  it('is a bare repo under data/ (0700) fetching only incident/*, with only named and incident refs', async () => {
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    const mirror = join(dataDir, 'repo.git');
    expect(await runGit(mirror, ['rev-parse', '--is-bare-repository'])).toBe('true');
    expect(await runGit(mirror, ['config', '--get-all', 'remote.origin.fetch'])).toBe('+refs/heads/incident/*:refs/heads/incident/*');
    expect(await runGit(mirror, ['config', 'remote.origin.url'])).toBe(fx.originUrl);
    const names = (await runGit(mirror, ['for-each-ref', '--format=%(refname:strip=2)'])).split('\n');
    expect(names.every((n) => ['main', 'scenario/error-spike', 'scenario/fog', 'scenario/dark-room'].includes(n) || /^incident\/c[a-z0-9]{24}$/.test(n))).toBe(true);
    // The source checkout gets no refs and no worktrees.
    expect(await runGit(fx.source, ['for-each-ref', '--format=%(refname)', 'refs/heads/incident/'])).toBe('');
    expect((await runGit(fx.source, ['worktree', 'list'])).split('\n')).toHaveLength(1);
    expect(lines.some((l) => l.includes('FIX_RUN_AS_USER not set; development only'))).toBe(true);
  });

  it('answers 404 for an unknown ref and 503 for an unreachable origin', async () => {
    const m = new Mirror({ dataDir: join(fx.dir, 'data-x'), source: fx.source, originUrl: fx.originUrl, allowFileOrigin: true });
    await m.ensure();
    await expect(m.fetchIncident(cuidRef(999))).rejects.toMatchObject({ status: 404, code: 'unknown_ref' });
    const gone = new Mirror({ dataDir: join(fx.dir, 'data-y'), source: fx.source, originUrl: pathToFileURL(join(fx.dir, 'nope.git')).href, allowFileOrigin: true });
    await gone.ensure();
    await expect(gone.fetchIncident(cuidRef(1))).rejects.toMatchObject({ status: 503, code: 'origin_unreachable' });
    // Without the test flag a file origin is not even a permitted protocol.
    const strict = new Mirror({ dataDir: join(fx.dir, 'data-z'), source: fx.source, originUrl: fx.originUrl, allowFileOrigin: false });
    await strict.ensure();
    await expect(strict.fetchIncident(cuidRef(1))).rejects.toMatchObject({ status: 503 });
    await m.fetchIncident(cuidRef(1));
    expect(await m.refHead(cuidRef(1))).toBe(refs.good?.sha);
  }, 60_000);

  // Feature: fix-deploy, Property 9
  it('the incident ref limit keeps the newest 50 and deletes only incident refs', () => {
    const refArb = fc.stringMatching(/^c[a-z0-9]{24}$/).map((c) => `incident/${c}`);
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(refArb, fc.integer({ min: 0, max: 30 })), { selector: (t) => t[0], maxLength: 80 }),
        fc.array(fc.constantFrom('main', 'scenario/fog', 'exorcist/x'), { maxLength: 3 }),
        (pairs, others) => {
          const times = Object.fromEntries(pairs.map(([r, t]) => [r, new Date(Date.UTC(2026, 10, 1, 0, t)).toISOString()]));
          const present = [...pairs.map(([r]) => r), ...others];
          const del = planIncidentPrune(times, present, 50);
          const order = pairs
            .map(([r]) => r)
            .sort((a, b) => (times[a] === times[b] ? (a < b ? -1 : 1) : (times[a] as string) < (times[b] as string) ? 1 : -1));
          expect(new Set(del)).toEqual(new Set(order.slice(50)));
          expect(del.every((r) => r.startsWith('incident/'))).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('chain reader', () => {
  it('counts a merge against its first parent and reads both paths of a rename', async () => {
    const heads = Object.values(fx.heads);
    const merge = await readChain(fx.origin, refs.merge?.sha as string, heads);
    expect(merge.reachedHead).toBe(fx.heads['error-spike']);
    expect(merge.chain).toHaveLength(1);
    expect(merge.chain[0]?.parents).toHaveLength(2);
    expect(merge.chain[0]?.changes.map((c) => c.path)).toEqual([REFUNDS]);
    const moved = await readChain(fx.origin, refs.renameOut?.sha as string, heads);
    const files = moved.chain.flatMap((c) => c.changes.flatMap((f) => [f.path, f.oldPath]));
    expect(files).toContain('services/ledger/src/refunds.ts');
    const bin = await readChain(fx.origin, refs.binary?.sha as string, heads);
    expect(bin.chain[0]?.changes[0]?.binary).toBe(true);
    const link = await readChain(fx.origin, refs.symlink?.sha as string, heads);
    expect(link.chain[0]?.changes[0]?.newMode).toBe('120000');
    const long = await readChain(fx.origin, refs.long?.sha as string, heads);
    expect(long.reachedHead).toBeNull();
    expect(long.rootReached).toBe(false);
    const orphan = await readChain(fx.origin, refs.orphan?.sha as string, heads);
    expect(orphan.rootReached).toBe(true);
  });
});

describe('POST /chaos/deploy-fix', () => {
  it('auth, method and body checks: 401, 405, 400 (also for oversize and injection)', async () => {
    expect((await post(fix('good'), READ)).status).toBe(401);
    expect((await post(fix('good'), 'nope-nope-nope-nope')).status).toBe(401);
    expect((await httpRequest(`${base}/chaos/deploy-fix`, { headers: { authorization: `Bearer ${CHAOS}` } })).status).toBe(405);
    for (const bad of [
      { service: 'payments', ref: 'incident/c00000000000000000000000;rm -rf', sha: 'a'.repeat(40) },
      { service: 'payments', ref: '--upload-pack=touch /tmp/x', sha: 'a'.repeat(40) },
      { service: 'payments', ref: 'incident/../../main', sha: 'a'.repeat(40) },
      { service: 'payments', ref: 'exorcist/c000000000000000000000001', sha: 'a'.repeat(40) },
      { service: 'vault', ref: cuidRef(1), sha: 'a'.repeat(40) },
      { ...fix('good'), extra: true },
    ]) {
      expect(await post(bad)).toMatchObject({ status: 400, body: { error: { code: 'bad_request' } } });
    }
    expect((await post(null, CHAOS, '{nope')).status).toBe(400);
    expect((await post(null, CHAOS, `{"service":"payments","ref":"${'x'.repeat(9000)}"}`)).status).toBe(400);
  });

  it('404 unknown ref, 409 not head / long chain / no base / empty, 422 per content rule', async () => {
    expect(await post({ service: 'payments', ref: cuidRef(777), sha: 'a'.repeat(40) })).toMatchObject({ status: 404, body: { error: { code: 'unknown_ref' } } });
    expect(await post({ ...fix('good'), sha: 'b'.repeat(40) })).toMatchObject({ status: 409, body: { error: { code: 'not_head' } } });
    expect(await post(fix('long'))).toMatchObject({ status: 409, body: { error: { code: 'chain_too_long' } } });
    expect(await post(fix('orphan'))).toMatchObject({ status: 409, body: { error: { code: 'no_allowed_base' } } });
    expect(await post(fix('empty'))).toMatchObject({ status: 409, body: { error: { code: 'empty_fix' } } });
    expect(await post(fix('otherService'))).toMatchObject({ status: 422, body: { error: { code: 'outside_service' } } });
    expect(await post(fix('renameOut'))).toMatchObject({ status: 422, body: { error: { code: 'outside_service' } } });
    expect(await post(fix('good', 'orders'))).toMatchObject({ status: 422, body: { error: { code: 'outside_service' } } });
    expect(await post(fix('pkg'))).toMatchObject({ status: 422, body: { error: { code: 'manifest_change' } } });
    expect(await post(fix('binary'))).toMatchObject({ status: 422, body: { error: { code: 'binary_or_special_change' } } });
    expect(await post(fix('symlink'))).toMatchObject({ status: 422, body: { error: { code: 'binary_or_special_change' } } });
    expect(await post(fix('mode'))).toMatchObject({ status: 422, body: { error: { code: 'binary_or_special_change' } } });
    expect(await post(fix('big'))).toMatchObject({ status: 422, body: { error: { code: 'diff_too_large' } } });
    expect(await post(fix('blob'))).toMatchObject({ status: 422, body: { error: { code: 'diff_too_large' } } });
    expect(await post(fix('total'))).toMatchObject({ status: 422, body: { error: { code: 'diff_too_large' } } });
    expect(await post(fix('nodeModules'))).toMatchObject({ status: 422, body: { error: { code: 'manifest_change' } } });
    expect(await post(fix('newExec'))).toMatchObject({ status: 422, body: { error: { code: 'binary_or_special_change' } } });
    // Each commit is checked: touching another service and reverting it later is still refused.
    expect(await post(fix('revertedOther'))).toMatchObject({ status: 422, body: { error: { code: 'outside_service' } } });
    // Nothing was deployed by any refusal.
    const deploys = await httpRequest(`${base}/lab/deploys`, { headers: { authorization: `Bearer ${READ}` } });
    expect(deploys.text).not.toContain('"actor":"exorcist"');
  }, 120_000);

  it('deploys a good, a merge, a squash and a rebase fix as exorcist; a repeat is idempotent', async () => {
    for (const name of ['good', 'merge', 'squash', 'rebase']) {
      const res = await post(fix(name));
      expect(res, name).toMatchObject({ status: 200, body: { service: 'payments', sha: refs[name]?.sha } });
      expect(String(res.body.deployId)).toMatch(/^d-\d+$/);
      const st = await httpRequest(`${base}/chaos/state`, { headers: { authorization: `Bearer ${CHAOS}` } });
      const pay = (JSON.parse(st.text) as { services: { service: string; ref: string; sha: string }[] }).services.find((s) => s.service === 'payments');
      expect(pay).toMatchObject({ ref: refs[name]?.ref, sha: refs[name]?.sha });
    }
    const first = await post(fix('rebase'));
    const again = await post(fix('rebase'));
    expect(again).toMatchObject({ status: 200, body: { deployId: first.body.deployId } });
    const log = await httpRequest(`${base}/lab/deploys`, { headers: { authorization: `Bearer ${READ}` } });
    const items = (JSON.parse(log.text) as { items: { actor: string; ref: string; sha: string }[] }).items.filter((i) => i.actor === 'exorcist');
    expect(items.map((i) => i.ref)).toEqual(['good', 'merge', 'squash', 'rebase'].map((n) => refs[n]?.ref));
    // Fix diffs are served; fix worktrees stay (idle < 1 h), named ones are retired.
    const diff = await httpRequest(`${base}/lab/commits/${refs.good?.sha}/diff`, { headers: { authorization: `Bearer ${READ}` } });
    expect(diff.status).toBe(200);
    expect(diff.text).toContain('if (!refund)');
    const wts = await readdir(join(fx.dir, 'worktrees'));
    expect(wts).toContain(`payments@${refs.good?.sha}`);
    expect(wts).not.toContain(`payments@${fx.heads['error-spike']}`);
    expect((await runGit(fx.source, ['worktree', 'list'])).split('\n')).toHaveLength(1);
  }, 120_000);

  it('accepts a chain that reaches main (not a scenario head)', async () => {
    expect(await post(fix('onMain'))).toMatchObject({ status: 200, body: { sha: refs.onMain?.sha } });
  }, 60_000);

  it('the canary: everything it tries at boot is denied (signalling the parent is a dev-only WARN)', async () => {
    expect(await post(fix('canary'))).toMatchObject({ status: 200 });
    let results: Record<string, string> | undefined;
    const end = Date.now() + 30_000;
    while (!results && Date.now() < end) {
      const res = await httpRequest(`${base}/lab/logs?service=payments&limit=500`, { headers: { authorization: `Bearer ${READ}` } });
      const line = (JSON.parse(res.text) as { items: { line: string }[] }).items.map((i) => i.line).find((l) => l.startsWith(CANARY_PREFIX));
      if (line) results = JSON.parse(line.slice(CANARY_PREFIX.length)) as Record<string, string>;
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(results).toBeDefined();
    expect(results).toMatchObject({ binding: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED', worker: 'ERR_ACCESS_DENIED', readEnvFile: 'ERR_ACCESS_DENIED' });
    expect(['ERR_ACCESS_DENIED', 'skipped']).toContain(results?.procEnviron);
    const verdict = evaluateCanary(results as Record<string, string>, { dev: true });
    expect(verdict.ok).toBe(true);
    expect(verdict.rows.find((r) => r[0] === 'signalParent')?.[2]).toMatch(/^(WARN|denied)/);
    // Outside dev, a parent signal that works is a failure.
    expect(evaluateCanary({ ...results, signalParent: 'allowed' } as Record<string, string>, { dev: false }).ok).toBe(false);
    expect(evaluateCanary({ ...results, spawn: 'allowed' } as Record<string, string>, { dev: true }).ok).toBe(false);
  }, 60_000);

  it('reset returns every service to main', async () => {
    const res = await httpRequest(`${base}/chaos/reset`, { method: 'POST', headers: { authorization: `Bearer ${CHAOS}` } });
    expect(res.status).toBe(200);
    const st = JSON.parse((await httpRequest(`${base}/chaos/state`, { headers: { authorization: `Bearer ${CHAOS}` } })).text) as { services: { ref: string; sha: string }[] };
    expect(st.services.every((s) => s.ref === 'main' && s.sha === fx.heads.main)).toBe(true);
  }, 60_000);
});

