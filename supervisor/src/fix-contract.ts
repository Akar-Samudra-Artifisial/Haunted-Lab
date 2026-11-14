// Contract of `POST /chaos/deploy-fix` (Haunted Ops fix-proposal-flow design, "Lab contract") and
// the pure rule that decides whether a fetched incident head may be deployed.
import { isServiceName, type ServiceName } from './types.ts';

export const INCIDENT_REF = /^incident\/c[a-z0-9]{24}$/;
export const FULL_SHA = /^[0-9a-f]{40}$/;
export const MAX_CHAIN = 20;
export const MAX_DIFF_LINES = 400;
/** Largest new blob a fix may write, and the total new bytes of the fix (reached head -> sha). */
export const MAX_BLOB_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024;
export const MANIFEST_FILES: readonly string[] = Object.freeze(['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock']);

export interface DeployFixRequest {
  service: ServiceName;
  ref: string;
  sha: string;
}

export interface DeployFixResponse {
  deployId: string;
  service: ServiceName;
  sha: string;
}

export interface FileChange {
  path: string;
  /** Renames and copies only. */
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  oldMode: string;
  newMode: string;
  binary: boolean;
  added: number;
  deleted: number;
  /** Bytes of the new blob (0 for a deletion). */
  size?: number;
}

export interface ChainCommit {
  sha: string;
  parents: string[];
  /** Compared with the first parent, so a merge counts as its whole effect. */
  changes: FileChange[];
}

export type FixRefusal =
  | 'not_head'
  | 'chain_too_long'
  | 'no_allowed_base'
  | 'empty_fix'
  | 'outside_service'
  | 'manifest_change'
  | 'binary_or_special_change'
  | 'diff_too_large';

export type DeployFixDecision = { ok: true; base: string } | { ok: false; status: 409 | 422; code: FixRefusal };

export interface DeployFixInput {
  /** Head of the fetched incident ref. */
  head: string;
  /** Requested Fix_Sha. */
  sha: string;
  /** First-parent commits from `sha` (newest first) before the reached allowed head. */
  chain: readonly ChainCommit[];
  /** The allowed head the walk stopped at, or null. */
  reachedHead: string | null;
  /** The walk hit a commit with no parent before an allowed head. */
  rootReached: boolean;
  /** Added + deleted lines from `reachedHead` to `sha`. */
  totalLines: number;
  /** Bytes of all new blobs from `reachedHead` to `sha`. */
  totalBytes?: number;
  allowedHeads: readonly string[];
  service: ServiceName;
}

/** Total, exact body check. Never throws. */
export function validateDeployFixBody(value: unknown): { ok: true; request: DeployFixRequest } | { ok: false } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes('service') || !keys.includes('ref') || !keys.includes('sha')) return { ok: false };
  const { service, ref, sha } = value as Record<string, unknown>;
  if (!isServiceName(service)) return { ok: false };
  if (typeof ref !== 'string' || !INCIDENT_REF.test(ref)) return { ok: false };
  if (typeof sha !== 'string' || !FULL_SHA.test(sha)) return { ok: false };
  return { ok: true, request: { service, ref, sha } };
}

const SPECIAL_MODES = new Set(['120000', '160000']);
const NONE = '000000';

/** A package manifest or lockfile, or anything under a `node_modules` segment (dependencies). */
const isManifest = (path: string): boolean => MANIFEST_FILES.includes(path.slice(path.lastIndexOf('/') + 1)) || path.split('/').includes('node_modules');

function isSpecial(c: FileChange): boolean {
  if (c.binary) return true;
  if (SPECIAL_MODES.has(c.oldMode) || SPECIAL_MODES.has(c.newMode)) return true;
  if (c.status === 'T') return true;
  // A new executable file is as special as making an existing one executable.
  if (c.oldMode === NONE && c.newMode === '100755') return true;
  return c.oldMode !== NONE && c.newMode !== NONE && c.oldMode !== c.newMode;
}

/**
 * Pure rule (no I/O). First failing rule wins, in this order: not_head, empty_fix,
 * chain_too_long, no_allowed_base, then per commit binary_or_special_change, manifest_change,
 * outside_service, then diff_too_large (a new blob over 64 KiB, more than 256 KiB of new bytes,
 * or more than 400 changed lines).
 */
export function deployFixAllowed(input: DeployFixInput): DeployFixDecision {
  const refuse = (status: 409 | 422, code: FixRefusal): DeployFixDecision => ({ ok: false, status, code });
  if (input.sha !== input.head) return refuse(409, 'not_head');
  if (input.allowedHeads.includes(input.sha)) return refuse(409, 'empty_fix');
  if (input.chain.length > MAX_CHAIN) return refuse(409, 'chain_too_long');
  if (input.reachedHead === null || !input.allowedHeads.includes(input.reachedHead)) {
    return input.rootReached ? refuse(409, 'no_allowed_base') : refuse(409, 'chain_too_long');
  }
  const prefix = `services/${input.service}/`;
  for (const commit of input.chain) {
    for (const c of commit.changes) {
      if (isSpecial(c)) return refuse(422, 'binary_or_special_change');
      if (isManifest(c.path) || (c.oldPath !== undefined && isManifest(c.oldPath))) return refuse(422, 'manifest_change');
      if (!c.path.startsWith(prefix) || (c.oldPath !== undefined && !c.oldPath.startsWith(prefix))) return refuse(422, 'outside_service');
    }
  }
  for (const commit of input.chain) for (const c of commit.changes) if ((c.size ?? 0) > MAX_BLOB_BYTES) return refuse(422, 'diff_too_large');
  if ((input.totalBytes ?? 0) > MAX_TOTAL_BYTES) return refuse(422, 'diff_too_large');
  if (input.totalLines > MAX_DIFF_LINES) return refuse(422, 'diff_too_large');
  return { ok: true, base: input.reachedHead };
}
