import { bearerMatches, createLabServer, HttpError, unauthorized, type Ctx, type LabServer, type Route } from '@haunted-lab/common';
import type { Lab } from './chaos.ts';
import { validateDeployFixBody, type DeployFixRequest, type DeployFixResponse } from './fix-contract.ts';
import { toContractError } from './fix-deploy.ts';
import { commitWithDiff, listDeploys, listErrors, listLogs, parseLabQuery, type ObservabilityDeps } from './observability.ts';

export interface SupervisorTokens {
  chaos: string;
  read: string;
}

export interface SupervisorServerOptions {
  lab: Lab;
  observability: ObservabilityDeps;
  tokens: SupervisorTokens;
  /** `POST /chaos/deploy-fix` handler (validated request in, Contract response out). */
  deployFix?: (req: DeployFixRequest) => Promise<DeployFixResponse>;
  sink?: (line: string) => void;
}

/**
 * One node:http server: `/chaos/*` needs CHAOS_TOKEN, `/lab/*` needs LAB_READ_TOKEN
 * (each token works on its own prefix only), `/healthz` is open.
 */
export function createSupervisorServer(opts: SupervisorServerOptions): LabServer {
  const requireToken = (ctx: Ctx, secret: string) => {
    const header = ctx.headers.authorization;
    if (!bearerMatches(typeof header === 'string' ? header : undefined, secret)) throw unauthorized();
  };
  const chaos = (handler: (ctx: Ctx) => Promise<unknown> | unknown, method: 'GET' | 'POST', path: string): Route => ({
    method,
    path,
    handler: async (ctx) => {
      requireToken(ctx, opts.tokens.chaos);
      // The body never chooses a ref or a path; it is read only to enforce the 8 KiB limit.
      if (method === 'POST') await ctx.discardBody();
      return { status: 200, body: await handler(ctx) };
    },
  });
  const read = (handler: (ctx: Ctx) => Promise<unknown> | unknown, path: string): Route => ({
    method: 'GET',
    path,
    handler: async (ctx) => {
      requireToken(ctx, opts.tokens.read);
      return { status: 200, body: await handler(ctx) };
    },
  });
  const { lab, observability: obs } = opts;
  const routes: Route[] = [
    { method: 'GET', path: '/healthz', handler: () => ({ status: 200, body: { ok: true } }) },
    chaos((ctx) => lab.apply(ctx.params.name ?? ''), 'POST', '/chaos/scenarios/{name}/apply'),
    chaos(() => lab.reset(), 'POST', '/chaos/reset'),
    chaos(() => lab.state(), 'GET', '/chaos/state'),
    {
      // Contract route: only 200, 400, 401, 404, 409, 422, 503 (405 for other methods).
      method: 'POST',
      path: '/chaos/deploy-fix',
      handler: async (ctx) => {
        requireToken(ctx, opts.tokens.chaos);
        const bad = (msg: string) => new HttpError(400, 'bad_request', msg, { connection: 'close' });
        let raw: unknown;
        try {
          raw = await ctx.readJson();
        } catch (err) {
          // Oversize (413 elsewhere) and malformed bodies are both 400 on this route.
          throw bad(err instanceof HttpError && err.status === 413 ? 'body larger than 8 KiB' : 'body is not valid JSON');
        }
        const v = validateDeployFixBody(raw);
        if (!v.ok) throw new HttpError(400, 'bad_request', 'body must be { service, ref: incident/<cuid>, sha: <40 hex> }');
        if (!opts.deployFix) throw new HttpError(503, 'deploy_failed', 'fix deploys are not configured');
        try {
          return { status: 200, body: await opts.deployFix(v.request) };
        } catch (err) {
          throw toContractError(err);
        }
      },
    },
    read((ctx) => listErrors(obs, parseLabQuery(ctx.query)), '/lab/errors'),
    read((ctx) => listLogs(obs, parseLabQuery(ctx.query)), '/lab/logs'),
    read((ctx) => listDeploys(obs, parseLabQuery(ctx.query, ['since'])), '/lab/deploys'),
    read((ctx) => commitWithDiff(obs, ctx.params.sha ?? ''), '/lab/commits/{sha}/diff'),
  ];
  return createLabServer({
    name: 'supervisor',
    routes,
    infra: false,
    sink: opts.sink,
    errorExtras: (pathname) => (pathname === '/lab' || pathname.startsWith('/lab/') ? { untrusted: true } : undefined),
  });
}
