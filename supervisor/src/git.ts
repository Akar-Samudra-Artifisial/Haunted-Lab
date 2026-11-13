import { execFile, spawn } from 'node:child_process';

/**
 * Fixed env for every git call: no user or system config (no hooks, aliases, pagers, credential
 * helpers or filters from outside the repo), no prompts, C locale.
 */
export const GIT_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
});

/** Every git call is killed after this long. */
export const GIT_TIMEOUT_MS = 30_000;

/** Diffs served to the agent only cover the code the lab runs. */
export const DIFF_PATHSPEC: readonly string[] = Object.freeze(['services', 'packages']);

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitResult {
  code: number;
  stdout: string;
}

/** Run git with an argument array (never a shell string) and a timeout. Resolves for any exit code. */
export function git(repo: string, args: readonly string[], opts: { maxBuffer?: number; timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repo, ...args],
      { env: GIT_ENV, maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024, timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true },
      (err, stdout) => {
        if (err && (err as { killed?: boolean }).killed) {
          reject(new GitError(`git ${args[0] ?? ''} timed out`));
          return;
        }
        if (err && typeof (err as { code?: unknown }).code !== 'number') {
          reject(new GitError(`git ${args[0] ?? ''} failed to run`));
          return;
        }
        resolve({ code: err ? Number((err as { code: number }).code) : 0, stdout: String(stdout) });
      },
    );
  });
}

async function gitOk(repo: string, args: readonly string[]): Promise<string> {
  const r = await git(repo, args);
  if (r.code !== 0) throw new GitError(`git ${args[0] ?? ''} exited with ${r.code}`);
  return r.stdout.trim();
}

/** Resolve a branch name to its commit sha, or undefined if the branch does not exist. */
export async function revParseBranch(repo: string, branch: string): Promise<string | undefined> {
  const r = await git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}

/** Resolve a hex sha prefix to a full commit sha, or undefined. */
export async function resolveCommit(repo: string, hex: string): Promise<string | undefined> {
  if (!/^[0-9a-f]{7,40}$/.test(hex)) return undefined;
  const r = await git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${hex}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) && sha.startsWith(hex) ? sha : undefined;
}

export async function isAncestor(repo: string, sha: string, of: string): Promise<boolean> {
  const r = await git(repo, ['merge-base', '--is-ancestor', sha, of]);
  return r.code === 0;
}

export async function worktreeAdd(repo: string, dir: string, sha: string): Promise<void> {
  await gitOk(repo, ['worktree', 'add', '--detach', '--force', dir, sha]);
}

/** `git worktree remove --force <dir>`; false when git does not know the worktree. */
export async function worktreeRemove(repo: string, dir: string): Promise<boolean> {
  const r = await git(repo, ['worktree', 'remove', '--force', '--force', dir]);
  return r.code === 0;
}

export async function worktreePrune(repo: string): Promise<void> {
  await git(repo, ['worktree', 'prune']);
}

export async function headOf(dir: string): Promise<string | undefined> {
  const r = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export interface CommitInfo {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export async function commitInfo(repo: string, sha: string): Promise<CommitInfo> {
  const out = await gitOk(repo, ['log', '-1', '--no-color', '--format=%H%x00%an%x00%aI%x00%s', sha]);
  const [full = sha, author = '', date = '', subject = ''] = out.split('\0');
  return { sha: full, author, date, subject };
}

/**
 * Patch of one commit, limited to `services/` and `packages/`, read with a byte cap and a timeout:
 * reading stops (and git is killed) once `cap + 1` bytes arrived or the timeout passed.
 */
export function commitDiff(repo: string, sha: string, cap: number, timeoutMs: number = GIT_TIMEOUT_MS): Promise<{ diff: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, 'show', '--no-color', '--no-ext-diff', '--format=', '--patch', sha, '--', ...DIFF_PATHSPEC], {
      env: GIT_ENV,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      if (truncated) return;
      chunks.push(c);
      total += c.length;
      if (total > cap) {
        truncated = true;
        child.kill('SIGKILL');
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new GitError('git show failed to run'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new GitError('git show timed out'));
        return;
      }
      if (!truncated && code !== 0) {
        reject(new GitError(`git show exited with ${code}`));
        return;
      }
      resolve({ diff: Buffer.concat(chunks), truncated });
    });
  });
}
