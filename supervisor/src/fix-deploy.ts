// `POST /chaos/deploy-fix` flow: fetch one incident ref into the mirror, read its chain, decide
// with the pure rule, then deploy under the Lab mutex. Status codes are only the Contract's.
import { HttpError } from '@haunted-lab/common';
import type { Lab } from './chaos.ts';
import { deployFixAllowed, type DeployFixRequest, type DeployFixResponse } from './fix-contract.ts';
import { ChainTooLarge, readChain, type ChainRead } from './fix-chain.ts';
import type { Mirror } from './mirror.ts';

/** The only statuses the route may answer (plus 405 from the server for other methods). */
export const CONTRACT_STATUSES: ReadonlySet<number> = new Set([200, 400, 401, 404, 409, 422, 503]);

export interface FixDeployerDeps {
  mirror: Pick<Mirror, 'fetchIncident' | 'refHead' | 'allowedHeads' | 'path'>;
  lab: Pick<Lab, 'deployFix'>;
  /** False outside development without FIX_RUN_AS_USER: every request is 503 `isolation_unavailable`. */
  isolationAvailable?: boolean;
  /** Incident refs currently deployed (never pruned from the mirror). */
  activeIncidentRefs?: () => Set<string>;
  log?: (line: string) => void;
}

/** Map anything outside the Contract to 503 `deploy_failed`, so the route never leaks a 500. */
export function toContractError(err: unknown): HttpError {
  if (err instanceof HttpError && CONTRACT_STATUSES.has(err.status) && err.status !== 200) return err;
  return new HttpError(503, 'deploy_failed', 'deploy failed');
}

export function createFixDeployer(deps: FixDeployerDeps): (req: DeployFixRequest) => Promise<DeployFixResponse> {
  return async (req) => {
    if (deps.isolationAvailable === false) {
      throw new HttpError(503, 'isolation_unavailable', 'fix deploys need FIX_RUN_AS_USER outside development');
    }
    try {
      await deps.mirror.fetchIncident(req.ref, deps.activeIncidentRefs?.() ?? new Set());
      const { heads } = await deps.mirror.allowedHeads();
      const head = await deps.mirror.refHead(req.ref);
      if (!head) throw new HttpError(404, 'unknown_ref', 'the ref does not exist on origin');
      let chain: ChainRead = { chain: [], reachedHead: null, rootReached: false, totalLines: 0, totalBytes: 0 };
      if (head === req.sha && !heads.includes(req.sha)) {
        try {
          chain = await readChain(deps.mirror.path, req.sha, heads);
        } catch (err) {
          if (err instanceof ChainTooLarge) throw new HttpError(422, 'diff_too_large', 'the fix is too large');
          throw err;
        }
      }
      const decision = deployFixAllowed({ head, sha: req.sha, ...chain, allowedHeads: heads, service: req.service });
      if (!decision.ok) {
        deps.log?.(`deploy-fix refused for ${req.service}: ${decision.code}`);
        throw new HttpError(decision.status, decision.code, refusalMessage(decision.code));
      }
      const { record, deployed } = await deps.lab.deployFix(req.service, req.ref, req.sha, () => deps.mirror.refHead(req.ref));
      deps.log?.(`deploy-fix ${deployed ? 'deployed' : 'already running'} ${req.service} ${req.ref} ${req.sha.slice(0, 12)} as ${record.id}`);
      return { deployId: record.id, service: req.service, sha: req.sha };
    } catch (err) {
      const e = toContractError(err);
      if (!(err instanceof HttpError)) deps.log?.(`deploy-fix failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      throw e;
    }
  };
}

function refusalMessage(code: string): string {
  switch (code) {
    case 'not_head':
      return 'sha is not the head of the ref';
    case 'chain_too_long':
      return 'no allowed head within 20 first-parent commits';
    case 'no_allowed_base':
      return 'the chain does not start at main or a scenario head';
    case 'empty_fix':
      return 'sha is an allowed head, not a fix';
    case 'outside_service':
      return 'the chain touches files outside services/<service>/';
    case 'manifest_change':
      return 'the chain changes a package manifest or lockfile';
    case 'binary_or_special_change':
      return 'the chain changes a binary, symlink, submodule or file mode';
    default:
      return 'the fix is too large';
  }
}
