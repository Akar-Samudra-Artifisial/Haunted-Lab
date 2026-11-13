import { parseEnv } from '@haunted-lab/common';

export interface PaymentsConfig {
  port: number;
  host: string;
  ledgerUrl: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): PaymentsConfig {
  const cfg = parseEnv(
    {
      PAYMENTS_PORT: { kind: 'port' },
      LEDGER_URL: { kind: 'url' },
      SERVICE_BIND_HOST: { kind: 'host', default: '127.0.0.1' },
    },
    env,
  );
  return { port: Number(cfg.PAYMENTS_PORT), host: cfg.SERVICE_BIND_HOST, ledgerUrl: cfg.LEDGER_URL };
}
