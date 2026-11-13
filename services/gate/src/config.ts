import { parseEnv } from '@haunted-lab/common';

export interface GateConfig {
  port: number;
  host: string;
  ordersUrl: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): GateConfig {
  const cfg = parseEnv(
    {
      GATE_PORT: { kind: 'port' },
      ORDERS_URL: { kind: 'url' },
      SERVICE_BIND_HOST: { kind: 'host', default: '127.0.0.1' },
    },
    env,
  );
  return { port: Number(cfg.GATE_PORT), host: cfg.SERVICE_BIND_HOST, ordersUrl: cfg.ORDERS_URL };
}
