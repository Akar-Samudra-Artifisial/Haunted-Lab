import { parseEnv } from '@haunted-lab/common';

export interface LedgerConfig {
  port: number;
  host: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): LedgerConfig {
  const cfg = parseEnv(
    {
      LEDGER_LISTEN_PORT: { kind: 'port' },
      SERVICE_BIND_HOST: { kind: 'host', default: '127.0.0.1' },
    },
    env,
  );
  return { port: Number(cfg.LEDGER_LISTEN_PORT), host: cfg.SERVICE_BIND_HOST };
}
