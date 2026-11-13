import { parseEnv } from '@haunted-lab/common';

export interface OrdersConfig {
  port: number;
  host: string;
  paymentsUrl: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): OrdersConfig {
  const cfg = parseEnv(
    {
      ORDERS_PORT: { kind: 'port' },
      PAYMENTS_URL: { kind: 'url' },
      SERVICE_BIND_HOST: { kind: 'host', default: '127.0.0.1' },
    },
    env,
  );
  return { port: Number(cfg.ORDERS_PORT), host: cfg.SERVICE_BIND_HOST, paymentsUrl: cfg.PAYMENTS_URL };
}
