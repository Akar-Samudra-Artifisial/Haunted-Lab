import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, parseEnv } from '@haunted-lab/common';
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
  /** Repo the deploy refs come from (default: this checkout). */
  repo: string;
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
  if (invalid.length > 0) throw new ConfigError([], invalid);
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
    depsDir: CHECKOUT_ROOT,
    dataDir: resolve(cfg.LAB_DATA_DIR ?? resolve(CHECKOUT_ROOT, 'data')),
    worktreesDir: resolve(cfg.LAB_WORKTREES_DIR ?? resolve(CHECKOUT_ROOT, 'worktrees')),
    echo: cfg.LAB_ECHO_CHILD_OUTPUT !== '0',
  };
}
