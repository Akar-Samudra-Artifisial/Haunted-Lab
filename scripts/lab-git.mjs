// Deterministic git plumbing for the lab: planted scenario commits and the runtime snapshot repo.
// Every git call uses execFile with an argument array and an isolated config, so the SHAs depend
// only on file contents, the fixed identity and the fixed dates below.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const IDENTITY = Object.freeze({ name: 'Haunted Lab Bot', email: 'lab@example.invalid' });
export const SNAPSHOT_DATE = '2026-11-01T00:00:00+00:00';
export const SNAPSHOT_MESSAGE = 'lab runtime snapshot';

const BASE_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  TZ: 'UTC',
};

/** @param {string} repo @param {string[]} args @param {{ env?: Record<string,string>, input?: string, raw?: boolean }} [opts] */
export function git(repo, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-C', repo, ...args],
      { env: { ...BASE_ENV, ...opts.env }, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr).trim().split('\n')[0] ?? ''}`));
        else resolve(opts.raw ? String(stdout) : String(stdout).trim());
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

const identityEnv = (date) => ({
  GIT_AUTHOR_NAME: IDENTITY.name,
  GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_AUTHOR_DATE: date,
  GIT_COMMITTER_NAME: IDENTITY.name,
  GIT_COMMITTER_EMAIL: IDENTITY.email,
  GIT_COMMITTER_DATE: date,
});

/** @param {string} text @param {string} before @param {string} after @param {string} file */
function replaceOnce(text, before, after, file) {
  const at = text.indexOf(before);
  if (at === -1 || text.indexOf(before, at + 1) !== -1) {
    throw new Error(`main does not contain the expected code in ${file}; update the scenario patch`);
  }
  return text.slice(0, at) + after + text.slice(at + before.length);
}

const FOG_BEFORE = `/** Simulated stock reservation. Synthetic: no real inventory. */
export async function reserveStock(_sku: string): Promise<void> {
  await sleep(20);
}
`;

const FOG_AFTER = `const WAREHOUSES = ['north', 'south', 'east', 'west', 'harbor', 'hill', 'mill', 'yard'];

/** Ask a warehouse how fresh its stock count is before reserving. */
async function checkFreshness(_sku: string, _warehouse: string): Promise<void> {
  await sleep(200);
}

/** Simulated stock reservation. Synthetic: no real inventory. */
export async function reserveStock(sku: string): Promise<void> {
  for (const warehouse of WAREHOUSES) {
    await checkFreshness(sku, warehouse);
  }
  await sleep(20);
}
`;

const SPIKE_BEFORE = `  const refund = findRefund(orderId);
  if (!refund) {
    return DEFAULT_TERMS;
  }
  return { windowDays: refund.windowDays, feeCents: refund.feeCents };`;

const SPIKE_AFTER = `  const refund = findRefund(orderId) as RefundTerms;
  return { windowDays: refund.windowDays, feeCents: refund.feeCents };`;

/**
 * The three planted culprit commits. Each changes one file of one service.
 * Author and committer date = the base commit's committer date + `offsetHours`, so planted commits
 * are always newer than their parent and still deterministic for a given base.
 * @type {readonly { name: string, branch: string, service: string, file: string, message: string, offsetHours: number, patch: (text: string, file: string) => string }[]}
 */
export const SCENARIO_PATCHES = Object.freeze([
  {
    name: 'error-spike',
    branch: 'scenario/error-spike',
    service: 'payments',
    file: 'services/payments/src/refunds.ts',
    message: 'simplify refund lookup',
    offsetHours: 1,
    patch: (text, file) => replaceOnce(text, SPIKE_BEFORE, SPIKE_AFTER, file),
  },
  {
    name: 'fog',
    branch: 'scenario/fog',
    service: 'orders',
    file: 'services/orders/src/inventory.ts',
    message: 'add inventory freshness check',
    offsetHours: 2,
    patch: (text, file) => replaceOnce(text, FOG_BEFORE, FOG_AFTER, file),
  },
  {
    name: 'dark-room',
    branch: 'scenario/dark-room',
    service: 'ledger',
    file: 'services/ledger/src/config.ts',
    message: 'tidy config loading',
    offsetHours: 3,
    patch: (text, file) => {
      const step = replaceOnce(text, `LEDGER_PORT: { kind: 'port' },`, `LEDGER_LISTEN_PORT: { kind: 'port' },`, file);
      return replaceOnce(step, 'Number(cfg.LEDGER_PORT)', 'Number(cfg.LEDGER_LISTEN_PORT)', file);
    },
  },
]);

/** Git date for base committer time (unix seconds) + hours, in UTC. */
export function plantedDate(baseUnixSeconds, hours) {
  return `@${baseUnixSeconds + hours * 3600} +0000`;
}

/**
 * Check this repo's planted branches against a `{ base, shas }` record without requiring
 * `main === base` (committing the record itself moves `main`). Each scenario branch must be
 * exactly one commit whose parent is `record.base`, `record.base` must be an ancestor of `main`,
 * and the branch SHAs must equal the record. Returns a list of problems (empty when it holds).
 * @param {string} repo @param {{ base: string, shas: Record<string, string> }} record
 */
export async function verifyPlantRecord(repo, record) {
  const problems = [];
  const main = await git(repo, ['rev-parse', '--verify', 'refs/heads/main^{commit}']).catch(() => '');
  const ancestor = main
    ? await git(repo, ['merge-base', '--is-ancestor', record.base, main]).then(() => true, () => false)
    : false;
  if (!ancestor) problems.push('record.base is not an ancestor of main: re-run `node scripts/plant-scenarios.mjs`');
  for (const s of SCENARIO_PATCHES) {
    const sha = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${s.branch}`]).catch(() => '');
    if (sha !== record.shas[s.name]) {
      problems.push(`${s.branch} is ${sha || 'missing'}, record says ${record.shas[s.name]}`);
      continue;
    }
    const parents = (await git(repo, ['rev-list', '--parents', '-n', '1', sha])).split(' ').slice(1);
    if (parents.length !== 1 || parents[0] !== record.base) problems.push(`${s.branch} is not one commit on record.base`);
  }
  return problems;
}

async function withTempIndex(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'lab-index-'));
  try {
    return await fn({ GIT_INDEX_FILE: join(dir, 'index') });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write a commit with the fixed identity. @returns {Promise<string>} sha */
async function commitTree(repo, tree, parents, message, date) {
  const args = ['commit-tree', '--no-gpg-sign', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message];
  return git(repo, args, { env: identityEnv(date) });
}

/**
 * Plant (or confirm) the three scenario branches on the current `main` tip. Idempotent: the same
 * base gives the same SHAs, and a branch already at its SHA is left alone. Never moves `main` and
 * never touches the working tree.
 * @param {string} repo
 * @returns {Promise<{ base: string, shas: Record<string, string>, changed: string[] }>}
 */
export async function plantScenarios(repo) {
  const base = await git(repo, ['rev-parse', '--verify', 'refs/heads/main^{commit}']);
  const baseTime = Number(await git(repo, ['log', '-1', '--format=%ct', base]));
  /** @type {Record<string,string>} */
  const shas = {};
  const changed = [];
  for (const s of SCENARIO_PATCHES) {
    const before = await git(repo, ['show', `${base}:${s.file}`], { raw: true }).catch(() => {
      throw new Error(`main has no ${s.file}; commit the services before planting`);
    });
    const after = s.patch(before, s.file);
    const sha = await withTempIndex(async (env) => {
      await git(repo, ['read-tree', base], { env });
      const blob = await git(repo, ['hash-object', '-w', '--no-filters', '--stdin'], { input: after });
      await git(repo, ['update-index', '--cacheinfo', `100644,${blob},${s.file}`], { env });
      const tree = await git(repo, ['write-tree'], { env });
      return commitTree(repo, tree, [base], s.message, plantedDate(baseTime, s.offsetHours));
    });
    const current = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${s.branch}`]).catch(() => '');
    if (current !== sha) {
      await git(repo, ['update-ref', `refs/heads/${s.branch}`, sha]);
      changed.push(s.branch);
    }
    shas[s.name] = sha;
  }
  return { base, shas, changed };
}

/** Files the services need at run time. Only these go into a snapshot, so docs and tests never move the SHAs. */
export const SNAPSHOT_FILE = /^(services\/[a-z]+\/(package\.json|src\/[A-Za-z0-9_./-]+\.ts)|packages\/lab-common\/(package\.json|src\/[A-Za-z0-9_./-]+\.ts))$/;

/** @param {string} srcRoot @returns {Promise<string[]>} sorted runtime files (tracked or untracked, not ignored) */
export async function snapshotFiles(srcRoot) {
  const out = await git(srcRoot, ['ls-files', '-co', '--exclude-standard', '--', 'services', 'packages']);
  return [...new Set(out.split('\n'))]
    .filter((f) => SNAPSHOT_FILE.test(f) && existsSync(join(srcRoot, f)))
    .sort();
}

/**
 * Build a fresh repo at `dest` whose `main` is one commit holding the runtime files of `srcRoot`,
 * with the fixed identity and date. Same files give the same SHA on every machine.
 * @returns {Promise<string>} the main sha
 */
export async function buildSnapshotRepo(srcRoot, dest) {
  await mkdir(dest, { recursive: true });
  await git(dest, ['init', '-q', '-b', 'main']);
  const files = await snapshotFiles(srcRoot);
  return withTempIndex(async (env) => {
    for (const f of files) {
      const content = await readFile(join(srcRoot, f), 'utf8');
      const blob = await git(dest, ['hash-object', '-w', '--no-filters', '--stdin'], { input: content.endsWith('\n') ? content : `${content}\n` });
      await git(dest, ['update-index', '--add', '--cacheinfo', `100644,${blob},${f}`], { env });
    }
    const tree = await git(dest, ['write-tree'], { env });
    const sha = await commitTree(dest, tree, [], SNAPSHOT_MESSAGE, SNAPSHOT_DATE);
    await git(dest, ['update-ref', 'refs/heads/main', sha]);
    return sha;
  });
}
