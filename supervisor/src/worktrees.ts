import { lstat, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { headOf, worktreeAdd, worktreePrune, worktreeRemove } from './git.ts';
import type { ServiceName } from './types.ts';

export interface WorktreeOptions {
  /** Repo the refs come from. */
  repo: string;
  /** Parent dir of all worktrees (`worktrees/`). */
  root: string;
  /** Checkout whose installed `node_modules` the worktrees reuse. */
  depsDir: string;
}

const exists = async (p: string) => lstat(p).then(() => true, () => false);

const WORKTREE_NAME = /^(gate|orders|payments|ledger)@[0-9a-f]{40}$/;

export function worktreeDir(root: string, service: ServiceName, sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('worktree sha must be a full commit sha');
  return join(resolve(root), `${service}@${sha}`);
}

/** Only ever touch `<root>/<service>@<sha>` entries directly inside our own worktrees dir. */
function assertInside(root: string, dir: string): void {
  const rel = relative(resolve(root), resolve(dir));
  if (rel === '' || rel.startsWith('..') || rel.includes(sep) || !WORKTREE_NAME.test(rel)) {
    throw new Error('refusing to touch a path outside the worktrees dir');
  }
}

/** `git worktree remove --force` (via execFile), falling back to deleting our own dir, then prune. */
export async function removeWorktree(opts: WorktreeOptions, dir: string): Promise<void> {
  assertInside(opts.root, dir);
  const removed = await worktreeRemove(opts.repo, dir);
  if (!removed && (await exists(dir))) await rm(dir, { recursive: true, force: true });
  await worktreePrune(opts.repo);
}

/** Remove every lab worktree under `root` except the ones in `keep` (service dirs or worktree dirs). */
export async function cleanWorktrees(opts: WorktreeOptions, keep: Iterable<string> = []): Promise<string[]> {
  const root = resolve(opts.root);
  const kept = new Set([...keep].map((k) => resolve(k)));
  const entries = await readdir(root).catch(() => [] as string[]);
  const removed: string[] = [];
  for (const name of entries) {
    if (!WORKTREE_NAME.test(name)) continue;
    const dir = join(root, name);
    if (kept.has(dir)) continue;
    await removeWorktree(opts, dir);
    removed.push(name);
  }
  await worktreePrune(opts.repo);
  return removed;
}

/** The worktree dir that holds a service dir returned by `ensureWorktree`. */
export const worktreeOf = (serviceDir: string): string => dirname(dirname(resolve(serviceDir)));

/**
 * Ensure `worktrees/<service>@<sha>` exists at that sha and can run the service:
 * the service's `node_modules` is linked to the installed one in `depsDir`
 * (planted and fix commits never change dependencies).
 */
export async function ensureWorktree(opts: WorktreeOptions, service: ServiceName, sha: string): Promise<string> {
  const root = resolve(opts.root);
  const dir = worktreeDir(root, service, sha);
  await mkdir(root, { recursive: true });
  if ((await exists(dir)) && (await headOf(dir)) !== sha) {
    // Stale or broken worktree inside our own worktrees dir: rebuild it.
    await removeWorktree(opts, dir);
  }
  if (!(await exists(dir))) {
    await worktreePrune(opts.repo);
    await worktreeAdd(opts.repo, dir, sha);
  }
  const serviceDir = join(dir, 'services', service);
  if (!(await exists(join(serviceDir, 'src', 'main.ts')))) throw new Error(`commit has no services/${service}/src/main.ts`);
  const link = join(serviceDir, 'node_modules');
  if (!(await exists(link))) await symlink(join(resolve(opts.depsDir), 'services', service, 'node_modules'), link, 'dir');
  return serviceDir;
}
