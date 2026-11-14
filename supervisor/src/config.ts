import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, parseEnv } from '@haunted-lab/common';
import { FIX_USER_NAME } from './isolation.ts';
import { DEFAULT_ORIGIN_URL, parseOriginUrl } from './origin.ts';
import type { ServicePorts } from './runner.ts';

/** Repo root of this checkout (supervisor/src/config.ts -> ../..). */
export const CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const MIN_TOKEN_LENGTH = 16;
/** Placeholder prefix used in `.env.example`; a real token never starts with it. */
export const PLACEHOLDER_PREFIX = 'change-me';

export interface SupervisorConfig {
  port: number;
  ports: ServicePorts;
  bindHost: string;
  trafficRps: number;
  chaosToken: string;
  readToken: string;
  /** Source checkout that seeds the mirror (default: this checkout). */
  repo: string;
  /** Public origin the incident refs are fetched from. */
  originUrl: string;
  /** Tests only: allow a file:// origin. */
  allowFileOrigin: boolean;
  /** Optional OS user for fix children (EC2). */
  fixUser?: string;
  /** `NODE_ENV=production`: fix deploys need FIX_RUN_AS_USER (else 503 isolation_unavailable). */
  production: boolean;
  depsDir: string;
  dataDir: string;
  worktreesDir: string;
  echo: boolean;
}

/** Reads env. Errors carry NAMES only; token values are never printed. */
export function loadSupervisorConfig(env: Record<string, string | undefined> = process.env): SupervisorConfig {
  const cfg = parseEnv(
    {
      CHAOS_TOKEN: { kind: 'string' },
      LAB_READ_TOKEN: { kind: 'string' },
      SUPERVISOR_PORT: { kind: 'port', default: '4100' },
      GATE_PORT: { kind: 'port', default: '4001' },
      ORDERS_PORT: { kind: 'port', default: '4002' },
      PAYMENTS_PORT: { kind: 'port', default: '4003' },
      LEDGER_PORT: { kind: 'port', default: '4004' },
      SERVICE_BIND_HOST: { kind: 'host', default: '127.0.0.1' },
      TRAFFIC_RPS: { kind: 'int', default: '5' },
      LAB_REPO_DIR: { kind: 'string', default: CHECKOUT_ROOT },
      LAB_DATA_DIR: { kind: 'string', required: false },
      LAB_WORKTREES_DIR: { kind: 'string', required: false },
      LAB_ECHO_CHILD_OUTPUT: { kind: 'string', default: '1' },
      LAB_ORIGIN_URL: { kind: 'string', default: DEFAULT_ORIGIN_URL },
      LAB_ALLOW_FILE_ORIGIN: { kind: 'string', default: '0' },
      FIX_RUN_AS_USER: { kind: 'string', required: false },
      NODE_ENV: { kind: 'string', required: false },
    },
    env,
  );
  const invalid: string[] = [];
  // Too short, or still the .env.example placeholder: refuse to start.
  const weak = (t: string) => t.length < MIN_TOKEN_LENGTH || t.toLowerCase().startsWith(PLACEHOLDER_PREFIX);
  if (weak(cfg.CHAOS_TOKEN)) invalid.push('CHAOS_TOKEN');
  if (weak(cfg.LAB_READ_TOKEN)) invalid.push('LAB_READ_TOKEN');
  const rps = Number(cfg.TRAFFIC_RPS);
  if (rps > 50) invalid.push('TRAFFIC_RPS');
  if (cfg.LAB_ALLOW_FILE_ORIGIN !== '0' && cfg.LAB_ALLOW_FILE_ORIGIN !== '1') invalid.push('LAB_ALLOW_FILE_ORIGIN');
  if (cfg.FIX_RUN_AS_USER !== undefined && !FIX_USER_NAME.test(cfg.FIX_RUN_AS_USER)) invalid.push('FIX_RUN_AS_USER');
  if (invalid.length > 0) throw new ConfigError([], invalid);
  const allowFileOrigin = cfg.LAB_ALLOW_FILE_ORIGIN === '1';
  const originUrl = parseOriginUrl(cfg.LAB_ORIGIN_URL, allowFileOrigin);
  // One token must never open both prefixes.
  if (cfg.CHAOS_TOKEN === cfg.LAB_READ_TOKEN) throw new ConfigError([], [], 'CHAOS_TOKEN and LAB_READ_TOKEN must be different');
  const repo = resolve(cfg.LAB_REPO_DIR);
  return {
    port: Number(cfg.SUPERVISOR_PORT),
    ports: {
      gate: Number(cfg.GATE_PORT),
      orders: Number(cfg.ORDERS_PORT),
      payments: Number(cfg.PAYMENTS_PORT),
      ledger: Number(cfg.LEDGER_PORT),
    },
    bindHost: cfg.SERVICE_BIND_HOST,
    trafficRps: rps,
    chaosToken: cfg.CHAOS_TOKEN,
    readToken: cfg.LAB_READ_TOKEN,
    repo,
    originUrl,
    allowFileOrigin,
    ...(cfg.FIX_RUN_AS_USER !== undefined ? { fixUser: cfg.FIX_RUN_AS_USER } : {}),
    production: cfg.NODE_ENV === 'production',
    depsDir: CHECKOUT_ROOT,
    dataDir: resolve(cfg.LAB_DATA_DIR ?? resolve(CHECKOUT_ROOT, 'data')),
    worktreesDir: resolve(cfg.LAB_WORKTREES_DIR ?? resolve(CHECKOUT_ROOT, 'worktrees')),
    echo: cfg.LAB_ECHO_CHILD_OUTPUT !== '0',
  };
}
