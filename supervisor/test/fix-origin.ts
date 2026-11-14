// Origin Fixture: a local bare repo used as `origin` in tests, built from the deterministic
// snapshot repo with fixed authors and dates. Never touches GitHub.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSnapshotRepo, git as scriptGit, plantScenarios } from '../../scripts/lab-git.mjs';

export const CHECKOUT = resolve(import.meta.dirname, '..', '..');

type GitFn = (repo: string, args: string[], opts?: { env?: Record<string, string>; input?: string; raw?: boolean }) => Promise<string>;
export const runGit = scriptGit as GitFn;

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture Bot', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture Bot', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const BASE_TIME = Date.parse('2026-11-03T00:00:00Z') / 1000;

export const cuidRef = (n: number): string => `incident/c${String(n).padStart(24, '0')}`;

export type FileSpec = string | null | { symlink: string } | { content: string; mode: '100755' };

export interface Fixture {
  dir: string;
  /** Source checkout stand-in (snapshot repo + planted scenarios). */
  source: string;
  /** Bare origin. */
  origin: string;
  originUrl: string;
  heads: { main: string; 'error-spike': string; fog: string; 'dark-room': string };
  /** Content of a file on `main` in the source. */
  mainFile(path: string): Promise<string>;
  /** Create a commit in origin on `parents[0]` (more parents = merge) with the files changed. */
  commit(parents: string[], files: Record<string, FileSpec>, message: string): Promise<string>;
  setRef(ref: string, sha: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function makeFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'lab-fix-'));
  const source = join(dir, 'source');
  const main = await buildSnapshotRepo(CHECKOUT, source);
  const planted = await plantScenarios(source);
  const origin = join(dir, 'origin.git');
  await runGit(dir, ['clone', '--bare', '-q', '--', source, origin]);
  // index commands refuse to run in a bare repo without a work tree; give them an empty one
  const emptyTree = join(dir, 'empty-work-tree');
  await mkdir(emptyTree);
  let tick = 0;
  return {
    dir,
    source,
    origin,
    originUrl: pathToFileURL(origin).href,
    heads: { main, 'error-spike': planted.shas['error-spike'] as string, fog: planted.shas.fog as string, 'dark-room': planted.shas['dark-room'] as string },
    mainFile: (path) => runGit(source, ['show', `main:${path}`], { raw: true }),
    async commit(parents, files, message) {
      const env = { ...IDENTITY, GIT_INDEX_FILE: join(dir, `index-${++tick}`), GIT_WORK_TREE: emptyTree };
      await runGit(origin, ['read-tree', parents[0] as string], { env });
      for (const [path, spec] of Object.entries(files)) {
        if (spec === null) {
          await runGit(origin, ['update-index', '--force-remove', '--', path], { env });
          continue;
        }
        const [mode, content] = typeof spec === 'string' ? ['100644', spec] : 'symlink' in spec ? ['120000', spec.symlink] : [spec.mode, spec.content];
        const blob = await runGit(origin, ['hash-object', '-w', '--no-filters', '--stdin'], { input: content });
        await runGit(origin, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], { env });
      }
      const tree = await runGit(origin, ['write-tree'], { env });
      const date = `@${BASE_TIME + tick * 60} +0000`;
      return runGit(origin, ['commit-tree', '--no-gpg-sign', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], {
        env: { ...IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
    },
    async setRef(ref, sha) {
      await runGit(origin, ['update-ref', `refs/heads/${ref}`, sha]);
    },
    // Retries: a stopped child's exit can still write data/pids.json for a moment.
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

export const REFUNDS = 'services/payments/src/refunds.ts';
