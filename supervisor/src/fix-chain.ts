// Reads a fix's first-parent chain into plain data for `deployFixAllowed`. All git calls use
// argument arrays, the isolated env, a timeout and a 1 MiB output cap.
import { MAX_CHAIN, type ChainCommit, type FileChange } from './fix-contract.ts';
import { GitOutputTooLarge, gitOk } from './git.ts';

export const CHAIN_OUTPUT_CAP = 1024 * 1024;
/** More changed files than this in one commit or in total: refused as too large. */
export const MAX_CHANGED_FILES = 200;

/** Output of one git read went over the cap: the fix is refused as `diff_too_large`. */
export class ChainTooLarge extends Error {
  constructor() {
    super('fix diff too large to read');
    this.name = 'ChainTooLarge';
  }
}

export interface ChainRead {
  chain: ChainCommit[];
  reachedHead: string | null;
  rootReached: boolean;
  totalLines: number;
  totalBytes: number;
}

async function read(repo: string, args: string[]): Promise<string> {
  try {
    return await gitOk(repo, args, { maxBuffer: CHAIN_OUTPUT_CAP });
  } catch (err) {
    if (err instanceof GitOutputTooLarge) throw new ChainTooLarge();
    throw err;
  }
}

const STATUSES = new Set(['A', 'M', 'D', 'R', 'C', 'T']);

/** Parse `git diff-tree -r -M --raw -z` output. */
export function parseRaw(out: string): (FileChange & { newSha: string })[] {
  const t = out.split('\0');
  const changes: (FileChange & { newSha: string })[] = [];
  let i = 0;
  while (i < t.length) {
    const head = t[i++] ?? '';
    if (!head.startsWith(':')) continue;
    const [oldMode = '', newMode = '', , newSha = '', statusField = ''] = head.slice(1).split(' ');
    const letter = statusField.charAt(0);
    const status = (STATUSES.has(letter) ? letter : 'M') as FileChange['status'];
    if (status === 'R' || status === 'C') {
      const oldPath = t[i++] ?? '';
      const path = t[i++] ?? '';
      changes.push({ path, oldPath, status, oldMode, newMode, binary: false, added: 0, deleted: 0, newSha });
    } else {
      const path = t[i++] ?? '';
      changes.push({ path, status, oldMode, newMode, binary: false, added: 0, deleted: 0, newSha });
    }
  }
  return changes;
}

/** Parse `git diff --numstat -z` output into `{ path -> lines }` (path = new path). */
export function parseNumstat(out: string): Map<string, { binary: boolean; added: number; deleted: number }> {
  const t = out.split('\0');
  const map = new Map<string, { binary: boolean; added: number; deleted: number }>();
  let i = 0;
  while (i < t.length) {
    const entry = t[i++] ?? '';
    if (entry === '') continue;
    const [a = '', d = '', ...rest] = entry.split('\t');
    let path = rest.join('\t');
    if (path === '') {
      i++; // old path
      path = t[i++] ?? '';
    }
    const binary = a === '-' || d === '-';
    map.set(path, { binary, added: binary ? 0 : Number(a) || 0, deleted: binary ? 0 : Number(d) || 0 });
  }
  return map;
}

/** Bytes of a new blob; 0 for deletions, submodules and the null sha. */
async function blobSize(repo: string, sha: string, mode: string): Promise<number> {
  if (!/^[0-9a-f]{40}$/.test(sha) || /^0+$/.test(sha) || mode === '000000' || mode === '160000') return 0;
  return Number(await read(repo, ['cat-file', '-s', '--end-of-options', sha])) || 0;
}

/** Changes of `commit` against `parent` (merges: their first parent). */
export async function commitChanges(repo: string, parent: string, commit: string): Promise<FileChange[]> {
  // -M: a rename is one entry with both paths, and both must be inside the service.
  const changes = parseRaw(await read(repo, ['diff-tree', '-r', '-M', '--raw', '--no-abbrev', '-z', '--end-of-options', parent, commit]));
  if (changes.length > MAX_CHANGED_FILES) throw new ChainTooLarge();
  const stats = parseNumstat(await read(repo, ['diff-tree', '-r', '-M', '--numstat', '-z', '--end-of-options', parent, commit]));
  const out: FileChange[] = [];
  for (const { newSha, ...c } of changes) {
    const s = stats.get(c.path);
    out.push({ ...c, ...(s ?? {}), size: await blobSize(repo, newSha, c.newMode) });
  }
  return out;
}

/**
 * Walk the first parents of `sha` (at most 21 so "more than 20" is visible) until an allowed head.
 * Per-commit changes and the total line count are read only when an allowed head was reached.
 */
export async function readChain(repo: string, sha: string, allowedHeads: readonly string[]): Promise<ChainRead> {
  const walk = (await read(repo, ['rev-list', '--first-parent', `--max-count=${MAX_CHAIN + 1}`, '--end-of-options', sha, '--'])).split('\n').filter(Boolean);
  const before: string[] = [];
  let reachedHead: string | null = null;
  for (const c of walk) {
    if (allowedHeads.includes(c)) {
      reachedHead = c;
      break;
    }
    before.push(c);
  }
  const rootReached = reachedHead === null && walk.length <= MAX_CHAIN;
  if (reachedHead === null) {
    return { chain: before.map((c) => ({ sha: c, parents: [], changes: [] })), reachedHead, rootReached, totalLines: 0, totalBytes: 0 };
  }
  const chain: ChainCommit[] = [];
  for (const c of before) {
    const parents = (await read(repo, ['rev-list', '--parents', '-n', '1', '--end-of-options', c, '--'])).split(' ').slice(1);
    const first = parents[0];
    chain.push({ sha: c, parents, changes: first ? await commitChanges(repo, first, c) : [] });
  }
  const total = parseNumstat(await read(repo, ['diff', '--numstat', '-z', '-M', '--end-of-options', reachedHead, sha, '--']));
  let totalLines = 0;
  for (const v of total.values()) totalLines += v.added + v.deleted;
  const totalRaw = parseRaw(await read(repo, ['diff', '--raw', '--no-abbrev', '-z', '-M', '--end-of-options', reachedHead, sha, '--']));
  if (totalRaw.length > MAX_CHANGED_FILES) throw new ChainTooLarge();
  let totalBytes = 0;
  for (const c of totalRaw) totalBytes += await blobSize(repo, c.newSha, c.newMode);
  return { chain, reachedHead, rootReached: false, totalLines, totalBytes };
}
