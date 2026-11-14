// Canary fix for the isolation check: service code that, at boot, tries what a hostile fix would
// try and logs one `CANARY {...}` line with each result. Shared by scripts/fix-deploy-check.mjs
// (CANARY=1) and the supervisor tests. Only ever committed to a temp origin.

export const CANARY_FILE = 'services/payments/src/canary.ts';
export const CANARY_PREFIX = 'CANARY ';

/** Attempts and what counts as "denied" for each. */
export const CANARY_ATTEMPTS = Object.freeze(['binding', 'procEnviron', 'spawn', 'worker', 'readEnvFile', 'signalParent']);

/**
 * Source of the canary module. `envFile` is the absolute path of the supervisor's `.env` (or a
 * stand-in in tests); it is only read (and must be denied).
 * @param {string} envFile
 */
export function canarySource(envFile) {
  return `// Isolation canary: every attempt below must be denied for fix code.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';

const r: Record<string, string> = {};
const code = (e: unknown) => String((e as { code?: string }).code ?? (e as Error).name ?? 'error');
try {
  (process as unknown as { binding(name: string): unknown }).binding('fs');
  r.binding = 'allowed';
} catch (e) {
  r.binding = code(e);
}
if (process.platform === 'linux') {
  try {
    readFileSync('/proc/' + process.ppid + '/environ');
    r.procEnviron = 'allowed';
  } catch (e) {
    r.procEnviron = code(e);
  }
} else {
  r.procEnviron = 'skipped';
}
try {
  execFileSync('/bin/echo', ['canary']);
  r.spawn = 'allowed';
} catch (e) {
  r.spawn = code(e);
}
try {
  const w = new Worker('0', { eval: true });
  void w.terminate();
  r.worker = 'allowed';
} catch (e) {
  r.worker = code(e);
}
try {
  readFileSync(${JSON.stringify(envFile)}, 'utf8');
  r.readEnvFile = 'allowed';
} catch (e) {
  r.readEnvFile = code(e);
}
try {
  process.kill(process.ppid, 0);
  r.signalParent = 'allowed';
} catch (e) {
  r.signalParent = code(e);
}
console.log(${JSON.stringify(CANARY_PREFIX)} + JSON.stringify(r));
`;
}

/** `services/payments/src/main.ts` of the canary fix: the original file with the canary imported first. */
export const withCanaryImport = (mainSource) => `import './canary.ts';\n${mainSource}`;

/**
 * Evaluate canary results. Denied = an error code (ERR_ACCESS_DENIED, EPERM, ...) or `skipped`.
 * In dev mode (no FIX_RUN_AS_USER) the design allows `signalParent`: the child runs as the
 * supervisor's own user and Node's permission model does not cover signals; that is a WARN.
 * @param {Record<string, string>} results
 * @param {{ dev: boolean }} opts
 * @returns {{ ok: boolean, rows: [string, string, string][] }}
 */
export function evaluateCanary(results, opts) {
  const rows = [];
  let ok = true;
  for (const name of CANARY_ATTEMPTS) {
    const v = results[name];
    if (v === undefined) {
      rows.push([name, 'missing', 'FAIL']);
      ok = false;
    } else if (v !== 'allowed') {
      rows.push([name, v, v === 'skipped' ? 'skipped' : 'denied']);
    } else if (name === 'signalParent' && opts.dev) {
      rows.push([name, v, 'WARN (dev: same OS user; denied on EC2 by FIX_RUN_AS_USER)']);
    } else {
      rows.push([name, v, 'FAIL']);
      ok = false;
    }
  }
  return { ok, rows };
}
